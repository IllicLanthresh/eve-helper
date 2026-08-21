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
  'Patience Widget': 9011,      // thin enough that the window is what decides
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

/* THIN, and coherent. Three units trade a day in a band of 950,000-1,050,000 around an
   average of 1,000,000, so half of them clear at or above 1,000,000: 1.5 units a day
   reach a listing at that price, and each trade carries one unit (volume = order_count).
   Twenty units therefore need about thirteen days of arrivals — more than a rush window
   has, comfortably inside a balanced one. This is the item the patience control decides,
   and it decides it through the arrival rate rather than through how often a year of
   daily highs happened to touch the price. */
const PATIENCE_HIST = series(400, () => ({
  average: 1000000, highest: 1050000, lowest: 950000, volume: 3, order_count: 3 }));

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
  // one unit queued ahead, so the wait is the arrival rate and almost nothing else
  'Patience Widget': { buys: [{ p: 900000, v: 1000 }], sells: [{ p: 1000000, v: 1 }],
                       hist: PATIENCE_HIST },
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
    fillDays: r.fillDays, fillChance: r.fillChance, fillBound: r.fillBound, fillPAny: r.fillPAny,
    perSlot: r.perSlot,
    trendPctWk: r.trendPctWk, dir: r.dir, pctRank: r.pctRank, hist: r.hist, why: r.why,
    patientPrice: m.patientPrice, decay: m.decay, velPctDay: m.velPctDay, window: m.window,
    patHitP: m.patHit ? m.patHit.p : null, patHitRaw: m.patHit ? m.patHit.raw : null,
    guarded: (m.guarded || []).map(g => ({ price: g.price, p: g.p, raw: g.hit ? g.hit.raw : null })),
    comp: m.comp ? { price: m.comp.price, net: m.comp.net, p: m.comp.p, days: m.comp.days,
                     broker: m.comp.brokerCharge, churn: m.comp.churn, relists: m.comp.relists,
                     listQty: m.comp.listQty, pAny: m.comp.pAny, bound: m.comp.bound,
                     expUnits: m.comp.out ? m.comp.out.expUnits : null,
                     capped: m.comp.out ? m.comp.out.capped : null,
                     src: m.comp.out ? m.comp.out.src : null } : null,
    patOpt: m.patOpt ? { price: m.patOpt.price, net: m.patOpt.net, p: m.patOpt.p, days: m.patOpt.days,
                         broker: m.patOpt.brokerCharge, churn: m.patOpt.churn, relists: m.patOpt.relists,
                         listQty: m.patOpt.listQty, pAny: m.patOpt.pAny, bound: m.patOpt.bound,
                         expUnits: m.patOpt.out ? m.patOpt.out.expUnits : null } : null,
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

    /* An undercut that rounds to NEAREST can land back on — or above — the order
       it is meant to beat. Ten thousand prices across nine orders of magnitude,
       every one of which must come out strictly below and on a legal tick. */
    const sweep = await page.evaluate(() => {
      let notBelow = 0, offTick = 0, worst = null;
      for (let i = 0; i < 10000; i++){
        const p = Math.round(Math.pow(10, (i % 900) / 100) * 1000) / 100;
        if (!(p > 0.01)) continue;
        const u = undercut(p);
        if (!(u < p)){ notBelow++; if (!worst) worst = [p, u]; }
        const t = Math.max(Math.pow(10, Math.floor(Math.log10(u)) - 3), 0.01);
        if (Math.abs(u / t - Math.round(u / t)) > 1e-6) offTick++;
      }
      return { notBelow, offTick, worst };
    });
    eq('an undercut is never equal to or above the price it undercuts', sweep.notBelow, 0);
    eq('...and always lands on a legal tick', sweep.offTick, 0);

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

    const cells = await s2.page.evaluate(() => [...document.querySelectorAll('#tblBody tr.a')].map(tr => ({
      name: tr.querySelector('.nm').textContent,
      hasCheckbox: !!tr.querySelector('td.tick').querySelector('input[type=checkbox]'),
      bolt: tr.querySelector('td.tick').textContent.trim(),
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
    const icons = await s2.page.evaluate(() => [...document.querySelectorAll('#tblBody tr.a')].map(tr => {
      const td = tr.querySelector('[data-cell="name"]');
      // the cell holds the icon, the name and any warning chips; the NAME is its own span
      const nm = td.querySelector('.nm');
      const img = td.querySelector('img.ticon');
      return {
        name: nm.textContent,
        copy: nm.dataset.copy || null,
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
    await s2.page.waitForFunction(() => document.querySelectorAll('#tblBody tr.a').length === 1);
    eq('the table now shows one row',
      await s2.page.evaluate(() => document.querySelectorAll('#tblBody tr.a').length), 1);
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
      && [...document.querySelectorAll('#tblBody tr.a')]
        .every(tr => !/^(Pyerite|Damage Control II)$/.test(tr.querySelector('.nm').textContent)));
    const shown = await s2.page.evaluate(() =>
      [...document.querySelectorAll('#tblBody tr.a')].map(tr => tr.querySelector('.nm').textContent));
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

    /* ================================================================================
       THE REPORTED BUG, and the rule that answers it.

       Reported verbatim: "when u click on select top N, it selects based on their number
       in the # column (which idk what that is) but the default sort is isk/slot-day".
       Both halves were true. # was a position by expected net ISK fixed at plan time, the
       table opened sorted by ISK/slot-day, and "Tick top N" walked the first of those —
       so the rows that got ticked were not the rows at the top of the screen, and nothing
       on the page said which order was in charge.

       The rule now: THE SCREEN IS THE ORDER. # counts the view out, "Tick top N" ticks
       # 1…N, and the exports come out in the same order. What follows pins that, and
       pins scenario S2 — a bulk button can no longer leave more rows in the import list
       than it says on its face.
       ================================================================================ */
    section('# is the row’s position in the view, not a hidden score');
    const s3 = await openSell(browser, server);
    await fetchInventory(s3.page, PASTE);

    const viewOf = page => page.evaluate(() => [...document.querySelectorAll('#tblBody tr.a')]
      
      .map(tr => ({ pos: tr.querySelector('[data-cell="pos"]').textContent, name: tr.querySelector('.nm').textContent })));

    let view = await viewOf(s3.page);
    check('the table has rows to number', view.length >= 5, JSON.stringify(view));
    eq('# counts the rendered rows 1..n, top down',
      view.map(v => v.pos).join(','), view.map((_v, i) => i + 1).join(','));
    const byPerSlot = view.map(v => v.name);

    await s3.page.selectOption('#sortBy', 'qty');
    await s3.page.waitForFunction(() => state.sortKey === 'qty');
    view = await viewOf(s3.page);
    const byQty = view.map(v => v.name);
    check('sorting by another column really reorders the table',
      byQty.join(',') !== byPerSlot.join(','), byQty.join(',') + ' vs ' + byPerSlot.join(','));
    eq('...and # renumbers with it rather than staying pinned to the row',
      view.map(v => v.pos).join(','), view.map((_v, i) => i + 1).join(','));
    eq('...so # 1 is whatever is on top now', view[0].name, byQty[0]);

    await s3.page.fill('#fltText', 'widget');
    await s3.page.dispatchEvent('#fltText', 'input');
    await s3.page.waitForFunction(() => state.filterText === 'widget');
    view = await viewOf(s3.page);
    check('a filter narrows the table', view.length < byQty.length, JSON.stringify(view));
    eq('...and # starts again at 1 — it numbers what you can see', view[0].pos, '1');
    await s3.page.fill('#fltText', '');
    await s3.page.dispatchEvent('#fltText', 'input');
    await s3.page.waitForFunction(() => state.filterText === '');

    const sortState = await s3.page.evaluate(() => {
      const before = { k: state.sortKey, d: state.sortDir };
      document.querySelector('#tbl thead th.nosort').click();
      return { before: before, after: { k: state.sortKey, d: state.sortDir } };
    });
    eq('# is not a sort key — clicking it changes nothing',
      JSON.stringify(sortState.after), JSON.stringify(sortState.before));
    eq('...and it does not offer a sort cursor either',
      await s3.page.$eval('#tbl thead th.nosort', el => getComputedStyle(el).cursor), 'default');

    section('every column in the Sell table says what it is');
    const heads = await s3.page.evaluate(() =>
      [...document.querySelectorAll('#tbl thead th')].map(th => ({ t: th.textContent, tip: th.title })));
    const mute = heads.filter(h => !h.tip.trim()).map(h => h.t);
    eq('no header is left unexplained', JSON.stringify(mute), '[]');
    const hashTip = heads.find(h => h.t === '#').tip;
    check('...and # says plainly that it is a position in this view',
      /position in the table as sorted/.test(hashTip) && /renumbers/.test(hashTip), hashTip);
    check('...and names the button that walks it',
      /Tick top N works down this order/.test(hashTip), hashTip);

    section('the ranking column owns up when it has no rates');
    /* Without history there is no fill estimate, so ISK/slot-day is null on every row and
       the sort quietly falls through to expected net — while the header still shows ▼ over
       "ISK/slot-day". The header counts the rows it has no rate for rather than implying a
       ranking it is not doing. */
    const rateTip = await s3.page.evaluate(() => ({
      unrated: state.rows.filter(r => r.strategy !== 'imm' && r.perSlot == null).length,
      total: state.rows.length,
      // ISK/slot-day shares the Net ISK column now, so its heading carries the count
      tip: document.querySelector('#tbl thead th[data-key="totalNet"]').title,
    }));
    check('this fixture is fetched without history, so there are no rates',
      rateTip.unrated > 0, JSON.stringify(rateTip));
    check('...and the header says how many rows have no rate yet',
      rateTip.tip.includes(`no rate yet: ${rateTip.unrated} rows`), rateTip.tip);
    check('...on top of what the column means, still in short lines',
      /expected net ÷ expected days/.test(rateTip.tip)
      && rateTip.tip.split('\n').every(l => l.length <= 130), JSON.stringify(rateTip.tip));

    section('Tick top N ticks the rows numbered 1..N — under any sort');
    /* The owner's case, run twice over two different sorts. Under the old code the ticked
       set was the same both times, because it came off a column the sort never touched. */
    const tickTop = async (page, n) => {
      await page.fill('#topN', String(n));
      await page.click('#btnTop');
      return page.evaluate(() => ({
        ticked: state.rows.filter(r => r.inImport).map(r => r.name).sort(),
        view: [...document.querySelectorAll('#tblBody tr.a')]
          .map(tr => {
            const row = state.rows.find(r => r.key === tr.dataset.key);
            return { pos: tr.querySelector('[data-cell="pos"]').textContent, name: tr.querySelector('.nm').textContent,
                     ticked: !!tr.querySelector('td.tick').querySelector('input:checked'),
                     sel: !!row && selectable(row) };
          }),
        echo: document.getElementById('impEcho').textContent,
        preview: document.getElementById('preview').value,
        hiddenTicked: state.rows.filter(r => r.inImport && !rowFilter(r)).length,
      }));
    };

    await s3.page.selectOption('#sortBy', 'perSlot');
    await s3.page.waitForFunction(() => state.sortKey === 'perSlot' && state.sortDir === -1);
    const topPerSlot = await tickTop(s3.page, 2);
    const prefix = v => v.filter(x => x.sel).map(x => x.ticked ? 'T' : '.').join('');
    check('the ticked rows are the TOP of the view — no tickable row above an unticked one',
      /^T*\.*$/.test(prefix(topPerSlot.view)), prefix(topPerSlot.view));
    eq('exactly 2 rows are in the import list', topPerSlot.ticked.length, 2);
    const perSlotPick = topPerSlot.ticked.join(',');

    await s3.page.selectOption('#sortBy', 'qty');
    await s3.page.waitForFunction(() => state.sortKey === 'qty' && state.sortDir === -1);
    const topQty = await tickTop(s3.page, 2);
    eq('...still exactly 2 after re-sorting and clicking again', topQty.ticked.length, 2);
    check('...and they are again the top of the view',
      /^T*\.*$/.test(prefix(topQty.view)), prefix(topQty.view));
    check('THE BUG: a different sort picks a different top 2',
      topQty.ticked.join(',') !== perSlotPick, topQty.ticked.join(',') + ' vs ' + perSlotPick);
    eq('...and they are the first two tickable rows the # column numbered',
      topQty.view.filter(v => v.ticked).map(v => v.pos).join(','),
      topQty.view.filter(v => v.sel).slice(0, 2).map(v => v.pos).join(','));
    /* A row it passes over says why on its own face — a ⚡ where the checkbox would be, or
       an unsellable flag — so a top-2 that lands on # 1 and # 3 is readable, not silent. */
    const skipped = topQty.view.filter(v => !v.sel);
    check('a row it passes over is visibly untickable',
      skipped.length === 0 || (await s3.page.evaluate(names => names.every(n => {
        const tr = [...document.querySelectorAll('#tblBody tr.a')]
          .find(x => x.querySelector('.nm').textContent === n);
        const r = state.rows.find(y => y.name === n);
        return !tr.querySelector('td.tick').querySelector('input') || (r && r.unsellable && r.flags.length > 0);
      }), skipped.map(v => v.name))), JSON.stringify(skipped.map(v => v.name)));
    check('...and the button says so rather than promising 1..N',
      /passes over/.test(await s3.page.$eval('#btnTop', el => el.title)),
      await s3.page.$eval('#btnTop', el => el.title));

    section('S2 — "top N" can never leave more than N rows in the import list');
    /* Old behaviour: the button cleared ticks only among the rows the filter showed, so a
       second click under a disjoint filter ADDED to the list. Two clicks of "top 2" left
       four rows in it, and the ⚠ that said so disappeared the moment the filter cleared —
       exactly when the list was at its most wrong. */
    await s3.page.selectOption('#sortBy', 'perSlot');
    await s3.page.waitForFunction(() => state.sortKey === 'perSlot' && state.sortDir === -1);
    const s2a = await tickTop(s3.page, 2);
    eq('unfiltered, "top 2" is 2', s2a.ticked.length, 2);

    /* 'trinket' is disjoint from that first pick on this fixture, which is the case the old
       code got wrong: it cleared ticks only among the rows the filter showed, so the two
       already-ticked rows survived off screen and "top 2" left THREE in the list. */
    await s3.page.fill('#fltText', 'trinket');
    await s3.page.dispatchEvent('#fltText', 'input');
    await s3.page.waitForFunction(() => state.filterText === 'trinket');
    const s2b = await tickTop(s3.page, 2);
    check('a second "top 2" under a disjoint filter leaves at most 2 — not 3',
      s2b.ticked.length <= 2 && s2b.ticked.length >= 1, JSON.stringify(s2b.ticked));
    check('...and none of the first pick survived off screen',
      s2a.ticked.every(n => !s2b.ticked.includes(n)),
      JSON.stringify(s2a.ticked) + ' then ' + JSON.stringify(s2b.ticked));
    eq('...and the import echo agrees with the checkboxes',
      s2b.echo.split(' ')[0], String(s2b.ticked.length));
    eq('...every ticked row is on screen, so the count is checkable by eye', s2b.hiddenTicked, 0);
    check('...and nothing warns about hidden ticks, because there are none',
      !/⚠/.test(s2b.echo), s2b.echo);
    check('the rows it ticked are the ones the filter shows',
      s2b.ticked.every(n => /trinket/i.test(n)), JSON.stringify(s2b.ticked));

    await s3.page.fill('#fltText', '');
    await s3.page.dispatchEvent('#fltText', 'input');
    await s3.page.waitForFunction(() => state.filterText === '');
    const afterClear = await s3.page.evaluate(() => ({
      ticked: state.rows.filter(r => r.inImport).map(r => r.name).sort(),
      echo: document.getElementById('impEcho').textContent,
    }));
    eq('clearing the filter reveals no extra ticks — the list was always the whole list',
      afterClear.ticked.join(','), s2b.ticked.join(','));
    check('...and the echo never moved', /^\d+ items/.test(afterClear.echo)
      && afterClear.echo.split(' ')[0] === String(s2b.ticked.length), afterClear.echo);

    section('the three bulk buttons agree about what a filter is');
    /* One rule for all three: a bulk button SETS the import list, it never adds to it.
       So after any of them, nothing ticked is off screen. Only the checkbox is additive. */
    for (const [label, btn] of [['Tick top N', '#btnTop'], ['All', '#btnAll'], ['None', '#btnNone']]) {
      await s3.page.click('#btnAll');                       // start from a full list
      /* hand-tick an INSTANT row first. btnAll already zeroes latent INSTANT ticks, so
         without this the assertion below would be checking a value its own setup had
         just guaranteed — it passed even with the clearing removed from setSelection. */
      await s3.page.evaluate(() => {
        const r = state.rows.find(x => x.strategy === 'imm');
        if (r){ r.checked = true; render(); persist(); }
      });
      const latentBefore = await s3.page.evaluate(() =>
        state.rows.filter(r => r.checked && r.strategy === 'imm').length);
      eq(label + ' starts from a latent INSTANT tick that is really there', latentBefore, 1);
      await s3.page.fill('#fltText', 'widget');
      await s3.page.dispatchEvent('#fltText', 'input');
      await s3.page.waitForFunction(() => state.filterText === 'widget');
      await s3.page.click(btn);
      const st = await s3.page.evaluate(() => ({
        hidden: state.rows.filter(r => r.inImport && !rowFilter(r)).length,
        shownTicked: state.rows.filter(r => r.inImport && rowFilter(r)).length,
        latentOnInstant: state.rows.filter(r => r.checked && r.strategy === 'imm').length,
      }));
      eq(label + ' leaves nothing ticked off screen', st.hidden, 0);
      eq('...and clears the latent ticks on INSTANT rows too', st.latentOnInstant, 0);
      if (btn === '#btnNone') eq('...None empties it outright', st.shownTicked, 0);
      else check('...' + label + ' leaves a list you can see', st.shownTicked > 0, String(st.shownTicked));
      await s3.page.fill('#fltText', '');
      await s3.page.dispatchEvent('#fltText', 'input');
      await s3.page.waitForFunction(() => state.filterText === '');
    }
    check('every bulk button states its scope on its tooltip',
      (await s3.page.evaluate(() => ['btnTop', 'btnAll', 'btnNone']
        .map(i => document.getElementById(i).title)))
        .every(t => /import list|filters/.test(t) && t.split('\n').length >= 2),
      JSON.stringify(await s3.page.evaluate(() => ['btnTop', 'btnAll', 'btnNone']
        .map(i => document.getElementById(i).title))));

    /* ---------- a filling button with nothing to fill from ----------------------------
       Setting the list from an empty candidate set is a delete, and it happens entirely
       off screen: the table is showing one INSTANT row or none at all, so nothing visible
       changes, and the "N ticked hidden" warning disappears as if it had been resolved.
       "show = INSTANT only" is two controls away from the buttons. */
    section('a bulk fill with nothing tickable leaves the list alone');
    for (const [label, btn, how] of [
      ['Tick top N', '#btnTop', 'fltType'], ['All', '#btnAll', 'fltType'],
      ['Tick top N', '#btnTop', 'fltText'], ['All', '#btnAll', 'fltText'],
    ]) {
      await s3.page.selectOption('#fltType', 'all');
      await s3.page.fill('#fltText', '');
      await s3.page.dispatchEvent('#fltText', 'input');
      await s3.page.waitForFunction(() => state.filterText === '' && state.filterType === 'all');
      await s3.page.click('#btnAll');
      const before = await s3.page.evaluate(() => state.rows.filter(r => r.inImport).map(r => r.key));
      check(`${label} via ${how}: the list starts non-empty`, before.length > 0, String(before.length));
      if (how === 'fltType') {
        await s3.page.selectOption('#fltType', 'imm');       // every visible row is INSTANT
        await s3.page.waitForFunction(() => state.filterType === 'imm');
      } else {
        await s3.page.fill('#fltText', 'zzzznothing');       // the table says "no rows match"
        await s3.page.dispatchEvent('#fltText', 'input');
        await s3.page.waitForFunction(() => state.filterText === 'zzzznothing');
      }
      const nothingTickable = await s3.page.evaluate(() => state.rows.filter(selectable).length);
      eq(`...and the filter really leaves nothing tickable`, nothingTickable, 0);
      await s3.page.click(btn);
      const after = await s3.page.evaluate(() => ({
        keys: state.rows.filter(r => r.inImport).map(r => r.key),
        note: document.getElementById('bulkNote').textContent,
        stored: (JSON.parse(localStorage.getItem('eveSellHelper.v2') || '{}').ticked || []).length,
      }));
      eq(`...${label} does not delete the import list`, after.keys.join(','), before.join(','));
      eq(`...nor the copy of it in storage`, after.stored, before.length);
      check(`...and says why, where the button is`, /nothing tickable/.test(after.note), after.note);
      check(`...which the tooltip warned about`,
        /none tickable/.test(await s3.page.getAttribute(btn, 'title')),
        await s3.page.getAttribute(btn, 'title'));
    }
    // None is the way to empty the list on purpose, and it still is
    await s3.page.fill('#fltText', '');
    await s3.page.dispatchEvent('#fltText', 'input');
    await s3.page.waitForFunction(() => state.filterText === '');
    await s3.page.selectOption('#fltType', 'imm');
    await s3.page.click('#btnNone');
    eq('None still empties it, filters or no filters',
      await s3.page.evaluate(() => state.rows.filter(r => r.inImport).length), 0);
    check('...and clears the stand-down note it may be sitting under',
      (await s3.page.textContent('#bulkNote')) === '', await s3.page.textContent('#bulkNote'));
    await s3.page.selectOption('#fltType', 'all');
    await s3.page.waitForFunction(() => state.filterType === 'all' && state.filterText === '');

    /* ---------- ticks do not come back from the dead --------------------------------
       restore() seeds state.savedTicked and rebuild() falls back to it for any row that
       was not in state.rows when the rebuild started. Nothing but a page load used to
       narrow that set, so a tick removed with None reappeared the next time its row went
       absent and came back — and select-all, delete, paste is the ordinary way to replace
       an inventory. */
    section('a removed tick stays removed across a re-paste');
    await s3.page.click('#btnAll');
    const paste = await s3.page.inputValue('#inv');
    /* the reload is the point: restore() seeds state.savedTicked from storage, and until
       this fix nothing else ever narrowed it again for the life of the page */
    await s3.page.reload();
    await s3.page.waitForFunction("typeof rebuild === 'function'");
    await s3.page.waitForFunction(() => state.savedTicked.size > 0);
    eq('a reload seeds the saved set from storage',
      await s3.page.evaluate(() => state.savedTicked.size), 5);
    await fetchInventory(s3.page, paste);
    eq('...and the list comes back with it',
      await s3.page.evaluate(() => state.rows.filter(r => r.inImport).length), 5);
    await s3.page.click('#btnNone');
    eq('None empties the list', await s3.page.evaluate(() => state.rows.filter(r => r.inImport).length), 0);
    eq('...and the saved set with it',
      await s3.page.evaluate(() => state.savedTicked.size), 0);
    await s3.page.fill('#inv', '');
    await s3.page.dispatchEvent('#inv', 'input');
    await s3.page.waitForFunction(() => state.rows.length === 0);
    eq('...emptying the box does not repopulate the saved set',
      await s3.page.evaluate(() => state.savedTicked.size), 0);
    await fetchInventory(s3.page, paste);
    eq('pasting the same inventory back does not resurrect them',
      await s3.page.evaluate(() => state.rows.filter(r => r.inImport).length), 0);
    // ...while a clear-and-paste that was never asked to give up its picks still keeps them
    await s3.page.click('#btnAll');
    const kept = await s3.page.evaluate(() => state.rows.filter(r => r.inImport).length);
    await s3.page.fill('#inv', '');
    await s3.page.dispatchEvent('#inv', 'input');
    await s3.page.waitForFunction(() => state.rows.length === 0);
    await fetchInventory(s3.page, paste);
    eq('...but a plain clear-and-paste still restores the picks it never gave up',
      await s3.page.evaluate(() => state.rows.filter(r => r.inImport).length), kept);

    section('the exports come out in the order on screen');
    await s3.page.click('#btnAll');
    await s3.page.click('#tbl thead th[data-key="name"]');
    await s3.page.waitForFunction(() => state.sortKey === 'name');
    const ordered = await s3.page.evaluate(() => ({
      view: [...document.querySelectorAll('#tblBody tr.a')]
        .filter(tr => tr.querySelector('td.tick').querySelector('input:checked'))
        .map(tr => tr.querySelector('.nm').textContent),
      preview: document.getElementById('preview').value.split('\n').filter(Boolean).map(l => l.split('\t')[0]),
      tsv: fullTsv().split('\n').slice(1).map(l => l.split('\t')[0]),
      allView: [...document.querySelectorAll('#tblBody tr.a')]
        .map(tr => tr.querySelector('.nm').textContent),
    }));
    eq('the import list pastes in the order the table shows',
      ordered.preview.join(','), ordered.view.join(','));
    eq('...and so does the TSV', ordered.tsv.slice(0, ordered.allView.length).join(','),
      ordered.allView.join(','));

    section('the Import column sorts on membership, not on the latent tick');
    /* A tick survives a re-plan, so an INSTANT row can carry one while showing a ⚡ and
       sitting outside the import list. It must not sort as though it were in the list. */
    const impSort = await s3.page.evaluate(() => {
      for (const r of state.rows) r.checked = r.strategy === 'imm';
      state.sortKey = 'checked'; state.sortDir = -1;
      render();
      const first = document.querySelector('#tblBody tr');
      return { top: first.querySelector('.nm').textContent,
               topIsInstant: first.querySelector('td.tick').textContent.trim() === '⚡',
               echo: document.getElementById('impEcho').textContent };
    });
    check('a latent tick on an INSTANT row does not sort to the top of Import',
      !impSort.topIsInstant, JSON.stringify(impSort));
    eq('...and it is not in the import list either', impSort.echo, 'nothing ticked');
    await s3.page.click('#btnNone');
    await s3.close();

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

    /* ---------- vol/day counts calendar days, not the days ESI bothered to return ------
       A day with no trades is simply absent from the history. Averaging over the rows
       present answers "how much moves on a day when something moves", which on a thin
       item is a busy day's volume wearing the label of a daily rate — and that is what
       let a queue hundreds of units deep look as though it would clear in a fortnight. */
    section('vol/day over calendar days');
    const vol = await p4.evaluate(() => {
      const day = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      // 450 units across 30 trading days inside a 365-day window
      const sparse = [];
      for (let t = 364; t >= 0; t--) if (t % 12 === 0) sparse.push({ date: day(t), volume: 15 });
      // the same 450 units, but traded every day of a 30-day window
      const dense = [];
      for (let t = 29; t >= 0; t--) dense.push({ date: day(t), volume: 15 });
      return {
        sparse: histVolOf(sparse, 365),
        sparseRows: sparse.length,
        sparseOldRowsAvg: sparse.reduce((s2, h) => s2 + h.volume, 0) / sparse.length,
        dense: histVolOf(dense, 30),
        none: histVolOf([], 365),
        // a history shorter than the window is spanned by what it covers, not by the window
        young: histVolOf([{ date: day(6), volume: 70 }, { date: day(0), volume: 70 }], 365),
      };
    });
    eq('the thin item traded on 31 days of the year', vol.sparseRows, 31);
    eq('...which the old rows-present average called 15 a day', vol.sparseOldRowsAvg, 15);
    check('...where the calendar says it moves well under two a day',
      vol.sparse > 1.2 && vol.sparse < 1.4, String(vol.sparse));
    check('...an order of magnitude below what the queue was being divided by',
      vol.sparseOldRowsAvg / vol.sparse > 10, String(vol.sparseOldRowsAvg / vol.sparse));
    near('an item that trades every day is unaffected — the two denominators agree',
      vol.dense, 15, 1e-9);
    near('a week-old history is spanned by its own week, not by the window asked for',
      vol.young, 20, 1e-9);
    eq('no history, no rate', vol.none, null);

    /* ---------- the incomplete gamma the arrival model rests on ---------------------- */
    section('gammaP against closed forms');
    const gp = await p4.evaluate(() => ({
      a1x1: gammaP(1, 1), a1x5: gammaP(1, 5), a2x3: gammaP(2, 3), a3x2: gammaP(3, 2),
      half: gammaP(0.5, 2), zero: gammaP(5, 0), inf: gammaP(5, 1e4),
      big100: gammaP(100, 100), big1000: gammaP(1000, 1000),
      mono: (() => { let ok = true, prev = -1;
        for (let i = 0; i <= 200; i++){ const v = gammaP(3, i * 0.1); if (v < prev - 1e-15) ok = false; prev = v; }
        return ok; })(),
    }));
    // shape 1 is the exponential; shape 2 and 3 are its first two Erlang cousins
    near('P(1,1) is 1 - e^-1', gp.a1x1, 1 - Math.exp(-1), 1e-12);
    near('P(1,5) is 1 - e^-5', gp.a1x5, 1 - Math.exp(-5), 1e-12);
    near('P(2,3) is the Erlang sum', gp.a2x3, 1 - Math.exp(-3) * (1 + 3), 1e-12);
    near('P(3,2) likewise', gp.a3x2, 1 - Math.exp(-2) * (1 + 2 + 2), 1e-12);
    near('P(1/2,2) is erf(sqrt 2)', gp.half, 0.954499736103642, 1e-12);
    eq('nothing has arrived at time zero', gp.zero, 0);
    near('...and everything has by the end of time', gp.inf, 1, 1e-12);
    /* the mean of Gamma(a,1) sits above its median, so P(a,a) approaches a half from
       ABOVE, by 1/(3 sqrt(2 pi a)) — the check that the tail branch is right, since these
       shapes take the continued fraction rather than the series */
    near('P(100,100) is a half plus 1/(3 sqrt(2 pi a))',
      gp.big100, 0.5 + 1 / (3 * Math.sqrt(2 * Math.PI * 100)), 2e-5);
    near('...and P(1000,1000) is a half plus a third of that',
      gp.big1000, 0.5 + 1 / (3 * Math.sqrt(2 * Math.PI * 1000)), 2e-6);
    check('P is monotone in x', gp.mono, 'not monotone');

    /* ---------- the reconstructed daily price density -------------------------------- */
    section('reach: the share of units clearing at a price');
    const rch = await p4.evaluate(() => {
      const d = (l, a2, h2, x) => dayReach(l, a2, h2, x);
      let mean = 0; const step = 1e-3;
      for (let x = 100; x < 200; x += step) mean += d(100, 110, 200, x) * step;
      let mono = true, prev = 2;
      for (let i = 0; i <= 400; i++){ const v = d(100, 110, 200, 90 + i * 0.3); if (v > prev + 1e-12) mono = false; prev = v; }
      return {
        atLow: d(100, 110, 200, 100), atHigh: d(100, 110, 200, 200),
        aboveHigh: d(100, 110, 200, 200.01), belowLow: d(100, 110, 200, 50),
        leftOfMean: d(100, 110, 200, 110 - 1e-9), rightOfMean: d(100, 110, 200, 110 + 1e-9),
        meanPlusLow: 100 + mean, mono,
        noBandUnder: d(0, 110, 0, 109.9), noBandOver: d(0, 110, 0, 110.1),
        flatDay: d(110, 110, 110, 109.9),
        // the ship skin: a 200,000 outlier high on a market whose average is 12,500
        spikeAtAsk: d(9800, 12500, 200000, 177600),
        normalAtAsk: d(9800, 10300, 11000, 177600),
        spikeAtMarket: d(9800, 12500, 200000, 10010),
        normalAtMarket: d(9800, 10300, 11000, 10010),
      };
    });
    near('every unit cleared at or above the day low', rch.atLow, 1, 1e-12);
    eq('nothing cleared above the day high', rch.atHigh, 0);
    eq('...nor above that', rch.aboveHigh, 0);
    near('...and everything at or above a price under the low', rch.belowLow, 1, 1e-12);
    near('the density is continuous where the two segments meet',
      rch.leftOfMean, rch.rightOfMean, 1e-8);
    check('...and monotone across the whole band', rch.mono, 'not monotone');
    /* the reconstruction is pinned to all three published points: it must not merely be
       shaped like the day, it must have the day's own average as its mean */
    near('the reconstructed density has the published average as its mean',
      rch.meanPlusLow, 110, 2e-3);
    eq('a day with no high/low is a point mass at its average', rch.noBandUnder, 1);
    eq('...with nothing above it', rch.noBandOver, 0);
    eq('...and a day that traded at one price behaves the same', rch.flatDay, 1);

    /* THE REGRESSION THIS MODEL EXISTS FOR. Twelve outlier prints in a year put the daily
       HIGH above 177,600, so the old window-hit metric called that price a 62% chance. In
       units, those prints are a sliver of one day's trade. */
    check('an outlier high carries a sliver of its day, not the whole day',
      rch.spikeAtAsk > 0 && rch.spikeAtAsk < 0.002, String(rch.spikeAtAsk));
    eq('...and a day whose high never got there carries nothing', rch.normalAtAsk, 0);
    check('...while at the price the market actually trades at, most units qualify',
      rch.spikeAtMarket > 0.9 && rch.normalAtMarket > 0.7,
      rch.spikeAtMarket + ' / ' + rch.normalAtMarket);
    check('...a ratio of more than five hundred to one between the two prices',
      rch.spikeAtMarket / rch.spikeAtAsk > 500, String(rch.spikeAtMarket / rch.spikeAtAsk));

    /* ---------- recency decay, measured off the item ---------- */
    /* It used to be a flat 45 days for everything: six weeks of memory whether the item
       trades a thousand times a day or twice a month. The half-life is now the answer to
       "how far back do I have to go to find as many trading days as the patience window
       is long" — so a daily trader remembers the window, and a thin one remembers as far
       as it has to in order to have seen anything at all. */
    section('the recency half-life is the item\'s own tempo, not a house number');
    const HL = await p4.evaluate(() => {
      const day = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      // every day for a year
      const daily = [];
      for (let t = 364; t >= 0; t--) daily.push({ date: day(t), volume: 100 });
      // one day in six
      const thin = [];
      for (let t = 364; t >= 0; t--) thin.push({ date: day(t), volume: t % 6 === 0 ? 100 : 0 });
      // traded four times, ever
      const rare = [];
      for (let t = 364; t >= 0; t--) rare.push({ date: day(t), volume: t % 90 === 0 ? 100 : 0 });
      return {
        daily7: reachHalfLife(daily, 7), daily30: reachHalfLife(daily, 30),
        daily90: reachHalfLife(daily, 90),
        thin30: reachHalfLife(thin, 30),
        rare30: reachHalfLife(rare, 30),
        oldest: (Date.now() - Date.parse(day(364))) / 86400e3,
        empty: reachHalfLife([], 30),
      };
    });
    near('an item that trades every day remembers exactly the window: 7d', HL.daily7, 7, 1);
    near('...30d', HL.daily30, 30, 1);
    near('...90d', HL.daily90, 90, 1);
    check('...so the half-life follows the window, rather than sitting at a fixed 45',
      HL.daily7 < HL.daily30 && HL.daily30 < HL.daily90,
      [HL.daily7, HL.daily30, HL.daily90].join(' / '));
    near('one trading day in six costs six times the memory', HL.thin30, 180, 6);
    check('...which is far past the 45 days the old rule allowed anything',
      HL.thin30 > 45 * 2, String(HL.thin30));
    check('an item that has traded four times in a year counts its whole history',
      Math.abs(HL.rare30 - HL.oldest) < 2, HL.rare30 + ' vs ' + HL.oldest);
    check('...and never longer than the history it has', HL.rare30 <= HL.oldest + 1e-9,
      HL.rare30 + ' vs ' + HL.oldest);
    eq('no history at all falls back to the window itself', HL.empty, 30);

    /* The point of all this: a thin item's older prints must actually survive into the
       estimate. Same history, same price, two patience windows — the reach the model
       computes has to move, because the memory it is built on moved. */
    const HLR = await p4.evaluate(() => {
      const day = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      // traded one day in ten; the OLD prints are the expensive ones
      const hist = [];
      for (let t = 364; t >= 0; t--){
        if (t % 10) continue;
        const px = t > 180 ? 2000 : 1000;
        hist.push({ date: day(t), average: px, highest: px, lowest: px, volume: 100, order_count: 5 });
      }
      const e = { typeId: 1, hist };
      const r7 = reachOf(e, 1500, 7), r90 = reachOf(e, 1500, 90);
      return { hl7: r7.halfLife, hl90: r90.halfLife, R7: r7.Rraw, R90: r90.Rraw };
    });
    check('a longer window buys a longer memory on a thin item', HLR.hl90 > HLR.hl7,
      HLR.hl7 + ' -> ' + HLR.hl90);
    check('...and the old, expensive prints then carry more of the estimate',
      HLR.R90 > HLR.R7 + 0.05, HLR.R7 + ' -> ' + HLR.R90);

    /* ---------- the whole outlook, on the order that started this -------------------
       A ship skin listed at 177,600 with 178 units of other people's stock ahead of it,
       on a market that trades ~15 units on the 30 days a year it trades at all and whose
       average price is 12,500. The old metric said 62%. */
    section('the fill outlook on a hopeless order');
    const OUT = await p4.evaluate(() => {
      const day = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      const hist = [];
      for (let t = 364; t >= 0; t--){
        if (t % 12) continue;
        const spike = (t / 12) % 3 === 0;          // a third of trading days print an outlier
        hist.push({ date: day(t), average: spike ? 12500 : 10300,
                    highest: spike ? 200000 : 11000, lowest: 9800, volume: 15, orders: 3 });
      }
      const e = { hist };
      const comp = [{ p: 10010, v: 178 }];
      return {
        withQueue: fillOutlook(e, comp, 177600, 5, 14, { histDays: 365 }),
        noQueue:   fillOutlook(e, [],   177600, 5, 14, { histDays: 365 }),
        atMarket:  fillOutlook(e, [],   10010,  5, 14, { histDays: 365 }),
        aboveCeiling: fillOutlook(e, [], 948900, 5, 14, { histDays: 365 }),
        volDay: histVolOf(hist, 365),
      };
    });
    check('the market moves a unit or two a day, not fifteen',
      OUT.volDay > 0.8 && OUT.volDay < 2, String(OUT.volDay));
    eq('the queue alone condemns it — 178 units cannot clear in a fortnight',
      OUT.withQueue.fillFrac, 0);
    eq('...and the tool says which of the two reasons it was', OUT.withQueue.capped, 'queue');
    /* the brief asked for TWO independent reasons. Delete the queue entirely and the
       price alone still cannot clear the patience floor. */
    check('delete the queue and the price alone still fails the floor',
      OUT.noQueue.fillFrac < 0.35, String(OUT.noQueue.fillFrac));
    check('...even though this is an UPPER bound, not an estimate',
      OUT.noQueue.bound === 'upper', OUT.noQueue.bound);
    check('...while at the price the market actually pays, the same stack clears',
      OUT.atMarket.fillFrac > 0.9, String(OUT.atMarket.fillFrac));
    check('...which is the case the old metric got backwards, in the other direction',
      OUT.atMarket.fillFrac > OUT.noQueue.fillFrac * 3,
      OUT.atMarket.fillFrac + ' vs ' + OUT.noQueue.fillFrac);
    /* a price above everything the market has ever paid is not a small percentage, it is
       a checkable statement about the history */
    eq('a price above the ceiling is exactly zero, not nearly zero',
      OUT.aboveCeiling.fillFrac, 0);
    eq('...and says so', OUT.aboveCeiling.capped, 'ceiling');
    eq('...with no finite estimate of when', OUT.aboveCeiling.expDays, Infinity);

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
                       'Nohigh Widget\t20', 'Blind Widget\t20', 'Patience Widget\t20'].join('\n');
    // the user's own settings: a LEVEL statistic over a long window, which is exactly
    // what used to fire the ⏳ tag forever
    await fetchWithHistory(p4, DEC_PASTE, 'median', 120);

    // the fee model itself is fees.test.js's job; here it only has to be the SAME number
    // on both sides of the hand arithmetic below
    const fees = await p4.evaluate(() => ({ tax: feePct('salesTax'), broker: feePct('brokerFee') }));
    const TAX = fees.tax, BROKER = fees.broker;
    near('the page fees are Accounting 5 / Broker Relations 5, at full precision',
      TAX, 7.5 * (1 - 0.11 * 5) / 100, 1e-12);
    near('...and the broker fee likewise', BROKER, 0.015, 1e-12);
    /* the box is the display AND the override surface, so it holds two decimals; the
       arithmetic must not be run through that rounding. 3.375 shows as 3.37 and is still
       used as 3.375 — worth 0.15% of every net figure on the page. */
    eq('...while the box still shows the rounded rate',
      await p4.inputValue('#salesTax'), '3.37');
    check('...so the displayed rate is NOT the one the math used',
      Number(await p4.inputValue('#salesTax')) / 100 !== TAX,
      await p4.inputValue('#salesTax') + ' vs ' + TAX);
    // ...and typing a genuinely different number still wins over the computed rate
    const typedFee = await p4.evaluate(async () => {
      const box = document.getElementById('salesTax'), was = box.value;
      box.value = '5.00'; const got = feePct('salesTax');
      box.value = was; feePct('salesTax');
      return got;
    });
    near('...but an override the user typed is used as typed', typedFee, 0.05, 1e-12);

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

    /* REWRITTEN — the value is no longer priced off that window share.

       The two-branch expectation is unchanged in shape and its fee handling is unchanged,
       but the p in it is now the share of the stack the arrival model expects to SELL,
       not the share of past windows whose daily high touched the price. On this fixture
       the two disagree flatly: the window metric says 70%, because a 1.2M high prints
       only every twentieth day; the market it is asking about trades AT 1,000,000 every
       single day, 100 units of it, against a queue of 40 and a stack of 20. Every unit
       sells, and the old metric called that a coin flip with a 30% tail.

       So p is asserted at 1 from the market's own arithmetic, and the value identity is
       then checked against the p the page actually used. */
    const qty = 20, LP = 1000000, LC = 950000;
    const netInstant = 20 * 900000 * (1 - TAX);
    const brokerAt = v => Math.max(100, BROKER * v);
    near('the market moves a hundred units a day at the patient price', steady.comp.p, 1, 1e-9);
    near('...so all twenty of them are expected to sell', steady.patOpt.expUnits, qty, 1e-6);
    check('...which the window metric put at seven in ten',
      pSteady.p > 0.6 && pSteady.p < 0.8 && steady.patOpt.p - pSteady.p > 0.2,
      pSteady.p + ' vs ' + steady.patOpt.p);
    const expPatSteady = -brokerAt(qty * LP) + steady.patOpt.p * qty * LP * (1 - TAX)
      + (1 - steady.patOpt.p) * netInstant;
    const expCompSteady = -brokerAt(qty * LC) + steady.comp.p * qty * LC * (1 - TAX)
      + (1 - steady.comp.p) * netInstant;
    near('the instant leg is the plain buy-book walk', steady.netInstant, netInstant, 1e-6);
    near('the patient listing is worth p x (it sells) + (1-p) x (dump it later), fee charged in both',
      steady.patOpt.net, expPatSteady, 1e-6);
    near('...and the competitive listing likewise', steady.comp.net, expCompSteady, 1e-6);
    check('the broker fee is charged even in the branch where nothing sells',
      steady.patOpt.net < steady.patOpt.p * qty * LP * (1 - TAX)
        + (1 - steady.patOpt.p) * netInstant, steady.patOpt.net);
    eq('a flat market with no slide needs no relists', steady.patOpt.relists, 0);
    eq('the flat item is told to list patiently', steady.strategy, 'pat');
    eq('...at the patient price', steady.exportPrice, LP);

    section('ISK per slot-day is the ranking objective');
    /* REWRITTEN: the days term used to blend the queue-over-volume divide with the whole
       window. It now blends the MODEL's own clearing time — the queue walked level by
       level at each level's demand rate, plus the wait for your own units — which is the
       number the same model already produced to price the fill. 40 units queued at
       950,000 drain at the full 100 a day, then 20 of your own at ~95 a day: 0.4 + 0.21. */
    const expDays = steady.patOpt.p * 0.61 + (1 - steady.patOpt.p) * 14;
    near('expected days = p x (the model\u2019s own clearing time) + (1-p) x the whole window',
      steady.patOpt.days, expDays, 0.01);
    check('...which is well under the one slot-day a listing is charged at minimum',
      steady.patOpt.days < 1, String(steady.patOpt.days));
    near('ISK/slot-day is the expectation over those days, floored at one',
      steady.perSlot, expPatSteady / Math.max(steady.patOpt.days, 1), 1e-6);
    check('the patient listing beats the competitive one per slot-day',
      steady.patOpt.net / expDays > steady.comp.net / expDays, steady.perSlot);
    const sorted = await p4.evaluate(() => ({
      key: state.sortKey, dir: state.sortDir,
      order: [...document.querySelectorAll('#tblBody tr.a')].map(tr => tr.querySelector('.nm').textContent),
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
    /* ---------- pick the odds, get the price ---------------------------------------
       The inverse of everything else here. It only works because the fill fraction never
       rises with price, so these check that property directly rather than trusting it. */
    section('solving a price for a target chance');
    const solve = await p4.evaluate(() => {
      const e = state.esi.get('steady trinket');
      const r = state.rows.find(x => x.name === 'Steady Trinket');
      const opts = { histDays: currentHistDays(), volDay: r.volDay, tracker: null,
                     floor: r.bestBuy };
      const at = px => { const o = listingOutlook(e, e.sellLevels, px, r.qty, (PATIENCE[state.patience] || PATIENCE.balanced).days, opts);
                         return o ? o.frac : null; };
      const ceiling = reachOf(e, 1e-9).ceiling;
      // the curve itself: sampled across the whole bracket
      const xs = [], fs = [];
      for (let i = 0; i <= 40; i++){
        const px = r.bestBuy + (ceiling - r.bestBuy) * i / 40;
        xs.push(px); fs.push(at(px));
      }
      const solved = {};
      for (const t of [0.3, 0.5, 0.7, 0.9]) solved[t] = priceForOdds(e, e.sellLevels, r.qty, (PATIENCE[state.patience] || PATIENCE.balanced).days, t, opts);
      return {
        ceiling, floor: r.bestBuy,
        monotone: fs.every((f, i) => i === 0 || f == null || fs[i-1] == null || f <= fs[i-1] + 1e-12),
        solved,
        got: Object.fromEntries(Object.entries(solved).map(([t, px]) => [t, px == null ? null : at(px)])),
        aboveCeiling: at(ceiling * 1.5),
        // no history is the real can't-solve case: there is no ceiling to search up to
        noHistory: priceForOdds({ hist: [], typeId: 1 }, e.sellLevels, r.qty, 30, 0.6, opts),
        // ...and so is a bracket whose floor already misses the target
        floorMisses: priceForOdds(e, e.sellLevels, r.qty, 30, 0.6,
          Object.assign({}, opts, { floor: reachOf(e, 1e-9).ceiling * 10 })),
      };
    });
    check('the fill fraction never rises with price — what makes a bisection valid',
      solve.monotone, 'not monotone');
    check('a price above everything the market has paid fills nothing',
      solve.aboveCeiling === 0, String(solve.aboveCeiling));
    for (const t of ['0.3', '0.5', '0.7', '0.9']){
      check(`a price exists for ${Math.round(Number(t) * 100)}%`, solve.solved[t] > 0,
        String(solve.solved[t]));
      check(`...and it actually delivers at least the odds asked for`,
        solve.got[t] >= Number(t) - 1e-9, `${solve.got[t]} for ${t}`);
    }
    check('asking for better odds never costs more — the price falls as the target rises',
      solve.solved['0.3'] >= solve.solved['0.5']
      && solve.solved['0.5'] >= solve.solved['0.7']
      && solve.solved['0.7'] >= solve.solved['0.9'],
      JSON.stringify(solve.solved));
    check('the solved price sits inside the bracket it was searched in',
      Object.values(solve.solved).every(px => px >= solve.floor * 0.999 && px <= solve.ceiling),
      JSON.stringify(solve.solved) + ' in ' + solve.floor + '..' + solve.ceiling);
    /* a target nothing can reach is a fact about the item, not a failure — the tool must
       not invent a price for it, and the row falls back with a chip saying so */
    eq('an item with no history has no ceiling to search, so no price is invented',
      solve.noHistory, null);
    eq('...nor when even the cheapest price in the bracket misses the target',
      solve.floorMisses, null);

    section('the odds source prices every row, and a row can be pinned off it');
    await p4.check('#srcOdds');
    await p4.fill('#oddsTarget', '60');
    await p4.dispatchEvent('#oddsTarget', 'change');
    await p4.waitForFunction(() => state.rows.some(r => r.oddsTarget != null));
    const odds = await p4.evaluate(() => {
      const listed = state.rows.filter(r => r.strategy !== 'imm');
      return {
        allTargeted: listed.every(r => Math.abs(r.oddsTarget - 0.6) < 1e-9),
        nonePinned: listed.every(r => !r.oddsPinned),
        cellIsInput: !!document.querySelector('#tblBody input.oddsin'),
        cellValue: (document.querySelector('#tblBody input.oddsin') || {}).value,
      };
    });
    check('every listed row is priced for the global target', odds.allTargeted);
    check('...none of them pinned to a target of its own', odds.nonePinned);
    check('the Fill cell becomes the input, because the chance is now what you set',
      odds.cellIsInput);
    eq('...showing the global target', odds.cellValue, '60');

    // one row nudged off the global target, and nothing else moving with it
    const beforePin = await p4.evaluate(() =>
      state.rows.filter(r => r.strategy !== 'imm').map(r => [r.name, r.exportPrice]));
    // the row the FIRST input belongs to, addressed by a locator so it survives the
    // re-render that typing into it causes
    const pinName = await p4.evaluate(() => {
      const tr = document.querySelector('#tblBody tr.a input.oddsin').closest('tr');
      return tr.querySelector('.nm').textContent;
    });
    /* Set and fire in one go: the row re-renders on change, which replaces the input, so a
       multi-step fill loses its own element halfway through. */
    await p4.evaluate(n => {
      const tr = [...document.querySelectorAll('#tblBody tr.a')]
        .find(x => x.querySelector('.nm').textContent === n);
      const inp = tr.querySelector('input.oddsin');
      inp.value = '85';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, pinName);
    await p4.waitForFunction(() => state.oddsRow.size === 1);
    const pinned = await p4.evaluate(prev => {
      const now = state.rows.filter(r => r.strategy !== 'imm');
      const was = new Map(prev);
      const p = now.find(r => r.oddsPinned);
      /* A re-plan re-solves every row against a clock that has moved on, because the trend
         carry is measured from now(), so an unpinned row can shift by a tick. What must
         not happen is an unpinned row moving MATERIALLY. */
      const others = now.filter(r => !r.oddsPinned)
        .map(r => Math.abs(r.exportPrice - was.get(r.name)) / was.get(r.name));
      return { pinnedName: p && p.name, pinnedTarget: p && p.oddsTarget,
        drop: p ? (was.get(p.name) - p.exportPrice) / was.get(p.name) : null,
        othersMax: others.length ? Math.max(...others) : 0,
        pinnedCount: state.oddsRow.size,
        markedCount: document.querySelectorAll('#tblBody input.oddsin.pinned').length };
    }, beforePin);
    eq('exactly one row is pinned', pinned.pinnedCount, 1);
    eq('...and exactly one is marked as such', pinned.markedCount, 1);
    eq('...it is the row whose input was typed into', pinned.pinnedName, pinName);
    near('...carrying the target that was typed', pinned.pinnedTarget, 0.85, 1e-9);
    /* Asking for better odds can never ask MORE. It does not always ask less: on a market
       liquid enough to fill at any price in the bracket, both targets solve to the same
       ceiling, and that is the right answer rather than a missing one. The strict version
       of this is the four-target ladder above. */
    check('...and it never asks more for being surer of selling',
      pinned.drop >= -1e-9, String(pinned.drop));
    check('no other row moved by more than rounding',
      pinned.othersMax < 0.01, String(pinned.othersMax));

    await p4.check('#srcSell');
    await p4.waitForFunction(() => state.rows.every(r => r.oddsTarget == null));

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
    /* REWRITTEN from eq(…, 1): the model integrates a gamma rather than counting windows,
       so a certainty comes out as one minus a rounding crumb. */
    near('...with a fill chance the guard is happy with', decay.fillChance, 1, 1e-4);

    /* ================= PARTIAL FILLS ===============================================
       The listing that neither fills nor fails. Twenty units at 1,000,000 on a market
       that sends 1.5 units a day past that price: a week is nowhere near enough for the
       stack, and almost certainly enough for SOMETHING. The old model had no way to say
       that — it multiplied one probability by the whole listing value, so its only two
       stories were "all twenty sold" and "none did". */
    section('a listing that half-fills is worth half a fill');
    await setPatience(p4, 'rush');
    const half = await decisionRow(p4, 'Patience Widget');
    const HQ = 20, HP = 1000000;
    const netInstantHalf = HQ * 900000 * (1 - TAX);
    near('the whole stack is listed — the buy book beats nothing here', half.comp.listQty, HQ, 1e-12);
    check('under half the stack is expected to sell inside a week',
      half.comp.expUnits > 6 && half.comp.expUnits < 12, String(half.comp.expUnits));
    near('...and that fraction IS the p the value is priced with',
      half.comp.p, half.comp.expUnits / HQ, 1e-12);
    check('...while selling at least ONE unit is all but certain',
      half.comp.pAny > 0.99, String(half.comp.pAny));
    check('...which is the sentence an all-or-nothing model cannot say',
      half.comp.pAny - half.comp.p > 0.4, half.comp.pAny + ' vs ' + half.comp.p);
    const asEvent = -Math.max(100, BROKER * HQ * HP) + half.comp.pAny * HQ * HP * (1 - TAX)
      + (1 - half.comp.pAny) * netInstantHalf;
    check('pricing the same odds as an event would overvalue this listing by a million ISK',
      asEvent - half.comp.net > 1e6, asEvent + ' vs ' + half.comp.net);
    near('the value is the expected UNITS at your price, plus the rest dumped later',
      half.comp.net,
      -Math.max(100, BROKER * HQ * HP) + half.comp.expUnits * HP * (1 - TAX)
        + (HQ - half.comp.expUnits) / HQ * netInstantHalf, 1e-6);
    eq('...and it is an upper bound until the tracker feeds it', half.comp.bound, 'upper');

    section('patience: one control, three answers, no refetch');
    /* REWRITTEN onto an item the window can actually decide. Steady Trinket used to carry
       this section, on the strength of a 20-day high pattern that a 7-day window caught
       less often than a 14-day one — an artefact of counting windows, not a statement
       about the market, which trades AT the patient price every day and always filled.
       Patience Widget makes the same point out of arrival rates: 1.5 units a day reach
       1,000,000, so twenty of them take about thirteen days. */
    const fetchedTypes = await p4.evaluate(() => state.esi.size);
    const rush = await decisionRow(p4, 'Patience Widget');
    eq('in a rush the window is 7 days', rush.window, 7);
    check('...which is not enough days of arrivals to clear the stack',
      rush.comp.p < 0.75, String(rush.comp.p));
    eq('...so the thin item is sold now rather than listed on a hope', rush.strategy, 'imm');
    check('...the guard naming the fee it would have spent to move part of a stack',
      rush.guarded.some(g => g.price === 1000000), JSON.stringify(rush.guarded));
    await setPatience(p4, 'patient');
    const patient = await decisionRow(p4, 'Patience Widget');
    eq('patient stretches the window to 30 days', patient.window, 30);
    near('...twice over what the stack needs, so all of it sells', patient.fillChance, 1, 1e-5);
    eq('...so the listing comes back', patient.strategy, 'ord');
    eq('flipping patience never refetches anything', await p4.evaluate(() => state.esi.size), fetchedTypes);
    await setPatience(p4, 'balanced');
    const balanced = await decisionRow(p4, 'Patience Widget');
    eq('...and balanced restores the middle answer', balanced.strategy, 'ord');
    check('...a middle answer that really is in the middle',
      balanced.comp.p > rush.comp.p && balanced.comp.p < patient.comp.p,
      [rush.comp.p, balanced.comp.p, patient.comp.p].join(' < '));
    eq('the liquid item is listed patiently whatever the hurry',
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
      const tr = [...document.querySelectorAll('#tblBody tr.a')].find(x => x.querySelector('.nm').textContent === 'Steady Trinket');
      const pair = [tr, tr.nextElementSibling];
      const at = k => pair.map(t => t && t.querySelector(`[data-cell="${k}"]`)).find(Boolean);
      const tsv = fullTsv().split('\n');
      return {
        heads,
        keys: [...document.querySelectorAll('#tbl thead th')].map(th => th.dataset.key),
        chance: at('fillChance').textContent,
        slot: at('perSlot').dataset.copy,
        fill: at('fillDays').dataset.copy,
        planCell: at('strategy').textContent,
        planTitle: at('strategy').querySelector('.badge').title,
        head: tsv[0].split('\t'),
        row: (tsv.find(l => l.startsWith('Steady Trinket')) || '').split('\t'),
        cellText: Object.fromEntries(['fillDays', 'fillChance', 'perSlot']
          .map(k => [k, at(k) ? at(k).textContent : ''])),
        sortable: [...document.querySelectorAll('#sortBy option')].map(o => o.value),
      };
    });
    check('Fill est., Chance % and ISK/slot-day are shown, each an addressable cell',
      ['fillDays', 'fillChance', 'perSlot'].every(k => cols.cellText[k] && cols.cellText[k] !== ''),
      JSON.stringify(cols.cellText));
    check('...and every one of them is reachable from the sort control',
      ['fillDays', 'fillChance', 'perSlot'].every(k => cols.sortable.includes(k)),
      cols.sortable.join(','));
    check('no numeric Trend %/wk column crowds the table — it lives in the tooltip',
      !cols.heads.some(h => /^Trend/.test(h)), cols.heads.join('|'));
    check('...the sparkline column carries that sort instead',
      cols.heads[3] === 'History' && cols.keys[3] === 'trendPctWk',
      cols.heads[3] + '/' + cols.keys[3]);
    // PATIENT, not LIST-PATIENT: the long form wrapped to two lines in a 74px column
    check('the plan cell reads as an action', /PATIENT/.test(cols.planCell), cols.planCell);
    check('...and hovering it gives the numbers behind it',
      /ISK\/slot-day/.test(cols.planTitle) && /% in \d+d/.test(cols.planTitle), cols.planTitle);
    check('the chance cell shows a percentage', /%$/.test(cols.chance), cols.chance);
    check('the slot-day cell copies its raw value', Number(cols.slot) > 0, cols.slot);
    check('the fill cell copies its raw value', Number(cols.fill) >= 0, cols.fill);
    /* REWRITTEN: 'Chance %' became 'Fill %' when the number stopped being a coin flip on
       the whole stack, and 'Fill bound' travels beside it so an upper bound off ESI
       regional volume and an estimate off the station's own sell-side prints cannot
       export as the same number. */
    check('the TSV gained the four columns',
      ['Fill est. days', 'Fill %', 'Fill bound', 'ISK/slot-day'].every(h => cols.head.includes(h)),
      cols.head.join('|'));
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
      const cell = n => [...document.querySelectorAll('#tblBody tr.a')]
        .find(tr => tr.querySelector('.nm').textContent === n).querySelector('[data-cell="spark"]');
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
    // REWRITTEN with the column it restates: the odds cell is a share of the stack now
    eq('the row’s decision numbers are restated under the chart',
      det.nums.join(','), 'plan,net ISK,fill est. d,fill,ISK/slot-day');
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
      return { ms, rows: document.querySelectorAll('#tblBody tr.a').length,
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
