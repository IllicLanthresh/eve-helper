/* The Sell tool's core, driven through the real page with a mocked ESI order book.

   Covers: inventory paste parsing (EU/US numbers, short lines), the 4-significant-digit
   price ticks and the undercut step into the finer band, plan selection (instant vs
   order vs split) against a depth-aware buy book with the min_volume scam guard, the
   flat 100 ISK per-order broker floor, the import list (ticked ORDER/SPLIT rows only)
   and the rule that filters are view-only.

   ...the inline SVG sparkline and the chart a row expands into, and the decision layer
   that replaced the ⏳ wait tag: the trend, the percentile
   rank, the fill estimate, the recency-weighted hit rate, the two-branch expectation with
   the broker fee charged in both branches, the fill-probability guard, ISK per slot-day,
   and the case the whole rework exists for — a recommendation flipping from LIST-PATIENT
   to INSTANT purely because the trend turned negative. */
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
  'Steady Trinket': 9005,       // flat market, and
  'Sliding Trinket': 9006,      // falling market / same highs, same patient price
  'Decay Widget': 9007,         // the p90-forever case
  'Nohigh Widget': 9008,        // history without a `highest` field
  'Blind Widget': 9009,         // no history at all
  'Spark Widget': 9010,         // a history built for the sparkline's arithmetic
};

/* ---------- history fixtures for the decision layer ----------
   `day(t)` is t days ago; a series is built newest-last so the page's own sort is
   exercised. Every series is geometric on purpose: the log of a geometric series is a
   straight line, so Theil-Sen's median pairwise slope is EXACTLY ln(k) and the expected
   %/week is (k^7 - 1) x 100 with no fitting error to allow for. */
const day = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
const series = (n, f) => {
  const out = [];
  for (let t = n - 1; t >= 0; t--) out.push(Object.assign({ date: day(t) }, f(t)));
  return out;
};

/* The isolation pair. Both items carry:
     - the SAME daily highs (1.2M every 20th day, 0.9M otherwise), so the hit rate at any
       price between them is identical;
     - the SAME 120-day median average (1,000,000), so the patient price is identical;
     - the SAME order book and quantity.
   The ONLY difference is direction: STEADY's average is flat, SLIDING's average (and its
   daily low) falls 1%/day, i.e. -6.79%/week. Everything the recommendation does
   differently between them therefore comes from the trend and nothing else. */
const SLIDE_K = 1.0101;                 // per day going BACKWARDS, so prices fall forward
const highAt = t => (t % 20 === 0 ? 1200000 : 900000);
const STEADY_HIST = series(400, t => ({
  average: 1000000, highest: highAt(t), lowest: 1000000, volume: 100, order_count: 8 }));
const slideAvg = t => 1000000 * Math.pow(SLIDE_K, Math.min(t, 119) - 59.5);
const SLIDING_HIST = series(400, t => ({
  average: slideAvg(t), highest: highAt(t), lowest: slideAvg(t), volume: 100, order_count: 8 }));

/* The user's own complaint, reproduced: an item that has been sliding 1%/day all year.
   Its p90-of-120-days is a high-water mark the market has not paid since spring. */
const DECAY_HIST = series(400, t => {
  const avg = 700000 * Math.pow(SLIDE_K, t);
  return { average: avg, highest: avg * 1.02, lowest: avg * 0.99, volume: 100, order_count: 8 };
});
/* Same shape, but ESI gave us no `highest` — the hit rate must fall back to the average
   and say so. */
const NOHIGH_HIST = series(200, t => ({ average: 1000000, volume: 50 }));

/* Exactly 120 days, one point per day, a straight decline — the sparkline's geometry is
   then a closed form the suite can re-derive. */
const SPARK_HIST = series(120, t => ({
  average: 1000 + t * 10, highest: 1000 + t * 10 + 5, lowest: 1000 + t * 10 - 5,
  volume: 100 + (t % 7), order_count: 4 }));

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
  // the isolation pair — identical books, identical highs, opposite direction
  'Steady Trinket':  { buys: [{ p: 900000, v: 1000 }], sells: [{ p: 950000, v: 40 }], hist: STEADY_HIST },
  'Sliding Trinket': { buys: [{ p: 900000, v: 1000 }], sells: [{ p: 950000, v: 40 }], hist: SLIDING_HIST },
  // the decaying item the ⏳ tag used to defer forever
  'Decay Widget':    { buys: [{ p: 600000, v: 1000 }], sells: [{ p: 700000, v: 40 }], hist: DECAY_HIST },
  // history with no `highest` at all
  'Nohigh Widget':   { buys: [{ p: 600000, v: 1000 }], sells: [{ p: 950000, v: 40 }], hist: NOHIGH_HIST },
  // priced, but with no history whatsoever — must degrade to the plain fee arithmetic
  'Blind Widget':    { buys: [{ p: 600000, v: 1000 }], sells: [{ p: 950000, v: 40 }] },
  /* Drawn on purpose: 120 days of daily average sliding 2,190 -> 1,000, a best sell of
     1,200 inside that range and a 30-day median of 1,145 under it, so the sparkline's
     scale, its point count and both marker positions are arithmetic, not eyeballing. */
  'Spark Widget':    { buys: [{ p: 800, v: 1000 }], sells: [{ p: 1200, v: 40 }],
                       hist: SPARK_HIST },
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

/* Same, but with history on and the history-reference controls set — the decision layer
   needs the history to have anything to decide with. */
async function fetchWithHistory(page, paste, mode, days) {
  await page.evaluate(o => {
    document.getElementById('histOn').checked = true;
    document.getElementById('histMode').value = o.mode;
    document.getElementById('histDays').value = String(o.days);
  }, { mode: mode, days: days });
  await page.fill('#inv', paste);
  await page.dispatchEvent('#inv', 'input');
  await page.waitForFunction(() => !document.getElementById('btnEsi').disabled);
  await page.click('#btnEsi');
  await page.waitForFunction(() => !document.getElementById('btnEsi').disabled && !state.esiRunning,
    null, { timeout: 30000 });
  // the history really arrived, so nothing below reads a half-built row
  await page.waitForFunction(() => state.fetchedHist === true && state.rows.length > 0);
}

