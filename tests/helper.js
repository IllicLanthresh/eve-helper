/* Shared plumbing for the EVE Helper test suites.

   Everything here is deliberately tiny: a PASS/FAIL check() with a process exit code,
   a static file server for the repo (the pages fetch data/industry.json, which does not
   work over file://), and a chromium launcher pointed at the pre-installed browser.

   No test framework on purpose — the suites are plain Node scripts, so `node x.test.js`
   runs one suite and `npm test` runs them all. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const REPO = path.resolve(__dirname, '..');
// pre-installed browser; PW_CHROMIUM overrides it (do NOT run `playwright install`)
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

/* ---------- PASS/FAIL reporting ---------- */
let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else {
    failed++;
    const line = name + (detail != null ? '  [' + detail + ']' : '');
    failures.push(line);
    console.log('  FAIL  ' + line);
  }
  return !!cond;
}

/* exact equality, with both values in the failure detail */
function eq(name, actual, expected) {
  return check(name, Object.is(actual, expected) || actual === expected,
    'got ' + fmt(actual) + ', expected ' + fmt(expected));
}

/* float equality within tol (absolute) */
function near(name, actual, expected, tol) {
  tol = tol == null ? 1e-9 : tol;
  const ok = typeof actual === 'number' && Number.isFinite(actual)
    && Math.abs(actual - expected) <= tol;
  return check(name, ok, 'got ' + fmt(actual) + ', expected ' + fmt(expected) + ' ±' + tol);
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v && typeof v === 'object') { try { return JSON.stringify(v); } catch (_e) { return String(v); } }
  return String(v);
}

function section(title) { console.log('\n— ' + title); }

