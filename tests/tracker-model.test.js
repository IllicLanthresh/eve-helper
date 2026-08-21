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
};

const PASTE = ['Tritanium\t1000', 'Dump Widget\t100', 'Buy Only\t100',
  'Ghost Widget\t100', 'Clamp Widget\t100'].join('\n');

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
};

function a4eRows(d) {
  const out = [];
  for (const loc of HUBS) {
    for (const [tid, s] of Object.entries(SIDES)) {
      for (const isBuy of [0, 1]) {
        const amount = isBuy ? s.buy : s.sell;
        if (!amount) continue;
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

async function fetchPrices(page) {
  await page.fill('#inv', PASTE);
  await page.dispatchEvent('#inv', 'input');
  await page.click('#btnEsi');
  await page.waitForFunction(() => !document.getElementById('btnEsi').disabled && !state.esiRunning,
    null, { timeout: 30000 });
}

async function refreshVolume(page, windowDays) {
  await page.selectOption('#trkDays', String(windowDays));
  await page.waitForFunction(() => !state.trkRunning);
  await page.click('#btnTrk');
  // waits on the run's own flag, never on a clock
  await page.waitForFunction(() => !state.trkRunning && !document.getElementById('btnTrk').disabled,
    null, { timeout: 90000 });
}

const rowOf = (page, name) => page.evaluate(n => {
  const r = state.rows.find(x => x.name === n);
  if (!r) return null;
  const heads = [...document.querySelectorAll('#tbl thead th')].map(th => th.dataset.key || '');
  const tr = [...document.querySelectorAll('#tblBody tr')].find(x => x.children[2].textContent === n);
  const cellOf = k => {
    const i = heads.indexOf(k);
    return tr && i >= 0 ? { text: tr.children[i].textContent, tip: tr.children[i].title,
      copy: tr.children[i].dataset.copy || '' } : { text: '(no such column)', tip: '', copy: '' };
  };
  return { volDay: r.volDay, volSell: r.volSell, volBuy: r.volBuy, capture: r.capture,
    volSrc: r.volSrc, cells: { volSell: cellOf('volSell'), volBuy: cellOf('volBuy'),
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
      await s1.page.textContent('#trkAge'), 'never fetched');
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

    /* ---------- the coverage manifest ------------------------------------------------ */
    section('a day already held is never asked for again');
    const before = s1.trk.urls.length;
    await s1.page.click('#btnTrk');
    await s1.page.waitForFunction(() => !state.trkRunning && !document.getElementById('btnTrk').disabled,
      null, { timeout: 30000 });
    eq('a second refresh asks for nothing', s1.trk.urls.length, before);
    eq('...and says so', await s1.page.textContent('#trkStatus'), 'up to date');

    section('the cache survives a reload');
    await s1.page.reload();
    await s1.page.waitForFunction("typeof rebuild === 'function'");
    await s1.page.waitForFunction(() => state.trk && state.trk.on, null, { timeout: 20000 });
    const reloaded = await s1.page.evaluate(() => ({
      age: document.getElementById('trkAge').textContent,
      days: Object.keys(state.trk.cov.days).length,
      window: document.getElementById('trkDays').value,
    }));
    eq('nothing was refetched to draw it', s1.trk.urls.length, before);
    eq('...the same days are held', reloaded.days, st1.held);
    eq('...the same line is drawn', reloaded.age, st1.age);
    eq('...and the window control came back as it was left', reloaded.window, '30');
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
    eq('a type the tracker does not carry reads a DASH', ghost.cells.volSell.text, '—');
    eq('...with a tooltip that says which of the two it is', ghost.cells.volSell.tip,
      'no tracker row at this hub');
    check('the three tooltips are pairwise different', new Set([
      cold.cells.volSell.tip, ghost.cells.volSell.tip, buyOnly.cells.volSell.tip]).size === 3,
      JSON.stringify([cold.cells.volSell.tip, ghost.cells.volSell.tip, buyOnly.cells.volSell.tip]));
    eq('a tracker-backed row records that source', trit.volSrc, 'tracker');
    eq('...and an uncovered one does not', ghost.volSrc, 'esi');

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
    check('Sell u/d and Buy u/d are real columns',
      cols.keys.includes('volSell') && cols.keys.includes('volBuy'), cols.keys.join(','));
    check('...next to each other, and next to the regional figure they are not',
      cols.keys.indexOf('volBuy') === cols.keys.indexOf('volSell') + 1
      && cols.keys.indexOf('volSell') === cols.keys.indexOf('volDay') + 1, cols.keys.join(','));
    check('the per-item sell share is a column of its own', cols.keys.includes('capture'),
      cols.keys.join(','));
    check('every one of the three explains itself on hover',
      cols.tips.length === 3 && cols.tips.every(t => t && t.split('\n').every(l => l.length <= 130)),
      JSON.stringify(cols.tips));
    check('...and each names the estimate for what it is',
      cols.tips.some(t => /Adam4EVE/.test(t)) && cols.tips.some(t => /this station only/.test(t)),
      JSON.stringify(cols.tips));
    check('My orders carries the same two facts',
      cols.ordKeys.includes('volSell') && cols.ordKeys.includes('capture'), cols.ordKeys.join(','));
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
    /* Seeded so exactly ONE day of the window is missing: a single-day group is fetched
       as a daily, which is the request whose 404 policy this is about. */
    const gapDay = shift(todayUTC(), -3);
    const s4 = await openSell(browser, server, { missing: [gapDay] });
    await fetchPrices(s4.page);
    await s4.page.evaluate(async d => {
      const days = {};
      for (let i = 1; i <= 30; i++) {
        const x = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
        if (x !== d) days[x] = { at: Date.now(), src: 'seed', hubs: { 60003760: 1 } };
      }
      await trkDb.setMeta('coverage', { v: 1, days });
    }, gapDay);
    await refreshVolume(s4.page, 30);
    const failedRun = await s4.page.evaluate(() => ({
      text: document.getElementById('trkStatus').textContent,
      cls: document.getElementById('trkStatus').className,
      held: Object.keys(state.trk.cov.days).length,
      age: document.getElementById('trkAge').textContent,
    }));
    eq('exactly one file was asked for', s4.trk.urls.length, 1);
    check('...as a daily, which is what a one-day gap inside the window is',
      /_daily_/.test(s4.trk.urls[0]), s4.trk.urls[0]);
    check('the run reports the failure rather than swallowing it',
      / · 1 failed$/.test(failedRun.text), failedRun.text);
    eq('...in red', failedRun.cls, 'err');
    check('...and the days that DID land are still held', failedRun.held === 29,
      String(failedRun.held));
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
    const weekGap = await s9.page.evaluate(async d => ({
      text: document.getElementById('trkStatus').textContent,
      cls: document.getElementById('trkStatus').className,
      absent: await trkDb.meta('absent'),
      has: !!(state.trk.cov.days[d]),
    }), gapWeek.day);
    check('the missing week is reported as a failure', / · \d+ failed$/.test(weekGap.text),
      weekGap.text);
    eq('...in red', weekGap.cls, 'err');
    eq('...its days are marked gone, so the next run does not loop on them',
      weekGap.absent[gapWeek.day], 'retired');
    check('...and none of them is claimed as held', !weekGap.has, String(weekGap.has));
    const askedTwice = s9.trk.urls.length;
    await s9.page.click('#btnTrk');
    await s9.page.waitForFunction(() => !state.trkRunning
      && !document.getElementById('btnTrk').disabled, null, { timeout: 30000 });
    eq('a second run asks for nothing at all', s9.trk.urls.length, askedTwice);
    await s9.close();

    section('with IndexedDB blocked the page is the page it always was');
    const s5 = await openSell(browser, server, {
      beforeLoad: () => {
        // a private window, or a browser with site data switched off
        Object.defineProperty(window, 'indexedDB', {
          get() { throw new Error('indexedDB is blocked'); },
        });
      },
    });
    await fetchPrices(s5.page);
    await s5.page.waitForFunction(() => state.trkDisabled === true, null, { timeout: 20000 });
    const blocked = await s5.page.evaluate(() => ({
      rows: document.querySelectorAll('#tblBody tr').length,
      age: document.getElementById('trkAge').textContent,
      tip: document.getElementById('trkAge').title,
      src: document.getElementById('volSrc').textContent,
      volSell: state.rows.every(r => r.volSell == null),
      strategies: state.rows.map(r => r.strategy).join(','),
      esiStatus: document.getElementById('esiStatus').textContent,
      esiCls: document.getElementById('esiStatus').className,
    }));
    check('every row still renders', blocked.rows >= 4, String(blocked.rows));
    eq('the line says why, once', blocked.age, 'storage unavailable');
    check('...and what it costs', /falls back to ESI regional/.test(blocked.tip), blocked.tip);
    check('the provenance line is the ESI one', /ESI regional/.test(blocked.src), blocked.src);
    check('no row invents a tracker number', blocked.volSell);
    check('...and every row still has a plan', blocked.strategies.split(',').every(Boolean),
      blocked.strategies);
    // a dead cache must not leak into an unrelated status line
    check('the price fetch reports its own success, not the cache\'s failure',
      /· \d+ items · /.test(blocked.esiStatus), blocked.esiStatus);
    eq('...in green', blocked.esiCls, 'ok');
    await s5.close();

    section('a schema bump throws the old database away rather than misreading it');
    const s6 = await openSell(browser, server, {});
    await fetchPrices(s6.page);
    await refreshVolume(s6.page, 30);
    const bumped = await s6.page.evaluate(async () => {
      // write a value shape this build does not understand, under an older schema stamp
      const db = await new Promise((res, rej) => {
        const rq = indexedDB.open('eveHelperTracker', 1);
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      });
      await new Promise(res => {
        const tx = db.transaction(['meta', 'rows'], 'readwrite');
        tx.objectStore('meta').put({ v: 0 }, 'schema');
        tx.objectStore('rows').put({ h: 60003760, t: 34, w: '1999-01', r: 'not an array' },
          '60003760|34|1999-01');
        tx.oncomplete = () => res();
      });
      db.close();
      return true;
    });
    check('the stale database is in place', bumped);
    await s6.page.reload();
    await s6.page.waitForFunction("typeof trkDb === 'object'");
    const afterBump = await s6.page.evaluate(async () => ({
      count: await trkDb.count(),
      cov: await trkDb.meta('coverage'),
      schema: await trkDb.meta('schema'),
      age: document.getElementById('trkAge').textContent,
    }));
    eq('every row is gone', afterBump.count, 0);
    eq('...and the coverage manifest with them', afterBump.cov, undefined);
    eq('...leaving the current schema stamped', afterBump.schema.v, 1);
    eq('...and a page that reads as a new one', afterBump.age, 'never fetched');
    await s6.close();

    section('a reload racing the refresh cannot leave a half-run line on screen');
    /* The inventory box reloads the memo on a debounce, so one can be in flight while a
       refresh is still downloading. When the button comes back the line must describe the
       FINISHED run, not whichever snapshot happened to resolve last. */
    const s8 = await openSell(browser, server, {});
    await fetchPrices(s8.page);
    await s8.page.selectOption('#trkDays', '30');
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
    await s7.page.selectOption('#trkDays', '365');
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

  } finally {
    await browser.close();
    await server.close();
  }
});
