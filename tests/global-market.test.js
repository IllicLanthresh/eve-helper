/* PLEX does not trade in any hub region.

   CCP moved it to a global market — region 19000001, GPMR-01 — and The Forge kept
   answering the question truthfully: /markets/10000002/orders/?type_id=44992 returns []
   and its history series stops on the day of the move. Nothing errors, so the app used
   to report "no book, no history" about the single most liquid item in the game.

   These checks pin the fallback: an empty REGIONAL feed sends the type to the global
   market once, the region that answered is the one the history comes from, and a type
   whose own region did answer is never asked twice. */
'use strict';
const H = require('./helper');

const FORGE  = 10000002;
const GLOBAL = 19000001;
const JITA   = 60003760;

const TYPE_IDS = { PLEX: 44992, Tritanium: 34, 'Dead Widget': 99999 };

const dayAgo = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const series = (from, to, price) => {
  const out = [];
  for (let i = from; i >= to; i--) out.push({
    date: dayAgo(i), average: price, highest: price * 1.02, lowest: price * 0.98,
    volume: 40000, order_count: 900,
  });
  return out;
};

/* The shape that matters: on a global market every buy is range 'region' and rests
   wherever its owner put it, while the sells the hub can list against are the ones
   sitting in that station. Both facts come from the live book (994 orders, all
   range 'region', 74 sells at Jita 4-4). */
const GLOBAL_PLEX = {
  buys: [
    { p: 4576000, v: 120, loc: 60008494, range: 'region' },   // Amarr — reaches Jita anyway
    { p: 4570000, v: 300, loc: JITA,     range: 'region' },
    { p: 4500000, v: 900, loc: 60011866, range: 'region' },
  ],
  sells: [
    { p: 4768000, v: 889, loc: JITA },
    { p: 4790000, v: 200, loc: JITA },
    { p: 4600000, v: 500, loc: 60008494 },                    // Amarr — not listable here
  ],
  hist: series(119, 0, 4537000),
};

/* What The Forge still says about PLEX: no orders, and a series frozen on the move. */
const FORGE_PLEX = { buys: [], sells: [], hist: series(415, 409, 4100000) };

const FORGE_TRIT = {
  buys:  [{ p: 5.10, v: 900000, loc: JITA, range: 'station' }],
  sells: [{ p: 5.60, v: 800000, loc: JITA }],
  hist:  series(119, 0, 5.4),
};

/* A type that genuinely trades nowhere: the fallback must run, find nothing, and leave
   the row unpriced rather than inventing a market for it. */
const NOWHERE = { buys: [], sells: [], hist: [] };

const BOOKS = {
  [FORGE]:  { 44992: FORGE_PLEX, 34: FORGE_TRIT, 99999: NOWHERE },
  [GLOBAL]: { 44992: GLOBAL_PLEX, 34: NOWHERE,   99999: NOWHERE },
};

/* Region-aware order and history routes. mockEsi serves one book for every region, which
   is exactly the assumption under test, so these are registered after it and win. */