/* Call at the end of a suite. Sets a non-zero exit code when anything failed. */
function finish(suite) {
  console.log('\n' + suite + ': ' + passed + ' passed, ' + failed + ' failed'
    + ' (' + (passed + failed) + ' checks)');
  if (failed) {
    console.log('failures:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
  return failed === 0;
}

/* Wrap a suite body so an exception is a loud failure rather than a silent exit-0. */
function run(suite, body) {
  console.log('=== ' + suite + ' ===');
  return Promise.resolve()
    .then(body)
    .catch(err => {
      failed++;
      failures.push('suite threw: ' + (err && err.stack || err));
      console.log('  FAIL  suite threw: ' + (err && err.message || err));
      console.error(err);
    })
    .then(() => finish(suite));
}

/* ---------- static server (repo root) ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function startServer(root) {
  root = root || REPO;
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: 'http://127.0.0.1:' + port,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

/* ---------- browser ---------- */
function launch() {
  return chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
}

/* Fail loudly on page errors instead of letting a broken page quietly pass. */
function watchPage(page, label) {
  page.on('pageerror', e => check((label || 'page') + ': no uncaught page error', false, e.message));
}

/* ---------- ESI/SSO mock plumbing ---------- */

/* A syntactically real JWT (unsigned — auth.js only base64-decodes the payload). */
function fakeJwt(payload) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}

const ALL_SCOPES = [
  'esi-skills.read_skills.v1',
  'esi-characters.read_standings.v1',
  'esi-markets.structure_markets.v1',
  'esi-universe.read_structures.v1',
  'esi-search.search_structures.v1',
  'esi-characters.read_blueprints.v1',
  'esi-markets.read_character_orders.v1',
  'esi-ui.open_window.v1',
];

/* The localStorage blob auth.js expects for a logged-in character (storage schema v2). */
function authState(chars, opts) {
  opts = opts || {};
  const out = { v: 2, clientId: opts.clientId || 'test-client-id', active: null, chars: {} };
  for (const c of chars) {
    out.chars[c.id] = {
      tokens: {
        access: fakeJwt({
          sub: 'CHARACTER:EVE:' + c.id,
          name: c.name,
          scp: c.scopes || ALL_SCOPES,
        }),
        refresh: 'refresh-' + c.id,
        exp: Date.now() + 3600e3,
      },
      character: { id: c.id, name: c.name },
    };
    if (out.active == null) out.active = c.id;
  }
  if (opts.active != null) out.active = opts.active;
  return out;
}

/* Seed localStorage before any page script runs. */
async function seedStorage(context, origin, entries) {
  await context.addInitScript(kv => {
    for (const [k, v] of kv) {
      try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (_e) {}
    }
  }, entries);
}

/* JSON reply helper — x-pages must be exposed or the pages cannot read it cross-origin. */
function json(body, headers) {
  return {
    status: 200,
    contentType: 'application/json',
    headers: Object.assign({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'x-pages, x-esi-error-limit-remain, x-esi-error-limit-reset',
      'x-pages': '1',
    }, headers || {}),
    body: JSON.stringify(body),
  };
}

/* A 1x1 transparent PNG, so a routed <img> decodes instead of erroring. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');

/* Type ids for skills resolved by NAME through /universe/ids (auth.js) and for market
   items (index.html). Both share one route handler. */
const NAMED_IDS = {
  Connections: 3359,
  Diplomacy: 3357,
  'Simple Ore Processing': 12190,
  'Coherent Ore Processing': 12191,
  'Variegated Ore Processing': 12192,
  'Complex Ore Processing': 12193,
  'Abyssal Ore Processing': 12194,
  'Mercoxit Ore Processing': 12195,
  'Ubiquitous Moon Ore Processing': 12196,
  'Common Moon Ore Processing': 12197,
  'Uncommon Moon Ore Processing': 12198,
  'Rare Moon Ore Processing': 12199,
  'Exceptional Moon Ore Processing': 12200,
};

/* Install ESI/SSO routes.
   opts: { skills:{name:level}, standings:{fromId:value}, stationOwner:{corp,faction},
           books:{typeName:{buys:[{p,v,minv}], sells:[{p,v}]}}, typeIds:{name:id},
           charOrders:{charId:[esiOrder]}, namedIds:{id:name},
           ssoScopes:[...] | null, onStandings:fn } */
async function mockEsi(context, opts) {
  opts = opts || {};
  const skills = opts.skills || {};
  const typeIds = Object.assign({}, NAMED_IDS, opts.typeIds || {});
  const books = opts.books || {};
  const owner = opts.stationOwner || { corp: 1000035, faction: 500001 };
  const counters = { standings: 0, skills: 0, orders: 0, charOrders: 0 };

  // SSO metadata (which scopes still exist)
  await context.route('**/login.eveonline.com/.well-known/**', route => {
    if (opts.ssoScopes === null) return route.fulfill({ status: 404, body: 'gone' });
    route.fulfill(json({ scopes_supported: opts.ssoScopes || ALL_SCOPES }));
  });

  // token endpoint (authorization_code + refresh_token)
  await context.route('**/login.eveonline.com/v2/oauth/token', route => {
    const tok = opts.tokenResponse || {};
    route.fulfill(json({
      access_token: tok.access || fakeJwt({
        sub: 'CHARACTER:EVE:' + (tok.charId || 93813310),
        name: tok.charName || 'Miquel Dreamer',
        scp: tok.scopes || ALL_SCOPES,
      }),
      refresh_token: 'refresh-token',
      expires_in: 1200,
    }));
  });

  // name -> type id (POST body carries the names)
  await context.route('**/universe/ids/**', route => {
    let names = [];
    try { names = JSON.parse(route.request().postData() || '[]'); } catch (_e) {}
    const inventory_types = names
      .filter(n => typeIds[n] != null)
      .map(n => ({ id: typeIds[n], name: n }));
    route.fulfill(json({ inventory_types }));
  });

  // character skills
  await context.route('**/characters/*/skills/**', route => {
    counters.skills++;
    const SKILL_IDS = { accounting: 16622, brokerRelations: 3446, reprocessing: 3385, reprocessingEfficiency: 3389 };
    const list = [];
    for (const [k, lvl] of Object.entries(skills)) {
      const id = SKILL_IDS[k] != null ? SKILL_IDS[k]
        : typeIds[k[0].toUpperCase() + k.slice(1)] != null ? typeIds[k[0].toUpperCase() + k.slice(1)]
        : typeIds[k];
      if (id != null) list.push({ skill_id: id, active_skill_level: lvl, trained_skill_level: lvl });
    }
    for (const [id, lvl] of Object.entries(opts.rawSkills || {}))
      list.push({ skill_id: Number(id), active_skill_level: lvl, trained_skill_level: lvl });
    route.fulfill(json({ skills: list, total_sp: 1e8 }));
  });

  // character standings
  await context.route('**/characters/*/standings/**', route => {
    counters.standings++;
    if (opts.standingsStatus) return route.fulfill({ status: opts.standingsStatus, body: '{}' });
    const list = Object.entries(opts.standings || {})
      .map(([id, v]) => ({ from_id: Number(id), from_type: 'npc_corp', standing: v }));
    route.fulfill(json(list));
  });

  // station -> owner corp -> faction
  await context.route('**/universe/stations/**', route =>
    route.fulfill(json({ station_id: 60003760, name: 'Jita IV - Moon 4', owner: owner.corp, system_id: 30000142 })));
  await context.route('**/corporations/**', route =>
    route.fulfill(json({ name: opts.corpName || 'Caldari Navy', faction_id: owner.faction })));
  await context.route('**/universe/factions/**', route =>
    route.fulfill(json([{ faction_id: owner.faction, name: opts.factionName || 'Caldari State' }])));

  // market orders for a region, filtered by type_id
  await context.route('**/markets/*/orders/**', route => {
    counters.orders++;
    const url = new URL(route.request().url());
    const typeId = Number(url.searchParams.get('type_id'));
    const name = Object.keys(typeIds).find(n => typeIds[n] === typeId);
    const book = (name && books[name]) || { buys: [], sells: [] };
    const orders = [];
    let oid = typeId * 1000;
    // a fixture level may pin its own order_id — that is how a suite puts the user's
    // OWN order into the book it is about to be compared against
    for (const b of book.buys) orders.push({
      order_id: b.id != null ? b.id : oid++, type_id: typeId, is_buy_order: true, price: b.p,
      volume_remain: b.v, min_volume: b.minv || 1, location_id: b.loc || 60003760,
      system_id: 30000142, range: b.range || 'station',
    });
    for (const s of book.sells) orders.push({
      order_id: s.id != null ? s.id : oid++, type_id: typeId, is_buy_order: false, price: s.p,
      volume_remain: s.v, min_volume: 1, location_id: s.loc || 60003760,
      system_id: 30000142, range: 'station',
    });
    route.fulfill(json(orders));
  });

  // a character's own open market orders (My orders mode). opts.charOrders is
  // {charId: [order, ...]}; a character absent from it answers 403, which is what ESI
  // does for a token without the scope.
  await context.route('**/characters/*/orders/**', route => {
    counters.charOrders++;
    const id = Number((route.request().url().match(/characters\/(\d+)/) || [])[1]);
    const list = (opts.charOrders || {})[id];
    if (!list) return route.fulfill({ status: 403, body: '{}' });
    route.fulfill(json(list));
  });

  // ids -> names (the mirror of /universe/ids). Resolves type ids out of typeIds and
  // anything else out of opts.namedIds; an id in neither is left out of the reply, which
  // is what ESI does for an id it cannot name.
  await context.route('**/universe/names/**', route => {
    let ids = [];
    try { ids = JSON.parse(route.request().postData() || '[]'); } catch (_e) {}
    const extra = opts.namedIds || {};
    const out = [];
    for (const id of ids) {
      const type = Object.keys(typeIds).find(n => typeIds[n] === id);
      if (type) out.push({ id, name: type, category: 'inventory_type' });
      else if (extra[id]) out.push({ id, name: extra[id], category: 'station' });
    }
    route.fulfill(json(out));
  });

  // price history (optional)
  await context.route('**/markets/*/history/**', route => {
    const url = new URL(route.request().url());
    const typeId = Number(url.searchParams.get('type_id'));
    const name = Object.keys(typeIds).find(n => typeIds[n] === typeId);
    route.fulfill(json(((books[name] || {}).hist) || []));
  });

  // never let a test reach the real network / CDN
  await context.route('**://web.ccpgamescdn.com/**', route => route.fulfill({ status: 200, body: '' }));

  // item icons. The suites only assert the src attribute, but an unrouted <img> is a real
  // request to CCP's CDN from every row of every table, so it is served locally instead.
  await context.route('**://images.evetech.net/types/*/icon*', route => route.fulfill({
    status: 200, contentType: 'image/png',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: PNG_1PX,
  }));

  return counters;
}

/* ---------- Adam4EVE market-order-tracker mock ----------

   The tracker is a plain static host: no auth, no pagination, no error-limit headers,
   one semicolon-separated CSV per day and one per ISO week, and a permissive CORS header
   that is the only reason a browser can read it at all. So this mock is much smaller than
   mockEsi — the interesting part is not the payload but the FILENAME, because two of its
   rules are easy to get backwards and silently produce a 404 against the real host:

     * the week number in a weekly URL is NOT zero-padded  (weekly_2026-1, never 2026-01)
     * the directory is the ISO WEEK-YEAR, not the calendar year of the days inside it
       (weekly_2026-1 covers 2025-12-29 onward and still lives under /2026/)

   Both rules are enforced here rather than papered over: a padded week number or a
   mismatched directory answers 404 exactly as the real host does, so a page that gets
   either wrong fails in the suite instead of in production. */

const A4E_HEADER = 'location_id;region_id;type_id;is_buy_order;has_gone;scanDate;'
  + 'amount;high;low;avg;orderNum;iskValue';

const FIXTURES = path.join(__dirname, 'fixtures');

/* CSV reply helper — the tracker host is plain text with a permissive CORS header. */
function csv(text, headers) {
  return {
    status: 200,
    contentType: 'text/csv',
    headers: Object.assign({ 'Access-Control-Allow-Origin': '*' }, headers || {}),
    body: text,
  };
}

/* ISO-8601 week of a 'YYYY-MM-DD' day. The Thursday of the week fixes both the year and
   the number, which is what makes week 1 of 2026 start in December 2025. */
function isoWeekOf(day) {
  const t = new Date(day + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  return { y, w: Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400e3 + 1) / 7) };
}