const setPatience = async (page, mode) => {
  const id = 'pat' + mode[0].toUpperCase() + mode.slice(1);
  await page.evaluate(i => {
    const el = document.getElementById(i);
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  }, id);
  await page.waitForFunction(m => state.patience === m, mode);
};

const decisionRow = (page, name) => page.evaluate(n => {
  const r = state.rows.find(x => x.name === n);
  if (!r) return null;
  const m = r.metrics || {};
  return {
    strategy: r.strategy, exportPrice: r.exportPrice, totalNet: r.totalNet, netInstant: r.netInstant,
    fillDays: r.fillDays, fillChance: r.fillChance, perSlot: r.perSlot,
    trendPctWk: r.trendPctWk, dir: r.dir, pctRank: r.pctRank, hist: r.hist, why: r.why,
    patientPrice: m.patientPrice, decay: m.decay, velPctDay: m.velPctDay, window: m.window,
    patHitP: m.patHit ? m.patHit.p : null, patHitRaw: m.patHit ? m.patHit.raw : null,
    guarded: (m.guarded || []).map(g => ({ price: g.price, p: g.p, raw: g.hit ? g.hit.raw : null })),
    comp: m.comp ? { price: m.comp.price, net: m.comp.net, p: m.comp.p, days: m.comp.days,
                     broker: m.comp.brokerCharge, churn: m.comp.churn, relists: m.comp.relists } : null,
    patOpt: m.patOpt ? { price: m.patOpt.price, net: m.patOpt.net, p: m.patOpt.p, days: m.patOpt.days,
                         broker: m.patOpt.brokerCharge, churn: m.patOpt.churn, relists: m.patOpt.relists } : null,
  };
}, name);

