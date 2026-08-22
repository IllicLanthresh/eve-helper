/* The Adam4EVE traded-volume path: fetch, parse, cache, and what the model and the table
   do with it.

   The tool used to have one volume number — ESI's regional total, both sides of the book
   pooled across every station in the region — and a fill model that multiplied it by a
   capture constant of 1 because ESI does not publish which side was the aggressor. Only a
   trade that hits a SELL order fills a resting sell order, so that constant was the
   largest guess in the whole model and everything downstream came out as an upper bound.

   Adam4EVE differences the hub order books every 10-15 minutes and publishes the two
   sides separately, per station, per day. This suite covers the whole route: the URL
   shapes (the one place a plausible-looking bug hides), the 404 policy, the coverage
   manifest that stops a day being fetched twice, the volume-weighted price that has to be
   computed rather than read off the published `avg` column, and the three ways a row can
   have no tracker number — which must not look alike on screen.

   Nothing here touches the network: the static host is routed in this file, the same way
   helper.js routes ESI. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./helper');
const { check, eq, near, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };
const JITA = 60003760, AMARR = 60008494;

const TYPE_IDS = {
  Tritanium: 34,
  'Dump Widget': 9101,       // most of its volume is sold INTO buy orders
  'Buy Only': 9102,          // tracker rows, zero sell-side units
  'Ghost Widget': 9103,      // no tracker row at all
  'Clamp Widget': 9104,      // iskValue/amount lands outside the day's band
  'Late Buyer': 9106,        // its buy side starts 26 days after its sell side
};

const day = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
const series = (n, f) => {
  const out = [];
  for (let t = n - 1; t >= 0; t--) out.push(Object.assign({ date: day(t) }, f(t)));
  return out;
};
const FLAT = series(200, () => ({ average: 100, highest: 110, lowest: 90, volume: 10000, orders: 500 }));

const BOOKS = {
  Tritanium: { buys: [{ p: 3.5, v: 100000 }], sells: [{ p: 4, v: 100000 }],
    hist: series(200, () => ({ average: 4, highest: 4.2, lowest: 3.8, volume: 10000, orders: 300 })) },
  'Dump Widget': { buys: [{ p: 90, v: 5000 }], sells: [{ p: 100, v: 5000 }], hist: FLAT },
  'Buy Only': { buys: [{ p: 40, v: 5000 }], sells: [{ p: 50, v: 5000 }], hist: FLAT },
  'Ghost Widget': { buys: [{ p: 40, v: 5000 }], sells: [{ p: 50, v: 5000 }], hist: FLAT },
  'Clamp Widget': { buys: [{ p: 90, v: 5000 }], sells: [{ p: 100, v: 5000 }], hist: FLAT },
  'Late Buyer': { buys: [{ p: 90, v: 5000 }], sells: [{ p: 100, v: 5000 }], hist: FLAT },
};

const PASTE = ['Tritanium\t1000', 'Dump Widget\t100', 'Buy Only\t100',
  'Ghost Widget\t100', 'Clamp Widget\t100', 'Late Buyer\t100'].join('\n');

/* ---------- the static host, in fixture form ----------------------------------------
   Semicolon separated, one header line, the columns in the order A4E publishes them.
   `avg` is written BELOW `low` on purpose: that is what the real dumps do on 62.8% of
   Jita rows, and reading it would put negative mass in dayReach's lower segment. */
const A4E_HEAD = 'location_id;region_id;type_id;is_buy_order;has_gone;scanDate;amount;high;low;avg;orderNum;iskValue';
const HUBS = [JITA, AMARR, 60011866, 60005686, 60004588];

/* per type: units/day on each side, the day's band, and the volume-weighted price the
   iskValue column has to reproduce */
const SIDES = {
  34:   { sell: 8000, buy: 2000, lo: 3.89, hi: 3.97, vw: 3.93 },
  9101: { sell: 220,  buy: 780,  lo: 90,   hi: 110,  vw: 100 },
  9102: { sell: 0,    buy: 500,  lo: 40,   hi: 50,   vw: 45 },
  9104: { sell: 300,  buy: 100,  lo: 90,   hi: 110,  vw: 200 },   // outside the band: clamped
  /* The population the sell-share column exists for: the two sides of one book started
     trading here on different days. buyDays keeps the buy rows to the four most recent
     days, so over a 30-day window the sides carry 30 days of prints and 4. */
  9106: { sell: 100,  buy: 300,  lo: 90,   hi: 110,  vw: 100, buyDays: 4 },
};

function a4eRows(d) {
  const out = [];
  // days back from today, so one side of a book can be made to start later than the other
  const age = Math.round((Date.parse(todayUTC() + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400e3);
  for (const loc of HUBS) {
    for (const [tid, s] of Object.entries(SIDES)) {
      for (const isBuy of [0, 1]) {
        const amount = isBuy ? s.buy : s.sell;
        if (!amount) continue;
        if (isBuy && s.buyDays && age > s.buyDays) continue;
        // the published avg, deliberately below `low` — the trap this suite exists for
        const avg = s.lo - 1;
        out.push([loc, 10000002, tid, isBuy, 0, d, amount, s.hi, s.lo, avg,
          95, Math.round(amount * s.vw * 1e4) / 1e4].join(';'));
      }
    }
  }
  // a station the tool does not track: every parser must drop it
  out.push([60000001, 10000002, 34, 0, 0, d, 999999, 4, 3, 2, 5, 3500000].join(';'));
  return out;
}

function isoWeekOf(d) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  return { y, w: Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400e3 + 1) / 7) };
}
const todayUTC = () => new Date().toISOString().slice(0, 10);
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

/* Routes the static host. `opts.missing` answers 404 for those days (a daily file), and
   `opts.only` restricts which days carry rows at all. Records every URL so a suite can
   assert WHICH files were asked for, and in what order. */