/* One CSV line. A row may be the twelve published fields in order, or an object using
   the column names, which is what a suite writing a row by hand actually wants. */
function a4eLine(row) {
  if (typeof row === 'string') return row;
  if (Array.isArray(row)) return row.join(';');
  const f = [
    row.locationId != null ? row.locationId : row.hub,
    row.regionId != null ? row.regionId : 10000002,
    row.typeId,
    row.isBuyOrder != null ? row.isBuyOrder : (row.buy ? 1 : 0),
    row.hasGone != null ? row.hasGone : 0,
    row.scanDate != null ? row.scanDate : row.day,
    row.amount,
    row.high, row.low, row.avg,
    row.orderNum != null ? row.orderNum : 1,
    row.iskValue,
  ];
  return f.join(';');
}

/* Header plus rows, with the trailing newline the real files carry. */
function a4eCsv(rows) {
  return A4E_HEADER + '\n' + (rows || []).map(a4eLine).join('\n') + '\n';
}

/* Read one of the distilled fixtures (see tests/fixtures/build-fixtures.mjs). Returns
   null when the file is absent, which the mock turns into the host's own 404. */
function fixture(name) {
  try { return fs.readFileSync(path.join(FIXTURES, name), 'utf8'); }
  catch (_e) { return null; }
}

