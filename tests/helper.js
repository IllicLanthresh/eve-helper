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
           ssoScopes:[...] | null, onStandings:fn } */
async function mockEsi(context, opts) {
  opts = opts || {};
  const skills = opts.skills || {};
  const typeIds = Object.assign({}, NAMED_IDS, opts.typeIds || {});
  const books = opts.books || {};
  const owner = opts.stationOwner || { corp: 1000035, faction: 500001 };
  const counters = { standings: 0, skills: 0, orders: 0 };

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
    for (const b of book.buys) orders.push({
      order_id: oid++, type_id: typeId, is_buy_order: true, price: b.p,
      volume_remain: b.v, min_volume: b.minv || 1, location_id: b.loc || 60003760,
      system_id: 30000142, range: b.range || 'station',
    });
    for (const s of book.sells) orders.push({
      order_id: oid++, type_id: typeId, is_buy_order: false, price: s.p,
      volume_remain: s.v, min_volume: 1, location_id: s.loc || 60003760,
      system_id: 30000142, range: 'station',
    });
    route.fulfill(json(orders));
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

  return counters;
}

module.exports = {
  REPO, CHROMIUM, ALL_SCOPES, NAMED_IDS,
  check, eq, near, section, finish, run,
  startServer, launch, watchPage,
  fakeJwt, authState, seedStorage, mockEsi, json,
};