async function mockA4E(context, opts) {
  opts = opts || {};
  const counters = { daily: 0, weekly: 0, urls: [], concurrent: 0, maxConcurrent: 0 };
  const body = days => [A4E_HEAD].concat([].concat.apply([], days.map(a4eRows))).join('\n') + '\n';
  const csv = text => ({ status: 200, contentType: 'text/csv',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: text });
  await context.route('**://static.adam4eve.eu/**', async route => {
    const url = route.request().url();
    counters.urls.push(url);
    // a host that accepts the connection and then says nothing, for as long as it takes
    if (opts.hang) return new Promise(() => {});
    // ...or one that does it to a single file and serves the rest, which is what a real
    // half-open connection looks like and is what the watchdog has to survive
    if (opts.hangFirst && counters.urls.length === 1) return new Promise(() => {});
    counters.concurrent++;
    counters.maxConcurrent = Math.max(counters.maxConcurrent, counters.concurrent);
    const finish = async r => {
      await new Promise(res => setTimeout(res, 15));
      try { await route.fulfill(r); } finally { counters.concurrent--; }
    };
    let m = url.match(/_daily_(\d{4}-\d{2}-\d{2})\.csv$/);
    if (m) {
      counters.daily++;
      if ((opts.missing || []).includes(m[1])) return finish({ status: 404, body: 'not found',
        headers: { 'Access-Control-Allow-Origin': '*' } });
      return finish(csv(body([m[1]])));
    }
    m = url.match(/_weekly_(\d{4})-(\d{1,2})\.csv$/);
    if (m) {
      counters.weekly++;
      // the real host serves weekly_2026-1.csv and 404s weekly_2026-01.csv
      if (m[2].length > 1 && m[2][0] === '0') return finish({ status: 404, body: 'zero padded',
        headers: { 'Access-Control-Allow-Origin': '*' } });
      const y = +m[1], w = +m[2];
      if ((opts.missingWeeks || []).includes(y + '-' + w))
        return finish({ status: 404, body: 'no such week', headers: { 'Access-Control-Allow-Origin': '*' } });
      const days = [];
      const yest = shift(todayUTC(), -1);
      for (let i = 0; i < 400; i++) {
        const d = shift(todayUTC(), -i);
        const iw = isoWeekOf(d);
        if (iw.y === y && iw.w === w && d <= yest && !(opts.missing || []).includes(d)) days.push(d);
      }
      days.sort();
      if (!days.length) return finish({ status: 404, body: 'no such week',
        headers: { 'Access-Control-Allow-Origin': '*' } });
      return finish(csv(body(days)));
    }
    return finish({ status: 404, body: 'unknown', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  return counters;
}

/* The real published dump, re-dated onto the last seven days and nothing else changed:
   the same rows, hubs, sides and per-day shape, so the shares the page derives are the
   shares tools/verify-tracker.mjs derives from the file on disk. */
async function mockA4EReal(context, file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const head = lines[0].replace(/\r$/, '');
  const src = lines.slice(1).map(l => l.replace(/\r$/, '')).filter(l => l.trim());
  const fileDays = [...new Set(src.map(l => l.split(';')[5]))].sort();
  // the file's last day becomes yesterday, the newest day the host ever publishes
  const remap = new Map(fileDays.map((d, i) => [d, shift(todayUTC(), -(fileDays.length - i))]));
  const byDay = new Map();
  for (const l of src) {
    const f = l.split(';');
    const nd = remap.get(f[5]);
    if (!nd) continue;
    f[5] = nd;
    if (!byDay.has(nd)) byDay.set(nd, []);
    byDay.get(nd).push(f.join(';'));
  }
  const csv = rs => ({ status: 200, contentType: 'text/csv',
    headers: { 'Access-Control-Allow-Origin': '*' }, body: [head].concat(rs).join('\n') + '\n' });
  await context.route('**://static.adam4eve.eu/**', async route => {
    const url = route.request().url();
    let m = url.match(/_daily_(\d{4}-\d{2}-\d{2})\.csv$/);
    if (m) return route.fulfill(csv(byDay.get(m[1]) || []));
    m = url.match(/_weekly_(\d{4})-(\d{1,2})\.csv$/);
    if (m) {
      const rs = [];
      for (const [d, list] of byDay) {
        const w = isoWeekOf(d);
        if (w.y === +m[1] && w.w === +m[2]) rs.push.apply(rs, list);
      }
      return route.fulfill(csv(rs));
    }
    return route.fulfill({ status: 404, body: 'unknown',
      headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  return [...byDay.keys()].sort();
}

async function openSell(browser, server, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, [['eveHelper.auth.v1', H.authState([CHAR])]]);
  await H.mockEsi(context, { skills: { accounting: 5, brokerRelations: 5 }, standings: {},
    typeIds: TYPE_IDS, books: BOOKS });
  await context.route('**://images.evetech.net/**', route => route.fulfill({ status: 404, body: '' }));
  const trk = opts.noTracker ? null : await mockA4E(context, opts);
  if (opts.beforeLoad) await context.addInitScript(opts.beforeLoad);
  const page = await context.newPage();
  H.watchPage(page, 'sell');
  await page.goto(server.url + '/index.html');
  await page.waitForFunction("typeof rebuild === 'function' && typeof runTracker === 'function'");
  return { context, page, trk, close: () => context.close() };
}

/* PRICES ONLY. The Fetch prices BUTTON runs both legs now — that is the whole point of
   it — so the suites below that count tracker requests drive the price leg directly.
   The button's own two-leg behaviour is pinned in its own section. */
async function fetchPrices(page) {
  await page.fill('#inv', PASTE);
  await page.dispatchEvent('#inv', 'input');
  await page.evaluate(() => runEsi());
  await page.waitForFunction(() => !document.getElementById('btnEsi').disabled && !state.esiRunning,
    null, { timeout: 30000 });
}

/* One window setting for the whole page: the typed history-days field drives both the
   ESI statistic and how much traded volume gets downloaded. There is no second control. */
/* the one window control, set the way a person sets it */
const setWindow = (page, days) => page.evaluate(d => {
  const el = document.getElementById('histDays');
  el.value = String(d);
  el.dispatchEvent(new Event('change'));
}, days).then(() => page.waitForFunction(d => trkWindowDays() === d, days));

async function refreshVolume(page, windowDays) {
  await page.evaluate(d => {
    const el = document.getElementById('histDays');
    el.value = String(d);
    el.dispatchEvent(new Event('change'));
  }, windowDays);
  await page.waitForFunction(d => trkWindowDays() === d, windowDays);
  await page.waitForFunction(() => !state.trkRunning);
  await page.click('#btnTrk');
  // waits on the run's own flag, never on a clock
  await page.waitForFunction(() => !state.trkRunning && !document.getElementById('btnTrk').disabled,
    null, { timeout: 90000 });
}

/* An item is a PAIR of <tr>s sharing one data-key, and every value carries data-cell, so
   a lookup is by NAME rather than by counting columns. */
const rowOf = (page, name) => page.evaluate(n => {
  const r = state.rows.find(x => x.name === n);
  if (!r) return null;
  const head = [...document.querySelectorAll('#tblBody tr.a')]
    .find(x => x.querySelector('.nm') && x.querySelector('.nm').textContent === n);
  const pair = head ? [head, head.nextElementSibling] : [];
  const cellOf = k => {
    for (const tr of pair){
      if (!tr) continue;
      const el = tr.querySelector(`[data-cell="${k}"]`);
      if (el) return { text: el.textContent, tip: el.title, copy: el.dataset.copy || '' };
    }
    return { text: '(no such column)', tip: '', copy: '' };
  };
  return { volDay: r.volDay, volSell: r.volSell, volBuy: r.volBuy, capture: r.capture,
    volSrc: r.volSrc, volState: r.volState, volHeldDays: r.volHeldDays,
    volUnitsSell: r.volUnitsSell, volUnitsBuy: r.volUnitsBuy,
    volSellRaw: r.metrics ? r.metrics.volSellRaw : null,
    volBuyRaw: r.metrics ? r.metrics.volBuyRaw : null,
    trkCorr: r.metrics ? r.metrics.trkCorr : null,
    patSrc: r.metrics ? r.metrics.patSrc : null,
    patientPrice: r.metrics ? r.metrics.patientPrice : null,
    flags: (r.flags || []).map(f => ({ t: f.t, ttl: f.ttl })),
    cells: { volSell: cellOf('volSell'), volBuy: cellOf('volBuy'),
      capture: cellOf('capture'), volDay: cellOf('volDay') } };
}, name);

H.run('tracker-model', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {

    /* ================= the URL shapes ================================================
       The single easiest bug in this whole feature: the CACHE key pads the week so keys
       sort chronologically, and the URL must NOT, because the host 404s a padded one. */
    section('the week number is padded in the key and bare in the URL');
    const s0 = await openSell(browser, server, {});
    const iso = await s0.page.evaluate(() => ({
      mid: isoWeek('2026-08-10'),
      // the Thursday rule puts 2025-12-29 in week 1 of week-year 2026, in the /2026/ dir
      cross: isoWeek('2025-12-29'),
      keyCross: trkWeekKey('2025-12-29'),
      keyMid: trkWeekKey('2026-08-10'),
      urlW1: trkWeeklyUrl(2026, 1),
      urlW33: trkWeeklyUrl(2026, 33),
      urlDay: trkDailyUrl('2026-08-10'),
    }));
    eq('2026-08-10 is ISO week 33 of 2026', JSON.stringify(iso.mid), JSON.stringify({ y: 2026, w: 33 }));
    eq('...and 2025-12-29 is week 1 of week-year 2026', JSON.stringify(iso.cross),
      JSON.stringify({ y: 2026, w: 1 }));
    eq('the cache key pads the week, so keys sort chronologically', iso.keyCross, '2026-01');
    eq('...and a two-digit week is unchanged by that', iso.keyMid, '2026-33');
    check('the weekly URL does NOT pad the week — the host 404s a padded one',
      /marketOrderTrades_weekly_2026-1\.csv$/.test(iso.urlW1), iso.urlW1);
    check('...and it lives under the ISO WEEK-YEAR directory, not the calendar year',
      /\/2026\/marketOrderTrades_weekly_2026-1\.csv$/.test(iso.urlW1), iso.urlW1);
    check('a two-digit week needs no special case',
      /\/2026\/marketOrderTrades_weekly_2026-33\.csv$/.test(iso.urlW33), iso.urlW33);
    check('a daily file is keyed by its own calendar year',
      /\/2026\/marketOrderTrades_daily_2026-08-10\.csv$/.test(iso.urlDay), iso.urlDay);

    section('a day that is not published yet is the schedule, not a fault');
    const pub = await s0.page.evaluate(() => {
      const at = h => new Date(Date.UTC(2026, 7, 21, h, 0, 0));
      return {
        today: trkExpected404('2026-08-21', at(12)),
        yestEarly: trkExpected404('2026-08-20', at(2)),
        yestLate: trkExpected404('2026-08-20', at(12)),
        older: trkExpected404('2026-08-14', at(2)),
      };
    });
    check('today has never been published', pub.today);
    check('...nor has yesterday, before the 03:32-03:38 UTC run', pub.yestEarly);
    check('after the run, a missing yesterday IS a fault', !pub.yestLate);
    check('...and an older missing day always was', !pub.older);
    await s0.close();

    /* ================= the whole route, end to end =================================== */
    section('the refresh downloads, parses and caches');
    const s1 = await openSell(browser, server, {});
    await fetchPrices(s1.page);
    eq('with nothing cached the age line is quiet, not an error',
      await s1.page.textContent('#trkAge'), 'not fetched');
    const beforeSrc = await s1.page.textContent('#volSrc');
    check('...and the provenance line names the ESI fallback for what it is',
      /ESI regional/.test(beforeSrc) && /upper bound/.test(beforeSrc), beforeSrc);
    await refreshVolume(s1.page, 30);

    const st1 = await s1.page.evaluate(() => ({
      text: document.getElementById('trkStatus').textContent,
      cls: document.getElementById('trkStatus').className,
      age: document.getElementById('trkAge').textContent,
      ordAge: document.getElementById('ordTrkAge').textContent,
      src: document.getElementById('volSrc').textContent,
      held: Object.keys(state.trk.cov.days).length,
    }));
    check('the run reports days and rows', /^\d+d · [\d,]+ rows · /.test(st1.text), st1.text);
    eq('...with no failures', st1.cls, 'ok');
    /* A weekly file covers a whole week, so the backfill lands a few days EITHER SIDE of
       the window — they are kept (re-downloading is the expensive part) and the line
       counts only the ones inside it. */
    check('the whole window is held, and then some', st1.held >= 29, String(st1.held));
    check('the age line counts the window, and names the newest day held',
      /^30d through \d\d-\d\d$/.test(st1.age), st1.age);
    eq('...and My orders shows the very same line', st1.ordAge, st1.age);
    check('the provenance line switches to Adam4EVE', /Adam4EVE/.test(st1.src), st1.src);

    section('the fetch is sequential, and asks for weeklies past the daily window');
    const urls = s1.trk.urls;
    eq('one file at a time — a volunteer host is not a worker pool', s1.trk.maxConcurrent, 1);
    check('the backfill uses weekly files', s1.trk.weekly > 0, String(s1.trk.weekly));
    check('...and the catch-up uses daily ones', s1.trk.daily > 0, String(s1.trk.daily));
    const cutoff = shift(todayUTC(), -14);
    const dailyDays = urls.map(u => (u.match(/_daily_(\d{4}-\d{2}-\d{2})/) || [])[1]).filter(Boolean);
    check('no daily file is asked for past the host\'s ~16-day retention',
      dailyDays.every(d => d >= cutoff), JSON.stringify(dailyDays.filter(d => d < cutoff)));
    check('no weekly URL is ever zero-padded',
      urls.filter(u => /_weekly_\d{4}-0\d\.csv/.test(u)).length === 0,
      JSON.stringify(urls.filter(u => /_weekly_\d{4}-0\d\.csv/.test(u))));

    /* ---------- the trap that would have been silent -------------------------------- */
    section('the average is iskValue/amount, never the published avg column');
    const stored = await s1.page.evaluate(async () => {
      const recs = await trkDb.rowsFor(60003760, 34);
      const rows = [].concat.apply([], recs.map(r => r.r));
      const sell = rows.filter(r => !r.b);
      const clampRecs = await trkDb.rowsFor(60003760, 9104);
      const clampRows = [].concat.apply([], clampRecs.map(r => r.r)).filter(r => !r.b);
      const other = await trkDb.rowsFor(60000001, 34);
      return {
        n: sell.length,
        av: sell[0].av, lo: sell[0].lo, hi: sell[0].hi, vw: sell[0].vw,
        k: sell[0].k, a: sell[0].a,
        inBand: sell.every(r => r.vw >= r.lo && r.vw <= r.hi),
        gone: sell.every(r => r.g === 0),
        clampVw: clampRows[0].vw, clampHi: clampRows[0].hi, clampFlag: clampRows[0].cl,
        clampK: clampRows[0].k, clampA: clampRows[0].a,
        untracked: other.length,
      };
    });
    check('the fixture reproduces the real defect: avg is BELOW low',
      stored.av < stored.lo, stored.av + ' vs ' + stored.lo);
    near('the stored average is iskValue ÷ amount', stored.vw, stored.k / stored.a, 1e-9);
    check('...which is inside the day\'s band, unlike the avg column', stored.inBand);
    check('the avg column is still stored verbatim — nothing published is dropped',
      stored.av != null && stored.av < stored.lo, String(stored.av));
    check('has_gone is stored too, so a future has_gone=1 dump cannot merge silently',
      stored.gone);
    eq('a station the tool does not track is dropped at the parser', stored.untracked, 0);
    check('a volume-weighted price above the day\'s high is clamped to it',
      stored.clampVw === stored.clampHi && stored.clampK / stored.clampA > stored.clampHi,
      stored.clampVw + ' vs ' + stored.clampHi);
    eq('...and the clamp is counted, not hidden', stored.clampFlag, 1);

    /* ---------- nothing is kept between runs ---------------------------------------
       The cache was removed deliberately: market data that outlives the run which fetched
       it goes stale and then produces wrong numbers that read as model bugs. So a refresh
       is always a full re-fetch of the window, and a reload starts from nothing. These two
       sections assert exactly what the old cache tests asserted, inverted. */
    section('a refresh re-fetches, so nothing on screen can be stale');
    const before = s1.trk.urls.length;
    await s1.page.click('#btnTrk');
    await s1.page.waitForFunction(() => !state.trkRunning && !document.getElementById('btnTrk').disabled,
      null, { timeout: 30000 });
    check('a second refresh asks for every file again',
      s1.trk.urls.length === before * 2, `${before} -> ${s1.trk.urls.length}`);
    check('...and reports what it fetched rather than declaring itself up to date',
      /\d+d · [\d,]+ rows/.test(await s1.page.textContent('#trkStatus')),
      await s1.page.textContent('#trkStatus'));
    eq('...holding the same days as the first run, since the window did not move',
      await s1.page.evaluate(() => Object.keys(state.trk.cov.days).length), st1.held);

    section('a reload starts from nothing');
    await s1.page.reload();
    await s1.page.waitForFunction("typeof rebuild === 'function'");
    await s1.page.waitForFunction("typeof trkDb === 'object'");
    const reloaded = await s1.page.evaluate(async () => ({
      age: document.getElementById('trkAge').textContent,
      rows: await trkDb.count(),
      cov: await trkDb.meta('coverage'),
      window: String(trkWindowDays()),
    }));
    eq('no rows survived the reload', reloaded.rows, 0);
    eq('...nor any record of what was held', reloaded.cov, undefined);
    eq('...so the line reads as a page that has fetched nothing', reloaded.age, 'not fetched');
    // the SETTING is a preference and does persist; the DATA is not and does not
    eq('...while the window control came back as it was left', reloaded.window, '30');
    await s1.close();

    /* ================= the three empty states ======================================== */
    section('nothing cached, no row here, and a measured zero do not look alike');
    const s2 = await openSell(browser, server, {});
    await fetchPrices(s2.page);
    const cold = await rowOf(s2.page, 'Tritanium');
    eq('with nothing cached the Sell u/d cell is a dash, not a number', cold.cells.volSell.text, '—');
    eq('...and the tooltip points at the button', cold.cells.volSell.tip, 'no tracker data — Refresh volume');
    eq('...with no capture either', cold.cells.capture.text, '—');
    eq('...and the row records which source it used', cold.volSrc, 'esi');
    check('the regional Vol/day column is untouched by any of this', cold.volDay > 0, String(cold.volDay));

    await refreshVolume(s2.page, 30);
    const trit = await rowOf(s2.page, 'Tritanium');
    const dump = await rowOf(s2.page, 'Dump Widget');
    const buyOnly = await rowOf(s2.page, 'Buy Only');
    const ghost = await rowOf(s2.page, 'Ghost Widget');

    /* The rate is per CALENDAR day — the same denominator the Vol/day column already uses,
       so the two are comparable — which is why a 30-day window whose oldest day starts at
       midnight reports 29 days of prints over 30 days of calendar. The RATIO is exact. */
    check('Tritanium\'s sell side is the measured 8,000 units a day, over calendar days',
      trit.volSell > 7500 && trit.volSell <= 8000, String(trit.volSell));
    check('...and its buy side the measured 2,000', trit.volBuy > 1875 && trit.volBuy <= 2000,
      String(trit.volBuy));
    near('...in exactly the 4:1 the fixture published', trit.volSell / trit.volBuy, 4, 1e-9);
    near('...so 80% of its traded units hit sell orders', trit.capture, 0.8, 1e-9);
    near('the dumping item is the opposite: 22%', dump.capture, 0.22, 1e-9);
    check('...which is why one global capture constant could never be right',
      Math.abs(trit.capture - dump.capture) > 0.5,
      trit.capture + ' vs ' + dump.capture);
    eq('a type with rows but no sell side reads ZERO, a number', buyOnly.cells.volSell.text, '0');
    eq('...and its capture is zero too', buyOnly.cells.capture.text, '0%');
    /* REWRITTEN: the two absences used to be one glyph apart — both `—`, told apart only
       on hover — while the README claimed they did not look alike. "Nothing has been
       downloaded" is unknown; "this item does not trade at this hub across every day
       held" is a measurement, and a measurement gets its own mark. */
    eq('a covered hub with no row for the item says so in the CELL', ghost.cells.volSell.text, 'none');
    eq('...on the buy side too', ghost.cells.volBuy.text, 'none');
    eq('...and in the share column', ghost.cells.capture.text, 'none');
    check('...with the days it was measured over', /^no trade at this hub · 30d held$/
      .test(ghost.cells.volSell.tip), ghost.cells.volSell.tip);
    eq('nothing downloaded is still the dash, which is not a measurement', cold.cells.volSell.text, '—');
    check('the three states are three MARKS, before any hovering', new Set([
      cold.cells.volSell.text, ghost.cells.volSell.text, buyOnly.cells.volSell.text]).size === 3,
      JSON.stringify([cold.cells.volSell.text, ghost.cells.volSell.text, buyOnly.cells.volSell.text]));
    check('...and three tooltips behind them', new Set([
      cold.cells.volSell.tip, ghost.cells.volSell.tip, buyOnly.cells.volSell.tip]).size === 3,
      JSON.stringify([cold.cells.volSell.tip, ghost.cells.volSell.tip, buyOnly.cells.volSell.tip]));
    eq('a tracker-backed row records that source', trit.volSrc, 'tracker');
    eq('...and an uncovered one does not', ghost.volSrc, 'esi');

    /* ---------- D2: a share of units, over one day set ------------------------------ */
    section('the sell share is a share of units, not a ratio of two rates');
    /* Late Buyer's sell side prints on all thirty days and its buy side on the last four
       — the shape nine of the thirteen real fixture pairs have, and exactly the illiquid
       population this column exists to flag. histVolOf spans each side from ITS OWN first
       row, so the shipped formula divided 96.7 u/d by 336.7 u/d and called it a share. */
    const late = await rowOf(s2.page, 'Late Buyer');
    eq('the sell side holds thirty days of the fixture\'s 100 units', late.volUnitsSell, 3000);
    eq('...and the buy side four days of its 300', late.volUnitsBuy, 1200);
    near('the share is units over units', late.capture, 3000 / 4200, 1e-12);
    /* The RATE columns carry the ESI-ratio correction (see D5 below); the raw reading
       behind them is what has to share a denominator, and it does. */
    near('...and both rates carry the same denominator, the days held',
      late.volBuyRaw, 1200 / 30, 1e-12);
    near('...the sell side likewise', late.volSellRaw, 3000 / 30, 1e-12);
    const twoRate = await s2.page.evaluate(async () => {
      const recs = await trkDb.rowsFor(60003760, 9106);
      const rows = [].concat.apply([], recs.map(r => r.r));
      const side = b => rows.filter(r => !!r.b === b).map(trkHistRow);
      const sell = histVolOf(side(false), 30) || 0, buy = histVolOf(side(true), 30) || 0;
      return { sell, buy, share: sell / (sell + buy) };
    });
    check('the shipped two-rate formula reads this pair as a third of what it is',
      twoRate.share < 0.35, twoRate.share + ' vs ' + (3000 / 4200));

    /* ---------- D2b: the undercount correction ------------------------------------- */
    /* A4E's bulk files read a vanished order as a cancel, so they undercount real trade —
       a median 54% of ESI's regional volume over 28 measured type-days, range 0.28-1.01.
       The correction is the ITEM's own ratio over the days A4E holds, not that median. It
       cannot separate its three causes, so its size goes on the row instead of being
       folded away. */
    section('the tracker undercount is corrected per item, and the correction is shown');
    const corrRows = await s2.page.evaluate(() => state.rows.filter(r => r.metrics && r.metrics.trkCorr)
      .map(r => ({ name: r.name, c: r.metrics.trkCorr, volSell: r.volSell,
                   raw: r.metrics.volSellRaw, capture: r.capture,
                   flags: r.flags.map(f => f.t) })));
    check('some rows carry a correction at all', corrRows.length > 0, String(corrRows.length));
    for (const r of corrRows.slice(0, 1)){
      near('the correction is ESI regional units over what the tracker counted',
        r.c.ratio, r.c.esi / r.c.a4e, 1e-12);
      near('...applied to the arrival rate', r.volSell, r.raw * Math.max(1, r.c.ratio), 1e-9);
    }
    const bigCorr = corrRows.find(r => r.c.ratio > 1.1);
    if (bigCorr){
      check('a correction worth noticing is on the row as a chip',
        bigCorr.flags.some(t => /^vol ×/.test(t)), JSON.stringify(bigCorr.flags));
    } else {
      check('a correction worth noticing is on the row as a chip', false, 'no row corrected past 1.1');
    }
    /* volUnitsSell/Buy are the RAW counts — what the tracker saw, uncorrected. The share
       computed from them has to equal the share on the row, which is the whole claim: a
       common factor on both sides cancels. */
    near('the sell/buy split is a ratio, so the correction cancels out of it',
      late.capture, late.volUnitsSell / (late.volUnitsSell + late.volUnitsBuy), 1e-12);
    check('...and the correction on that row was not 1, so the claim has teeth',
      (late.trkCorr && late.trkCorr.ratio) > 1.0001, JSON.stringify(late.trkCorr));

    /* ---------- D2c: the patient price anchors to what sold HERE ------------------- */
    /* The history reference is ESI regional — both sides of the book pooled across every
       station in the region. Fine as a statistic the owner picks; wrong as the price to
       hold out for at one hub. The tracker's sell-side prints are trades at this station
       that filled a sell order, which is the event being waited for. */
    section('the patient price anchors to sell-side trades at this hub');
    const pat = await s2.page.evaluate(() => state.rows
      .filter(r => r.metrics && r.metrics.patientPrice != null)
      .map(r => ({ name: r.name, src: r.metrics.patSrc, price: r.metrics.patientPrice,
                   volState: r.volState, sellUnits: r.volUnitsSell })));
    const withSells = pat.filter(r => r.volState === 'tracker' && r.sellUnits > 0);
    const noSells = pat.filter(r => !(r.volState === 'tracker' && r.sellUnits > 0));
    check('there are rows on both sides of the fallback', withSells.length > 0 && noSells.length > 0,
      withSells.length + ' anchored / ' + noSells.length + ' not');
    check('a row with sell-side prints here anchors to them',
      withSells.every(r => r.src === 'tracker'), JSON.stringify(withSells));
    /* An item the tracker HAS rows for but only on the buy side has no sell-side print to
       anchor to — nothing at this station has filled a sell order — so it falls back
       exactly as an untracked item does. */
    check('...and a row with none falls back to ESI regional, buy-side-only rows included',
      noSells.every(r => r.src === 'esi'), JSON.stringify(noSells));
    check('...one of which is a tracked item that only ever sold into buy orders',
      noSells.some(r => r.volState === 'tracker'), JSON.stringify(noSells));
    const anchored = await s2.page.evaluate(() => {
      const r = state.rows.find(x => x.volState === 'tracker' && x.metrics.patSrc === 'tracker');
      const trk = trkSeriesFor(hub().station, r.typeId);
      const days = Number(document.getElementById('histDays').value) || 30;
      const mode = document.getElementById('histMode').value;
      return {
        fromTracker: round4sig(histStatOf(trk.sell, days, mode)),
        fromEsi: round4sig(histStatOf(state.esi.get(r.name.toLowerCase()).hist, days, mode)),
        shown: r.metrics.patientPrice,
      };
    });
    eq('...the number being the tracker statistic, computed the owner\'s way',
      anchored.shown, anchored.fromTracker);
    check('...which is not simply the ESI one wearing a different label',
      anchored.fromEsi !== anchored.fromTracker,
      anchored.fromEsi + ' vs ' + anchored.fromTracker);

    /* ---------- D2d: two lines, not an average of two -------------------------------- */
    /* ESI's series is regional and pools both sides of the book across every station; the
       tracker's is sell-side prints at THIS hub. Averaging them would hide the one thing
       worth seeing — where they diverge, the hub is out of line with its region. */
    section('the chart plots both series, and neither becomes the other');
    const chart = await s2.page.evaluate(() => {
      const r = state.rows.find(x => x.trkRows && x.trkRows.length > 1 && x.histRows && x.histRows.length > 1);
      if (!r) return null;
      const box = buildDetailChart(r);
      const svg = box.querySelector('svg');
      const path = k => svg.querySelector(`[data-series="${k}"]`);
      const legend = [...svg.querySelectorAll('text')].map(t => t.textContent);
      return {
        name: r.name,
        avg: path('avg') ? { points: Number(path('avg').dataset.points), stroke: path('avg').getAttribute('stroke'),
                             dash: path('avg').getAttribute('stroke-dasharray') } : null,
        hub: path('hub') ? { points: Number(path('hub').dataset.points), stroke: path('hub').getAttribute('stroke'),
                             dash: path('hub').getAttribute('stroke-dasharray'), d: path('hub').getAttribute('d') } : null,
        legend,
        trkDays: r.trkRows.length,
      };
    });
    check('there is a row with both series to draw', !!chart, 'none found');
    check('the regional series is drawn', !!(chart && chart.avg), JSON.stringify(chart && chart.avg));
    check('...and the hub sell side is drawn beside it', !!(chart && chart.hub),
      JSON.stringify(chart && chart.hub));
    check('...in a different colour', chart && chart.hub.stroke !== chart.avg.stroke,
      chart && (chart.avg.stroke + ' vs ' + chart.hub.stroke));
    check('...and a different line, so the two are told apart without colour',
      chart && chart.hub.dash && !chart.avg.dash, chart && chart.hub.dash);
    check('both are labelled for what they are',
      chart && chart.legend.some(t => /hub sell side/.test(t))
        && chart.legend.some(t => /region, both sides/.test(t)),
      JSON.stringify(chart && chart.legend));
    check('a gap in the tracker\'s coverage is a gap in the line, not a shortcut across it',
      chart && (chart.hub.d.match(/M/g) || []).length >= 1, chart && chart.hub.d.slice(0, 60));
    check('...and the hub line never claims more days than the tracker holds',
      chart && chart.hub.points <= chart.trkDays,
      chart && (chart.hub.points + ' of ' + chart.trkDays));

    section('the split is a column, not a number with the split hidden on hover');
    const cols = await s2.page.evaluate(() => {
      const th = [...document.querySelectorAll('#tbl thead th')];
      const ord = [...document.querySelectorAll('#ordTbl thead th')];
      const tsv = fullTsv().split('\n');
      return {
        keys: th.map(x => x.dataset.key || ''),
        labels: th.map(x => x.textContent.trim()),
        tips: th.filter(x => ['volSell', 'volBuy', 'capture'].includes(x.dataset.key)).map(x => x.title),
        ordKeys: ord.map(x => x.dataset.key || ''),
        head: tsv[0].split('\t'),
        row: (tsv.find(l => l.startsWith('Tritanium')) || '').split('\t'),
        unpriced: tsv.filter(l => l.includes('UNPRICED')).map(l => l.split('\t').length),
      };
    });
    /* REWRITTEN for the two-line row. The Sell table folded twenty-four headers into nine,
       so a "column" is now an addressable, VISIBLE cell rather than a <th>. The intent is
       unchanged and is the one the owner stated twice: the split is shown, not hidden on a
       hover. These assert the values are real rendered text, side by side, and that
       deleting the tooltips would not delete the numbers. */
    const flow = await s2.page.evaluate(() => {
      const tr = [...document.querySelectorAll('#tblBody tr.a')]
        .find(x => x.querySelector('.nm').textContent === 'Tritanium');
      const pair = [tr, tr.nextElementSibling];
      const get = k => pair.map(t => t && t.querySelector(`[data-cell="${k}"]`)).find(Boolean);
      const cell = k => { const e = get(k); return e && { text: e.textContent, tip: e.title,
        td: e.closest('td').dataset.cell || e.closest('td').className }; };
      const s = get('volSell'), b2 = get('volBuy'), c = get('capture');
      return { sell: cell('volSell'), buy: cell('volBuy'), cap: cell('capture'),
        sameCell: s.closest('td') === b2.closest('td') && b2.closest('td') === c.closest('td'),
        order: s.compareDocumentPosition(b2) & Node.DOCUMENT_POSITION_FOLLOWING
             && b2.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
        flowHead: [...document.querySelectorAll('#tbl thead th')]
          .find(x => x.dataset.key === 'volDay').title };
    });
    check('the sell side is rendered text, not a tooltip',
      flow.sell && flow.sell.text && flow.sell.text !== '', JSON.stringify(flow.sell));
    check('...and so is the buy side', flow.buy && flow.buy.text && flow.buy.text !== '',
      JSON.stringify(flow.buy));
    check('...and the per-item share', flow.cap && flow.cap.text && flow.cap.text !== '',
      JSON.stringify(flow.cap));
    check('all three sit together under the regional figure they qualify', flow.sameCell);
    check('...in the order sell, buy, share', !!flow.order);
    check('each still explains itself on hover, without the hover carrying the number',
      [flow.sell, flow.buy, flow.cap].every(c => c.tip && c.tip.split('\n').every(l => l.length <= 130)),
      JSON.stringify([flow.sell.tip, flow.buy.tip, flow.cap.tip]));
    check('...and the group header names what the two sides mean',
      /sell orders/.test(flow.flowHead) && /buy orders/.test(flow.flowHead), flow.flowHead);
    check('...while each value names the station it was measured at',
      [flow.sell.tip, flow.buy.tip].every(t => /station:/.test(t)),
      JSON.stringify([flow.sell.tip, flow.buy.tip]));
    /* REWRITTEN: My orders used to get Sell u/d and Sell share, with the buy side on the
       tooltip of one of them. This is the screen where live orders are read, and the
       split behind a hover is the shape that was rejected. It gets the column. */
    check('My orders carries all three, as columns',
      ['volSell', 'volBuy', 'capture'].every(k => cols.ordKeys.includes(k)), cols.ordKeys.join(','));
    check('...with the two sides next to each other there too',
      cols.ordKeys.indexOf('volBuy') === cols.ordKeys.indexOf('volSell') + 1
      && cols.ordKeys.indexOf('capture') === cols.ordKeys.indexOf('volBuy') + 1,
      cols.ordKeys.join(','));
    check('the TSV gained the split and the source',
      ['Sell u/d', 'Buy u/d', 'Sell share', 'Vol source'].every(h => cols.head.includes(h)),
      cols.head.join('|'));
    eq('every TSV row is as wide as its header', cols.row.length, cols.head.length);
    check('...including the unpriced tail',
      cols.unpriced.every(n => n === cols.head.length), JSON.stringify(cols.unpriced));
    near('the exported sell share is the raw ratio, not the rounded cell',
      Number(cols.row[cols.head.indexOf('Sell share')]), 0.8, 1e-4);
    await s2.close();

    /* ================= the model ===================================================== */
    section('the measured sell-side rate replaces the capture guess');
    const s3 = await openSell(browser, server, { noTracker: true });
    const model = await s3.page.evaluate(() => {
      const d = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      // one ESI history, so the ONLY difference between the two runs is the tracker
      const hist = [];
      for (let t = 89; t >= 0; t--)
        hist.push({ date: d(t), average: 100, highest: 110, lowest: 90, volume: 1000, orders: 20 });
      const e = { hist, typeId: 9101 };
      const trkRows = share => {
        const rows = [];
        for (let t = 89; t >= 0; t--)
          rows.push({ date: d(t), average: 100, highest: 110, lowest: 90,
                      volume: 1000 * share, orders: 20 });
        return rows;
      };
      const mk = share => {
        const sell = trkRows(share);
        return { sell, buy: [], sellUnitsDay: histVolOf(sell, 90),
                 buyUnitsDay: 1000 * (1 - share), capture: share };
      };
      const opts = { histDays: 90 };
      return {
        // a stack big enough that the arrival rate decides the answer, not the window
        esi:   fillOutlook(e, [], 100, 3000, 14, opts),
        rich:  fillOutlook(e, [], 100, 3000, 14, Object.assign({ tracker: mk(0.83) }, opts)),
        thin:  fillOutlook(e, [], 100, 3000, 14, Object.assign({ tracker: mk(0.22) }, opts)),
        empty: fillOutlook(e, [], 100, 3000, 14, Object.assign({ tracker:
                 { sell: [], buy: [], sellUnitsDay: 0, buyUnitsDay: 5, capture: 0 } }, opts)),
        capture: FILL_CAPTURE_GONE(),
      };
      function FILL_CAPTURE_GONE(){ return typeof FILL_CAPTURE; }
    });
    eq('the capture constant is gone from the file', model.capture, 'undefined');
    eq('with no tracker the answer is still an UPPER bound', model.esi.bound, 'upper');
    eq('...computed off the ESI regional history', model.esi.reachSrc, 'esi');
    eq('with tracker rows it becomes an ESTIMATE', model.rich.bound, 'estimate');
    eq('...computed off the sell-side prints at this station', model.rich.reachSrc, 'tracker');
    near('...and it carries the measured share', model.rich.capture, 0.83, 1e-9);
    check('the item where 22% of volume hits sell orders fills far less than the 83% one',
      model.thin.fillFrac < model.rich.fillFrac * 0.6,
      model.thin.fillFrac + ' vs ' + model.rich.fillFrac);
    check('...and sells fewer units while it is up',
      model.thin.expUnits < model.rich.expUnits * 0.6,
      model.thin.expUnits + ' vs ' + model.rich.expUnits);
    check('...even though ESI reports the SAME regional volume for both',
      model.thin.volDay !== model.esi.volDay && model.rich.volDay !== model.esi.volDay,
      [model.thin.volDay, model.rich.volDay, model.esi.volDay].join('/'));
    eq('a tracker series with no sell side falls back rather than dividing by zero',
      model.empty.bound, 'upper');
    eq('...on the ESI history', model.empty.reachSrc, 'esi');

    section('reach is rebuilt on the sell-side prints, and it bites');
    const reach = await s3.page.evaluate(() => {
      const d = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      const hist = [];
      for (let t = 89; t >= 0; t--)
        hist.push({ date: d(t), average: 100, highest: 200, lowest: 90, volume: 1000, orders: 20 });
      const e = { hist, typeId: 9105 };
      // the tracker's own band is NARROWER: nobody bought from a sell order above 110
      const sell = [];
      for (let t = 89; t >= 0; t--)
        sell.push({ date: d(t), average: 100, highest: 110, lowest: 90, volume: 1000, orders: 20 });
      const trk = { sell, buy: [], sellUnitsDay: histVolOf(sell, 90), buyUnitsDay: 0, capture: 1 };
      return {
        esi: fillOutlook(e, [], 150, 10, 14, { histDays: 90 }),
        trk: fillOutlook(e, [], 150, 10, 14, { histDays: 90, tracker: trk }),
      };
    });
    check('ESI\'s pooled band says a price of 150 is reachable',
      reach.esi.reach.R > 0 && reach.esi.fillFrac > 0, String(reach.esi.reach.R));
    eq('the sell-side prints say it is exactly zero, not nearly zero', reach.trk.fillFrac, 0);
    eq('...and name the ceiling as the reason', reach.trk.capped, 'ceiling');
    eq('...as an estimate, not an upper bound', reach.trk.bound, 'estimate');

    section('kappa stays on ESI order_count — the tracker\'s orderNum is censored');
    const kap = await s3.page.evaluate(() => {
      const d = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      const withOrders = [], noOrders = [], sell = [];
      for (let t = 89; t >= 0; t--) {
        withOrders.push({ date: d(t), average: 100, highest: 110, lowest: 90, volume: 1000, orders: 100 });
        noOrders.push({ date: d(t), average: 100, highest: 110, lowest: 90, volume: 1000 });
        // A4E pins orderNum at ~96, the number of 15-minute scans in a day
        sell.push({ date: d(t), average: 100, highest: 110, lowest: 90, volume: 1000, orders: 5 });
      }
      const trk = { sell, buy: [], sellUnitsDay: histVolOf(sell, 90), buyUnitsDay: 0, capture: 1 };
      return {
        both: fillOutlook({ hist: withOrders, typeId: 1 }, [], 100, 500, 14, { histDays: 90, tracker: trk }),
        only: fillOutlook({ hist: noOrders, typeId: 1 }, [], 100, 500, 14, { histDays: 90, tracker: trk }),
      };
    });
    near('with ESI order_count present, kappa is ESI\'s 1000/100', kap.both.kappa, 10, 1e-9);
    eq('...and says so', kap.both.kappaSrc, 'esi');
    near('with none, the tracker figure stands in', kap.only.kappa, 200, 1e-9);
    check('...labelled as the CEILING on units-per-trade that it is',
      kap.only.kappaSrc === 'tracker-upper', kap.only.kappaSrc);
    await s3.close();

    /* ================= failure containment =========================================== */
    section('a 404 on a published, retained day is a fault, and is counted');
    /* One day inside the daily window answers 404 while it is published and retained,
       which is the case this policy is about: not the schedule, a real fault. */
    const gapDay = shift(todayUTC(), -3);
    const s4 = await openSell(browser, server, { missing: [gapDay] });
    await fetchPrices(s4.page);
    await refreshVolume(s4.page, 30);
    const failedRun = await s4.page.evaluate(() => ({
      text: document.getElementById('trkStatus').textContent,
      cls: document.getElementById('trkStatus').className,
      held: Object.keys(state.trk.cov.days).length,
      age: document.getElementById('trkAge').textContent,
    }));
    check('the missing day was asked for as a daily, being inside the retention window',
      s4.trk.urls.some(u => u.includes('_daily_' + gapDay)), s4.trk.urls.join(' '));
    check('the run reports the failure rather than swallowing it',
      / · 1 failed$/.test(failedRun.text), failedRun.text);
    eq('...in red', failedRun.cls, 'err');
    check('...and every other day of the window still landed',
      failedRun.held >= 28, String(failedRun.held));
    check('...with the hole named as a gap, not as staleness',
      / · 1 gaps$/.test(failedRun.age), failedRun.age);
    await s4.close();

    section('a weekly that is not there is a gap, counted and never retried');
    /* A weekly is the last resort for its days: past the daily retention there is no
       other file to ask for, so a 404 on one is a real hole in the window. */
    const gapWeek = (() => {
      const d = shift(todayUTC(), -25);
      const w = isoWeekOf(d);
      return { key: w.y + '-' + w.w, day: d };
    })();
    const s9 = await openSell(browser, server, { missingWeeks: [gapWeek.key] });
    await fetchPrices(s9.page);
    await refreshVolume(s9.page, 30);
    const weekGap = await s9.page.evaluate(d => ({
      text: document.getElementById('trkStatus').textContent,
      cls: document.getElementById('trkStatus').className,
      asked: 0,
      has: !!(state.trk.cov.days[d]),
    }), gapWeek.day);
    check('the missing week is reported as a failure', / · \d+ failed$/.test(weekGap.text),
      weekGap.text);
    eq('...in red', weekGap.cls, 'err');
    check('...and none of its days is claimed as held', !weekGap.has, String(weekGap.has));
    // within one run a dead weekly is not retried; across runs everything is asked again,
    // because nothing is kept to remember it by
    const askedOnce = s9.trk.urls.length;
    const weeklyAsks = s9.trk.urls.filter(u => u.includes(gapWeek.key)).length;
    eq('the dead weekly was asked for once in the run, not looped on', weeklyAsks, 1);
    await s9.page.click('#btnTrk');
    await s9.page.waitForFunction(() => !state.trkRunning
      && !document.getElementById('btnTrk').disabled, null, { timeout: 30000 });
    eq('a second run asks for the whole window again', s9.trk.urls.length, askedOnce * 2);
    await s9.close();

    /* Storage is not touched at all any more, so a browser that refuses it must be
       indistinguishable from one that allows it — including a refresh that still works.
       This is the regression test against ever quietly reintroducing a dependency on it. */
    section('a browser with storage switched off is not a degraded browser');
    const s5 = await openSell(browser, server, {
      beforeLoad: () => {
        // a private window, or site data switched off
        Object.defineProperty(window, 'indexedDB', {
          get() { throw new Error('indexedDB is blocked'); },
        });
      },
    });
    await fetchPrices(s5.page);
    await refreshVolume(s5.page, 30);
    const blocked = await s5.page.evaluate(async () => ({
      rows: document.querySelectorAll('#tblBody tr').length,
      age: document.getElementById('trkAge').textContent,
      status: document.getElementById('trkStatus').textContent,
      statusCls: document.getElementById('trkStatus').className,
      src: document.getElementById('volSrc').textContent,
      stored: await trkDb.count(),
      volSell: state.rows.some(r => r.volSell > 0),
      strategies: state.rows.map(r => r.strategy).join(','),
      esiStatus: document.getElementById('esiStatus').textContent,
      esiCls: document.getElementById('esiStatus').className,
    }));
    check('every row still renders', blocked.rows >= 4, String(blocked.rows));
    check('the refresh ran to completion', /\d+d · [\d,]+ rows/.test(blocked.status), blocked.status);
    eq('...without an error', blocked.statusCls, 'ok');
    check('...and really did hold rows', blocked.stored > 0, String(blocked.stored));
    check('rows carry measured sell-side volume, exactly as anywhere else', blocked.volSell);
    check('the provenance line names the tracker', /Adam4EVE/.test(blocked.src), blocked.src);
    check('the coverage line is the ordinary one, not a warning',
      /\d+d through/.test(blocked.age), blocked.age);
    check('...and every row still has a plan', blocked.strategies.split(',').every(Boolean),
      blocked.strategies);
    check('the price fetch reports its own success',
      /· \d+ items · /.test(blocked.esiStatus), blocked.esiStatus);
    eq('...in green', blocked.esiCls, 'ok');
    await s5.close();

    section('a reload racing the refresh cannot leave a half-run line on screen');
    /* The inventory box reloads the memo on a debounce, so one can be in flight while a
       refresh is still downloading. When the button comes back the line must describe the
       FINISHED run, not whichever snapshot happened to resolve last. */
    const s8 = await openSell(browser, server, {});
    await fetchPrices(s8.page);
    await setWindow(s8.page, 30);
    await s8.page.waitForFunction(() => !state.trkRunning);
    await s8.page.click('#btnTrk');
    await s8.page.waitForFunction(() => state.trkRunning === true, null, { timeout: 20000 });
    await s8.page.evaluate(() => trkMemoSoon());     // mid-run, exactly as a keystroke would
    await s8.page.waitForFunction(() => !state.trkRunning
      && !document.getElementById('btnTrk').disabled, null, { timeout: 90000 });
    const settled = await s8.page.evaluate(() => ({
      age: document.getElementById('trkAge').textContent,
      days: Object.keys(state.trk.cov.days).length,
      newest: Object.keys(state.trk.cov.days).sort().pop(),
      volSell: (state.rows.find(r => r.name === 'Tritanium') || {}).volSell,
    }));
    check('the line describes the whole run', /^30d through \d\d-\d\d$/.test(settled.age),
      settled.age);
    check('...through yesterday, the newest day the host publishes',
      settled.newest === new Date(Date.now() - 86400e3).toISOString().slice(0, 10), settled.newest);
    check('...and the table already carries the numbers behind it',
      settled.volSell > 7000, String(settled.volSell));
    await s8.close();

    section('Clear cancels a refresh in flight');
    const s7 = await openSell(browser, server, {});
    await fetchPrices(s7.page);
    await setWindow(s7.page, 365);
    await s7.page.waitForFunction(() => !state.trkRunning);
    // how many files a year of backfill needs, so "it stopped early" is a real statement
    const planned = await s7.page.evaluate(() =>
      trkPlanJobs({ v: 1, days: {} }, {}, 365, new Date()).length);
    check('a year of backfill is a long run', planned > 40, String(planned));
    await s7.page.click('#btnTrk');
    // wait on the run's own state, not a clock: the token has to be live to be cancelled
    await s7.page.waitForFunction(() => state.trkRunning === true, null, { timeout: 20000 });
    await s7.page.click('#btnClear');
    await s7.page.waitForFunction(() => !state.trkRunning, null, { timeout: 120000 });
    const asked = s7.trk.urls.length;
    const stopped = await s7.page.evaluate(() => ({
      barHidden: document.getElementById('trkBar').hidden,
      disabled: document.getElementById('btnTrk').disabled,
      running: state.trkRunning,
      held: state.trk && state.trk.cov ? Object.keys(state.trk.cov.days).length : 0,
    }));
    check('the run stopped far short of its plan', asked < planned / 2,
      asked + ' of ' + planned + ' files');
    check('...so nothing like a year of days landed', stopped.held < 200, String(stopped.held));
    check('the bar is put away', stopped.barHidden);
    check('...and the button given back', !stopped.disabled);
    check('...with nothing left running', !stopped.running);
    // whatever DID land is kept: a killed run costs the files it had not started, no more
    check('the days that landed before the cancel are still held', stopped.held >= 0,
      String(stopped.held));
    await s7.close();

    /* ================= the denominator =============================================
       Every number below used to be divided by the wrong thing. histVolOf spans a series
       from its own oldest row to today, which is right for ESI history — a day absent
       from it really had no trades — and wrong for a cache, where an absent day is a day
       nobody downloaded. The cache knows exactly which days it holds. */

    section('a day nobody downloaded is not a day with no trades');
    const gapDays = [3, 7, 8, 12, 15, 16, 17, 22, 26].map(n => shift(todayUTC(), -n));
    const s11 = await openSell(browser, server, { missing: gapDays });
    await fetchPrices(s11.page);
    await refreshVolume(s11.page, 30);
    const gapped = await rowOf(s11.page, 'Tritanium');
    const gapLines = await s11.page.evaluate(() => ({
      age: document.getElementById('trkAge').textContent,
      src: document.getElementById('volSrc').textContent,
      held: state.trk.held, window: state.trk.days,
      rows: state.rows.length, fed: state.rows.filter(r => r.volSrc === 'tracker').length,
    }));
    eq('nine of the thirty days never arrived', gapLines.held, 21);
    eq('...and the window still asked for thirty', gapLines.window, 30);
    eq('the cache holds twenty-one days of the fixture\'s 8,000 units', gapped.volUnitsSell, 168000);
    near('...so the rate is 8,000 a day, undamaged by the holes', gapped.volSell, 8000, 1e-9);
    eq('...and every rate says which days it was measured over', gapped.volHeldDays, 21);
    const spanRate = await s11.page.evaluate(async () => {
      const recs = await trkDb.rowsFor(60003760, 34);
      const rows = [].concat.apply([], recs.map(r => r.r)).filter(r => !r.b).map(trkHistRow);
      return histVolOf(rows, 30);
    });
    check('the span divisor would have called this market a quarter quieter than it is',
      spanRate < 6000, spanRate + ' vs ' + gapped.volSell);

    section('the tooltip states the units the cache holds, over the days it holds');
    const tips = await s11.page.evaluate(() => {
      const r = state.rows.find(x => x.name === 'Tritanium');
      const head = [...document.querySelectorAll('#tblBody tr.a')]
        .find(x => x.querySelector('.nm').textContent === 'Tritanium');
      const pair = [head, head.nextElementSibling];
      const tip = k => pair.map(t => t && t.querySelector(`[data-cell="${k}"]`))
        .find(Boolean).title.split('\n')[0];
      return {
        sell: tip('volSell'), buy: tip('volBuy'),
        held: `sell side: ${fmt.format(Math.round(r.volUnitsSell))} u over ${r.volHeldDays}d held`,
        window: `sell side: ${fmt.format(Math.round(r.volSell * state.trk.days))} u over ${state.trk.days}d held`,
      };
    });
    eq('the sell tooltip is the cache, unit for unit', tips.sell, tips.held);
    check('...and not the dropdown setting, which would claim half as many again',
      tips.sell !== tips.window, tips.sell + ' | ' + tips.window);
    check('the buy side is stated the same way', /^buy side: [\d,]+ u over 21d held$/.test(tips.buy),
      tips.buy);

    section('the provenance line and the age line state one coverage, not two');
    check('the age line counts the days held, and names the holes',
      /^21d through \d\d-\d\d · 9 gaps$/.test(gapLines.age), gapLines.age);
    check('...and the volume line counts the same days', /· 21d through \d\d-\d\d/.test(gapLines.src),
      gapLines.src);
    eq('...the two numbers are one number',
      (gapLines.age.match(/^(\d+)d/) || [])[1], (gapLines.src.match(/· (\d+)d/) || [])[1]);
    check('...and it says how many rows the tracker actually fed',
      gapLines.src.includes(` · ${gapLines.fed}/${gapLines.rows} rows`) && gapLines.fed < gapLines.rows,
      gapLines.src);
    await s11.page.fill('#inv', 'Ghost Widget\t100');
    await s11.page.dispatchEvent('#inv', 'input');
    await s11.page.waitForFunction(() => state.rows.length === 1);
    const ghostOnly = await s11.page.evaluate(() => ({
      src: document.getElementById('volSrc').textContent,
      tip: document.getElementById('volSrc').title,
    }));
    check('a covered hub whose items the tracker has no rows for is an ESI table, and says ESI',
      /ESI regional/.test(ghostOnly.src), ghostOnly.src);
    check('...naming the tracker\'s silence rather than pretending it fed anything',
      /holds no row for these items/.test(ghostOnly.tip), ghostOnly.tip);
    await s11.close();

    /* ================= the page against its own harness ==============================
       tools/verify-tracker.mjs is a second implementation of this aggregate, written to
       be run by hand against the real published dumps. The fixture below IS a real dump —
       published week 2026-33, 380 rows, seven days, five hubs — re-dated onto the last
       seven days so the page's own window arithmetic applies to it. Every per (hub, type)
       share the page derives is checked against the one the harness derives from the same
       bytes, and the harness is asked for its numbers directly rather than through a
       committed copy of them. */
    section('the page reproduces the harness, share for share, on a real dump');
    const FIXTURE = path.join(H.REPO, 'tests', 'fixtures', 'marketOrderTrades_weekly_2026-33.csv');
    const truth = JSON.parse(execFileSync(process.execPath,
      [path.join(H.REPO, 'tools', 'verify-tracker.mjs'), FIXTURE, '--json'], { encoding: 'utf8' }))
      .aggregate.filter(a => a.hasGone === 0);
    const s12 = await openSell(browser, server, { noTracker: true });
    const realDays = await mockA4EReal(s12.context, FIXTURE);
    await fetchPrices(s12.page);
    await refreshVolume(s12.page, 30);
    const mine = await s12.page.evaluate(async pairs => {
      const held = trkHeldDays(await trkDb.meta('coverage'), 30);
      const out = [];
      for (const [hub, typeId] of pairs) {
        const recs = await trkDb.rowsFor(hub, typeId);
        const s = trkSeries(recs, 30, held.length);
        const side = b => (s ? (b ? s.buy : s.sell) : []);
        const sr = histVolOf(side(false), 30) || 0, br = histVolOf(side(true), 30) || 0;
        out.push({ hub, typeId,
          sellUnits: s ? s.sellUnits : null, buyUnits: s ? s.buyUnits : null,
          share: s ? s.capture : null, rate: s ? s.sellUnitsDay : null,
          twoRate: sr + br > 0 ? sr / (sr + br) : null });
      }
      return { held: held.length, rows: out };
    }, truth.map(a => [a.hub, a.typeId]));
    eq('only the days that carried rows are held', mine.held, realDays.length);
    eq('...which is the week the file covers', mine.held, 7);
    const missPair = mine.rows.filter((r, i) =>
      r.sellUnits !== truth[i].sellUnits || r.buyUnits !== truth[i].buyUnits);
    eq('every unit the harness counted is in the cache, on the side it counted it',
      JSON.stringify(missPair.map(r => r.hub + '|' + r.typeId)), '[]');
    const missShare = mine.rows.filter((r, i) => Math.abs((r.share || 0) - (truth[i].share || 0)) > 1e-12);
    eq('and every share matches it exactly, all ' + truth.length + ' pairs',
      JSON.stringify(missShare.map(r => r.hub + '|' + r.typeId)), '[]');
    near('the rate is units over the days held', mine.rows[0].rate, mine.rows[0].sellUnits / 7, 1e-9);
    const twoRateWrong = mine.rows.filter((r, i) =>
      r.twoRate != null && Math.abs(r.twoRate - truth[i].share) > 1e-9);
    check('the shipped two-rate formula disagrees with the file on the uneven pairs',
      twoRateWrong.length >= 8, twoRateWrong.length + ' of ' + truth.length + ' pairs');
    check('...which is why nothing but the file itself could have caught this',
      truth.filter(a => a.sellDays !== a.buyDays).length >= twoRateWrong.length,
      truth.filter(a => a.sellDays !== a.buyDays).length + ' pairs have uneven sides');
    await s12.close();

    /* ================= a host that stops talking ==================================== */
    section('a stalled host cannot keep the buttons');
    /* `fetch` has no timeout of its own. Measured on the shipped page against a host that
       accepts and then says nothing: settled=false after 25 s, both Refresh buttons
       disabled, and Clear could not recover them — it bumped the cancel token while the
       request it was waiting on stayed open. Only a reload escaped. */
    const s13 = await openSell(browser, server, { hang: true });
    await fetchPrices(s13.page);
    await setWindow(s13.page, 30);
    await s13.page.waitForFunction(() => !state.trkRunning);
    await s13.page.click('#btnTrk');
    await s13.page.waitForFunction(() => state.trkRunning === true, null, { timeout: 20000 });
    // wait for a request to be genuinely in flight before cancelling it
    await s13.page.waitForFunction(() => /^(week|day) 1\//.test(
      document.getElementById('trkStatus').textContent), null, { timeout: 20000 });
    const hangStatus = await s13.page.textContent('#trkStatus');
    check('the running line quotes the download it is making',
      / · \d+ MB$/.test(hangStatus), hangStatus);
    const t13 = Date.now();
    await s13.page.click('#btnClear');
    let clearWorked = true;
    try {
      // well inside the 30 s watchdog: only an ABORT can settle it this fast
      await s13.page.waitForFunction(() => !state.trkRunning
        && !document.getElementById('btnTrk').disabled, null, { timeout: 12000 });
    } catch (_e) { clearWorked = false; }
    check('Clear aborts the request, not only its token', clearWorked,
      'still running after ' + Math.round((Date.now() - t13) / 1000) + 's');
    const afterClear = await s13.page.evaluate(() => ({
      running: state.trkRunning,
      disabled: document.getElementById('btnTrk').disabled,
      ordDisabled: document.getElementById('btnOrdTrk').disabled,
      bar: document.getElementById('trkBar').hidden,
    }));
    check('...with both Refresh buttons back', !afterClear.disabled && !afterClear.ordDisabled,
      JSON.stringify(afterClear));
    check('...the bar put away', afterClear.bar);
    check('...and nothing left running', !afterClear.running);
    await s13.close();

    section('...and a stall nobody cancels is given up on, counted, and shown');
    /* One file of the run stalls and the rest serve. The watchdog is what ends that one
       request, and the page must land where the ABORTING host already lands — buttons
       back, red, "1 failed" — with every other day of the window still landing. */
    const s14 = await openSell(browser, server, { hangFirst: true });
    await fetchPrices(s14.page);
    await setWindow(s14.page, 30);
    await s14.page.waitForFunction(() => !state.trkRunning);
    await s14.page.click('#btnTrk');
    let watchdog = true;
    try {
      await s14.page.waitForFunction(() => !state.trkRunning
        && !document.getElementById('btnTrk').disabled, null, { timeout: 75000 });
    } catch (_e) { watchdog = false; }
    check('the watchdog ends a run the host has abandoned', watchdog, 'never settled');
    const stalled = await s14.page.evaluate(() => ({
      text: document.getElementById('trkStatus').textContent,
      cls: document.getElementById('trkStatus').className,
      disabled: document.getElementById('btnTrk').disabled,
      held: Object.keys(state.trk.cov.days).length,
    }));
    check('...counting the file it lost', / · 1 failed$/.test(stalled.text), stalled.text);
    eq('...in red', stalled.cls, 'err');
    check('...with the button given back', !stalled.disabled);
    check('...and every file that did answer still landed', stalled.held > 0,
      String(stalled.held));
    await s14.close();

    /* ================= the guard that became the measurement ========================= */
    section('a clamped trade size says it is clamped');
    /* Measured on a liquid item: amount/orderNum came to 3.58 M, the flat 1e6 guard took
       it, and the model then ran on the constant while the source still read a
       measurement. The guard is a rule now — one transaction cannot be larger than
       everything that trades inside the window — and when it bites it is named. */
    const s15 = await openSell(browser, server, { noTracker: true });
    const kappaCase = await s15.page.evaluate(() => {
      const d = t => new Date(Date.now() - t * 86400e3).toISOString().slice(0, 10);
      // one enormous print in a month of silence: 3.3e7 a day, one trade of 1e9
      const lumpy = [{ date: d(29), average: 100, highest: 110, lowest: 90, volume: 1, orders: 1 },
                     { date: d(1), average: 100, highest: 110, lowest: 90, volume: 1e9, orders: 1 }];
      const steady = [];
      for (let t = 29; t >= 0; t--)
        steady.push({ date: d(t), average: 100, highest: 110, lowest: 90, volume: 1000, orders: 100 });
      return {
        lumpy: fillOutlook({ hist: lumpy, typeId: 7001 }, [], 100, 50, 14, { histDays: 30 }),
        steady: fillOutlook({ hist: steady, typeId: 7002 }, [], 100, 50, 14, { histDays: 30 }),
        max: typeof KAPPA_MAX,
      };
    });
    eq('the invented ceiling is gone from the file', kappaCase.max, 'undefined');
    check('a trade bigger than the whole window is cut down to it',
      kappaCase.lumpy.kappaCapped === true
      && Math.abs(kappaCase.lumpy.kappa - kappaCase.lumpy.volDay * 14) < 1e-6,
      kappaCase.lumpy.kappa + ' vs ' + kappaCase.lumpy.volDay * 14);
    eq('...and the source stops calling the constant a measurement',
      kappaCase.lumpy.kappaSrc, 'esi-capped');
    check('on an ordinary item the guard never touches the number',
      kappaCase.steady.kappaCapped === false && Math.abs(kappaCase.steady.kappa - 10) < 1e-9,
      kappaCase.steady.kappa + ' / ' + kappaCase.steady.kappaSrc);
    eq('...which is what an inert guard looks like', kappaCase.steady.kappaSrc, 'esi');
    await s15.close();

    /* ================= the ordering the last pass claimed and did not pin ============ */
    section('the memo settles BEFORE the button comes back');
    /* "!state.trkRunning is a signal a test can wait on" is only true if the numbers are
       in place before the flag drops. Moving the settle after the re-enable — the natural
       mutation of that exact claim — left every check green last time, so the order is
       recorded here rather than inferred from a timing race: the memo stamps the sequence
       when it resolves, a MutationObserver stamps it when the button loses `disabled`. */
    const s16 = await openSell(browser, server, {});
    await fetchPrices(s16.page);
    await s16.page.evaluate(() => {
      window.__order = [];
      const orig = loadTrackerMemo;
      window.loadTrackerMemo = async function (...a) {
        const r = await orig.apply(null, a);
        window.__order.push('memo');
        return r;
      };
      new MutationObserver(() => {
        if (!document.getElementById('btnTrk').disabled) window.__order.push('button');
      }).observe(document.getElementById('btnTrk'), { attributes: true, attributeFilter: ['disabled'] });
    });
    await setWindow(s16.page, 30);
    await s16.page.waitForFunction(() => !state.trkRunning);
    await s16.page.evaluate(() => { window.__order.length = 0; });
    await s16.page.click('#btnTrk');
    await s16.page.waitForFunction(() => !state.trkRunning
      && !document.getElementById('btnTrk').disabled, null, { timeout: 90000 });
    const order = await s16.page.evaluate(() => window.__order.slice());
    check('the run reloaded the memo and gave the button back', order.includes('memo')
      && order.includes('button'), JSON.stringify(order));
    check('...in that order, so "not running" means the numbers are the cache\'s',
      order.indexOf('memo') < order.indexOf('button'), JSON.stringify(order));
    const settledNow = await s16.page.evaluate(() =>
      (state.rows.find(r => r.name === 'Tritanium') || {}).volSell);
    check('...and the table already carries them at that instant', settledNow > 7000,
      String(settledNow));
    await s16.close();

    /* ================= one button, both feeds ======================================== */
    /* Prices and traded volume are not two errands: the fill model cannot run without the
       tracker's sell-side rate, so a page fetched with one of the two buttons was a page
       holding half a model. */
    section('one button fetches everything the model needs');
    const s18 = await openSell(browser, server, {});
    await s18.page.fill('#inv', PASTE);
    await s18.page.dispatchEvent('#inv', 'input');
    await setWindow(s18.page, 30);
    const before18 = s18.trk.urls.length;
    await s18.page.click('#btnEsi');
    await s18.page.waitForFunction(() => !state.esiRunning && !state.trkRunning
      && !document.getElementById('btnEsi').disabled && !document.getElementById('btnTrk').disabled,
      null, { timeout: 120000 });
    const got18 = await s18.page.evaluate(() => ({
      priced: state.esi.size,
      tracked: state.trk && state.trk.held,
      rows: state.rows.length,
      withVol: state.rows.filter(r => r.volState === 'tracker').length,
    }));
    check('one press priced the inventory', got18.priced > 0, JSON.stringify(got18));
    check('...and downloaded traded volume in the same press',
      s18.trk.urls.length > before18, `${before18} -> ${s18.trk.urls.length}`);
    check('...so the rows come out with a station-measured rate, not just ESI regional',
      got18.withVol > 0, JSON.stringify(got18));
    eq('...and the tracker holds the window the history field asked for', got18.tracked, 30);
    await s18.close();

    /* A player structure has no Adam4EVE coverage, so the second leg must not fire and
       spend 20+ MB on data that cannot be used. */
    section('...and skips the volume leg where there is no coverage to fetch');
    const s19 = await openSell(browser, server, {});
    await s19.page.fill('#inv', PASTE);
    await s19.page.dispatchEvent('#inv', 'input');
    const before19 = s19.trk.urls.length;
    await s19.page.evaluate(() => {
      // pretend the selected market is a structure: the tracker covers NPC hubs only
      window.hub = () => ({ label: 'Test Structure', region: 10000002, structure: 1234567890,
                            station: null });
    });
    await s19.page.evaluate(() => runFetch().catch(() => {}));
    await s19.page.waitForFunction(() => !state.esiRunning && !state.trkRunning, null, { timeout: 60000 });
    eq('no traded-volume request was made for an uncovered market',
      s19.trk.urls.length, before19);
    await s19.close();

    /* ================= what the download costs, before it is made ==================== */
    section('the page states the size of the download it is about to make');
    const s17 = await openSell(browser, server, {});
    // the button carries the quote once there is an inventory to fetch for
    await s17.page.fill('#inv', PASTE);
    await s17.page.dispatchEvent('#inv', 'input');
    await s17.page.waitForFunction(() => !document.getElementById('btnEsi').disabled);
    const quoted = await s17.page.evaluate(() => ({
      days: trkWindowDays(),
      fetch: document.getElementById('btnEsi').title,
      histDays: document.getElementById('histDays').title,
      btn: document.getElementById('btnTrk').title,
      ord: document.getElementById('btnOrdTrk').title,
      feeds: document.querySelector('#trkAge').parentElement.title,
      notes: (() => {
        const c = document.body.cloneNode(true);
        for (const x of c.querySelectorAll('script, style')) x.remove();   // copy, not code
        return c.textContent.replace(/\s+/g, ' ');
      })(),
    }));
    /* Priced by the page's own planner against the measured gzip sizes, so the copy
       cannot drift from either. The figures are checked against that arithmetic rather
       than against a number typed into the markup. */
    const priced = await s17.page.evaluate(() => {
      const now = new Date();
      const out = {};
      for (const d of [30, 90, 180, 365])
        out[d] = trkMb(trkWireBytes(trkPlanJobs({ v: 1, days: {} }, {}, d, now)));
      return out;
    });
    /* The quote follows the ONE window setting, so it has to be priced for whatever is
       typed rather than for an enumerated list that no longer exists. */
    check('the fetch button prices the download it is about to make',
      quoted.fetch.includes(`${priced[quoted.days]} MB gzipped for ${quoted.days}d`),
      quoted.fetch + ' | ' + JSON.stringify(priced));
    check('...at the measured size of a gzipped weekly file, not a guess',
      priced[90] >= 55 && priced[90] <= 70 && priced[365] > 200,
      JSON.stringify(priced));
    check('...and says it fetches both feeds, not just prices',
      /ESI/.test(quoted.fetch) && /Adam4EVE/.test(quoted.fetch), quoted.fetch);
    check('the history-days field says it drives the download too',
      quoted.histDays.includes(`${priced[quoted.days]} MB gzipped for ${quoted.days}d`)
        && /how far back/.test(quoted.histDays), quoted.histDays);
    check('both Refresh buttons quote the rule behind those figures',
      /per week of history: 4\.76 MB/.test(quoted.btn) && quoted.btn === quoted.ord, quoted.btn);
    check('the feeds line quotes the first run in bytes and rows',
      quoted.feeds.includes(`${priced[quoted.days]} MB`) && /rows: [\d.]+ M/.test(quoted.feeds),
      quoted.feeds);
    check('the notes state the real row count, not "a few hundred thousand"',
      /2\.1 million rows/.test(quoted.notes) && !/few hundred thousand/.test(quoted.notes),
      (quoted.notes.match(/[^.]*million rows[^.]*/) || ['(absent)'])[0]);
    await s17.close();

  } finally {
    await browser.close();
    await server.close();
  }
});