async function mockRegions(context, asked) {
  const bookFor = url => {
    const u = new URL(url);
    const region = Number((u.pathname.match(/markets\/(\d+)\//) || [])[1]);
    const typeId = Number(u.searchParams.get('type_id'));
    asked.push({ region, typeId, kind: /\/history\//.test(u.pathname) ? 'history' : 'orders' });
    return (BOOKS[region] || {})[typeId] || NOWHERE;
  };
  await context.route('**/markets/*/orders/**', route => {
    const book = bookFor(route.request().url());
    const typeId = Number(new URL(route.request().url()).searchParams.get('type_id'));
    let oid = typeId * 1000;
    const orders = [
      ...book.buys.map(b => ({ order_id: oid++, type_id: typeId, is_buy_order: true, price: b.p,
        volume_remain: b.v, min_volume: 1, location_id: b.loc, system_id: 30000142,
        range: b.range || 'station' })),
      ...book.sells.map(s => ({ order_id: oid++, type_id: typeId, is_buy_order: false, price: s.p,
        volume_remain: s.v, min_volume: 1, location_id: s.loc, system_id: 30000142,
        range: 'station' })),
    ];
    route.fulfill(H.json(orders));
  });
  await context.route('**/markets/*/history/**', route =>
    route.fulfill(H.json(bookFor(route.request().url()).hist || [])));
}

H.run('global-market', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  const asked = [];
  const leaked = [];
  try {
    const context = await browser.newContext();
    await H.blockNetwork(context, u => leaked.push(u));
    await H.mockEsi(context, { typeIds: TYPE_IDS, books: {} });
    // the one button fetches the tracker too; this suite is about ESI regions, so the
    // tracker is served empty rather than left to reach the real host
    await H.mockA4E(context, { fixtures: false });
    await mockRegions(context, asked);
    const page = await context.newPage();
    H.watchPage(page, 'global-market');
    await page.goto(server.url + '/index.html');
    await page.waitForFunction("typeof rebuild === 'function'");

    await page.evaluate(() => {
      document.getElementById('histOn').checked = true;
      document.getElementById('histDays').value = '90';
    });
    await page.fill('#inv', 'PLEX\t9031\nTritanium\t1000000\nDead Widget\t5');
    await page.dispatchEvent('#inv', 'input');
    await page.waitForFunction(() => !document.getElementById('btnEsi').disabled);
    await page.click('#btnEsi');
    await page.waitForFunction(() => !document.getElementById('btnEsi').disabled && !state.esiRunning,
      null, { timeout: 30000 });
    await page.waitForFunction(() => state.fetchedHist === true);

    const seen = await page.evaluate(() => {
      const e = state.esi.get('plex') || {};
      const row = state.rows.find(r => r.name === 'PLEX') || null;
      return {
        region: e.region ?? null,
        typeId: e.typeId ?? null,
        buyLevels: (e.buyLevels || []).length,
        sellLevels: (e.sellLevels || []).length,
        bestSell: e.bestSell ?? null,
        histRows: (e.hist || []).length,
        histNewest: (e.hist || []).length ? e.hist[e.hist.length - 1].date : null,
        priced: !!row,
        hist: row ? row.hist : null,
        tritRegion: (state.esi.get('tritanium') || {}).region ?? null,
        unpriced: state.unpriced.map(u => u.name + ' · ' + u.reason),
      };
    });

    H.section('PLEX reaches its own market');
    H.eq('type id resolved', seen.typeId, 44992);
    H.eq('book came from the global region', seen.region, GLOBAL);
    H.check('the row is priced', seen.priced, 'PLEX still unpriced');
    H.check('history is not the frozen Forge series',
      seen.histNewest === dayAgo(0), 'newest history row ' + seen.histNewest);
    H.eq('history rows', seen.histRows, 120);
    H.check('a history reference exists', seen.hist != null && seen.hist > 0, 'hist ' + seen.hist);

    H.section('the hub still decides what is listable');
    H.eq('sells narrow to this station', seen.sellLevels, 2);
    H.eq('best sell is the cheapest one resting here', seen.bestSell, 4768000);
    H.eq("region-range buys count wherever they rest", seen.buyLevels, 3);

    H.section('the fallback fires only where the region came back empty');
    const forgePlexOrders  = asked.filter(a => a.region === FORGE  && a.typeId === 44992 && a.kind === 'orders').length;
    const globalPlexOrders = asked.filter(a => a.region === GLOBAL && a.typeId === 44992 && a.kind === 'orders').length;
    const globalTrit       = asked.filter(a => a.region === GLOBAL && a.typeId === 34).length;
    const globalPlexHist   = asked.filter(a => a.region === GLOBAL && a.typeId === 44992 && a.kind === 'history').length;
    const forgePlexHist    = asked.filter(a => a.region === FORGE  && a.typeId === 44992 && a.kind === 'history').length;
    H.eq('the hub region is asked first', forgePlexOrders, 1);
    H.eq('the global market is asked once', globalPlexOrders, 1);
    H.eq('history follows the region that answered', globalPlexHist, 1);
    H.eq('the frozen Forge series is never fetched', forgePlexHist, 0);
    H.eq('a type its own region answered is never asked twice', globalTrit, 0);
    H.eq('that type keeps its own region', seen.tritRegion, FORGE);

    H.section('a type that trades nowhere still says so');
    H.eq('one unpriced row', seen.unpriced.length, 1);
    H.check('the message names the market that was asked',
      /^Dead Widget · no book, no history · Jita/.test(seen.unpriced[0] || ''),
      seen.unpriced[0]);
    H.eq('the dead type was tried in both regions',
      asked.filter(a => a.typeId === 99999 && a.kind === 'orders').length, 2);

    H.check('nothing reached the real network', leaked.length === 0, leaked.join(', '));
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
