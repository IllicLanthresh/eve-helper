/* Proves the Adam4EVE mock in helper.js does what the tracker suites will rely on.

   Nothing here touches index.html. The mock is shared plumbing, and plumbing that is only
   exercised through the suites it serves fails in the confusing direction — a page bug and
   a mock bug look identical. So the two filename rules that 404 against the real host, the
   404/503/slow/truncated replies, the counters, and the ordering rule for the network
   backstop are all asserted directly, against a blank document from the local server. */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./helper.js');
const { check, eq, run, launch, startServer, mockA4E, blockNetwork } = H;
const BASE = 'https://static.adam4eve.eu/MarketOrdersTrades';

run('tracker-mock', async () => {
  const srv = await startServer();
  const browser = await launch();
  const ctx = await browser.newContext();

  const leaked = [];
  await blockNetwork(ctx, u => leaked.push(u));   // FIRST — it is the backstop, not an override

  const c = await mockA4E(ctx, {
    days: {
      '2026-08-17': [{ hub: 60003760, typeId: 34, buy: 0, day: '2026-08-17',
                       amount: 100, high: 4, low: 3.9, avg: 3.95, orderNum: 7, iskValue: 395 }],
      '2026-08-18': 'location_id;region_id;type_id;is_buy_order;has_gone;scanDate;amount;high;low;avg;orderNum;iskValue\n60003760;10000002;34;0;0;2026-08-18;5;1;1;1;1;5\n',
      '2026-08-19': fs.readFileSync(path.join(H.FIXTURES, 'truncated.csv'), 'utf8'),
    },
    missing: ['2026-08-21'],
    fail: ['2026-08-20'],
    weeklyMissing: ['2026-30'],
    slow: { '2026-08-18': 400, '2026-08-11': 250, '2026-08-12': 250 },
  });

  const page = await ctx.newPage();
  // a plain document from the local server, NOT index.html: this suite is about the mock,
  // so it must not go red when the page it is eventually pointed at is mid-edit
  await page.goto(srv.url + '/tests/fixtures/manifest.json');

  const get = u => page.evaluate(async url => {
    const t0 = performance.now();
    try {
      const r = await fetch(url);
      return { status: r.status, body: await r.text(), ms: performance.now() - t0 };
    } catch (e) { return { status: 'THREW', body: String(e), ms: performance.now() - t0 }; }
  }, u);

  H.section('serving days');
  const a = await get(`${BASE}/2026/marketOrderTrades_daily_2026-08-17.csv`);
  eq('a programmatic day is 200', a.status, 200);
  check('the object row became the twelve published columns',
    a.body.split('\n')[1] === '60003760;10000002;34;0;0;2026-08-17;100;4;3.9;3.95;7;395', a.body.split('\n')[1]);
  eq('the header is verbatim', a.body.split('\n')[0], H.A4E_HEADER);

  const raw = await get(`${BASE}/2026/marketOrderTrades_daily_2026-08-18.csv`);
  eq('a raw body is served verbatim', raw.body.split('\n')[1], '60003760;10000002;34;0;0;2026-08-18;5;1;1;1;1;5');
  check('a slow day actually takes its delay', raw.ms >= 380, raw.ms);

  const trunc = await get(`${BASE}/2026/marketOrderTrades_daily_2026-08-19.csv`);
  eq('a truncated body is 200 with a broken last line', trunc.status, 200);
  check('the last line of the truncated body is not a whole row',
    trunc.body.split('\n').pop().split(';').length < 12, JSON.stringify(trunc.body.slice(-40)));

  H.section('absent and failing days');
  eq('an unpublished day is 404', (await get(`${BASE}/2026/marketOrderTrades_daily_2026-08-21.csv`)).status, 404);
  eq('a failing day is 503', (await get(`${BASE}/2026/marketOrderTrades_daily_2026-08-20.csv`)).status, 503);
  eq('a day with no fixture and no opts entry is 404',
    (await get(`${BASE}/2019/marketOrderTrades_daily_2019-01-01.csv`)).status, 404);
  eq('a daily filed under the wrong year is 404',
    (await get(`${BASE}/2025/marketOrderTrades_daily_2026-08-17.csv`)).status, 404);

  H.section('fixtures');
  const fx = await get(`${BASE}/2026/marketOrderTrades_daily_2026-08-10.csv`);
  eq('a fixture day is served when opts does not name it', fx.status, 200);
  check('the fixture day carries real rows', /60003760;10000002;34;0;0;2026-08-10;3250944708/.test(fx.body));

  const wk = await get(`${BASE}/2026/marketOrderTrades_weekly_2026-33.csv`);
  eq('the fixture week is served', wk.status, 200);
  eq('the fixture week has every distilled row', wk.body.trim().split('\n').length - 1, 380);

  H.section('the two filename rules that 404 against the real host');
  eq('a zero-padded week number is 404',
    (await get(`${BASE}/2026/marketOrderTrades_weekly_2026-01.csv`)).status, 404);
  eq('the same week unpadded is 200',
    (await get(`${BASE}/2026/marketOrderTrades_weekly_2026-1.csv`)).status, 200);
  eq('the year-boundary week lives under its ISO week-year',
    (await get(`${BASE}/2025/marketOrderTrades_weekly_2026-1.csv`)).status, 404);
  const yb = await get(`${BASE}/2026/marketOrderTrades_weekly_2026-1.csv`);
  check('week 1 of 2026 starts in December 2025', /;2025-12-29;/.test(yb.body));
  check('week 1 of 2026 ends in January 2026', /;2026-01-04;/.test(yb.body));
  eq('a missing weekly is 404', (await get(`${BASE}/2026/marketOrderTrades_weekly_2026-30.csv`)).status, 404);

  H.section('a weekly assembled out of the days');
  const asm = await get(`${BASE}/2026/marketOrderTrades_weekly_2026-34.csv`);
  eq('the assembled week is 200', asm.status, 200);
  check('it holds the days of that ISO week',
    /;2026-08-17;/.test(asm.body) && /;2026-08-18;/.test(asm.body), asm.body.slice(0, 200));
  check('it does not reach into another ISO week',
    !/;2026-08-16;/.test(asm.body) && !/;2026-08-24;/.test(asm.body));

  H.section('counters');
  const before = c.urls.length;
  await Promise.all([
    get(`${BASE}/2026/marketOrderTrades_daily_2026-08-11.csv`),
    get(`${BASE}/2026/marketOrderTrades_daily_2026-08-12.csv`),
  ]);
  check('urls records every tracker request in order', c.urls.length === before + 2, c.urls.length);
  check('maxInflight notices two at once', c.maxInflight >= 2, c.maxInflight);
  check('daily and weekly are counted apart', c.daily > 0 && c.weekly > 0, c.daily + '/' + c.weekly);

  H.section('nothing reaches the real network');
  eq('an unrouted host is aborted', (await get('https://api.adam4eve.eu/v1/tracker')).status, 'THREW');
  eq('an unknown tracker path is 404, not a real request',
    (await get(`${BASE}/MarketOrdersTrades.txt`)).status, 404);

  check('the backstop reported what it blocked', leaked.length > 0 && leaked.some(u => u.includes('api.adam4eve.eu')),
    JSON.stringify(leaked));
  await browser.close();
  await srv.close();
});
