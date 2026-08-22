/* The Sell tool's "My orders" mode, driven through the real page with mocked ESI.

   Covers the two-mode switcher over one shared DOM, the per-character order import
   (including a character whose login does not carry the scope), name and location
   resolution down to the unresolvable id, the table and the header totals, and then the
   triage itself: queue position with the user's OWN volume excluded, days to fill, the
   stalled rule and each of its three reasons, all three verdicts against hand-computed
   arithmetic (including the sunk-fee rule that must never charge the already-paid broker
   fee against cancelling), the unverified relist fee and its persisted override, the buy
   order toggle, the duplicate-order flag the Sell mode raises, and graceful degradation
   when a book, a history or a scope is missing.

   Every expected number below is derived by hand in the comments from the fixtures, not
   read back out of the page. */
'use strict';
const H = require('./helper');
const { check, eq, near, section } = H;

const MAIN = { id: 93813310, name: 'Miquel Dreamer' };
const ALT  = { id: 90000002, name: 'Alt Pilot' };
const ORDERS_SCOPE = 'esi-markets.read_character_orders.v1';
const STRUCT_SCOPE = 'esi-markets.structure_markets.v1';
const JITA = 60003760;
const GHOST_STATION = 60009999;      // a station id ESI refuses to name
const STRUCT = 1030049082711;

const TYPE_IDS = {
  'Hold Widget': 9101,
  'Dump Widget': 9102,
  'Reprice Widget': 9103,
  'Blind Widget': 9104,
  'Struct Widget': 9105,
  'Queue Widget': 9107,
  'Slide Widget': 9108,
  'Nobook Widget': 9109,
  'Ghost Widget': 9110,
  'Ship Skin': 9111,          // the order this whole pass exists for
  'Liquid Widget': 9112,      // at the front of a deep book — must stay healthy
  Tritanium: 34,
  'Advanced Broker Relations': 3447,
};

/* ---------- fee model, exactly as the page computes it from the mocked character ------
   Accounting 5      -> tax    = 7.5 x (1 - 0.11 x 5) = 3.375%. The box still displays
                        toFixed(2), but the page now keeps the unrounded rate beside it
                        and does its arithmetic on that, so the fraction used is the exact
                        one rather than the 3.37 the display rounds to.
   Broker Relations 5, zero standings -> broker = 3 - 0.3 x 5 = 1.50%
   Advanced Broker Relations 4 -> discount = 0.50 + 0.06 x 4 = 0.74
                                  relist   = 1.50 x (1 - 0.74) = 0.39%            */
const TAX = 0.03375;
const BROKER_PCT = 1.5;
const ADV_BROKER_LEVEL = 4;
const RELIST_DISCOUNT = 0.50 + 0.06 * ADV_BROKER_LEVEL;           // 0.74
const RELIST_PCT = BROKER_PCT * (1 - RELIST_DISCOUNT);            // 0.39
/* The whole modify-order charge, restated from the formula rather than copied off the
   page: the discounted rate on the entire new order value, PLUS the undiscounted broker
   rate on however much the order grew, and never less than the 100 ISK per-order floor.
   At these fixture sizes (10 x 1,000 = 10,000 ISK) 0.39% is 39 ISK, so the floor governs
   every reprice in this suite — which is exactly why the section further down drives the
   rate itself against the four readings taken off a real client. */
const relistFee = (qty, newPrice, oldPrice) => Math.max(100,
  RELIST_PCT / 100 * qty * newPrice
  + BROKER_PCT / 100 * Math.max(0, qty * newPrice - qty * oldPrice));
const net = isk => isk * (1 - TAX);

const day = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
const iso = t => new Date(Date.now() - t * 86400e3).toISOString();
const series = (n, f) => {
  const out = [];
  for (let t = n - 1; t >= 0; t--) out.push(Object.assign({ date: day(t) }, f(t)));
  return out;
};

/* Geometric histories again, for the same reason the Sell suite uses them: the log of a
   geometric series is a straight line, so Theil-Sen's median pairwise slope is exactly
   ln(k) and the weekly trend is a closed form with no fitting error to allow for. */
const K = 1.0101;                                   // per day going BACKWARDS
const TREND = (Math.pow(K, -7) - 1) * 100;          // = -6.79281…%/week
const FLAT = series(400, () => ({ average: 1000, highest: 2000, lowest: 900, volume: 100 }));

const BOOKS = {
  // highs of 2000 clear any price below it, so the hit rate at 1,000 is exactly 1
  'Hold Widget': {
    buys: [{ p: 500, v: 1000 }],
    // 5 units at 900 + SEVEN at 1000 are other people's; the ten at 1000 are the user's
    sells: [{ p: 900, v: 5 }, { p: 1000, v: 10, id: 11 }, { p: 1000, v: 7 }, { p: 1200, v: 100 }],
    hist: FLAT,
  },
  // highs never reach the asking price -> chance 0; the average slides, so the give-up
  // branch is worth less than dumping today
  'Dump Widget': {
    buys: [{ p: 900, v: 1000 }],
    sells: [{ p: 1000, v: 10, id: 12 }],
    hist: series(400, t => ({ average: 1000 * Math.pow(K, t), highest: 400 * Math.pow(K, t),
                              lowest: 900 * Math.pow(K, t), volume: 100 })),
  },
  // 0% at 2,000, 100% at the 1,000 somebody else is asking -> repricing is worth it
  'Reprice Widget': {
    buys: [{ p: 100, v: 1000 }],
    sells: [{ p: 1000, v: 5 }, { p: 2000, v: 10, id: 13 }],
    hist: series(400, () => ({ average: 1000, highest: 1500, lowest: 900, volume: 100 })),
  },
  'Blind Widget': { buys: [{ p: 100, v: 1000 }],
                    sells: [{ p: 1000, v: 5 }, { p: 1000, v: 10, id: 14 }] },   // no history at all
  'Struct Widget': { buys: [], sells: [], hist: FLAT },                          // structure book only
  // 10,000 units queued below the user against 100 traded a day, on an order with two
  // days left: the queue cannot possibly clear in time
  'Queue Widget': {
    buys: [{ p: 800, v: 1000 }],
    sells: [{ p: 900, v: 10000 }, { p: 1000, v: 10, id: 16 }],
    hist: FLAT,
  },
  /* Overbid on a sliding market. The highs slide with the average, so carrying every
     past day to today's price level lands them all back on the same band — the ONLY thing
     that makes this row stalled is the trend plus sitting above the best sell.

     RETUNED for the arrival model. The book used to queue 2,000 units below the user
     against 100 traded a day, and the old metric handled that by multiplying a hit rate
     of 1 by 14/20 — a queue that takes 20 days to clear reported as a 70% chance. The
     model walks the queue at each level's own demand rate instead, and 2,000 units in
     front of a market that clears ~9 a day at that price is not 70%, it is nothing. So
     the queue is one unit and the arrival rate carries the window instead: 7 units a day
     trade, 8.2% of them at or above 1,100, so ~0.57 units a day reach the user's price.
     Ten units then need about seventeen days — inside a patient 30-day window, short of a
     balanced 14-day one. That is the same statement the fixture always made, made in
     units instead of in a fudge factor. */
  'Slide Widget': {
    buys: [{ p: 900, v: 1000 }],
    sells: [{ p: 1000, v: 1 }, { p: 1100, v: 10, id: 17 }],
    hist: series(400, t => ({ average: 1000 * Math.pow(K, t), highest: 2000 * Math.pow(K, t),
                              lowest: 900 * Math.pow(K, t), volume: 7 })),
  },
  /* THE ACCEPTANCE CASE, off the owner's own hangar. Five units of a ship skin listed at
     177,600 with 178 units of other people's stock queued in front at 10,010, on a market
     that trades two units a day and has printed a high above 177,600 on five days out of
     365. The buy book pays 5,000.

     A spike every 15 days puts a high above 177,600 in 89% of 14-day windows, and 178
     units against 2 a day tempers that by 14/89 — so the metric this page used to decide
     with reads about 14%, and 14% of 888,000 ISK dwarfs 24,156 of buy book. That is why
     it said KEEP. The section below re-derives the number from the page's own hitRateOf
     and asserts the verdict no longer follows it.

     The market drifts UP 1.4%/week — inside the flat band, so nothing is classed falling,
     but enough that the give-up branch is worth more at the end of the window than the
     buy book is worth today. Holding therefore still SCORES higher than dumping with a
     zero fill, and only the floor takes it off the table. That is the shape of the 27
     stalled orders the page was still telling him to hold: not outscored, ungated.

     The spikes stop 31 days back, so the 30-day trend window sees a flat market and the
     direction reason cannot fire. */
  'Ship Skin': {
    buys: [{ p: 5000, v: 1000 }],
    sells: [{ p: 10010, v: 178 }, { p: 177600, v: 5, id: 21 }],
    hist: series(365, t => {
      const f = Math.pow(1.002, -t);           // 0.2%/day forward = +1.41%/week
      return (t >= 31 && t % 15 === 1)
        ? { average: 12500 * f, highest: 200000 * f, lowest: 9800 * f, volume: 2, orders: 1 }
        : { average: 10300 * f, highest: 11000 * f, lowest: 9800 * f, volume: 2, orders: 1 };
    }),
  },
  /* The control: at the very front of the book on a market that moves a million units a
     day. Whatever the model does to the hopeless order, it must leave this one alone. */
  'Liquid Widget': {
    buys: [{ p: 4.5, v: 1e7 }],
    sells: [{ p: 5, v: 10000, id: 22 }],
    hist: series(365, () => ({ average: 5, highest: 5.2, lowest: 4.8,
                               volume: 1e6, orders: 5000 })),
  },
  'Nobook Widget': { buys: [{ p: 100, v: 10 }], sells: [], hist: FLAT },   // its book 404s below
  'Ghost Widget': { buys: [{ p: 100, v: 10 }], sells: [], hist: FLAT },    // at the unnameable station
  Tritanium: { buys: [{ p: 4, v: 1e6 }], sells: [{ p: 6, v: 1e6 }] },
};