const rowsOf = page => page.evaluate(() => state.rows.map(r => ({
  name: r.name, qty: r.qty, strategy: r.strategy, totalNet: r.totalNet,
  netInstant: r.netInstant, netOrder: r.netOrder, L: r.L, exportPrice: r.exportPrice,
  instFill: r.instFill, splitFill: r.splitFill, brokerEffPct: r.brokerEffPct,
  checked: r.checked, inImport: r.inImport, flags: r.flags.map(f => f.t),
  flagTips: r.flags.map(f => f.ttl || ''),
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
    check('...and the row carries a min-fee chip',
      cheap.flags.includes('minfee'), JSON.stringify(cheap.flags));
    check('...whose tooltip names the 100 ISK floor',
      cheap.flagTips.some(t => /broker floor: 100 ISK/.test(t)), JSON.stringify(cheap.flagTips));
    check('...and the effective rate it produces',
      cheap.flagTips.some(t => /effective: 2\.2%/.test(t)), JSON.stringify(cheap.flagTips));
    check('...against the nominal one',
      cheap.flagTips.some(t => /nominal: 1\.50%/.test(t)), JSON.stringify(cheap.flagTips));
    check('...and the chip itself stays short', cheap.flags.every(f => f.length <= 10),
      JSON.stringify(cheap.flags));
    near('a big order pays exactly the nominal 1.5%', bulk.brokerEffPct, 1.5, 1e-9);
    check('...and carries no min-fee chip',
      !bulk.flags.includes('minfee'), JSON.stringify(bulk.flags));

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

    // re-price through the real ESI path and wait for the fetch to finish, rather than
    // guessing how long it takes
    await fetchInventory(page, 'Floor Flipper\t40');
    await page.waitForFunction(() => state.rows.some(x => x.name === 'Floor Flipper'),
      null, { timeout: 20000 });
    const flipRow = await page.evaluate(() => {
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

    section('item icons — matching a row against the stack in your hangar');
    const icons = await s2.page.evaluate(() => [...document.querySelectorAll('#tblBody tr')].map(tr => {
      const td = tr.children[2];
      const img = td.querySelector('img.ticon');
      return {
        name: td.textContent,
        copy: td.dataset.copy || null,
        src: img ? img.getAttribute('src') : null,
        lazy: img ? img.getAttribute('loading') : null,
        alt: img ? img.getAttribute('alt') : null,
        hidden: img ? img.getAttribute('aria-hidden') : null,
        box: img ? [img.width, img.height] : null,
      };
    }));
    check('every priced row carries an item icon', icons.length > 0 && icons.every(i => i.src),
      JSON.stringify(icons.map(i => [i.name, i.src])));
    check('the icon points at the type id on CCP\u2019s public image CDN',
      icons.every(i => i.src === `https://images.evetech.net/types/${TYPE_IDS[i.name]}/icon?size=64`),
      JSON.stringify(icons.map(i => [i.name, TYPE_IDS[i.name], i.src])));
    check('icons load lazily — a 300-row table must not fetch 300 images at once',
      icons.every(i => i.lazy === 'lazy'), JSON.stringify(icons.map(i => i.lazy)));
    check('the icon is decorative: the name is already the label',
      icons.every(i => i.alt === '' && i.hidden === 'true'),
      JSON.stringify(icons.map(i => [i.alt, i.hidden])));
    check('the icon reserves a fixed box so the names keep one left edge',
      icons.every(i => i.box && i.box[0] === 32 && i.box[1] === 32),
      JSON.stringify(icons.map(i => i.box)));
    check('the icon adds nothing to the cell\u2019s text or its click-to-copy value',
      icons.every(i => i.name === i.copy), JSON.stringify(icons.map(i => [i.name, i.copy])));

    const broke = await s2.page.evaluate(() => {
      const img = document.querySelector('#tblBody tr img.ticon');
      img.dispatchEvent(new Event('error'));
      return { vis: img.style.visibility, w: img.getBoundingClientRect().width };
    });
    check('an icon the CDN does not have (SKINs, mostly) hides without collapsing its box',
      broke.vis === 'hidden' && broke.w > 0, JSON.stringify(broke));

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
      /⚠\d+ hidden/.test(await s2.page.$eval('#impEcho', el => el.textContent)),
      await s2.page.$eval('#impEcho', el => el.textContent));
    check('...with the long form on its tooltip',
      /hidden by the filters: \d+ — still in the list/
        .test(await s2.page.$eval('#impEcho', el => el.title)),
      await s2.page.$eval('#impEcho', el => el.title));

    await s2.page.fill('#fltText', '');
    await s2.page.dispatchEvent('#fltText', 'input');
    await s2.page.selectOption('#fltType', 'ord');
    // wait on the rendered outcome, not just the state flag behind it
    await s2.page.waitForFunction(() => state.filterType === 'ord'
      && [...document.querySelectorAll('#tblBody tr')]
        .every(tr => !/^(Pyerite|Damage Control II)$/.test(tr.children[2].textContent)));
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

    /* ================= the decision layer ================= */
    /* The ⏳ wait tag used to fire whenever an order at the p90 of the history window
       would net more than the current plan. p90 is a LEVEL, so on a declining item it is
       a high-water mark and the tag fired forever — the user hid those rows and they
       rotted in the hangar. What follows pins the model that replaced it. */

    const s4 = await openSell(browser, server);
    const p4 = s4.page;

    section('trend — a robust slope on log price, in %/week');
    const trend = await p4.evaluate(() => {
      const mk = (n, f) => { const o = []; for (let t = n - 1; t >= 0; t--) o.push({ date: new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10), average: f(t) }); return o; };
      return {
        // a clean 2%-per-day decline: today 1,000,000, 29 days ago 1.02^29 x that
        falling: theilSenPctPerWeek(mk(30, t => 1000000 * Math.pow(1.02, t)).map(h => ({ t: Date.parse(h.date) / 86400e3, y: h.average }))),
        flat: theilSenPctPerWeek(mk(30, () => 1000000).map(h => ({ t: Date.parse(h.date) / 86400e3, y: h.average }))),
        // one absurd spike must not drag the slope — that is why this is Theil-Sen
        spiked: theilSenPctPerWeek(mk(30, t => t === 7 ? 90000000 : 1000000).map(h => ({ t: Date.parse(h.date) / 86400e3, y: h.average }))),
        short: theilSenPctPerWeek(mk(4, () => 1000000).map(h => ({ t: Date.parse(h.date) / 86400e3, y: h.average }))),
        classes: [trendClass(1.4), trendClass(1.6), trendClass(-1.4), trendClass(-1.6), trendClass(null)],
      };
    });
    near('a clean 2%/day decline reads as (1.02^-7 - 1) = -12.99%/week',
      trend.falling, (Math.pow(1.02, -7) - 1) * 100, 1e-9);
    near('a flat series reads as exactly 0%/week', trend.flat, 0, 1e-12);
    near('a single 90x spike leaves the median pairwise slope at 0', trend.spiked, 0, 1e-12);
    eq('fewer than five traded days is not a trend', trend.short, null);
    eq('+-1.5%/week is the flat band', trend.classes.join(','), 'flat,rising,flat,falling,');

    section('pctRank — where the live price sits in 60 days of history');
    const rank = await p4.evaluate(() => {
      const e = { hist: [] };
      for (let t = 9; t >= 0; t--) e.hist.push({ date: new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10), average: 10 - t });
      // averages are 1..10, newest = 10
      return { mid: histPctRank(e, 5.5), tie: histPctRank(e, 10), under: histPctRank(e, 0.5), over: histPctRank(e, 99), none: histPctRank({ hist: [] }, 5) };
    });
    eq('5.5 against 1..10 is the 50th percentile', rank.mid, 50);
    eq('the top value counts its own tie as half -> 95', rank.tie, 95);
    eq('below everything is the 0th percentile', rank.under, 0);
    eq('above everything is the 100th', rank.over, 100);
    eq('no history, no rank', rank.none, null);

    section('daysToFill — the queue already listed at or below your price');
    const queue = await p4.evaluate(() => ({
      atMid: daysToFillAt([{ p: 100, v: 10 }, { p: 110, v: 20 }, { p: 130, v: 5 }], 110, 5),
      atTop: daysToFillAt([{ p: 100, v: 10 }, { p: 110, v: 20 }, { p: 130, v: 5 }], 130, 5),
      below: daysToFillAt([{ p: 100, v: 10 }], 90, 5),
      noVol: daysToFillAt([{ p: 100, v: 10 }], 110, 0),
      noBook: daysToFillAt(null, 110, 5),
    }));
    eq('10 + 20 units at or below 110, 5 traded a day -> 6 days', queue.atMid, 6);
    eq('the whole book of 35 units -> 7 days', queue.atTop, 7);
    eq('nothing is listed below your price -> 0 days', queue.below, 0);
    eq('no traded volume to divide by -> no estimate', queue.noVol, null);
    eq('no sell book -> no estimate', queue.noBook, null);

    section('hitRate — how often the market actually paid that price');
    const hit = await p4.evaluate(() => {
      const d = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      // six days, newest last, highs 1/1/10/1/1/10 reading oldest->newest
      const flat = { hist: [5, 4, 3, 2, 1, 0].map(t => ({ date: d(t), average: 1, highest: [10, 1, 1, 10, 1, 1][5 - t] })) };
      // no `highest` anywhere: the average must stand in, and say so
      const noHigh = { hist: [5, 4, 3, 2, 1, 0].map(t => ({ date: d(t), average: [10, 1, 1, 10, 1, 1][5 - t] })) };
      const mixed = { hist: [5, 4, 3, 2, 1, 0].map(t => ({ date: d(t), average: 1, highest: t % 2 ? 10 : undefined })) };
      return {
        flat2: hitRateOf(flat, 10, 2),
        flat6: hitRateOf(flat, 10, 6),
        tooShort: hitRateOf(flat, 10, 7),
        unreachable: hitRateOf(flat, 11, 2),
        noHigh2: hitRateOf(noHigh, 10, 2),
        mixed: hitRateOf(mixed, 10, 2),
      };
    });
    // windows of 2 over highs [10,1,1,10,1,1]: (10,1) (1,1) (1,10) (10,1) (1,1) -> 3 of 5
    near('3 of the 5 two-day windows contain a day that paid 10', hit.flat2.p, 3 / 5, 1e-12);
    eq('...counted over five windows', hit.flat2.windows, 5);
    eq('...off the daily high', hit.flat2.basis, 'daily high');
    eq('a window as long as the whole history is one window, and it hit', hit.flat6.p, 1);
    eq('a window longer than the history has nothing to say', hit.tooShort, null);
    eq('a price the market never reached scores 0', hit.unreachable.p, 0);
    near('with no `highest` the daily average stands in — same answer here',
      hit.noHigh2.p, 3 / 5, 1e-12);
    check('...and the basis says which field was used',
      /daily average/.test(hit.noHigh2.basis), hit.noHigh2.basis);
    check('a history with only some highs says so too',
      /average on the days without one/.test(hit.mixed.basis), hit.mixed.basis);

    section('hitRate is measured in TODAY’s money — the dip/decay separator');
    const detrend = await p4.evaluate(() => {
      const d = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      const hist = [];
      for (let t = 364; t >= 0; t--){
        const avg = 700000 * Math.pow(1.0101, t);       // 1%/day slide, all year
        hist.push({ date: d(t), average: avg, highest: avg * 1.02, lowest: avg * 0.99 });
      }
      const e = { hist };
      return { trend: histTrend(e), high: hitRateOf(e, 1277000, 14), live: hitRateOf(e, 700000, 14) };
    });
    check('a year-long 1%/day slide is read as a fall of about -6.8%/week',
      detrend.trend < -6.7 && detrend.trend > -6.9, detrend.trend);
    check('a price 80% above the market was reached in most of the past year’s windows...',
      detrend.high.raw > 0.8, detrend.high.raw);
    eq('...but never once the market it traded in is carried to today', detrend.high.p, 0);
    eq('...while the price you can ask right now fills in every window', detrend.live.p, 1);

    /* ---------- the three disposals, driven through the page ---------- */
    section('the three disposals, valued net of fees');
    const DEC_PASTE = ['Steady Trinket\t20', 'Sliding Trinket\t20', 'Decay Widget\t20',
                       'Nohigh Widget\t20', 'Blind Widget\t20'].join('\n');
    // the user's own settings: a LEVEL statistic over a long window, which is exactly
    // what used to fire the ⏳ tag forever
    await fetchWithHistory(p4, DEC_PASTE, 'median', 120);

    // the fee model itself is fees.test.js's job; here it only has to be the SAME number
    // on both sides of the hand arithmetic below
    const fees = await p4.evaluate(() => ({ tax: feePct('salesTax'), broker: feePct('brokerFee') }));
    const TAX = fees.tax, BROKER = fees.broker;
    near('the page fees are Accounting 5 / Broker Relations 5, to the box\'s two decimals',
      TAX, Number((7.5 * (1 - 0.11 * 5)).toFixed(2)) / 100, 1e-12);
    near('...and the broker fee likewise', BROKER, 0.015, 1e-12);

    const steady = await decisionRow(p4, 'Steady Trinket');
    const sliding = await decisionRow(p4, 'Sliding Trinket');

    eq('both items resolve the same patient price from the same 120-day median',
      steady.patientPrice, sliding.patientPrice);
    eq('...which is the flat market’s level', steady.patientPrice, 1000000);
    near('the flat item has no trend', steady.trendPctWk, 0, 1e-12);
    eq('...so it is classed flat', steady.dir, 'flat');
    near('the sliding item falls (1.0101^-7 - 1) = -6.79%/week',
      sliding.trendPctWk, (Math.pow(1.0101, -7) - 1) * 100, 1e-9);
    eq('...and is classed falling', sliding.dir, 'falling');
    near('...with the daily low sliding at that rate per day',
      sliding.velPctDay, -(Math.pow(1.0101, -7) - 1) * 100 / 7, 1e-9);
    eq('the flat item’s low is not sliding at all', steady.velPctDay, 0);

    // p is re-derived here from the definition rather than read off the page
    const expectP = (price, windowDays, weekly) => {
      const now = Date.now();
      const highs = [], adj = [];
      for (let t = 364; t >= 0; t--){
        const v = (t % 20 === 0 ? 1200000 : 900000);
        highs.push(v);
        adj.push(v * Math.pow(1 + weekly / 100, t / 7));
      }
      const scan = vals => {
        let last = -1, hits = 0, total = 0;
        const lastHit = vals.map((v, j) => { if (v >= price) last = j; return last; });
        for (let i = 0; i + windowDays - 1 < vals.length; i++){ total++; if (lastHit[i + windowDays - 1] >= i) hits++; }
        return hits / total;
      };
      return { p: scan(adj), raw: scan(highs) };
    };
    const pSteady = expectP(1000000, 14, 0);
    near('the flat item’s patient price fills in the share of windows the fixture puts a 1.2M high in',
      steady.patHitP, pSteady.p, 1e-12);
    check('...which is a real probability, not a certainty',
      steady.patHitP > 0.6 && steady.patHitP < 0.8, steady.patHitP);

    /* The two-branch expectation, hand-computed:
         net = legNet - broker - churn + p x (fills) + (1 - p) x (give up and dump, decayed)
       The flat item has no trend and no slide, so decay = 1 and churn = 0 — the whole
       formula reduces to the fee-charged expectation over the two outcomes. */
    const qty = 20, LP = 1000000, LC = 950000;
    const netInstant = 20 * 900000 * (1 - TAX);
    const brokerAt = v => Math.max(100, BROKER * v);
    const expPatSteady = -brokerAt(qty * LP) + pSteady.p * qty * LP * (1 - TAX) + (1 - pSteady.p) * netInstant;
    const expCompSteady = -brokerAt(qty * LC) + pSteady.p * qty * LC * (1 - TAX) + (1 - pSteady.p) * netInstant;
    near('the instant leg is the plain buy-book walk', steady.netInstant, netInstant, 1e-6);
    near('the patient listing is worth p x (it fills) + (1-p) x (dump it later), fee charged in both',
      steady.patOpt.net, expPatSteady, 1e-6);
    near('...and the competitive listing likewise', steady.comp.net, expCompSteady, 1e-6);
    check('the broker fee is charged even in the branch where nothing sells',
      steady.patOpt.net < pSteady.p * qty * LP * (1 - TAX) + (1 - pSteady.p) * netInstant,
      steady.patOpt.net);
    eq('a flat market with no slide needs no relists', steady.patOpt.relists, 0);
    eq('the flat item is told to list patiently', steady.strategy, 'pat');
    eq('...at the patient price', steady.exportPrice, LP);

    section('ISK per slot-day is the ranking objective');
    const expDays = pSteady.p * 0.5 + (1 - pSteady.p) * 14;   // queue is 0.4d, floored at 0.5
    near('expected days = p x (queue estimate) + (1-p) x the whole window',
      steady.patOpt.days, expDays, 1e-9);
    near('ISK/slot-day is the expectation over those days', steady.perSlot, expPatSteady / expDays, 1e-6);
    check('the patient listing beats the competitive one per slot-day',
      steady.patOpt.net / expDays > steady.comp.net / expDays, steady.perSlot);
    const sorted = await p4.evaluate(() => ({
      key: state.sortKey, dir: state.sortDir,
      order: [...document.querySelectorAll('#tblBody tr')].map(tr => tr.children[2].textContent),
      rates: state.rows.filter(rowFilter).map(r => r.perSlot),
    }));
    eq('the table sorts by ISK/slot-day out of the box', sorted.key, 'perSlot');
    eq('...descending', sorted.dir, -1);
    check('INSTANT rows carry no slot-day rate at all',
      (await p4.evaluate(() => state.rows.filter(r => r.strategy === 'imm').every(r => r.perSlot == null))));

    /* ---------- THE REGRESSION THIS REWORK EXISTS FOR ---------- */
    section('LIST-PATIENT flips to INSTANT purely because the trend turned negative');
    /* Steady and Sliding have the SAME book, the SAME quantity, the SAME daily highs and
       therefore the same raw hit rate, and the SAME 120-day median (so the same patient
       price). The only thing that differs is the direction of the daily average — which
       is precisely the information the old ⏳ p90 tag threw away. */
    eq('the flat item is told to list at the patient price', steady.strategy, 'pat');
    eq('the sliding one is told to sell now instead', sliding.strategy, 'imm');
    near('...off the same patient price', sliding.patientPrice, steady.patientPrice, 1e-9);
    near('...and the same raw hit rate at it', sliding.patHitRaw, steady.patHitRaw, 1e-12);
    check('...but almost none of those windows survive being carried to today’s prices',
      sliding.patHitP < 0.05 && steady.patHitP > 0.6,
      sliding.patHitP + ' vs ' + steady.patHitP);
    check('the sliding item’s listing is worth less than dumping it',
      sliding.patOpt.net < sliding.netInstant, sliding.patOpt.net + ' vs ' + sliding.netInstant);
    check('the "why" names the decay rather than a dip',
      /decay, not a dip/.test(sliding.why), sliding.why);
    check('...and quotes the trend it turned on',
      /trend: -6\.8%\/wk \(falling\)/.test(sliding.why), sliding.why);
    check('the flat item’s "why" quotes the percentile and the window instead',
      /rank: p\d+ of 60d/.test(steady.why) && /in 14d/.test(steady.why), steady.why);
    check('...as key: value lines, never a paragraph',
      steady.why.includes('\n') && !/\. [A-Z]/.test(steady.why), JSON.stringify(steady.why));

    section('the fee guard: no listing that would spend the broker fee for nothing');
    const decay = await decisionRow(p4, 'Decay Widget');
    check('the p90-style patient price sits far above what the market pays now',
      decay.patientPrice > decay.exportPrice * 1.5, decay.patientPrice + ' vs ' + decay.exportPrice);
    check('...and at the prices of the day it was "reached" in most windows — the old tag’s whole case',
      decay.patHitRaw > 0.8, decay.patHitRaw);
    eq('...but not once in today’s market', decay.patHitP, 0);
    check('so it is refused by the guard, not recommended',
      decay.guarded.some(g => g.price === decay.patientPrice), JSON.stringify(decay.guarded));
    check('...and the reason names the fee that would have been burned',
      /fee [\d,.]+ ISK spent either way/.test(decay.why), decay.why);
    check('...under the floor it failed to clear',
      /skip [\d,.]+: \d+% < 55% floor \(balanced\)/.test(decay.why), decay.why);
    eq('the item is still sold — listed at a price the market does pay', decay.strategy, 'ord');
    eq('...which is the live best sell', decay.exportPrice, 700000);
    eq('...with a fill chance the guard is happy with', decay.fillChance, 1);

    section('patience: one control, three answers, no refetch');
    const fetchedTypes = await p4.evaluate(() => state.esi.size);
    await setPatience(p4, 'rush');
    const rush = await decisionRow(p4, 'Steady Trinket');
    eq('in a rush the window is 7 days', rush.window, 7);
    check('...a 7-day window catches the 20-day high pattern far less often',
      rush.fillChance == null || rush.fillChance < 0.75, String(rush.fillChance));
    eq('...so the flat item is sold now rather than listed on a hope', rush.strategy, 'imm');
    await setPatience(p4, 'patient');
    const patient = await decisionRow(p4, 'Steady Trinket');
    eq('patient stretches the window to 30 days', patient.window, 30);
    eq('...where the same pattern always fills', patient.fillChance, 1);
    eq('...so the patient listing comes back', patient.strategy, 'pat');
    eq('flipping patience never refetches anything', await p4.evaluate(() => state.esi.size), fetchedTypes);
    await setPatience(p4, 'balanced');
    eq('...and balanced restores the middle answer',
      (await decisionRow(p4, 'Steady Trinket')).strategy, 'pat');

    section('rows without usable history degrade instead of guessing');
    const blind = await decisionRow(p4, 'Blind Widget');
    eq('no history at all still produces a plan', blind.strategy, 'ord');
    eq('...with no trend', blind.trendPctWk, null);
    eq('...no chance', blind.fillChance, null);
    check('...and a "why" that says so',
      /no history: plain fee arithmetic, no odds/.test(blind.why), blind.why);
    const nohigh = await decisionRow(p4, 'Nohigh Widget');
    check('a history with no `highest` still yields a probability',
      nohigh.fillChance != null, String(nohigh.fillChance));

    section('the ⏳ wait tag and its filter are gone');
    const gone = await p4.evaluate(() => ({
      waitInput: !!document.getElementById('waitPct'),
      waitFilter: !!document.getElementById('fltWait'),
      // the page's own visible text and its tooltips — the inline <script> is skipped, it
      // is allowed to talk about the tag it replaced
      hourglass: (() => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: n => /^(SCRIPT|STYLE)$/.test(n.parentNode.tagName)
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
        let txt = '';
        while (w.nextNode()) txt += w.currentNode.nodeValue;
        for (const el of document.body.querySelectorAll('[title],[placeholder],[aria-label]'))
          txt += (el.getAttribute('title') || '') + (el.getAttribute('placeholder') || '')
               + (el.getAttribute('aria-label') || '');
        return /⏳|wait tag|wait\?/i.test(txt);
      })(),
      waitFields: state.rows.some(r => 'waitPct' in r || 'waitFlag' in r),
      patienceBox: !!document.getElementById('patienceBox'),
      planOptions: [...document.getElementById('fltType').options].map(o => o.value).join(','),
    }));
    check('the wait-% input is gone', !gone.waitInput);
    check('the three-way wait filter is gone', !gone.waitFilter);
    check('no ⏳ tag, label or tooltip survives anywhere in the page', !gone.hourglass);
    check('and no row carries its fields any more', !gone.waitFields);
    check('the patience control took its place', gone.patienceBox);
    eq('the plan filter offers the four plans', gone.planOptions, 'all,imm,ord,pat,split');

    section('the new columns are exported and copyable');
    const cols = await p4.evaluate(() => {
      const heads = [...document.querySelectorAll('#tbl thead th')].map(th => th.textContent.trim());
      const tr = [...document.querySelectorAll('#tblBody tr')].find(x => x.children[2].textContent === 'Steady Trinket');
      const idx = k => [...document.querySelectorAll('#tbl thead th')].findIndex(th => th.dataset.key === k);
      const tsv = fullTsv().split('\n');
      return {
        heads,
        keys: [...document.querySelectorAll('#tbl thead th')].map(th => th.dataset.key),
        chance: tr.children[idx('fillChance')].textContent,
        slot: tr.children[idx('perSlot')].dataset.copy,
        fill: tr.children[idx('fillDays')].dataset.copy,
        planCell: tr.children[idx('strategy')].textContent,
        planTitle: tr.children[idx('strategy')].querySelector('.badge').title,
        head: tsv[0].split('\t'),
        row: (tsv.find(l => l.startsWith('Steady Trinket')) || '').split('\t'),
      };
    });
    check('Fill est., Chance % and ISK/slot-day are columns',
      ['fillDays', 'fillChance', 'perSlot'].every(k => cols.keys.includes(k)), cols.keys.join(','));
    check('no numeric Trend %/wk column crowds the table — it lives in the tooltip',
      !cols.heads.some(h => /^Trend/.test(h)), cols.heads.join('|'));
    check('...the sparkline column carries that sort instead',
      cols.heads[3] === 'History' && cols.keys[3] === 'trendPctWk',
      cols.heads[3] + '/' + cols.keys[3]);
    check('the plan cell reads as an action', /LIST-PATIENT/.test(cols.planCell), cols.planCell);
    check('...and hovering it gives the numbers behind it',
      /ISK\/slot-day/.test(cols.planTitle) && /% in \d+d/.test(cols.planTitle), cols.planTitle);
    check('the chance cell shows a percentage', /%$/.test(cols.chance), cols.chance);
    check('the slot-day cell copies its raw value', Number(cols.slot) > 0, cols.slot);
    check('the fill cell copies its raw value', Number(cols.fill) >= 0, cols.fill);
    check('the TSV gained the three columns',
      ['Fill est. days', 'Chance %', 'ISK/slot-day'].every(h => cols.head.includes(h)), cols.head.join('|'));
    check('...and dropped the wait upside', !cols.head.includes('Wait upside %'), cols.head.join('|'));
    eq('every TSV row is as wide as its header', cols.row.length, cols.head.length);
    check('the TSV keeps the working numbers the table hides',
      ['Trend %/wk', 'Pct rank 60d', 'Undercut %/day', 'Broker at risk ISK'].every(h => cols.head.includes(h)),
      cols.head.join('|'));
    await s4.close();

    section('the patience preset persists, and old saved state loads clean');
    const s5 = await openSell(browser, server, {});
    await s5.page.evaluate(() => {
      document.getElementById('patPatient').checked = true;
      document.getElementById('patPatient').dispatchEvent(new Event('change'));
    });
    const blob = await s5.page.evaluate(() => JSON.parse(localStorage.getItem('eveSellHelper.v2')));
    eq('the chosen patience is saved', blob.patience, 'patient');
    check('...and the dead waitPct key is not written back', blob.waitPct === undefined, JSON.stringify(blob.waitPct));
    await s5.close();

    const ctx6 = await browser.newContext();
    await H.seedStorage(ctx6, server.url, [
      ['eveHelper.auth.v1', H.authState([CHAR])],
      // exactly what the old build wrote, ⏳ threshold and all
      ['eveSellHelper.v2', { inv: 'Tritanium\t1000', waitPct: '25', histMode: 'p90', histDays: '120',
                             market: 'jita', ticked: [] }],
    ]);
    await H.mockEsi(ctx6, { skills: { accounting: 5, brokerRelations: 5 }, standings: {}, typeIds: TYPE_IDS, books: BOOKS });
    const p6 = await ctx6.newPage();
    H.watchPage(p6, 'sell-migrate');
    await p6.goto(server.url + '/index.html');
    await p6.waitForFunction("typeof rebuild === 'function'");
    eq('state from the wait-tag era restores its inventory', await p6.$eval('#inv', el => el.value), 'Tritanium\t1000');
    eq('...and its history settings', await p6.$eval('#histMode', el => el.value), 'p90');
    eq('...while the dead waitPct is ignored silently', await p6.evaluate(() => state.patience), 'balanced');
    check('...leaving the balanced preset selected in the UI',
      await p6.evaluate(() => document.getElementById('patBalanced').checked));
    await p6.evaluate(() => persist());
    check('...and a re-save drops the key',
      await p6.evaluate(() => JSON.parse(localStorage.getItem('eveSellHelper.v2')).waitPct === undefined));
    await ctx6.close();

    /* ================= the graphs ================= */
    section('the sparkline — the hit-rate claim, drawn');
    const s7 = await openSell(browser, server);
    const p7 = s7.page;
    await fetchWithHistory(p7, ['Spark Widget\t20', 'Blind Widget\t20'].join('\n'), 'median', 30);
    // wait on the drawing itself, never on a clock: every visible cell ends up carrying
    // data-spark, either a chart or an honest "no history"
    await p7.waitForFunction(() => document.querySelectorAll('#tblBody td.spark[data-spark]').length === 2);

    const geom = await p7.evaluate(() => {
      const cell = n => [...document.querySelectorAll('#tblBody tr')]
        .find(tr => tr.children[2].textContent === n).children[3];
      const spark = cell('Spark Widget');
      const line = spark.querySelector('[data-series]');
      return {
        W: SPARK_W, H: SPARK_H, days: SPARK_DAYS,
        state: spark.dataset.spark,
        points: Number(line.dataset.points),
        d: line.getAttribute('d'),
        stroke: line.getAttribute('stroke'),
        markers: [...spark.querySelectorAll('[data-marker]')].map(l => ({
          key: l.dataset.marker, price: Number(l.dataset.price), y: l.getAttribute('y1'),
          x1: l.getAttribute('x1'), x2: l.getAttribute('x2'),
        })),
        aria: spark.querySelector('svg').getAttribute('aria-label'),
        title: spark.querySelector('svg title').textContent,
        role: spark.querySelector('svg').getAttribute('role'),
        cellRole: spark.getAttribute('role'),
        expanded: spark.getAttribute('aria-expanded'),
        bare: cell('Blind Widget').dataset.spark,
        bareText: cell('Blind Widget').textContent,
        bareSvg: !!cell('Blind Widget').querySelector('svg'),
        row: (() => { const r = state.rows.find(x => x.name === 'Spark Widget'); return { L: r.L, bestSell: r.bestSell, patient: r.metrics.patientPrice, dir: r.dir }; })(),
      };
    });
    eq('a priced row with history gets a sparkline', geom.state, 'ready');
    eq('...one point per day of the 120-day window', geom.points, 120);
    check('...drawn as a single path', /^M[\d. ]+L/.test(geom.d), geom.d.slice(0, 40));
    // the scale spans the series AND the markers, so a marker is never off-canvas:
    //   lo = 1,000 (today's average)   hi = 2,190 (the oldest day)
    //   y(v) = (H-2) - (v - lo)/(hi - lo) x (H-4)
    const yOf = v => ((geom.H - 2) - (v - 1000) / (2190 - 1000) * (geom.H - 4)).toFixed(2);
    eq('the best sell is marked', geom.markers.filter(m => m.key === 'sell').length, 1);
    eq('...at exactly its place on the shared scale',
      geom.markers.find(m => m.key === 'sell').y, yOf(1200));
    eq('the patient price is marked too', geom.markers.filter(m => m.key === 'patient').length, 1);
    eq('...also at its own place', geom.markers.find(m => m.key === 'patient').y, yOf(1145));
    eq('...which is the 30-day median the plan uses', geom.row.patient, 1145);
    check('a cheaper price sits lower on the chart',
      Number(geom.markers.find(m => m.key === 'patient').y) > Number(geom.markers.find(m => m.key === 'sell').y),
      JSON.stringify(geom.markers));
    check('the list price is not drawn twice when it IS the best sell',
      !geom.markers.some(m => m.key === 'list') && geom.row.L === geom.row.bestSell,
      JSON.stringify(geom.markers));
    check('markers run the full width', geom.markers.every(m => m.x1 === '0' && Number(m.x2) === geom.W),
      JSON.stringify(geom.markers));
    eq('a falling market is drawn in red', geom.stroke, 'var(--red)');
    eq('...because that is what the row says it is', geom.row.dir, 'falling');
    check('the chart is labelled for a screen reader',
      /days of daily average price/.test(geom.aria) && /patient price/.test(geom.aria), geom.aria);
    eq('...and is an image with a title', geom.role, 'img');
    check('...whose title invites the full chart', /click for the full chart/.test(geom.title), geom.title);
    eq('the cell announces itself as a control', geom.cellRole, 'button');
    eq('...that is not expanded yet', geom.expanded, 'false');
    eq('a row with no history says so instead of drawing nothing', geom.bare, 'none');
    eq('...with a dash in the cell', geom.bareText, '—');
    check('...and no empty SVG', !geom.bareSvg);

    section('the expanded chart');
    const sparkCell = n => `#tblBody tr[data-key="${n}"] td.spark`;
    // the row with no history opens too — it just says so instead of drawing a chart
    await p7.click(sparkCell('blind widget'));
    await p7.waitForSelector('tr.detail');
    check('a row with no history opens an explanation rather than an empty chart',
      await p7.evaluate(() => {
        const d = document.querySelector('tr.detail');
        return !d.querySelector('svg') && /no history at this market/.test(d.textContent);
      }));
    await p7.click(sparkCell('spark widget'));
    await p7.waitForSelector('tr.detail svg[role=img]');
    const det = await p7.evaluate(() => {
      const d = document.querySelector('tr.detail');
      const svg = d.querySelector('svg');
      return {
        openKey: state.openDetail,
        colSpan: d.querySelector('td').colSpan,
        headers: document.querySelectorAll('#tbl thead th').length,
        points: Number(svg.querySelector('[data-series]').dataset.points),
        band: !!svg.querySelector('[data-band]'),
        bars: svg.querySelectorAll('[data-vol]').length,
        barVols: [...svg.querySelectorAll('[data-vol]')].map(rc => Number(rc.dataset.vol)),
        zeroHeight: [...svg.querySelectorAll('[data-vol]')].every(rc => Number(rc.getAttribute('height')) > 0),
        markers: [...svg.querySelectorAll('[data-marker]')].map(l => l.dataset.marker),
        labels: [...svg.querySelectorAll('[data-marker-label]')].map(t => t.textContent),
        nums: [...d.querySelectorAll('.chart-nums div')].map(x => x.querySelector('span').textContent),
        values: [...d.querySelectorAll('.chart-nums b')].map(x => x.textContent),
        why: d.querySelector('.chart-why').textContent,
        aria: svg.getAttribute('aria-label'),
        expanded: document.querySelector('#tblBody tr.open td.spark').getAttribute('aria-expanded'),
        rows: document.querySelectorAll('#tblBody tr.detail').length,
      };
    });
    eq('clicking a sparkline opens exactly one detail row', det.rows, 1);
    eq('...spanning the whole table', det.colSpan, det.headers);
    eq('...remembered by row key', det.openKey, 'spark widget');
    eq('...and the cell now reports itself expanded', det.expanded, 'true');
    eq('the price series is redrawn at full size', det.points, 120);
    check('the high/low band is drawn when ESI gave us one', det.band);
    eq('every day gets a volume bar', det.bars, 120);
    check('...with the volumes the history carried',
      det.barVols[0] === 100 + (119 % 7) && det.barVols[119] === 100, JSON.stringify(det.barVols.slice(0, 3)));
    check('...and none of them collapse to nothing', det.zeroHeight);
    check('both price markers are repeated and labelled',
      det.markers.includes('sell') && det.markers.includes('patient')
      && det.labels.some(t => /best sell/.test(t)) && det.labels.some(t => /patient price/.test(t)),
      JSON.stringify(det.labels));
    eq('the row’s decision numbers are restated under the chart',
      det.nums.join(','), 'plan,net ISK,fill est. d,chance,ISK/slot-day');
    check('...with real values', det.values.every(v => v && v !== ''), JSON.stringify(det.values));
    check('...and the same key: value why', /^(INSTANT|LIST) /.test(det.why), det.why);
    check('the chart is labelled for a screen reader',
      /days of price history/.test(det.aria) && /daily traded volume/.test(det.aria), det.aria);

    // the open chart is a property of the row, not of this render
    await setPatience(p7, 'patient');
    eq('a re-rank keeps the chart open on the same row',
      await p7.evaluate(() => document.querySelectorAll('#tblBody tr.detail').length), 1);
    await p7.click('#tbl thead th[data-key=name]');
    eq('...and so does a re-sort',
      await p7.evaluate(() => document.querySelectorAll('#tblBody tr.detail').length), 1);
    await setPatience(p7, 'balanced');
    await p7.click('#tblBody tr.open td.spark');
    await p7.waitForFunction(() => document.querySelectorAll('#tblBody tr.detail').length === 0);
    eq('clicking again closes it', await p7.evaluate(() => state.openDetail), null);
    // the keyboard reaches it too
    await p7.evaluate(() => {
      const td = document.querySelector('#tblBody tr[data-key="spark widget"] td.spark');
      td.focus();
      td.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await p7.waitForSelector('tr.detail');
    check('Enter on a focused sparkline opens the chart too',
      await p7.evaluate(() => document.querySelectorAll('#tblBody tr.detail').length) === 1);

    section('a history with no high/low still charts');
    await p7.evaluate(() => { state.openDetail = null; render(); });
    await fetchWithHistory(p7, 'Nohigh Widget\t20', 'median', 30);
    await p7.waitForFunction(() => document.querySelectorAll('#tblBody td.spark[data-spark]').length === 1);
    await p7.click('#tblBody tr[data-key="nohigh widget"] td.spark');
    await p7.waitForSelector('tr.detail svg');
    const noBand = await p7.evaluate(() => {
      const svg = document.querySelector('tr.detail svg');
      return { band: !!svg.querySelector('[data-band]'), series: !!svg.querySelector('[data-series]'),
               bars: svg.querySelectorAll('[data-vol]').length };
    });
    check('no `highest`/`lowest`, no band drawn', !noBand.band);
    check('...but the price line and the volume bars are still there',
      noBand.series && noBand.bars > 0, JSON.stringify(noBand));
    await s7.close();

    section('250 rows stay fast because the charts are lazy');
    const BULK_IDS = {}, BULK_BOOKS = {}, bulkLines = [];
    for (let i = 0; i < 250; i++) {
      const name = 'Bulk Item ' + String(i).padStart(3, '0');
      BULK_IDS[name] = 20000 + i;
      BULK_BOOKS[name] = {
        buys: [{ p: 900 + i, v: 1000 }], sells: [{ p: 1200 + i, v: 40 }],
        hist: series(90, t => ({ average: 1000 + i + t * 3, highest: 1010 + i + t * 3,
                                 lowest: 990 + i + t * 3, volume: 50 + t })),
      };
      bulkLines.push(name + '\t' + (10 + i));
    }
    const s8 = await openSell(browser, server, { typeIds: BULK_IDS, books: BULK_BOOKS });
    await fetchWithHistory(s8.page, bulkLines.join('\n'), 'median', 30);
    await s8.page.waitForFunction(() => state.rows.length === 250);
    await s8.page.waitForFunction(() => (state.sparkDrawn || 0) > 0);
    const bulkStats = await s8.page.evaluate(() => {
      const t0 = performance.now();
      render();
      const ms = performance.now() - t0;
      return { ms, rows: document.querySelectorAll('#tblBody tr').length,
               cells: document.querySelectorAll('#tblBody td.spark').length,
               drawnNow: document.querySelectorAll('#tblBody td.spark[data-spark]').length };
    });
    eq('all 250 rows render', bulkStats.rows, 250);
    eq('...each with a sparkline cell', bulkStats.cells, 250);
    check('...but only the ones on screen are actually drawn',
      bulkStats.drawnNow < 250, bulkStats.drawnNow + ' of 250 drawn immediately');
    check('...and a full re-render of 250 rows stays well under a second',
      bulkStats.ms < 900, bulkStats.ms + ' ms');
    // scrolling the table draws the rows that come into view — waited on the count, not a clock
    const drawnBefore = await s8.page.evaluate(() => state.sparkDrawn || 0);
    await s8.page.evaluate(() => { document.querySelector('.tablewrap').scrollTop = 6000; });
    await s8.page.waitForFunction(n => (state.sparkDrawn || 0) > n, drawnBefore, { timeout: 15000 });
    check('scrolling draws the newly visible ones',
      await s8.page.evaluate(() => document.querySelectorAll('#tblBody td.spark[data-spark] svg').length) > 0);
    await s8.close();


  } finally {
    await browser.close();
    await server.close();
  }
});