/* Install Adam4EVE static-host routes.

   opts:
     days:    { 'YYYY-MM-DD': rows[] | 'raw csv body' }   what a daily file contains
     weeks:   { '2026-33': rows[] | 'raw csv body' }      overrides the assembled weekly
     missing: ['YYYY-MM-DD']       404, the shape of a day that is not published yet
     fail:    ['YYYY-MM-DD']       503, a real fault the page must count as failed
     weeklyMissing: ['2026-1']     404 for that weekly (week number UNPADDED, as in the URL)
     weeklyFail:    ['2026-33']    503 for that weekly
     slow:    ms | { 'YYYY-MM-DD': ms, '2026-33': ms }    delay before the reply lands
     fixtures: false               do not fall back to tests/fixtures/ (default: do)

   When a day is in neither `days` nor `missing` nor `fail`, the fixture of that name is
   served; when there is no such fixture the reply is 404. A weekly with no override is
   assembled out of `days` by ISO week, and falls back to the fixture the same way.

   Returns counters: { daily, weekly, other, urls, maxInflight } — `urls` is every tracker
   URL in request order, so a suite can assert WHICH files were asked for, and
   `maxInflight` is how many were ever in flight at once, so it can assert that the page
   fetches one file at a time rather than hammering a volunteer host. */