const ord = (o) => Object.assign({
  location_id: JITA, region_id: 10000002, range: 'station', duration: 90,
  issued: iso(30), min_volume: 1,
}, o);

const MAIN_ORDERS = [
  ord({ order_id: 11, type_id: 9101, price: 1000, volume_remain: 10, volume_total: 10 }),
  ord({ order_id: 12, type_id: 9102, price: 1000, volume_remain: 10, volume_total: 10 }),
  ord({ order_id: 13, type_id: 9103, price: 2000, volume_remain: 10, volume_total: 10 }),
  ord({ order_id: 14, type_id: 9104, price: 1000, volume_remain: 10, volume_total: 10 }),
  ord({ order_id: 15, type_id: 9105, price: 5000, volume_remain: 4, volume_total: 4,
        location_id: STRUCT, duration: 30, issued: iso(10) }),
  ord({ order_id: 16, type_id: 9107, price: 1000, volume_remain: 10, volume_total: 10,
        duration: 7, issued: iso(5) }),
  ord({ order_id: 17, type_id: 9108, price: 1100, volume_remain: 10, volume_total: 10 }),
  ord({ order_id: 18, type_id: 9109, price: 1000, volume_remain: 10, volume_total: 10 }),
  ord({ order_id: 19, type_id: 9110, price: 1000, volume_remain: 2, volume_total: 2,
        location_id: GHOST_STATION }),
  ord({ order_id: 20, type_id: 34, price: 4.5, volume_remain: 1000, volume_total: 1000,
        is_buy_order: true, duration: 30, issued: iso(5), escrow: 4500 }),
];

const ACCEPT_ORDERS = [
  ord({ order_id: 21, type_id: 9111, price: 177600, volume_remain: 5, volume_total: 5 }),
  ord({ order_id: 22, type_id: 9112, price: 5, volume_remain: 10000, volume_total: 10000 }),
];

async function openOrders(browser, server, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  const scopes = opts.scopes || H.ALL_SCOPES;
  await H.seedStorage(context, server.url, [['eveHelper.auth.v1', H.authState([
    { id: MAIN.id, name: MAIN.name, scopes },
    { id: ALT.id, name: ALT.name, scopes: H.ALL_SCOPES.filter(s => s !== ORDERS_SCOPE) },
  ])]]);
  await H.mockEsi(context, {
    skills: { accounting: 5, brokerRelations: 5 },
    rawSkills: { 3447: ADV_BROKER_LEVEL },
    standings: {}, typeIds: TYPE_IDS, books: BOOKS,
    charOrders: { [MAIN.id]: opts.orders || MAIN_ORDERS },
  });
  // routes registered AFTER mockEsi win, so these override its generic handlers
  await context.route('**/universe/stations/60009999/**', route =>
    route.fulfill({ status: 404, body: 'not found' }));
  await context.route('**/markets/*/orders/**', route => {
    const url = new URL(route.request().url());
    if (Number(url.searchParams.get('type_id')) === 9109)
      return route.fulfill({ status: 404, body: 'gone' });      // one book that cannot be had
    route.fallback();
  });
  await context.route('**/universe/structures/**', route => route.fulfill(H.json({
    name: 'V-3YG7 VI - The Capital', solar_system_id: 30000142, type_id: 35834 })));
  await context.route('**/universe/systems/**', route =>
    route.fulfill(H.json({ name: 'Jita', constellation_id: 20000020, security_status: 0.9 })));
  await context.route('**/universe/constellations/**', route =>
    route.fulfill(H.json({ region_id: 10000002 })));
  await context.route('**/markets/structures/**', route => route.fulfill(H.json([
    { order_id: 900, type_id: 9105, is_buy_order: false, price: 4000, volume_remain: 3,
      location_id: STRUCT, min_volume: 1 },
    { order_id: 901, type_id: 9105, is_buy_order: false, price: 5000, volume_remain: 4,
      location_id: STRUCT, min_volume: 1 },
    { order_id: 902, type_id: 9105, is_buy_order: true, price: 2000, volume_remain: 50,
      location_id: STRUCT, min_volume: 1 },
  ])));
  const page = await context.newPage();
  H.watchPage(page, 'orders');
  await page.goto(server.url + '/index.html');
  await page.waitForFunction("typeof runOrders === 'function' && typeof diagnoseOrders === 'function'");
  // the skills/standings auto-fill has landed once the broker box holds the computed rate
  await page.waitForFunction(() => document.getElementById('brokerFee').value === '1.50');
  return { context, page, close: () => context.close() };
}

const fetchOrders = async page => {
  await page.click('#btnOrders');
  await page.waitForFunction(() => !state.orders.running && state.orders.fetched, null, { timeout: 30000 });
};

const diagOf = (page, orderId) => page.evaluate(id => {
  const d = state.orders.diag[id];
  if (!d) return null;
  const { histRows, ...rest } = d;
  return Object.assign(rest, { hasHist: !!(histRows && histRows.length) });
}, orderId);

const rowCells = (page, orderId) => page.evaluate(id => {
  const tr = document.querySelector(`#ordBody tr[data-order-id="${id}"]`);
  return tr ? [...tr.children].map(td => td.textContent.trim()) : null;
}, String(orderId));

/* The My-orders mirror writes into the Sell mode's two fields, which is the whole point
   of it — one source of truth, two screens. */
const setPatience = async (page, days, floorPct) => {
  await page.evaluate(v => {
    const d = document.getElementById('ordPatDays');
    d.value = String(v.days);
    d.dispatchEvent(new Event('change'));
    if (v.floor != null){
      const f = document.getElementById('ordPatFloor');
      f.value = String(v.floor);
      f.dispatchEvent(new Event('change'));
    }
  }, { days, floor: floorPct == null ? null : floorPct });
  await page.waitForFunction(v => Number(state.patDays) === v.days
    && (v.floor == null || Number(state.patFloor) === v.floor),
    { days, floor: floorPct == null ? null : floorPct });
};

