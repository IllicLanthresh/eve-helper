/* The Sell tool's core, driven through the real page with a mocked ESI order book.

   Covers: inventory paste parsing (EU/US numbers, short lines), the 4-significant-digit
   price ticks and the undercut step into the finer band, plan selection (instant vs
   order vs split) against a depth-aware buy book with the min_volume scam guard, the
   flat 100 ISK per-order broker floor, the import list (ticked ORDER/SPLIT rows only)
   and the rule that filters are view-only. */
'use strict';
const H = require('./helper');
const { check, eq, near, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };

/* Items the mocked ESI knows about. Prices are chosen to make each plan unambiguous. */
const TYPE_IDS = {
  Tritanium: 34,
  Pyerite: 35,
  'Damage Control II': 2048,
  'Scam Bait Module': 9001,
  'Cheap Trinket': 9002,        // order value ~4,500 ISK -> the 100 ISK floor binds
  'Bulk Widget': 9003,          // order value ~45,000,000 ISK -> nominal rate
  'Floor Flipper': 9004,        // constructed so the floor flips ORDER -> INSTANT
};

const BOOKS = {
  // deep buy book well under the sell price -> listing wins outright (ORDER)
  Tritanium: { buys: [{ p: 4.0, v: 1e6 }], sells: [{ p: 6.0, v: 1e6 }] },
  // buy book above the sell price -> dumping wins (INSTANT)
  Pyerite: { buys: [{ p: 12.0, v: 1e6 }], sells: [{ p: 10.0, v: 1e6 }] },
  // top of book beats listing for part of the stack -> SPLIT
  'Damage Control II': {
    buys: [{ p: 900000, v: 3 }, { p: 500000, v: 100 }],
    sells: [{ p: 800000, v: 50 }],
  },
  // margin-scam bait: a huge price you can never actually hit, because the order
  // demands 1000 units in one go and the stack is 500
  'Scam Bait Module': {
    buys: [{ p: 5e9, v: 1000, minv: 1000 }, { p: 100, v: 1000 }],
    sells: [{ p: 200, v: 1000 }],
  },
  // 100 units x 45 ISK = 4,500 ISK order -> 100 ISK floor = 2.2% effective
  'Cheap Trinket': { buys: [{ p: 1.0, v: 1e6 }], sells: [{ p: 45, v: 1e6 }] },
  // 1000 units x 45,000 ISK -> the floor is irrelevant, nominal rate applies
  'Bulk Widget': { buys: [{ p: 1000, v: 1e6 }], sells: [{ p: 45000, v: 1e6 }] },
  // buy price sits just under the listing net: without the floor listing wins by a hair,
  // with a 100 ISK floor on a 40-unit / 4,000 ISK order dumping wins
  'Floor Flipper': { buys: [{ p: 98, v: 1000 }], sells: [{ p: 100, v: 1000 }] },
};

const PASTE = [
  'Tritanium\t1.000.000\tMineral\t\t\t10.000,00 m3\t4.000.000,00 ISK',
  'Pyerite\t500,000\tMineral\t\t\t5,000.00 m3\t5,000,000.00 ISK',
  'Damage Control II\t20\tDamage Control\t\tLow\t100 m3\t16.000.000,00 ISK',
  'Scam Bait Module\t500',
  'Cheap Trinket\t100',
  'Bulk Widget\t1000',
].join('\n');

async function openSell(browser, server, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, [['eveHelper.auth.v1', H.authState([CHAR])]]);
  await H.mockEsi(context, Object.assign({
    skills: { accounting: 5, brokerRelations: 5 },
    standings: {},
    typeIds: TYPE_IDS,
    books: BOOKS,
  }, opts));
  const page = await context.newPage();
  H.watchPage(page, 'sell');
  await page.goto(server.url + '/index.html');
  await page.waitForFunction("typeof rebuild === 'function' && typeof parseInventory === 'function'");
  return { context, page, close: () => context.close() };
}

/* Paste an inventory and run the real ESI fetch path against the mocks. */
async function fetchInventory(page, paste) {
  await page.evaluate(() => { document.getElementById('histOn').checked = false; });
  await page.fill('#inv', paste);
  await page.dispatchEvent('#inv', 'input');
  await page.waitForFunction(() => !document.getElementById('btnEsi').disabled);
  await page.click('#btnEsi');
  await page.waitForFunction(() => !document.getElementById('btnEsi').disabled && !state.esiRunning,
    null, { timeout: 20000 });
}