async function mockA4E(context, opts) {
  opts = opts || {};
  const days = opts.days || {};
  const weeks = opts.weeks || {};
  const missing = new Set(opts.missing || []);
  const fail = new Set(opts.fail || []);
  const weeklyMissing = new Set((opts.weeklyMissing || []).map(String));
  const weeklyFail = new Set((opts.weeklyFail || []).map(String));
  const useFixtures = opts.fixtures !== false;
  const slowAll = typeof opts.slow === 'number' ? opts.slow : 0;
  const slowOne = typeof opts.slow === 'object' && opts.slow ? opts.slow : {};
  const counters = { daily: 0, weekly: 0, other: 0, urls: [], maxInflight: 0 };
  let inflight = 0;

  const body = v => typeof v === 'string' ? v : a4eCsv(v);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* The published name of a daily is unambiguous; a weekly's is not, so the two rules
     that decide it are checked against the URL exactly as the page wrote it. */
  const DAILY = /^\/MarketOrdersTrades\/(\d{4})\/marketOrderTrades_daily_(\d{4}-\d{2}-\d{2})\.csv$/;
  const WEEKLY = /^\/MarketOrdersTrades\/(\d{4})\/marketOrderTrades_weekly_(\d{4})-(\d{1,2})\.csv$/;

  await context.route('**://static.adam4eve.eu/**', async route => {
    const url = new URL(route.request().url());
    counters.urls.push(url.pathname);
    inflight++;
    counters.maxInflight = Math.max(counters.maxInflight, inflight);
    // the count has to stay up until the reply has actually left, or two overlapping
    // requests can each look like the only one in flight
    const done = async reply => { try { await route.fulfill(reply); } finally { inflight--; } };

    const d = DAILY.exec(url.pathname);
    if (d) {
      counters.daily++;
      const [, dir, day] = d;
      const wait = slowOne[day] != null ? slowOne[day] : slowAll;
      if (wait) await sleep(wait);
      // the real host files a daily under the calendar year of its own date
      if (dir !== day.slice(0, 4)) return done({ status: 404, body: 'not found' });
      if (fail.has(day)) return done({ status: 503, body: 'service unavailable' });
      if (missing.has(day)) return done({ status: 404, body: 'not found' });
      if (days[day] != null) return done(csv(body(days[day])));
      const fx = useFixtures && fixture('marketOrderTrades_daily_' + day + '.csv');
      return done(fx ? csv(fx) : { status: 404, body: 'not found' });
    }

    const w = WEEKLY.exec(url.pathname);
    if (w) {
      counters.weekly++;
      const [, dir, year, num] = w;
      const key = year + '-' + num;
      const wait = slowOne[key] != null ? slowOne[key] : slowAll;
      if (wait) await sleep(wait);
      // a padded week number is a different filename, and the real host has no such file
      if (num.length > 1 && num[0] === '0') return done({ status: 404, body: 'not found' });
      // the directory is the ISO week-year, which is the year in the filename
      if (dir !== year) return done({ status: 404, body: 'not found' });
      if (weeklyFail.has(key)) return done({ status: 503, body: 'service unavailable' });
      if (weeklyMissing.has(key)) return done({ status: 404, body: 'not found' });
      if (weeks[key] != null) return done(csv(body(weeks[key])));
      const own = Object.keys(days).filter(day => {
        const iso = isoWeekOf(day);
        return iso.y === Number(year) && iso.w === Number(num);
      }).sort();
      if (own.length) {
        const rows = [];
        for (const day of own) {
          const v = days[day];
          if (typeof v === 'string') rows.push(...v.split('\n').slice(1).filter(l => l.trim()));
          else rows.push(...(v || []).map(a4eLine));
        }
        return done(csv(a4eCsv(rows)));
      }
      const fx = useFixtures && fixture('marketOrderTrades_weekly_' + year + '-' + Number(num) + '.csv');
      return done(fx ? csv(fx) : { status: 404, body: 'not found' });
    }

    counters.other++;
    return done({ status: 404, body: 'not found' });
  });

  return counters;
}

/* Abort everything no other route claimed, so a suite that forgets a mock fails loudly
   instead of quietly reaching the real internet.

   INSTALL IT FIRST, before mockEsi and mockA4E. Measured in this Chromium: Playwright
   picks the most RECENTLY registered handler whose pattern matches, and specificity does
   not enter into it — a '**' registered last swallows every mock registered before it.
   Registered first, the same '**' is what is left when nothing else matched, which is
   what a backstop has to be.

   The local static server is exempt: it is the page under test, not the network.

   onBlocked(url) is called for each aborted request; pass one to report what leaked. */
async function blockNetwork(context, onBlocked) {
  await context.route('**', route => {
    const url = route.request().url();
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return route.continue();
    if (onBlocked) onBlocked(url);
    return route.abort();
  });
}

module.exports = {
  REPO, CHROMIUM, ALL_SCOPES, NAMED_IDS,
  check, eq, near, section, finish, run,
  startServer, launch, watchPage,
  fakeJwt, authState, seedStorage, mockEsi, json,
  A4E_HEADER, FIXTURES, csv, isoWeekOf, a4eLine, a4eCsv, fixture, mockA4E, blockNetwork,
};