H.run('orders', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    const s = await openOrders(browser, server);
    const page = s.page;

    /* ---------- (a) the two-mode switcher ---------- */
    section('the two-mode switcher, over one shared DOM');
    eq('the page opens in Sell loot mode', await page.evaluate(() => document.body.dataset.mode), 'sell');
    check('the inventory paste is visible there', await page.isVisible('#inv'));
    check('...and the orders table is not', !(await page.isVisible('#ordTbl')));
    eq('the Sell button reads as pressed',
      await page.getAttribute('#modeSell', 'aria-pressed'), 'true');
    await page.click('#modeOrders');
    eq('clicking My orders swaps the mode', await page.evaluate(() => document.body.dataset.mode), 'orders');
    check('the orders table is visible', await page.isVisible('#ordTbl'));
    check('...and the inventory paste is not', !(await page.isVisible('#inv')));
    check('no state was thrown away by the swap',
      await page.evaluate(() => typeof state.rows.length === 'number' && state.esi instanceof Map));
    await page.reload();
    await page.waitForFunction("typeof runOrders === 'function'");
    eq('the mode is persisted across a reload',
      await page.evaluate(() => document.body.dataset.mode), 'orders');

    /* ---------- (b) the per-character import ---------- */
    section('open orders, per character');
    /* Pinned to an explicit fortnight and a 55% floor. Every verdict below is checked
       against arithmetic this file works out by hand, so the window it works out has to
       be a number this file chose, not whatever the page happens to default to. */
    await setPatience(page, 14, 55);
    await fetchOrders(page);
    const chars = await page.evaluate(() => state.orders.chars);
    const main = chars.find(c => c.id === 93813310);
    const alt = chars.find(c => c.id === 90000002);
    eq('the character carrying the scope contributed its orders', main.count, MAIN_ORDERS.length);
    eq('...9 of them sell orders', main.sell, 9);
    eq('...and one buy order', main.buy, 1);
    check('the character WITHOUT the scope is reported, not skipped silently', !!alt);
    eq('...flagged as missing the scope', alt.missingScope, true);
    eq('...and contributing nothing', alt.count, 0);
    const charsBox = await page.textContent('#ordChars');
    check('the panel names the character that cannot be read', charsBox.includes('Alt Pilot'), charsBox);
    check('...with the inline permissions note', charsBox.includes('see permissions'), charsBox);
    eq('...which links the scope it needs',
      await page.getAttribute('#ordChars .evePermLink', 'data-perm-scope'), ORDERS_SCOPE);
    check('...and the readable character reports its slots in use',
      charsBox.includes('10 slots · 9 sell · 1 buy'), charsBox);
    const summary = await page.textContent('#ordSummary');
    check('the header counts the open orders', summary.includes('10'), summary);
    check('...and reports slots in use per character rather than a made-up cap',
      /Miquel Dreamer 10/.test(summary) && !/of \d+ slots/.test(summary), summary);

    /* ---------- (c) names and locations ---------- */
    section('type names and location names');
    const names = await page.evaluate(() => state.orders.names);
    eq('type ids resolve to item names', names['9101'], 'Hold Widget');
    const locs = await page.evaluate(() => state.orders.locs);
    eq('an NPC station is named from /universe/stations', locs[JITA].name, 'Jita IV - Moon 4');
    eq('a player structure is named from /universe/structures', locs[STRUCT].name, 'V-3YG7 VI - The Capital');
    eq('...and recorded as a structure', locs[STRUCT].kind, 'structure');
    eq('a station ESI will not name stays unresolved', locs[GHOST_STATION].name, null);
    const ghostCells = await rowCells(page, 19);
    check('...and its row shows the raw id honestly',
      ghostCells.includes(String(GHOST_STATION)), ghostCells && ghostCells.join(' | '));

    section('item icons, on the item cell only');
    const ordIcons = await page.evaluate(() => {
      const tr = document.querySelector('#ordBody tr[data-order-id="11"]');
      const cells = [...tr.querySelectorAll('td.name')];
      return {
        cellCount: cells.length,
        item: (() => {
          const img = cells[0].querySelector('img.ticon');
          return img ? { src: img.getAttribute('src'), lazy: img.getAttribute('loading'),
                         alt: img.getAttribute('alt') } : null;
        })(),
        itemText: cells[0].textContent,
        locationHasIcon: cells.slice(1).some(td => !!td.querySelector('img.ticon')),
      };
    });
    check('the item cell carries the type icon', !!ordIcons.item, JSON.stringify(ordIcons));
    check('...pointing at that order\u2019s type id',
      ordIcons.item && /^https:\/\/images\.evetech\.net\/types\/\d+\/icon\?size=64$/.test(ordIcons.item.src),
      JSON.stringify(ordIcons.item));
    check('...lazily, and decorative', ordIcons.item &&
      ordIcons.item.lazy === 'lazy' && ordIcons.item.alt === '', JSON.stringify(ordIcons.item));
    check('the LOCATION cell shares the class but must never get an item icon',
      ordIcons.cellCount >= 2 && ordIcons.locationHasIcon === false, JSON.stringify(ordIcons));
    check('the icon leaves the item cell\u2019s text alone',
      ordIcons.itemText === 'Hold Widget', ordIcons.itemText);

    /* ---------- (d) the table and its totals ---------- */
    section('the table and the header totals');
    const hold = await rowCells(page, 11);
    eq('character', hold[0], MAIN.name);
    eq('item', hold[1], 'Hold Widget');
    eq('your price', hold[3], '1,000');
    eq('qty remaining / total', hold[4], '10 / 10');
    eq('location', hold[5], 'Jita IV - Moon 4');
    eq('age in days since issued', hold[6], '30');
    eq('days left = duration - age', hold[7], '60');
    eq('ISK tied up = price x remaining', hold[8], '10,000');
    const totals = await page.evaluate(() => {
      const rows = ordRows().filter(r => !r.isBuy);
      return { tied: rows.reduce((t, r) => t + r.iskTied, 0), n: rows.length };
    });
    // 10,000 + 10,000 + 20,000 + 10,000 + 20,000 + 10,000 + 11,000 + 10,000 + 2,000
    eq('the sell orders tie up the sum of price x remaining', Math.round(totals.tied), 103000);
    check('buy orders are out of the default view',
      !(await rowCells(page, 20)), 'the buy row should be hidden');

    /* ---------- (e) queue position, with the user's own volume excluded ---------- */
    section('queue position excludes your own order');
    const dHold = await diagOf(page, 11);
    // book at 1,000 or below: 5 @ 900 + 10 @ 1000 (yours) + 7 @ 1000 = 22 units, of which
    // 10 are your own -> 12 units are actually ahead of you
    eq('units at or below your price, minus your own remaining volume', dHold.queueAhead, 12);
    eq('the best sell is the best COMPETING sell, not your own order', dHold.bestOther, 900);
    near('...and "vs best" is measured against it', dHold.aboveBestPct, (1000 - 900) / 900 * 100, 1e-9);
    const dRep = await diagOf(page, 13);
    // the only other listing is 5 @ 1,000; the ten at 2,000 are the user's own
    eq('your own units are removed from the level they sit on', dRep.queueAhead, 5);
    eq('...leaving the competitor as the best sell', dRep.bestOther, 1000);
    const own = await page.evaluate(() => {
      const lv = [{ p: 100, v: 4, id: 1 }, { p: 100, v: 6, id: 2 }, { p: 110, v: 3, id: 3 }];
      return {
        // your order is dropped whole by its id, even where the two feeds disagree on size
        byId: competitorSells(lv, [{ orderId: 2, price: 100, volumeRemain: 99 }]),
        // an order the book does not carry falls back to matching by price
        byPrice: competitorSells(lv, [{ orderId: 77, price: 100, volumeRemain: 7 }]),
        none: competitorSells(lv, []),
      };
    });
    eq('an own order in the book is dropped by its id, whatever size the book says',
      JSON.stringify(own.byId), JSON.stringify([{ p: 100, v: 4 }, { p: 110, v: 3 }]));
    eq('...and one the book does not carry is deducted by price, across levels',
      JSON.stringify(own.byPrice), JSON.stringify([{ p: 100, v: 3 }, { p: 110, v: 3 }]));
    eq('...while a book with nothing of yours in it is untouched',
      JSON.stringify(own.none), JSON.stringify([{ p: 100, v: 4 }, { p: 100, v: 6 }, { p: 110, v: 3 }]));

    /* ---------- (f) days to fill ---------- */
    section('days to fill at your current price');
    near('12 units ahead / 100 traded per day', dHold.daysToFill, 0.12, 1e-12);
    eq('...divided by the same regional volume the Sell table uses', dHold.volDay, 100);
    const dQueue = await diagOf(page, 16);
    near('10,000 units ahead / 100 a day = 100 days', dQueue.daysToFill, 100, 1e-9);
    const dBlind = await diagOf(page, 14);
    eq('with no history there is no volume to divide by', dBlind.daysToFill, null);

    /* ---------- (g) what works against an order ---------- */
    /* These three used to drive a "Stalled?" column of their own, a second verdict
       sitting beside the real one — a red "yes" next to a HOLD. The column is gone;
       the three facts remain, as chips on the item's name, and the rules that produce
       them are unchanged, which is what the block below still pins. */
    section('what works against an order, and each of its reasons');
    eq('a 100% chance inside the window has nothing against it', dHold.reasons.length, 0);
    eq('...and the trend is flat on that item', dHold.trendPctWk, 0);
    const dDump = await diagOf(page, 12);
    check('an order the market never reaches has something against it', dDump.reasons.length > 0,
      JSON.stringify(dDump.reasons));
    eq('...for the odds', dDump.chance, 0);
    check('...with a chip stating the odds against the floor',
      dDump.reasons.some(r => /^\d+%<\d+%$/.test(r.t)), JSON.stringify(dDump.reasons));
    /* REWRITTEN: the tooltip used to quote a chance of the whole order filling. The
       number behind it is now the share of the units expected to sell, and the floor it
       misses no longer merely decorates the row — it takes holding out of the running,
       which is the sentence the tooltip has to carry. */
    check('...whose tooltip carries the units, the price, the floor it missed and the cost',
      dDump.reasons.some(r => /^fill: \d+% of [\d,]+ u$/m.test(r.ttl)
        && /^at: [\d,]+ in \d+d$/m.test(r.ttl)
        && /^floor: \d+% \(14d · 55%\)$/m.test(r.ttl)
        && /^hold: not offered$/m.test(r.ttl)),
      JSON.stringify(dDump.reasons));
    check('...as key: value lines, with no sentence anywhere in it',
      dDump.reasons.every(r => r.ttl.split('\n').every(l => /^[^:]{1,18}: .{1,26}$/.test(l))),
      JSON.stringify(dDump.reasons.map(r => r.ttl)));
    check('...and the chip stays a chip', dDump.reasons.every(r => r.t.length <= 10),
      JSON.stringify(dDump.reasons.map(r => r.t)));
    eq('the window is capped by the days left on the order', dQueue.window, 2);
    check('a queue that cannot clear before expiry is called out',
      dQueue.reasons.some(r => /^q[\d.<]+d>[\d.<]+d$/.test(r.t)),
      JSON.stringify(dQueue.reasons));
    check('...with the units queued at or below your price on the tooltip',
      dQueue.reasons.some(r => /queue: [\d,]+ u at or below your price/.test(r.ttl)
        && /clears in: [\d.<]+d/.test(r.ttl) && /expires in: [\d.<]+d/.test(r.ttl)),
      JSON.stringify(dQueue.reasons));
    const dSlide = await diagOf(page, 17);
    near('a sliding market is measured, not guessed', dSlide.trendPctWk, TREND, 1e-9);
    /* REWRITTEN: this used to assert 14/20 = 0.7, the old queue fudge — a hit rate of 1
       scaled by window/daysToFill. The page now asks how many units actually arrive at
       this price inside the window, and the answer is a share of the ten on the order:
       above the 55% floor, under the 90% that would make the trend irrelevant. */
    check('...the chance is the share of the order the arrivals cover, not a fudge factor',
      dSlide.chance > 0.55 && dSlide.chance < 0.9, String(dSlide.chance));
    near('...which is expected units over the ten still listed',
      dSlide.chance, dSlide.expUnits / 10, 1e-12);
    eq('...an estimate off ESI regional volume, and labelled as the upper bound it is',
      dSlide.bound, 'upper');
    check('being above the best sell on a falling market counts on its own',
      dSlide.reasons.length === 1
        && /^\+[\d.]+%▼$/.test(dSlide.reasons[0].t), JSON.stringify(dSlide.reasons));
    // read defensively: a suite whose earlier claim fails must still reach the ones below
    const slideTtl = (dSlide.reasons[0] || {}).ttl || '';
    check('...its tooltip naming the gap and the trend, and nothing else',
      /^above best sell: \+[\d.]+%$/m.test(slideTtl)
        && /^trend: -[\d.]+%\/wk$/m.test(slideTtl)
        && slideTtl.split('\n').length === 2, slideTtl);
    check('...even though the odds pass the floor and the queue clears in time',
      dSlide.chance > 0.55 && dSlide.daysToFill < dSlide.daysLeft,
      dSlide.chance + ' / ' + dSlide.daysToFill + ' vs ' + dSlide.daysLeft);
    eq('...so the floor never gets to gate anything on this row', dSlide.floored.length, 0);

    /* ---------- (h) the three verdicts ---------- */
    section('HOLD / REPRICE / CANCEL & DUMP, hand-computed');
    // HOLD: certain fill at 1,000 -> 10 x 1,000 net of tax
    eq('a good order is held', dHold.verdict, 'hold');
    near('...worth chance x units x price, net of tax', dHold.valueHold, net(10 * 1000), 1e-6);
    // dumping it instead walks the buy book: 10 x 500 net of tax
    near('...against a dump worth the buy book, net of tax', dHold.valueDump, net(10 * 500), 1e-6);
    // repricing to the 900 someone else is asking: 0.39% of 9,000 is 35, so the 100 ISK
    // per-order floor is what actually comes off
    near('...and a reprice worth the lower price minus the relist fee',
      dHold.valueReprice, net(10 * 900) - relistFee(10, 900, 1000), 1e-6);

    // DUMP: 0% chance, so holding is only worth the give-up branch, and the trend shrinks
    // that by (1 + TREND/100)^(14/7) before you ever get to sell it
    eq('an order the market has left behind is dumped', dDump.verdict, 'dump');
    near('...the buy book pays this today', dDump.dumpNow, net(10 * 900), 1e-6);
    near('...the trend carries that to the end of the window', dDump.decay,
      Math.pow(1 + TREND / 100, 2), 1e-12);
    near('...so holding is worth only the decayed dump', dDump.valueHold,
      net(10 * 900) * Math.pow(1 + TREND / 100, 2), 1e-6);
    check('...which is less than dumping now', dDump.valueDump > dDump.valueHold,
      dDump.valueDump + ' vs ' + dDump.valueHold);

    // REPRICE: 0% at 2,000, 100% at 1,000. Dropping the price means no growth term, so
    // the charge is 0.39% x 10,000 = 39 -> floored to 100
    eq('an overpriced order with a live market under it is repriced', dRep.verdict, 'reprice');
    eq('...to the competitive price', dRep.repricePrice, 1000);
    near('...paying the relist fee', dRep.relistFee, relistFee(10, 1000, 2000), 1e-9);
    eq('...which at this size is the 100 ISK floor, not the rate', dRep.relistFee, 100);
    near('...for a value net of that fee', dRep.valueReprice,
      net(10 * 1000) - relistFee(10, 1000, 2000), 1e-6);
    check('...which beats both holding and dumping',
      dRep.valueReprice > dRep.valueHold && dRep.valueReprice > dRep.valueDump);

    /* the sunk fee. The 1.5% broker fee that put order 13 up cost 0.015 x 10 x 2,000 =
       300 ISK. It is gone whatever happens next, so it must appear in NONE of the three
       values — charging it against cancelling is the classic error that keeps dead orders
       alive ("I already paid for this listing"). */
    section('the broker fee already paid is sunk');
    near('cancelling is worth exactly what the buy book pays, after tax only',
      dRep.valueDump, net(10 * 100), 1e-6);
    check('...not that minus the broker fee already spent',
      Math.abs(dRep.valueDump - (net(10 * 100) - 0.015 * 10 * 2000)) > 1, dRep.valueDump);
    check('...and the explanation says so',
      /^sunk: the broker fee that put this order up/m.test(dRep.why)
        && /least of all against cancelling/.test(dRep.why), dRep.why);
    check('the only fee in the comparison is the future relist fee',
      /relist fee/.test(dRep.why), dRep.why);

    section('the verdict arithmetic is on the badge');
    const verdictTitle = await page.evaluate(() =>
      document.querySelector('#ordBody tr[data-order-id="13"] .badge').title);
    check('the badge carries the whole derivation', verdictTitle === dRep.why && verdictTitle.length > 200);
    check('...naming all three options', /^hold: /m.test(verdictTitle)
      && /^reprice [\d,.]+: /m.test(verdictTitle) && /^dump: /m.test(verdictTitle), verdictTitle);
    check('...as one key: value line each, not a paragraph',
      verdictTitle.split('\n').length >= 5
        && verdictTitle.split('\n').every(l => l.length <= 160), verdictTitle);

    /* ---------- (i2) the raw numbers, handed to a spreadsheet ----------
       The table on screen is terse on purpose, so the TSV is where the working numbers
       live: every visible column plus the diagnostics behind the verdict. */
    section('Copy TSV for the triage table');
    const otsv = await page.evaluate(() => {
      const lines = ordTsv().split('\n');
      const head = lines[0].split('\t');
      const idx = h => head.indexOf(h);
      const row = (lines.find(l => l.startsWith('Miquel Dreamer\tReprice Widget')) || '').split('\t');
      const cells = {};
      for (const h of head) cells[h] = row[idx(h)];
      return { head, cells, n: lines.length - 1,
               widths: lines.slice(1).map(l => l.split('\t').length) };
    });
    /* REWRITTEN: 'Chance %' became 'Fill %' when the number stopped being a coin flip on
       the whole order, and 'Fill bound' travels beside it — an upper bound off ESI
       regional volume and an estimate off the station's own sell-side prints are not the
       same number and must not export as one. */
    check('the diagnostic columns are all there',
      ['Queue ahead', 'Fill est. d', 'Fill %', 'Fill bound', 'Trend %/wk', 'Hold ISK',
       'Reprice ISK', 'Dump ISK', 'Relist fee ISK'].every(h => otsv.head.includes(h)),
      otsv.head.join('|'));
    eq('...and the bound is on the row, not just in the header', otsv.cells['Fill bound'], 'upper');
    check('...alongside the columns the table shows',
      ['Character', 'Item', 'Your price', 'Qty left', 'Location', 'ISK tied up', 'vs best %',
       'Against it', 'Verdict'].every(h => otsv.head.includes(h)), otsv.head.join('|'));
    check('every row is as wide as the header',
      otsv.widths.every(w => w === otsv.head.length), JSON.stringify(otsv.widths));
    eq('one line per sell order', otsv.n, 9);
    eq('the reprice row carries its verdict', otsv.cells['Verdict'], 'REPRICE');
    eq('...the price it would move to', otsv.cells['Reprice price'], '1000.00');
    near('...the relist fee that costs', Number(otsv.cells['Relist fee ISK']),
      relistFee(10, 1000, 2000), 1e-9);
    near('...and the three option values behind the choice', Number(otsv.cells['Dump ISK']),
      net(10 * 100), 1e-6);
    check('...with hold and reprice beside it',
      Number(otsv.cells['Reprice ISK']) > Number(otsv.cells['Hold ISK']),
      otsv.cells['Reprice ISK'] + ' vs ' + otsv.cells['Hold ISK']);
    check('what works against a row travels as its chips',
      /%<\d+%/.test(otsv.cells['Against it']), otsv.cells['Against it']);
    check('...and the deleted second verdict is not a column any more',
      !otsv.head.includes('Stalled') && !otsv.head.includes('Stalled reasons'), otsv.head.join('|'));
    await page.click('#btnOrdTsv');
    await page.waitForFunction(() => document.getElementById('copyStatusOrd').textContent !== '');
    check('the button reports what it copied',
      /copied 9 orders/.test(await page.textContent('#copyStatusOrd')),
      await page.textContent('#copyStatusOrd'));

    /* ---------- (h2) the second verdict system is gone from the screen ---------- */
    section('one verdict, not two');
    const cols = await page.$$eval('#ordTbl thead th', els => els.map(e => e.textContent.trim()));
    check('there is no Stalled? column', !cols.some(c => /stalled/i.test(c)), cols.join('|'));
    const bodyWidth = await page.$$eval('#ordBody tr[data-order-id]',
      rows => [...new Set(rows.map(tr => tr.children.length))]);
    eq('every row is as wide as the header', bodyWidth.join(','), String(cols.length));
    /* the facts did not go anywhere — they sit on the name, with the other warnings,
       the same way the Sell table carries its chips */
    const chipRow = await page.evaluate(() => {
      const tr = [...document.querySelectorAll('#ordBody tr[data-order-id]')]
        .find(x => Number(x.dataset.orderId) === 12);
      const td = tr.querySelector('td.name');
      return { chips: [...td.querySelectorAll('.flag')].map(c => ({ t: c.textContent, ttl: c.title })),
               text: td.textContent };
    });
    check('the order the market never reaches carries its chip on the name',
      chipRow.chips.some(c => /%<\d+%/.test(c.t)), JSON.stringify(chipRow.chips));
    check('...with its numbers still on the tooltip',
      chipRow.chips.some(c => /floor: \d+%/.test(c.ttl)), JSON.stringify(chipRow.chips.map(c => c.ttl)));
    check('...and the item name is still there to read',
      /Tritanium|[A-Za-z]/.test(chipRow.text), chipRow.text);
    const cleanRow = await page.evaluate(() => {
      const tr = [...document.querySelectorAll('#ordBody tr[data-order-id]')]
        .find(x => Number(x.dataset.orderId) === 11);
      return tr.querySelector('td.name').querySelectorAll('.flag').length;
    });
    eq('a healthy order carries no chip at all', cleanRow, 0);

    /* ---------- (i) the totals, counted off the verdict ---------- */
    /* They used to be counted off the deleted "stalled" flag, which is exactly the
       double-reading that got it deleted: the number in the header has to be the number
       of orders the VERDICT wants you to do something about. */
    section('triage totals');
    const triage = await page.evaluate(() => {
      const rows = ordRows().filter(r => !r.isBuy && (r.verdict === 'reprice' || r.verdict === 'dump'));
      const dumps = ordRows().filter(r => !r.isBuy && r.verdict === 'dump');
      return { n: rows.length, tied: rows.reduce((t, r) => t + r.iskTied, 0),
               recover: dumps.reduce((t, r) => t + (r.dumpNow || 0), 0),
               dumpIds: dumps.map(r => r.orderId).sort((a, b) => a - b) };
    });
    check('the header counts the orders the triage wants acted on', triage.n > 0, JSON.stringify(triage));
    const sumText = await page.textContent('#ordSummary');
    check('the header states it in those words',
      new RegExp(triage.n + ' orders?').test(sumText) && /to act on/.test(sumText)
        && /recoverable/.test(sumText), sumText);
    check('...and no longer speaks of a stalled list', !/stalled/i.test(sumText), sumText);
    const dumpNow = await page.evaluate(ids => {
      const by = new Map(ordRows().map(r => [r.orderId, r]));
      return ids.reduce((t, id) => t + (by.get(id).dumpNow || 0), 0);
    }, triage.dumpIds);
    near('...with the recoverable figure summing exactly the CANCEL & DUMP rows',
      triage.recover, dumpNow, 1e-6);

    /* ---------- (j) default sort ---------- */
    section('sorting');
    const order = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('#ordBody tr[data-order-id]')].map(tr => Number(tr.dataset.orderId));
      const by = new Map(ordRows().map(r => [r.orderId, r]));
      return ids.map(id => ({ id, tied: by.get(id).iskTied }));
    });
    check('the default sort runs down the ISK on the market',
      order.every((r, i) => i === 0 || order[i - 1].tied >= r.tied), JSON.stringify(order));
    eq('...topped by the biggest order', order[0].tied, 20000);

    /* The indicator used to decide "is this column text?" from a hard-coded list of three
       keys while the comparator decided it from the value's own type, so Verdict — which
       holds strings — sorted A→Z and drew ▼. An arrow pointing the opposite way to the
       order it labels is the same defect as a # column ranking by something invisible. */
    const arrowFor = async key => {
      await page.click(`#ordTbl thead th[data-key="${key}"]`);
      await page.waitForFunction(k => state.ordSortKey === k, key);
      return page.evaluate(k => {
        const th = document.querySelector(`#ordTbl thead th[data-key="${k}"]`);
        const by = new Map(ordRows().map(r => [r.orderId, r]));
        return {
          arrow: th.classList.contains('s-asc') ? 'asc' : th.classList.contains('s-desc') ? 'desc' : 'none',
          // the sell block only: buys are sorted separately, below their own separator
          values: [...document.querySelectorAll('#ordBody tr[data-order-id]')]
            .map(tr => by.get(Number(tr.dataset.orderId)))
            .filter(r => r && !r.isBuy).map(r => r[k]),
          text: ordRows().some(r => typeof r[k] === 'string'),
        };
      }, key);
    };
    // compared exactly the way the page compares them — including a text column's empty
    // cells — so this checks the arrow, not the locale
    const ascending = a => a.values.every((x, i) => i === 0 || (a.text
      ? String(a.values[i - 1] == null ? '' : a.values[i - 1])
          .localeCompare(String(x == null ? '' : x)) <= 0
      : (a.values[i - 1] == null ? -Infinity : a.values[i - 1]) <= (x == null ? -Infinity : x)));
    for (const key of ['verdict', 'name', 'iskTied']) {
      const a = await arrowFor(key);
      const varied = new Set(a.values.map(String)).size > 1;
      check(`the ${key} column has something to order`, varied, JSON.stringify(a.values));
      check(`the ${key} column draws an arrow at all`, a.arrow !== 'none', a.arrow);
      eq(`...pointing the way the ${key} column is actually ordered`,
        a.arrow, ascending(a) ? 'asc' : 'desc');
      const b = await arrowFor(key);          // a second click reverses both
      eq(`...and reversing ${key} reverses the arrow with it`,
        b.arrow, ascending(b) ? 'asc' : 'desc');
      check(`...the second click really reversed ${key}`, b.arrow !== a.arrow, a.arrow + '->' + b.arrow);
    }
    check('Verdict is a text column, so it is the one the old hard-coded list missed',
      (await arrowFor('verdict')).text, 'verdict holds strings');
    await page.evaluate(() => { state.ordSortKey = 'iskTied'; state.ordSortDir = -1; renderOrders(); });

    /* ---------- (k) the relist fee, derived from the skill and overridable ---------- */
    section('the relist fee');
    eq('it is computed from the broker rate and Advanced Broker Relations',
      await page.inputValue('#relistPct'), RELIST_PCT.toFixed(3));
    eq('...with the skill resolved by name, not by a hardcoded id',
      await page.evaluate(() => advBrokerLevel), ADV_BROKER_LEVEL);
    // the discount is the character's, not a constant: level 4 earns 0.50 + 0.06 x 4
    near('...and the discount comes off the level rather than a fixed number',
      await page.evaluate(() => relistDiscount()), RELIST_DISCOUNT, 1e-12);
    eq('...so a different level would give a different discount',
      await page.evaluate(() => {
        const was = advBrokerLevel; advBrokerLevel = 5;
        const d = relistDiscount(); advBrokerLevel = was; return d;
      }), 0.8);
    const src = await page.textContent('#relistSrc');
    const srcTip = await page.getAttribute('#relistSrc', 'title');
    check('...and the line states the discount it applied', /74% Advanced Broker Relations/.test(src), src);
    check('...names the skill and the level it read', /Advanced Broker Relations \(level 4\)/.test(src), src);
    check('...publishes the per-level rule behind it, on hover',
      /50% \+ 6% per level/.test(srcTip), srcTip);
    check('...and warns that raising a price costs more than the rate, on hover',
      /full broker fee on the growth/.test(srcTip), srcTip);
    await page.fill('#relistPct', '0.75');
    await page.dispatchEvent('#relistPct', 'change');
    const dRep2 = await diagOf(page, 13);
    // 0.75% of 10,000 is 75, under EVE's flat 100 ISK per-order minimum, which the relist
    // fee goes through the same brokerOn() to respect
    near('typing a rate is used for every reprice — through the 100 ISK floor',
      dRep2.relistFee, 100, 1e-9);
    near('...and the reprice value follows it', dRep2.valueReprice, net(10 * 1000) - 100, 1e-6);
    check('...and the note stops claiming the computed derivation',
      /yours/.test(await page.textContent('#relistSrc'))
      && !/Advanced Broker Relations/.test(await page.textContent('#relistSrc')),
      await page.textContent('#relistSrc'));
    check('...while still warning that a raise pays the growth on top',
      /growth/.test(await page.getAttribute('#relistSrc', 'title')),
      await page.getAttribute('#relistSrc', 'title'));
    await page.reload();
    await page.waitForFunction("typeof runOrders === 'function'");
    eq('the override survives a reload', await page.inputValue('#relistPct'), '0.750');
    await page.waitForFunction(() => advBrokerLevel != null);   // the skill is read on load too
    await page.click('#relistReset');
    eq('...and reset goes back to the computed value',
      await page.inputValue('#relistPct'), RELIST_PCT.toFixed(3));

    /* ---------- (k2) the fee model against a real client -----------------------------
       Everything above runs on the mocked character. This block runs the page's own fee
       functions against readings taken off a live client, so the formulas are pinned to
       the game rather than to each other. Character: Broker Relations 5, Accounting 5,
       Advanced Broker Relations 4, Caldari State 0.15 unmodified, station corp 0.00.
       If CCP changes a coefficient, this is the block that goes red.                 */
    section('the fee model against a real client');
    const CLIENT = await page.evaluate(() => {
      const br = brokerPctFor({ brokerRelations: 5 }, 0.15, 0) / 100;
      const tax = salesTaxPctFor({ accounting: 5 }) / 100;
      const disc = RELIST_DISCOUNT_BASE + RELIST_DISCOUNT_PER_LEVEL * 4;
      const rl = br * (1 - disc);
      const vOld = 10 * 2166000;
      return {
        brokerPct: br * 100, taxPct: tax * 100, discount: disc, relistPct: rl * 100,
        // the sell window, on a 6,108,000 ISK order
        taxOn6108k: 6108000 * tax,
        brokerOn6108k: 6108000 * br,
        // four fresh listings spanning -55% to +304% of the regional average
        fresh: [100000, 222500, 450000, 900000].map(pp => 10 * pp * br),
        // four modify-order dialogs, same stack, old price 2,166,000
        modify: [500000, 1000000, 2166000, 4000000].map(pp => modifyFeeOn(10 * pp, vOld, rl, br)),
        // the growth term on its own, for the one reading that raises the price
        growthOnly: br * (10 * 4000000 - vOld),
        // 1 unit moved from 10.00 to 9.83: the rate says 0.038 ISK, the client said 100
        tinyOrder: modifyFeeOn(1 * 9.83, 1 * 10, rl, br),
        tinyOrderRate: rl * 1 * 9.83,
        floorAtMaxStanding: brokerPctFor({ brokerRelations: 5 }, 10, 10),
      };
    });
    near('sales tax is 7.5% less 11% per Accounting level', CLIENT.taxPct, 3.375, 1e-9);
    near('...which the client charged as 206,145 on a 6,108,000 ISK order',
      CLIENT.taxOn6108k, 206145, 5e-3);
    near('broker is 3% less 0.3pp per level less 0.03pp per faction standing point',
      CLIENT.brokerPct, 1.4955, 1e-9);
    near('...which the client charged as 91,345.14 on the same order',
      CLIENT.brokerOn6108k, 91345.14, 5e-3);
    // the same rate at every price: how far the listing sits from the regional average
    // does not enter a fresh listing's broker fee
    for (const [i, want] of [14955, 33274.875, 67297.5, 134595].entries())
      near(`...and holds flat on a fresh listing, reading ${i + 1} of 4`,
        CLIENT.fresh[i], want, 5e-3);

    near('Advanced Broker Relations 4 discounts a relist by 74%', CLIENT.discount, 0.74, 1e-12);
    near('...leaving 0.38883% of the new order value', CLIENT.relistPct, 0.38883, 1e-9);
    // three drops and one raise, all measured off the modify-order dialog
    near('the client charged 19,441.50 to move 10 units to 500,000', CLIENT.modify[0], 19441.50, 5e-3);
    near('...38,883.00 to move them to 1,000,000', CLIENT.modify[1], 38883.00, 5e-3);
    near('...84,220.58 to re-list them at the price they were already at',
      CLIENT.modify[2], 84220.58, 5e-3);
    near('...and 429,806.70 to RAISE them to 4,000,000', CLIENT.modify[3], 429806.70, 5e-3);
    /* the raise is the reading that proves the second term exists at all: the discounted
       rate alone would have been 155,532, a third of what the client actually charged */
    near('...of which the growth term is 274,274.70, at the UNDISCOUNTED broker rate',
      CLIENT.growthOnly, 274274.70, 5e-3);
    near('...so the discounted rate alone would have under-charged by that much',
      CLIENT.modify[3] - CLIENT.growthOnly, 155532, 5e-3);
    check('a drop pays no growth term at all',
      CLIENT.modify[0] < CLIENT.modify[1] && CLIENT.modify[1] < CLIENT.modify[2],
      CLIENT.modify.join('|'));

    /* the 100 ISK per-order floor reaches a relist as well as a fresh listing: a single
       Nova Rocket dropped from 10.00 to 9.83 computes to four hundredths of an ISK, and
       the client charged the whole hundred */
    check('the rate alone would have charged well under an ISK',
      CLIENT.tinyOrderRate < 0.05, String(CLIENT.tinyOrderRate));
    near('...but the 100 ISK per-order floor is what the client charged',
      CLIENT.tinyOrder, 100, 1e-9);

    // standings cap at 10.00, so the rate cannot go below this by any legitimate route
    near('the broker rate bottoms out at 1% rather than at zero',
      CLIENT.floorAtMaxStanding, 1, 1e-12);

    /* ---------- (k3) how many market slots the character has ------------------------
       5 to start with, then 4/8/16/32 per level of Trade, Retail, Wholesale and Tycoon.
       Slots are what runs out — the whole page ranks by ISK per slot-DAY — so the number
       is read off the character, with the four skills resolved by NAME. The ids below are
       deliberately not EVE's: if anything ever reached for a hardcoded id, this fails. */
    section('the order cap');
    const CAP = await page.evaluate(() => {
      const was = orderSkillIds, wasAll = EveAuth.allSkills;
      orderSkillIds = { Trade: 9201, Retail: 9202, Wholesale: 9203, Tycoon: 9204 };
      const capFor = lv => {
        EveAuth.allSkills = () => ({ 9201: lv[0], 9202: lv[1], 9203: lv[2], 9204: lv[3] });
        return orderCapOf(1).cap;
      };
      const out = {
        none: capFor([0, 0, 0, 0]),
        allFive: capFor([5, 5, 5, 5]),
        trade1: capFor([1, 0, 0, 0]),
        retail1: capFor([0, 1, 0, 0]),
        wholesale1: capFor([0, 0, 1, 0]),
        tycoon1: capFor([0, 0, 0, 1]),
        mixed: capFor([4, 3, 0, 0]),
        everyTerm: capFor([5, 4, 3, 2]),
      };
      // an id that never resolved must read as unknown, not as a silent zero
      orderSkillIds = { Trade: 9201 };
      EveAuth.allSkills = () => ({ 9201: 5 });
      out.partial = orderCapOf(1);
      orderSkillIds = was; EveAuth.allSkills = wasAll;
      return out;
    });
    eq('an untrained character has the base five', CAP.none, 5);
    eq('...and a maxed one has 305', CAP.allFive, 305);
    // each skill's own contribution, isolated
    eq('Trade is 4 a level', CAP.trade1 - CAP.none, 4);
    eq('Retail is 8', CAP.retail1 - CAP.none, 8);
    eq('Wholesale is 16', CAP.wholesale1 - CAP.none, 16);
    eq('Tycoon is 32', CAP.tycoon1 - CAP.none, 32);
    eq('every term adds up', CAP.everyTerm, 5 + 4 * 5 + 8 * 4 + 16 * 3 + 32 * 2);
    eq('Trade 4 with Retail 3 is the 45 slots the owner reads in the client',
      CAP.mixed, 45);
    eq('a skill whose id never resolved counts as nothing...',
      CAP.partial.cap, 5 + 4 * 5);
    check('...and is reported as unknown rather than as level zero',
      CAP.partial.levels.Trade === 5 && CAP.partial.levels.Retail === null,
      JSON.stringify(CAP.partial.levels));

    /* ---------- (l) patience drives the same window ---------- */
    section('patience');
    await fetchOrders(page);
    await setPatience(page, 30, 35);
    const dSlide30 = await diagOf(page, 17);
    eq('the window follows the patience field', dSlide30.window, 30);
    /* REWRITTEN: the old assertion was 30/20 capped at 1 — the queue fudge again. What
       the longer window really buys is more days of arrivals at the user's price, and ten
       units need about seventeen of them. */
    check('...and the extra fortnight is what carries the order over the line',
      dSlide30.chance > 0.9 && dSlide30.chance > dSlide.chance,
      dSlide30.chance + ' vs ' + dSlide.chance);
    eq('...which takes the warning off the row', dSlide30.reasons.length, 0);
    await setPatience(page, 14, 55);
    check('...and back', (await diagOf(page, 17)).reasons.length > 0);

    /* ---------- (m) the buy-order toggle ---------- */
    section('buy orders');
    await page.check('#ordShowBuy');
    const buyCells = await rowCells(page, 20);
    check('ticking the toggle shows the buy order', !!buyCells, 'no buy row');
    check('...marked as a buy', buyCells[1].includes('BUY'), buyCells[1]);
    check('...and separated by a line saying why they are different',
      (await page.textContent('#ordBody')).includes('ISK in escrow · no sell-side triage'),
      await page.textContent('#ordBody'));
    eq('...with no sell-side verdict on it', (await page.evaluate(() =>
      state.orders.diag[20] || null)), null);
    check('...and the ISK committed reported apart from the sell side',
      /ISK committed/.test(await page.textContent('#ordSummary')));
    await page.uncheck('#ordShowBuy');
    check('unticking hides it again', !(await rowCells(page, 20)));

    /* ---------- (n) degradation ---------- */
    section('degrading honestly');
    const dNoBook = await diagOf(page, 18);
    eq('an order whose book cannot be fetched gets no verdict', dNoBook.verdict, null);
    check('...and says the book is what is missing', /could not be fetched/.test(dNoBook.why), dNoBook.why);
    eq('...but its trend is still read from the history it does have',
      dNoBook.trendPctWk, 0);
    eq('an item with no history at all gets no chance', dBlind.chance, null);
    eq('...and no verdict', dBlind.verdict, null);
    check('...saying that plainly', /^no history in this region: no odds/.test(dBlind.why), dBlind.why);
    eq('...but the queue ahead of it is still counted', dBlind.queueAhead, 5);
    const spark = await page.evaluate(() => {
      const cell = id => document.querySelector(`#ordBody tr[data-order-id="${id}"] td.spark`);
      const marks = id => [...cell(id).querySelectorAll('[data-marker]')]
        .map(l => l.dataset.marker + '@' + l.dataset.price).join(',');
      return { drawn: cell(11).dataset.spark, marks: marks(11), blind: cell(14).dataset.spark };
    });
    eq('a row with history gets the Sell table sparkline', spark.drawn, 'ready');
    check('...with a marker at YOUR price and at the best competing sell',
      spark.marks.includes('yours@1000') && spark.marks.includes('sell@900'), spark.marks);
    eq('...and a row without history says so instead', spark.blind, 'none');

    /* ---------- (o) the structure path ---------- */
    section('player structures');
    const dStruct = await diagOf(page, 15);
    // the structure's own book: 3 units at 4,000 (someone else) + the user's 4 at 5,000
    eq('the structure book is read through the structure-market path', dStruct.bestOther, 4000);
    eq('...with the user\'s own units out of the queue', dStruct.queueAhead, 3);
    near('...and its buy side valued for the dump option', dStruct.dumpNow, net(4 * 2000), 1e-6);
    const structFetches = await page.evaluate(() => state.orders.list.filter(o => o.locationId === 1030049082711).length);
    eq('one order at that structure in the fixture', structFetches, 1);

    /* ---------- (p) prevention, back in Sell loot mode ---------- */
    section('filtering by verdict');
    const shownIds = () => page.evaluate(() =>
      [...document.querySelectorAll('#ordBody tr[data-order-id]')].map(tr => Number(tr.dataset.orderId)));
    const verdictOf = id => page.evaluate(i => (state.orders.diag[i] || {}).verdict, String(id));
    const setFlt = async v => {
      await page.selectOption('#ordFltVerdict', v);
      await page.waitForFunction(x => state.ordFilterVerdict === x, v);
    };
    const allIds = await shownIds();
    await setFlt('reprice');
    let ids = await shownIds();
    check('REPRICE only shows repriced orders', ids.length > 0, JSON.stringify(ids));
    const vs = await Promise.all(ids.map(verdictOf));
    check('...and nothing else', vs.every(v => v === 'reprice'), JSON.stringify(vs));

    /* The filter used to carry a fourth option, "stalled only", reading the deleted
       second verdict. Three verdicts is the whole vocabulary now. */
    const opts = await page.$$eval('#ordFltVerdict option', els => els.map(e => e.value));
    eq('the filter offers exactly all + the three verdicts', opts.join(','), 'all,reprice,dump,hold');

    await page.check('#ordShowBuy');
    await setFlt('hold');
    ids = await shownIds();
    const anyBuy = await page.evaluate(list =>
      list.some(i => (state.orders.list.find(o => o.orderId === i) || {}).isBuy), ids);
    check('a buy order is never triaged, so a verdict filter hides it rather than passing it',
      anyBuy === false, JSON.stringify(ids));
    await page.uncheck('#ordShowBuy');

    /* Copy TSV used to read ordRows() directly, so it copied every order while the table
       showed a filtered handful and the status line still said "copied N orders". The Sell
       side announces its hidden rows; this one said nothing at all. */
    await setFlt('dump');
    const filteredTsv = await page.evaluate(() => ({
      shown: document.querySelectorAll('#ordBody tr[data-order-id]').length,
      count: document.getElementById('ordCount').textContent,
      lines: ordTsv().split('\n').length - 1,
      // by header NAME: a hard-coded column index silently reads the wrong field the
      // moment a column is inserted anywhere to its left
      names: (() => {
        const rows = ordTsv().split('\n');
        const at = rows[0].split('\t').indexOf('Verdict');
        return rows.slice(1).map(l => l.split('\t')[at]);
      })(),
    }));
    check('the verdict filter really narrowed the table',
      filteredTsv.shown > 0 && /\d+\/\d+ orders/.test(filteredTsv.count), filteredTsv.count);
    eq('Copy TSV hands over the orders the table is showing, not a second set',
      filteredTsv.lines, filteredTsv.shown);
    check('...and every copied row really carries that verdict',
      filteredTsv.names.every(v => v === 'CANCEL & DUMP'), JSON.stringify(filteredTsv.names));
    await page.click('#btnOrdTsv');
    await page.waitForFunction(n => document.getElementById('copyStatusOrd').textContent
      === `copied ${n} orders`, filteredTsv.shown);
    eq('...and the status line counts what it actually copied',
      await page.textContent('#copyStatusOrd'), `copied ${filteredTsv.shown} orders`);

    await page.evaluate(() => { document.getElementById('copyStatusOrd').textContent = ''; });

    await page.fill('#ordFilter', 'zzz-no-such-order');
    await page.dispatchEvent('#ordFilter', 'input');
    await page.waitForFunction(() => state.ordFilter === 'zzz-no-such-order');
    eq('the name filter scopes it too — nothing shown, nothing copied',
      await page.evaluate(() => ordTsv().split('\n').length - 1), 0);
    await page.fill('#ordFilter', '');
    await page.dispatchEvent('#ordFilter', 'input');
    await page.waitForFunction(() => state.ordFilter === '');

    await setFlt('all');
    eq('"all orders" puts every row back', (await shownIds()).length, allIds.length);

    section('the ↗ button — copy the price, open the market window');
    const opened = [];
    await s.context.route('**/ui/openwindow/marketdetails/**', route => {
      const u = new URL(route.request().url());
      opened.push({ typeId: Number(u.searchParams.get('type_id')),
                    auth: route.request().headers()['authorization'] || null });
      route.fulfill({ status: 204, body: '' });
    });
    const repId = await page.evaluate(() => {
      const hit = Object.entries(state.orders.diag).find(([, d]) => d && d.verdict === 'reprice');
      return hit ? Number(hit[0]) : null;
    });
    check('there is a REPRICE row to act on', repId != null, String(repId));

    const act = await page.evaluate(id => {
      const tr = document.querySelector(`#ordBody tr[data-order-id="${id}"]`);
      const b = tr.querySelector('button.rowact');
      const o = state.orders.list.find(x => x.orderId === id);
      const d = state.orders.diag[id];
      return b ? { title: b.title, price: d.repricePrice, typeId: o.typeId, charId: o.charId,
                   charName: o.charName } : null;
    }, repId);
    check('the row carries a ↗ button', !!act, JSON.stringify(act));
    check('...whose tooltip states both halves and the client it will open in',
      /^copy: /.test(act.title) && /\nopen: market window/.test(act.title)
      && act.title.includes(act.charName) && act.title.includes('esi-ui.open_window.v1'),
      JSON.stringify(act.title));

    // clear the shared status first: waiting on text an earlier click left behind would
    // let this pass before the market window was ever requested
    await page.evaluate(() => { document.getElementById('copyStatusOrd').textContent = ''; });
    await page.click(`#ordBody tr[data-order-id="${repId}"] button.rowact`);
    await page.waitForFunction(() => /copied/.test(document.getElementById('copyStatusOrd').textContent),
      null, { timeout: 10000 });
    eq('clicking it opens exactly one market window', opened.length, 1);
    eq('...for that order\u2019s item', opened[0].typeId, act.typeId);
    const ownerTok = await page.evaluate(id => EveAuth.token(id), act.charId);
    eq('...on the client that OWNS the order, not the active character',
      opened[0].auth, 'Bearer ' + ownerTok);
    const said = await page.$eval('#copyStatusOrd', el => el.textContent);
    check('...and says the price went to the clipboard', /copied/.test(said), said);

    const holdTip = await page.evaluate(() => {
      const hit = Object.entries(state.orders.diag).find(([, d]) => d && d.verdict === 'hold');
      if (!hit) return null;
      const tr = document.querySelector(`#ordBody tr[data-order-id="${hit[0]}"]`);
      const b = tr && tr.querySelector('button.rowact');
      return b ? b.title : null;
    });
    check('a row with no new price offers the window alone, and promises no copy',
      holdTip && /^open: market window/.test(holdTip) && !/copy:/.test(holdTip), JSON.stringify(holdTip));

    section('the reprice price is copyable on its own');
    const priceSel = `#ordBody tr[data-order-id="${repId}"] td span[data-copy]`;
    const declared = await page.evaluate(sel => {
      const span = document.querySelector(sel);
      return span ? { spanCopy: span.dataset.copy, tdCopy: span.closest('td').dataset.copy } : null;
    }, priceSel);
    check('the price span declares its own value', declared && declared.spanCopy, JSON.stringify(declared));
    eq('...while the cell still declares the verdict', declared.tdCopy, 'REPRICE');
    // the copy is async (clipboard), so the flash lands a tick after the click
    await page.click(priceSel);
    const flashed = await page.waitForFunction(
      sel => document.querySelector(sel).classList.contains('copied'), priceSel, { timeout: 5000 })
      .then(() => true).catch(() => false);
    const tdFlashed = await page.evaluate(sel =>
      document.querySelector(sel).closest('td').classList.contains('copied'), priceSel);
    check('clicking the price copies the PRICE, not the word REPRICE',
      flashed && !tdFlashed, JSON.stringify({ flashed, tdFlashed }));

    section('the duplicate-order flag in Sell loot mode');
    await page.click('#modeSell');
    await page.evaluate(() => { document.getElementById('histOn').checked = false; });
    await page.fill('#inv', 'Hold Widget\t20\nTritanium\t100');
    await page.dispatchEvent('#inv', 'input');
    await page.click('#btnEsi');
    await page.waitForFunction(() => !document.getElementById('btnEsi').disabled && !state.esiRunning,
      null, { timeout: 20000 });
    const sellRows = await page.evaluate(() => state.rows.map(r =>
      ({ name: r.name, strategy: r.strategy, dup: r.dupOrders.length, flags: r.flags.map(f => f.t),
         flagTips: r.flags.map(f => f.ttl || '') })));
    const dupRow = sellRows.find(r => r.name === 'Hold Widget');
    eq('the item you already have listed here is matched', dupRow.dup, 1);
    check('...and flagged before you list a second order against yourself',
      dupRow.flags.includes('dup×1'), JSON.stringify(dupRow.flags));
    check('...with the tooltip naming the price it is already up at',
      dupRow.flagTips.some(t => /open sell orders here: 1/.test(t) && /first at: 1,000 ISK/.test(t)),
      JSON.stringify(dupRow.flagTips));
    check('...and the second broker fee it would cost',
      dupRow.flagTips.some(t => /same queue, second broker fee/.test(t)), JSON.stringify(dupRow.flagTips));
    const other = sellRows.find(r => r.name === 'Tritanium');
    check('an item you have no order for is not flagged',
      other.dup === 0 && !other.flags.some(f => /^dup/.test(f)), other.flags);
    await s.close();

    /* ---------- (q2) THE ACCEPTANCE CASE ---------- */
    /* The page computed the right answer and threw it away. fillOutlook has been in the
       file for a pass now, correctly reporting fillFrac 0 / capped "queue" for this exact
       row, while the verdict was still made out of a window-hit rate multiplied by a
       queue fudge. This section pins the wiring: the old number is still computable, it
       still says ~15%, and the verdict no longer follows it. */
    section('the order the page used to tell him to keep');
    const sA = await openOrders(browser, server, { orders: ACCEPT_ORDERS });
    await sA.page.click('#modeOrders');
    // the same explicit fortnight the rest of this file works out its arithmetic against
    await setPatience(sA.page, 14, 55);
    await fetchOrders(sA.page);
    const skin = await diagOf(sA.page, 21);
    const liquid = await diagOf(sA.page, 22);

    // the number that used to decide, re-derived from the page's own definition of it
    const wasChance = await sA.page.evaluate(() => {
      const e = ordEntry(state.orders.list.find(o => o.orderId === 21));
      const hit = hitRateOf(e, 177600, 14);
      const d = state.orders.diag[21];
      // window / days for the queue to clear, capped at 1 — the old temper, verbatim
      const qf = Math.min(1, d.window / Math.max(d.daysToFill, 0.5));
      return { hit: hit.p, qf, chance: hit.p * qf };
    });
    check('the old metric reads this price as reached in most windows',
      wasChance.hit > 0.85 && wasChance.hit < 0.95, String(wasChance.hit));
    check('...tempered by the queue to the sort of number that reads like a real chance',
      wasChance.chance > 0.12 && wasChance.chance < 0.16, String(wasChance.chance));
    check('...and that much of the listed value dwarfs the buy book — why it said HOLD',
      wasChance.chance * 5 * 177600 * (1 - TAX) > 5 * 5000 * (1 - TAX) * 4,
      String(wasChance.chance * 5 * 177600 * (1 - TAX)));

    // ...and what the model says about the very same row
    eq('the model expects not one unit of it to sell', skin.chance, 0);
    eq('...nor even one, on its own odds', skin.chanceAny, 0);
    eq('...and names the queue as the reason, not the price', skin.capped, 'queue');
    eq('...off ESI regional volume, so it is an upper bound', skin.bound, 'upper');
    eq('178 units really are ahead of him', skin.queueAhead, 178);
    check('...on a market that trades about two units a day',
      skin.volDay > 1.9 && skin.volDay <= 2, String(skin.volDay));

    // THE FLIP
    eq('the verdict follows the model', skin.verdict, 'dump');
    check('...with holding taken out of the running by the floor, not outscored by it',
      skin.floored.includes('hold'), JSON.stringify(skin.floored));
    check('...and repricing to the back of the same queue refused with it',
      skin.floored.includes('reprice'), JSON.stringify(skin.floored));
    /* THE POINT OF THE GATE. With a zero fill, holding is worth exactly the give-up
       branch — the same stack dumped at the end of the window instead of today — and on a
       market drifting up that is MORE ISK than dumping now. Score alone would keep the
       order up forever. */
    check('...even though holding still SCORES higher than dumping',
      skin.valueHold > skin.valueDump, skin.valueHold + ' vs ' + skin.valueDump);
    near('...being the buy book carried to day 14 by the trend', skin.valueHold,
      skin.valueDump * skin.decay, 1e-6);
    eq('...and the direction is not what did it: this market is not classed falling',
      skin.dir, 'flat');
    near('...the buy book being all this is really worth', skin.valueDump,
      5 * 5000 * (1 - TAX), 1e-6);
    check('the row says so on the badge', /^CANCEL & DUMP/.test(skin.why), skin.why);
    check('...naming the floor that took the other two away',
      /^floor: .*under \d+% \("14d · 55%"\) · not offered$/m.test(skin.why), skin.why);
    check('...and what kind of number the odds are',
      /^odds: upper bound · source ESI regional, both sides/m.test(skin.why), skin.why);

    // THE CONTROL — the liquid at-market order must not have moved
    near('at the front of a deep book the whole order still sells', liquid.chance, 1, 1e-9);
    eq('...and nothing works against it', liquid.reasons.length, 0);
    eq('...nor floored', liquid.floored.length, 0);
    eq('...and it is held', liquid.verdict, 'hold');
    near('...worth the full listed value, net of tax', liquid.valueHold,
      10000 * 5 * (1 - TAX), 1e-6);
    check('...which beats dumping it into the buy book',
      liquid.valueHold > liquid.valueDump, liquid.valueHold + ' vs ' + liquid.valueDump);
    const cellsA = await rowCells(sA.page, 21);
    const cellsL = await rowCells(sA.page, 22);
    check('the hopeless row reads as a bounded zero on screen',
      cellsA.includes('≤0%'), JSON.stringify(cellsA));
    check('...and the liquid one as a bounded certainty',
      cellsL.includes('≤100%'), JSON.stringify(cellsL));
    await sA.close();

    /* ---------- (q) a login without the structure scope ---------- */
    section('a structure with no market access');
    const s2 = await openOrders(browser, server, {
      scopes: H.ALL_SCOPES.filter(x => x !== STRUCT_SCOPE),
    });
    await s2.page.click('#modeOrders');
    await fetchOrders(s2.page);
    const dNoScope = await diagOf(s2.page, 15);
    eq('the structure order gets no verdict', dNoScope.verdict, null);
    check('...and names the missing scope rather than guessing',
      dNoScope.note.includes(STRUCT_SCOPE), dNoScope.note);
    eq('...while the NPC-station orders are diagnosed as usual',
      (await diagOf(s2.page, 11)).verdict, 'hold');
    await s2.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