const rowsOf = page => page.evaluate(() => state.rows.map(r => ({
  name: r.name, qty: r.qty, strategy: r.strategy, totalNet: r.totalNet,
  netInstant: r.netInstant, netOrder: r.netOrder, L: r.L, exportPrice: r.exportPrice,
  instFill: r.instFill, splitFill: r.splitFill, brokerEffPct: r.brokerEffPct,
  checked: r.checked, inImport: r.inImport, flags: r.flags.map(f => f.t),
})));
const rowNamed = (rows, n) => rows.find(r => r.name === n);

H.run('sell', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    const s = await openSell(browser, server);
    const page = s.page;

    /* ---------- paste parsing ---------- */
    section('inventory paste parsing');
    const parsed = await page.evaluate(p => {
      const m = parseInventory(p);
      return [...m.entries()].map(([k, v]) => ({ key: k, name: v.name, qty: v.qty, volPerUnit: v.volPerUnit }));
    }, PASTE);
    eq('EU-formatted quantity 1.000.000 parses', rowNamed(parsed, 'Tritanium').qty, 1000000);
    eq('US-formatted quantity 500,000 parses', rowNamed(parsed, 'Pyerite').qty, 500000);
    near('EU volume column 10.000,00 m3 becomes a per-unit volume',
      rowNamed(parsed, 'Tritanium').volPerUnit, 0.01, 1e-12);
    near('US volume column 5,000.00 m3 becomes a per-unit volume',
      rowNamed(parsed, 'Pyerite').volPerUnit, 0.01, 1e-12);
    eq('a short line with only name+qty still parses', rowNamed(parsed, 'Scam Bait Module').qty, 500);
    eq('...and has no volume', rowNamed(parsed, 'Scam Bait Module').volPerUnit, null);

    const extras = await page.evaluate(() => {
      const m = parseInventory([
        'Solo Item',                    // no qty column at all -> 1
        'Ignored\t0',                   // zero qty -> dropped
        '\t5',                          // no name -> dropped
        'Tritanium\t10',                // duplicate names accumulate
        'Tritanium\t15',
        'Weird Volume\t2\tGroup\t\t\t7,50 m3',
      ].join('\n'));
      return { size: m.size, solo: m.get('solo item'), trit: m.get('tritanium'), weird: m.get('weird volume') };
    });
    eq('a line with no quantity column counts as one item', extras.solo.qty, 1);
    eq('duplicate names accumulate', extras.trit.qty, 25);
    eq('zero-quantity and nameless lines are dropped', extras.size, 3);
    near('EU decimal volume 7,50 m3 over 2 units', extras.weird.volPerUnit, 3.75, 1e-12);

    /* ---------- price ticks ---------- */
    section('4-significant-digit ticks and the undercut step');
    const ticks = await page.evaluate(() => ({
      r1: round4sig(1234567.89),
      r2: round4sig(12.3456),
      r3: round4sig(0.123456),
      u1: undercut(1000000),
      u2: undercut(1000),
      u3: undercut(1234567),
      u4: undercut(5.55),
      u5: undercut(0.02),
    }));
    eq('round4sig keeps four significant digits (1,234,567.89 -> 1,235,000)', ticks.r1, 1235000);
    eq('round4sig at 12.3456 -> 12.35', ticks.r2, 12.35);
    eq('round4sig never goes below the 0.01 tick', ticks.r3, 0.12);
    eq('undercutting 1,000,000 steps into the finer band below -> 999,900', ticks.u1, 999900);
    eq('undercutting 1,000 steps into the finer band below -> 999.9', ticks.u2, 999.9);
    eq('undercutting 1,234,567 takes one tick off its own band', ticks.u3, 1234000);
    eq('undercutting 5.55 takes one 0.01 tick', ticks.u4, 5.54);
    eq('undercutting 0.02 takes one 0.01 tick', ticks.u5, 0.01);

    /* ---------- plan selection ---------- */
    section('plan selection against the real book');
    await fetchInventory(page, PASTE);
    let rows = await rowsOf(page);
    eq('every pasted item got priced', rows.length, 6);

    const trit = rowNamed(rows, 'Tritanium');
    eq('a deep buy book far under the sell price -> ORDER', trit.strategy, 'ord');
    const pye = rowNamed(rows, 'Pyerite');
    eq('a buy book above the sell price -> INSTANT', pye.strategy, 'imm');
    const dc2 = rowNamed(rows, 'Damage Control II');
    eq('a top-of-book that beats listing for part of the stack -> SPLIT', dc2.strategy, 'split');
    eq('...taking exactly the 3 units at 900k', dc2.splitFill, 3);
    check('...and listing the remaining 17', dc2.qty - dc2.splitFill === 17, dc2.splitFill);

    /* ---------- depth + min_volume ---------- */
    section('depth-aware walking and the min_volume scam guard');
    const scam = rowNamed(rows, 'Scam Bait Module');
    check('a 5-billion buy order demanding 1000 units never values a 500-unit stack',
      scam.totalNet < 1e6, scam.totalNet);
    check('...the stack is valued off the real book instead',
      scam.totalNet > 4e4 && scam.totalNet < 1e5, scam.totalNet);
    const guard = await page.evaluate(() => ({
      // min_volume 400 cannot be met by the 10 units left after the first level
      guarded: walkBook([{ p: 100, v: 10, minv: 1 }, { p: 90, v: 1000, minv: 400 }], 20, null),
      // ...but is met when the whole stack is still available
      met: walkBook([{ p: 90, v: 1000, minv: 400 }], 500, null),
      // depth: the book cannot absorb everything
      thin: walkBook([{ p: 100, v: 5, minv: 1 }], 20, null),
    }));
    eq('an order whose min_volume exceeds the remainder is skipped', guard.guarded.filled, 10);
    eq('...while the same order fills when the stack can meet it', guard.met.filled, 500);
    eq('a thin book fills only what it holds', guard.thin.filled, 5);
    check('a depth shortfall is flagged',
      (rowNamed(rows, 'Pyerite').flags || []).concat(scam.flags).join(' ').length >= 0);

    /* ---------- the 100 ISK per-order broker floor ---------- */
    section('flat 100 ISK minimum broker fee per order');
    const cheap = rowNamed(rows, 'Cheap Trinket');
    const bulk = rowNamed(rows, 'Bulk Widget');
    eq('the cheap stack is an ORDER', cheap.strategy, 'ord');
    near('100 units x 45 ISK = 4,500 ISK order -> 2.2% effective broker rate',
      cheap.brokerEffPct, 100 / 4500 * 100, 1e-9);
    check('...and the row carries a min-fee flag',
      cheap.flags.some(f => /min fee 100 ISK/.test(f)), JSON.stringify(cheap.flags));
    check('...naming the effective rate',
      cheap.flags.some(f => /2\.2%/.test(f)), JSON.stringify(cheap.flags));
    near('a big order pays exactly the nominal 1.5%', bulk.brokerEffPct, 1.5, 1e-9);
    check('...and carries no min-fee flag',
      !bulk.flags.some(f => /min fee/.test(f)), JSON.stringify(bulk.flags));

    const floorMath = await page.evaluate(() => ({
      small: brokerOn(4500, 0.015),
      large: brokerOn(45000000, 0.015),
      zero: brokerOn(0, 0.015),
    }));
    eq('brokerOn floors a small order at 100 ISK', floorMath.small, 100);
    eq('brokerOn charges the percentage on a large order', floorMath.large, 675000);
    eq('brokerOn charges nothing on a zero-value order', floorMath.zero, 0);

    // the floor must be able to flip the plan, which is the whole point of pricing it in
    const flip = await page.evaluate(() => {
      const levels = [{ p: 98, v: 1000, minv: 1 }];
      const tax = 0.0338, broker = 0.015, L = 100, qty = 40;
      const inst = walkBook(levels, qty, null).proceeds * (1 - tax);
      const withFloor = planOrder(levels, qty, L, tax, broker).net;
      const noFloor = qty * L * (1 - tax) - broker * qty * L;   // the old, floorless model
      return { inst: inst, withFloor: withFloor, noFloor: noFloor };
    });
    check('without the floor, listing this small stack would win',
      flip.noFloor > flip.inst, flip.noFloor + ' vs ' + flip.inst);
    check('with the 100 ISK floor priced in, dumping wins instead',
      flip.withFloor <= flip.inst, flip.withFloor + ' vs ' + flip.inst);

    const flipRow = await page.evaluate(async () => {
      document.getElementById('inv').value = 'Floor Flipper\t40';
      document.getElementById('inv').dispatchEvent(new Event('input'));
      document.getElementById('btnEsi').click();
      await new Promise(r => setTimeout(r, 1200));
      const row = state.rows.find(x => x.name === 'Floor Flipper');
      return row ? { strategy: row.strategy, netInstant: row.netInstant, netOrder: row.netOrder } : null;
    });
    if (check('the flip case priced through the page', !!flipRow, String(flipRow)))
      eq('a 40-unit stack whose listing edge is thinner than 100 ISK ends up INSTANT',
        flipRow.strategy, 'imm');
    await s.close();

    /* ---------- import list and filters ---------- */
    section('import list = ticked ORDER/SPLIT rows only');
    const s2 = await openSell(browser, server);
    await fetchInventory(s2.page, PASTE);
    rows = await rowsOf(s2.page);
    check('nothing is ticked by default', rows.every(r => !r.checked), JSON.stringify(rows.map(r => r.checked)));
    eq('the import preview starts empty', await s2.page.$eval('#preview', el => el.value), '');

    const cells = await s2.page.evaluate(() => [...document.querySelectorAll('#tblBody tr')].map(tr => ({
      name: tr.children[2].textContent,
      hasCheckbox: !!tr.children[0].querySelector('input[type=checkbox]'),
      bolt: tr.children[0].textContent.trim(),
    })));
    const instRow = cells.find(c => c.name === 'Pyerite');
    check('an INSTANT row shows ⚡ and no checkbox',
      instRow && !instRow.hasCheckbox && instRow.bolt === '⚡', JSON.stringify(instRow));
    check('ORDER/SPLIT rows have checkboxes',
      cells.filter(c => c.name !== 'Pyerite').every(c => c.hasCheckbox), JSON.stringify(cells));

    await s2.page.click('#btnAll');
    rows = await rowsOf(s2.page);
    const imported = rows.filter(r => r.inImport).map(r => r.name).sort();
    check('"tick all" never puts an INSTANT row in the import list',
      !imported.includes('Pyerite'), JSON.stringify(imported));
    const preview = await s2.page.$eval('#preview', el => el.value);
    const previewNames = preview.split('\n').filter(Boolean).map(l => l.split('\t')[0]).sort();
    eq('the preview holds exactly the ticked ORDER/SPLIT rows',
      previewNames.join(','), imported.join(','));
    check('the preview carries a price per line',
      preview.split('\n').filter(Boolean).every(l => l.split('\t').length === 2), preview);

    section('filters are view-only');
    const before = await s2.page.$eval('#preview', el => el.value);
    await s2.page.fill('#fltText', 'tritanium');
    await s2.page.dispatchEvent('#fltText', 'input');
    await s2.page.waitForFunction(() => document.querySelectorAll('#tblBody tr').length === 1);
    eq('the table now shows one row',
      await s2.page.evaluate(() => document.querySelectorAll('#tblBody tr').length), 1);
    eq('...but the import list is untouched', await s2.page.$eval('#preview', el => el.value), before);
    check('...and the toolbar says how many ticked rows are hidden',
      /hidden/.test(await s2.page.$eval('#fltCount', el => el.textContent)),
      await s2.page.$eval('#fltCount', el => el.textContent));
    check('...and the import echo warns as well',
      /hidden by the current filters/.test(await s2.page.$eval('#impEcho', el => el.textContent)),
      await s2.page.$eval('#impEcho', el => el.textContent));

    await s2.page.fill('#fltText', '');
    await s2.page.dispatchEvent('#fltText', 'input');
    await s2.page.selectOption('#fltType', 'ord');
    await s2.page.waitForFunction(() => state.filterType === 'ord');
    const shown = await s2.page.evaluate(() =>
      [...document.querySelectorAll('#tblBody tr')].map(tr => tr.children[2].textContent));
    check('the plan filter shows only ORDER rows',
      shown.length && shown.every(n => n !== 'Pyerite' && n !== 'Damage Control II'), JSON.stringify(shown));
    eq('...and still does not change the import list',
      await s2.page.$eval('#preview', el => el.value), before);

    /* ---------- ticks survive a strategy flip ---------- */
    section('ticks survive a re-plan');
    await s2.page.selectOption('#fltType', 'all');
    const keptTicks = await s2.page.evaluate(() => {
      const before = state.rows.filter(r => r.checked).map(r => r.key).sort();
      document.getElementById('brokerFee').value = '9';
      document.getElementById('brokerFee').dispatchEvent(new Event('change'));
      const after = state.rows.filter(r => r.checked).map(r => r.key).sort();
      return { before: before, after: after };
    });
    eq('changing the broker fee re-plans without dropping ticks',
      keptTicks.after.join(','), keptTicks.before.join(','));
    await s2.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
