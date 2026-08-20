/* Value equivalence across the structure centralisation.

   The facts a structure carries (the owner-set market broker %, the fitted reprocessing
   rig) used to live in each tool's own storage; they now live once, on the central
   structure record, and the tools only SELECT a structure. That move must be invisible in
   every number the tools compute.

   This suite proves it by running BOTH builds side by side: the pre-migration build is
   checked out of git into a temp directory and served on its own port, the current build
   is served from the repo, and both are handed the SAME legacy localStorage — the shapes
   the old tools wrote (eveSellHelper.v2.structBroker, eveHelper.mine.v1.fac.rig). The old
   build reads those directly; the new one imports them into the central record on load.
   Every computed value the pages expose is then captured from both and compared exactly:
   the Sell fee model and per-row plans (net ISK, strategy, list price, effective broker
   %), and the Mine facility base, per-ore refine yields and every profit-mode column.

   The two data files the pages fetch (data/ores.json, data/industry.json) are gitignored
   CI build products, so the fetches are intercepted and served small fixtures — the same
   ones for both builds, so any difference can only come from the migration. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./helper');
const { check, eq, section } = H;

/* The last commit before the central store landed. Everything this suite compares was
   computed by THAT build first; the current build has to reproduce it bit for bit. */
const PRE = '2e8a68b';
const PRE_FILES = ['index.html', 'mine.html', 'auth.js', 'structures.js'];

/* Industry moved one milestone later: profiles used to keep a COPY of every structure
   fact (hull, system, security, role bonuses) next to their routing. This is the last
   build that did, and the same comparison is run against it. */
const PRE_IND = '8bfaaf0';
const PRE_IND_FILES = ['industry.html', 'industry-engine.js', 'auth.js', 'structures.js'];

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };

/* ---------- the structures the legacy storage talks about ---------- */
const KEEPSTAR = {
  id: 1035466617946, name: 'Test Keepstar', typeId: 35834, typeName: 'Keepstar', refinery: null,
  systemId: 30000142, systemName: 'Jita', security: 0.946, regionId: 10000002,
};
const TATARA = {
  id: 9000001, name: 'Test Tatara', typeId: 35836, typeName: 'Tatara', refinery: 'tatara',
  systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999,
};

/* ---------- Sell fixture ---------- */
const SELL_TYPE_IDS = { Tritanium: 34, Pyerite: 35, 'Damage Control II': 2048, 'Cheap Trinket': 9002 };
// the structure's own order book: deep buys under the sell (ORDER), a buy book above the
// sell (INSTANT), a top-of-book slice that beats listing (SPLIT), and a tiny stack whose
// 450 ISK listing pays the 100 ISK broker floor — every plan shape, all broker-sensitive
const SELL_BOOK = {
  Tritanium: { buys: [{ p: 4.0, v: 1e6 }], sells: [{ p: 6.0, v: 1e6 }] },
  Pyerite: { buys: [{ p: 12.0, v: 1e6 }], sells: [{ p: 10.0, v: 1e6 }] },
  'Damage Control II': { buys: [{ p: 900000, v: 3 }, { p: 500000, v: 100 }], sells: [{ p: 800000, v: 50 }] },
  'Cheap Trinket': { buys: [{ p: 1.0, v: 1e6 }], sells: [{ p: 45, v: 1e6 }] },
};
const SELL_PASTE = [
  'Tritanium\t1.000.000\tMineral\t\t\t10.000,00 m3\t4.000.000,00 ISK',
  'Pyerite\t500,000\tMineral\t\t\t5,000.00 m3\t5,000,000.00 ISK',
  'Damage Control II\t20\tDamage Control\t\tLow\t100 m3\t16.000.000,00 ISK',
  'Cheap Trinket\t10',
].join('\n');

/* Storage exactly as the old Sell tool wrote it: the saved structure list in its v1 bare
   array shape, and the owner-set broker % in the tool's own per-structure map. */
const sellLegacy = () => [
  ['eveHelper.auth.v1', H.authState([CHAR])],
  ['eveHelper.structInfo.v1', { [KEEPSTAR.id]: KEEPSTAR }],
  ['eveHelper.structures.v1', [KEEPSTAR]],
  ['eveSellHelper.v2', {
    inv: SELL_PASTE, brokerFee: '2.20', salesTax: '3.00',
    structBroker: { [KEEPSTAR.id]: '4.5' },
    market: 's:' + KEEPSTAR.id, histOn: false, undercut: false, priceSrc: 'sell', ticked: [],
  }],
];

/* ---------- Mine fixture (verbatim SDE entries, as in mine-fleet.test.js) ---------- */
const ORES_FIXTURE = {
  v: 'equivalence-fixture',
  ores: {
    1230:  { n: 'Veldspar', v: 0.1, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 400]], c: 62516, cv: 0.001, ice: 0, s: 60377 },
    17471: { n: 'Dense Veldspar', v: 0.1, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 440]], c: 62518, cv: 0.001, ice: 0, s: 60377 },
    17449: { n: 'Pristine Jaspet', v: 2, p: 100, g: 'Jaspet', b: 'Jaspet', m: [[36, 165], [38, 55]], c: 62542, cv: 0.02, ice: 0, s: 60378 },
    16262: { n: 'Clear Icicle', v: 1000, p: 1, g: 'Ice', b: 'Clear Icicle', m: [[16272, 69], [16273, 35], [16274, 414], [16275, 1]], c: 28434, cv: 100, ice: 1, s: 18025 },
    62516: { n: 'Compressed Veldspar', v: 0.001, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 400]], c: null, cv: null, ice: 0, s: 60377 },
    62518: { n: 'Compressed Dense Veldspar', v: 0.001, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 440]], c: null, cv: null, ice: 0, s: 60377 },
    62542: { n: 'Compressed Pristine Jaspet', v: 0.02, p: 100, g: 'Jaspet', b: 'Jaspet', m: [[36, 165], [38, 55]], c: null, cv: null, ice: 0, s: 60378 },
    28434: { n: 'Compressed Clear Icicle', v: 100, p: 1, g: 'Ice', b: 'Clear Icicle', m: [[16272, 69], [16273, 35], [16274, 414], [16275, 1]], c: null, cv: null, ice: 1, s: 18025 },
  },
  names: {
    'veldspar': 1230, 'dense veldspar': 17471, 'pristine jaspet': 17449, 'clear icicle': 16262,
    'compressed veldspar': 62516, 'compressed dense veldspar': 62518,
    'compressed pristine jaspet': 62542, 'compressed clear icicle': 28434,
  },
  types: {
    34: 'Tritanium', 36: 'Mexallon', 38: 'Nocxium',
    16272: 'Heavy Water', 16273: 'Liquid Ozone', 16274: 'Helium Isotopes', 16275: 'Strontium Clathrates',
    18025: 'Ice Processing', 60377: 'Simple Ore Processing', 60378: 'Coherent Ore Processing',
  },
};
const MINE_TIDS = {
  'Compressed Veldspar': 62516, 'Compressed Dense Veldspar': 62518,
  'Compressed Pristine Jaspet': 62542, 'Compressed Clear Icicle': 28434,
  Veldspar: 1230, 'Dense Veldspar': 17471,
  'Heavy Water': 16272, 'Liquid Ozone': 16273, 'Helium Isotopes': 16274,
};
const TID_NAMES = Object.fromEntries(Object.entries(MINE_TIDS).map(([n, id]) => [id, n]));
const MINE_BOOKS = {
  'Compressed Veldspar': { buys: [], sells: [{ p: 15, v: 1e6 }] },
  'Compressed Dense Veldspar': { buys: [], sells: [{ p: 9, v: 1e6 }] },
  'Compressed Pristine Jaspet': { buys: [], sells: [{ p: 50, v: 1e6 }] },
  'Compressed Clear Icicle': { buys: [], sells: [{ p: 160000, v: 1e6 }] },
  Veldspar: { buys: [], sells: [{ p: 12, v: 1e6 }] },
  'Dense Veldspar': { buys: [], sells: [{ p: 25, v: 1e6 }] },
  'Heavy Water': { buys: [], sells: [{ p: 15, v: 1e6 }] },
  'Liquid Ozone': { buys: [], sells: [{ p: 90, v: 1e6 }] },
  'Helium Isotopes': { buys: [], sells: [{ p: 850, v: 1e6 }] },
};
const MINE_SKILLS = {
  reprocessing: 5, reprocessingEfficiency: 4, accounting: 5,
  'Simple Ore Processing': 5, 'Coherent Ore Processing': 3,
};
const MINE_RAW_SKILLS = { 18025: 3 };   // Ice Processing, by type id
const SCAN = [
  'Veldspar\t100.000\t10.000 m3\t7.431 m',
  'Dense Veldspar\t41,500\t4,150 m3\t9 km',
  'Pristine Jaspet\t3,205\t6,410 m3\t18 km',
  'Clear Icicle\t1,204\t1,204,000 m3\t21 km',
].join('\n');

/* Storage exactly as the old Mine tool wrote it: a facility snapshot carrying the fitted
   reprocessing rig ('t2') next to the pilot's implant. The structure was never in the
   shared saved list — only the ESI identity cache knows it, so the migration has to build
   the record from that. */
const mineLegacy = () => [
  ['eveHelper.auth.v1', H.authState([CHAR])],
  ['eveHelper.structInfo.v1', { [TATARA.id]: TATARA }],
  ['eveHelper.mine.v1', {
    fac: { struct: 's:' + TATARA.id, rig: 't2', sec: 'ns', imp: 4, structInfo: TATARA },
    fleetText: SCAN,
    fleet: { open: true },
  }],
];

/* ---------- the pre-migration build, straight out of git ---------- */
function checkoutPreBuild(commit, files) {
  commit = commit || PRE;
  files = files || PRE_FILES;
  try {
    execFileSync('git', ['-C', H.REPO, 'cat-file', '-e', commit + '^{commit}'], { stdio: 'ignore' });
  } catch (_e) {
    return null;   // shallow clone or no git — the caller reports it as a failed check
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-pre-migration-'));
  for (const f of files)
    fs.writeFileSync(path.join(dir, f),
      execFileSync('git', ['-C', H.REPO, 'show', commit + ':' + f], { maxBuffer: 128 << 20 }));
  return dir;
}

/* ---------- exact comparison with a readable first difference ---------- */
function firstDiff(a, b, at) {
  at = at || '';
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object')
    return at + ': ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], at + (Array.isArray(a) ? '[' + k + ']' : '.' + k));
    if (d) return d;
  }
  return null;
}
const same = (name, before, after) => check(name, firstDiff(before, after) === null, firstDiff(before, after));

/* ================= Sell ================= */
async function captureSell(browser, server) {
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, sellLegacy());
  await H.mockEsi(context, {
    skills: { accounting: 5, brokerRelations: 5 },
    standings: {},
    typeIds: SELL_TYPE_IDS,
    books: {},              // no regional liquidity: a structure market is its own book
  });
  // the structure's order book — one page, every type at once (no type_id filter exists)
  await context.route('**/markets/structures/**', route => {
    const orders = [];
    let oid = 700000;
    for (const [name, book] of Object.entries(SELL_BOOK)) {
      const typeId = SELL_TYPE_IDS[name];
      for (const b of book.buys) orders.push({ order_id: oid++, type_id: typeId, is_buy_order: true,
        price: b.p, volume_remain: b.v, min_volume: b.minv || 1, location_id: KEEPSTAR.id,
        system_id: KEEPSTAR.systemId, range: 'station' });
      for (const s of book.sells) orders.push({ order_id: oid++, type_id: typeId, is_buy_order: false,
        price: s.p, volume_remain: s.v, min_volume: 1, location_id: KEEPSTAR.id,
        system_id: KEEPSTAR.systemId, range: 'station' });
    }
    route.fulfill(H.json(orders));
  });
  const page = await context.newPage();
  H.watchPage(page, 'sell@' + server.url);
  await page.goto(server.url + '/index.html');
  await page.waitForFunction("typeof rebuild === 'function' && typeof hub === 'function'");
  // settled = the structure is the market, its owner-set rate is in the box, and the
  // skills auto-fill has finished writing the sales tax
  await page.waitForFunction(() => hub().structure === 1035466617946
    && document.getElementById('brokerFee').value === '4.5'
    && /⚡/.test(document.body.textContent), null, { timeout: 20000 });
  await page.click('#btnEsi');
  await page.waitForFunction(() => !document.getElementById('btnEsi').disabled && !state.esiRunning,
    null, { timeout: 20000 });
  const snap = await page.evaluate(() => ({
    brokerFrac: feePct('brokerFee'),
    taxFrac: feePct('salesTax'),
    brokerBox: document.getElementById('brokerFee').value,
    rows: state.rows.map(r => ({
      name: r.name, qty: r.qty, strategy: r.strategy, L: r.L, exportPrice: r.exportPrice,
      bestBuy: r.bestBuy, bestSell: r.bestSell, buyDepth: r.buyDepth, sellDepth: r.sellDepth,
      totalNet: r.totalNet, netInstant: r.netInstant, netOrder: r.netOrder,
      instFill: r.instFill, splitFill: r.splitFill, brokerEffPct: r.brokerEffPct,
      // the CONDITION each flag reports, not this build's wording for it
      flags: r.flags.map(f => f.t).map(t =>
        /min ?fee/i.test(t) ? 'minfee'
        : /already listed here|^dup×/.test(t) ? 'dup'
        : /suspect/.test(t) ? 'suspect'
        : /≫/.test(t) ? 'sell>>hist'
        : /≪/.test(t) ? 'sell<<hist'
        : /^depth/.test(t) ? 'depth'
        : /above best sell|^>best$/.test(t) ? 'above-best'
        : /no buy/.test(t) ? 'no-buy'
        : /no sell/.test(t) ? 'no-sell'
        : /unsellable/.test(t) ? 'unsellable'
        : /using history price|^L=hist$/.test(t) ? 'L-from-hist'
        : /using current sell|^L=sell$/.test(t) ? 'L-from-sell'
        : /^[↓▼]/.test(t) ? 'falling'
        : 'other:' + t),
    })).sort((x, y) => x.name.localeCompare(y.name)),
    // the artifact the page hands back to the game
    importList: document.getElementById('preview').value,
    // the summary line is presentation; what must hold is that each figure on it still
    // equals the rows behind it. Shapes only here — the agreement is checked in-page.
    summaryStats: [...document.querySelectorAll('#summary .stat')]
      .map(s => s.querySelector('span').textContent.replace(/\d+/g, '#')),
    summaryAgrees: (() => {
      try {
        const sum = k => state.rows.filter(r => k === 'all' || r.strategy === k)
          .reduce((t, r) => t + r.totalNet, 0);
        const stat = re => {
          const s = [...document.querySelectorAll('#summary .stat')]
            .find(x => re.test(x.querySelector('span').textContent));
          return s ? s.querySelector('b').textContent : null;
        };
        return {
          all: stat(/^expected net$/) === fmtCompact(sum('all')) + ' ISK',
          imm: stat(/^instant · /) === fmtCompact(sum('imm')) + ' ISK',
          list: stat(/^list · /) === fmtCompact(sum('ord') + sum('pat')) + ' ISK',
          split: stat(/^split · /) === fmtCompact(sum('split')) + ' ISK',
          counts: [
            stat(/^instant · /) != null && Number((/instant · (\d+)/.exec(
              [...document.querySelectorAll('#summary .stat span')].map(x => x.textContent).join('|')) || [])[1])
              === state.rows.filter(r => r.strategy === 'imm').length,
          ].every(Boolean),
        };
      } catch (_e) { return null; }   // the pre-migration build has no such summary
    })(),
  }));
  await context.close();
  return snap;
}

/* ================= Mine ================= */
async function captureMine(browser, server) {
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, mineLegacy());
  await H.mockEsi(context, {
    skills: MINE_SKILLS, rawSkills: MINE_RAW_SKILLS, standings: {},
    typeIds: MINE_TIDS, books: MINE_BOOKS,
  });
  await context.route('**/universe/names/**', route => {
    let ids = [];
    try { ids = JSON.parse(route.request().postData() || '[]'); } catch (_e) {}
    route.fulfill(H.json(ids.map(id => ({ id, name: TID_NAMES[id] || ('type ' + id) }))));
  });
  await context.route('**/data/ores.json', route => route.fulfill(H.json(ORES_FIXTURE)));
  const page = await context.newPage();
  H.watchPage(page, 'mine@' + server.url);
  await page.goto(server.url + '/mine.html');
  await page.waitForFunction(() => /per-ore refine from Miquel Dreamer/.test(document.body.textContent),
    null, { timeout: 20000 });
  // the legacy blob's open fleet section lands the page in profit mode
  await page.waitForFunction(() => document.body.dataset.mode === 'fleet', null, { timeout: 20000 });
  await page.waitForFunction(() => {
    if (!state.fleet.fetchedAt) return false;
    const tbl = document.querySelector('#fleetTable table');
    if (!tbl) return false;
    return ![...tbl.querySelectorAll('td')].some(td => td.textContent.trim() === '…');
  }, null, { timeout: 25000 });
  const snap = await page.evaluate(() => {
    const { rows } = fleetCompute(parseSurvey(document.getElementById('fleetScan').value).rows);
    const tbl = document.querySelector('#fleetTable table');
    const keys = [...tbl.querySelectorAll('thead th')].map(th => th.dataset.sort);
    const table = [...tbl.querySelectorAll('tbody tr')].map(tr => {
      const cells = [...tr.children];
      const row = { total: tr.classList.contains('total'), copy: {}, text: {} };
      keys.forEach((k, i) => {
        row.copy[k] = cells[i] ? (cells[i].dataset.copy != null ? cells[i].dataset.copy : null) : null;
        row.text[k] = cells[i] ? cells[i].textContent : null;
      });
      return row;
    });
    return {
      facilityBase: facilityBasePct(),
      implant: state.fac.imp,
      secBand: state.fac.sec,
      // the exact yield per reprocessing skill, breakdown text included
      yields: [['Simple Ore Processing', 60377], ['Coherent Ore Processing', 60378],
               ['Ice Processing', 18025]].map(([n, tid]) => {
        const r = refineWithSkill(n, tid);
        return { skill: n, pct: r.pct, detail: r.detail };
      }),
      // every profit-mode value, straight out of the page's own model
      rows: rows.map(r => ({
        name: r.o.n, rocks: r.rocks, units: r.units, m3: r.m3, cm3: r.cm3,
        ref: r.ref, comp: r.comp, raw: r.raw, refPct: r.r.pct, detail: r.r.detail,
        refState: r.refState, compState: r.compState, rawState: r.rawState,
      })),
      // ...and every rendered column of the profit table
      table, keys,
      skillsPanel: document.getElementById('skillsTblBody').textContent,
    };
  });
  await context.close();
  return snap;
}

/* ================= Industry =================
   A profile facility used to be a self-contained copy of the structure: hull, system,
   security, role bonuses (hand-corrected here: TE 18 where the Raitaru preset says 15),
   plus its routing. It is a REFERENCE now — every one of those facts is read from the
   central record, and the hand-corrected bonuses moved there with it. The engine itself
   is byte-identical in both builds, so any difference in a computed cost or job time can
   only come from the feed the page assembles. */
const RAITARU = { id: 1035466617947, name: 'Test Raitaru', typeId: 35825, typeName: 'Raitaru',
  refinery: null, systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999 };
const IND_T = { WIDGET: 1001, PLATE: 2001, MINERAL: 3001 };
const RIG_ME = 37147;      // M-Set ME II: 2.4% base, widgets only
const RIG_TE = 37148;      // M-Set TE I: 20% base, widgets and plates
const IND_FIXTURE = {
  v: 'equivalence-industry-fixture',
  types: {
    [IND_T.WIDGET]: ['Test Widget', 5, 5, 100, 200, null],
    [IND_T.PLATE]: ['Test Plate', 2, 2, 101, 201, null],
    [IND_T.MINERAL]: ['Test Mineral', 0.01, 0.01, 102, 202, null],
  },
  groups: { 100: ['Widgets', 6], 101: ['Plates', 6], 102: ['Minerals', 4] },
  marketGroups: { 200: ['Manufactured', 0], 201: ['Components', 0], 202: ['Minerals', 0] },
  skills: { 3380: 'Industry', 3388: 'Advanced Industry' },
  rigs: {
    [RIG_ME]: { n: 'Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II',
      sz: 'M', me: 2.4, te: 0, cost: 0, sec: { hs: 1, ls: 1.9, ns: 2.1 },
      scope: [100], act: ['man'], fit: [1657, 1404, 1406], dom: 'Basic Medium Ships' },
    [RIG_TE]: { n: 'Standup M-Set Basic Medium Ship Manufacturing Time Efficiency I',
      sz: 'M', me: 0, te: 20, cost: 0, sec: { hs: 1, ls: 1.9, ns: 2.1 },
      scope: [100, 101], act: ['man'], fit: [1657, 1404, 1406], dom: 'Basic Medium Ships' },
  },
  structures: { 35825: ['Raitaru', 1404, 'M', 3] },
  blueprints: {
    9001: { limit: 20, man: { t: 1200, m: [[IND_T.PLATE, 4]], p: [[IND_T.WIDGET, 1]], s: [] } },
    9003: { limit: 50, man: { t: 400, m: [[IND_T.MINERAL, 100]], p: [[IND_T.PLATE, 1]], s: [] } },
  },
};
const IND_SYS = RAITARU.systemId;
const IND_BOOK = {
  fetched: 1700000000000, pages: 1, typeCount: 3,
  types: {
    [IND_T.WIDGET]: { s: [[900000, 500, 1]], b: [[700000, 500, 1]] },
    [IND_T.PLATE]: { s: [[120000, 5000, 1]], b: [[90000, 5000, 1]] },
    [IND_T.MINERAL]: { s: [[1000, 1e6, 1]], b: [[900, 1e6, 1]] },
  },
};
const IND_ADJUSTED = { fetched: 1700000000000,
  map: { [IND_T.WIDGET]: 800000, [IND_T.PLATE]: 110000, [IND_T.MINERAL]: 950 } };
const IND_INDICES = { fetched: 1700000000000,
  map: { [IND_SYS]: { man: 0.042, rea: 0.01, inv: 0.02, cop: 0.02, me: 0.02, te: 0.02 } } };

/* Storage exactly as the old Industry page wrote it: the structure's rigs and owner-set
   tax already central (they moved a milestone earlier), the hull facts and the corrected
   role bonuses still copied into the facility. */
const industryLegacy = () => [
  ['eveHelper.auth.v1', H.authState([CHAR])],
  ['eveHelper.structInfo.v1', { [RAITARU.id]: RAITARU }],
  ['eveHelper.structures.v1', { v: 2, structures: [Object.assign({}, RAITARU, {
    marketBroker: null, facilityTax: 2.5, rigs: [RIG_ME, RIG_TE], reproRig: 'none',
    industryActivities: null, notes: '', conflicts: [] })] }],
  ['eveHelper.industryProfiles.v1', {
    active: 'p1',
    profiles: [{
      id: 'p1', name: 'Test',
      facilities: [{
        uid: 'f1', npc: false, id: RAITARU.id, label: RAITARU.name,
        typeId: RAITARU.typeId, typeName: RAITARU.typeName,
        system: RAITARU.systemId, systemName: RAITARU.systemName, security: RAITARU.security,
        activities: ['man'], scope: [],
        bonuses: { me: 1, te: 18, cost: 3 },     // TE hand-corrected away from the preset
        sciOverride: null,
      }],
      market: { auto: false, inputSide: 'sell', outputSide: 'sellOrder',
                brokerPct: 1.5, taxPct: 3.37, buyerBrokerPct: 1.5,
                buyerChar: CHAR.id, sellerChar: CHAR.id, manufChar: CHAR.id },
      shipping: { base: 10000000, perM3: 653.4, collateralPct: 1, roundUp: true, inbound: false, outbound: false },
      assumptions: { ownedBpoMe: 10, ownedBpoTe: 20, decryptor: null, sccPct: 4 },
      planning: { capital: null, slots: { man: 1, science: 1, reaction: 1 }, demandCapPct: 100, maxHaulM3: 350000 },
      forceBuy: [], forceBuild: [],
    }],
  }],
];

/* The Industry page reaches its computed state in stages, two of which are asynchronous
   and invisible from the outside. Both builds have both, so both captures have to be
   taken past both or the comparison straddles them.

   1. loadCaches() restores book/adjusted/indices from IndexedDB AFTER the static data has
      landed, then overwrites each with `x || null`. A fixture written into those globals
      before that restore lands is silently clobbered back to null, and the compute either
      refuses ('no order book') or prices nothing. renderAges() runs at the tail of
      loadCaches and fills #dataAges — the page's own marker that the restore is done.
   2. Demand / D.O.S. are filled in LAZILY, per visible row: the IntersectionObserver on
      #twrap calls needHist(tid) -> histWorker -> applyHist, which writes r.demand/r.dos
      and then calls refineRow(tid) to RE-PLAN the batch against the real demand, replacing
      the whole row object. So a row is one of two different things depending on whether
      its history has arrived, and a snapshot taken mid-flight compares a settled row
      against an unsettled one — the failure read `[0].demand: 0 -> undefined`.

   needHist() is idempotent, so ask for every row's history outright instead of depending
   on scroll position, then wait for refineRow's OWN no-op guard —
   `row.planDemand === histMem.get(tid).demand` — to hold for every row. Once it does, no
   further async re-plan is possible and both captures are taken in the same state, with
   the demand-refined values still compared rather than excluded. */
const indCachesRestored = page =>
  page.waitForFunction(() => document.getElementById('dataAges').children.length > 0,
    null, { timeout: 20000 });

const indComputed = page =>
  page.waitForFunction(() => document.getElementById('compStatus').className === 'ok'
    && state.rows.length > 0, null, { timeout: 20000 });

async function indDemandSettled(page) {
  await page.evaluate(() => state.rows.forEach(r => needHist(r.tid)));
  await page.waitForFunction(() => state.rows.every(r => {
    const h = histMem.get(r.tid);
    if (!h || h === 'loading') return false;      // history still in flight
    return !!r.err || r.planDemand === h.demand;  // refineRow is a no-op now: settled
  }), null, { timeout: 20000 });
}

async function captureIndustry(browser, server) {
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, industryLegacy());
  await H.mockEsi(context, { skills: { accounting: 5, brokerRelations: 5 }, standings: {} });
  await context.route('**/data/industry.json', route => route.fulfill(H.json(IND_FIXTURE)));
  const page = await context.newPage();
  H.watchPage(page, 'industry@' + server.url);
  await page.goto(server.url + '/industry.html');
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
  await indCachesRestored(page);   // ...or the restore clobbers the fixtures below
  // hand the page its ESI datasets directly — the real Update button would hit the network
  await page.evaluate(d => { book = d.book; adjusted = d.adjusted; indices = d.indices; },
    { book: IND_BOOK, adjusted: IND_ADJUSTED, indices: IND_INDICES });
  await page.evaluate(() => computeAll());
  await indComputed(page);
  await indDemandSettled(page);    // ...or the two captures straddle the demand refinement
  const snap = await page.evaluate(tids => {
    const walk = n => ({
      tid: n.tid, name: n.name, decision: n.decision, qty: n.qty,
      buyCost: n.buyCost, buildCost: n.buildCost, cost: n.cost,
      job: n.job ? {
        activity: n.job.activity, facilityLabel: n.job.facilityLabel, runs: n.job.runs,
        time: n.job.time, eiv: n.job.eiv, costBreakdown: n.job.costBreakdown,
        mods: n.job.matModifierBreakdown,
      } : null,
      children: (n.children || []).map(walk),
    });
    const strip = r => {
      const out = {};
      // everything the row model carries except the blueprint descriptor's object handle
      for (const [k, v] of Object.entries(r)) out[k] = k === 'bp' ? v.label : v;
      return out;
    };
    return {
      // the facilities exactly as the engine sees them
      feed: activeProfile().facilities.map(f => facilityToEngine(f)),
      // every computed table row, and the full cost/time tree of each product
      rows: state.rows.map(strip).sort((a, b) => a.tid - b.tid),
      trees: tids.map(tid => walk(evalOne(tid).tree)),
      totals: tids.map(tid => evalOne(tid).totals),
    };
  }, [IND_T.WIDGET, IND_T.PLATE]);
  await context.close();
  return snap;
}

H.run('equivalence', async () => {
  const preDir = checkoutPreBuild();
  if (!check('the pre-migration build can be checked out of git (commit ' + PRE + ')', !!preDir,
      'git or the commit is unavailable — the comparison cannot run')) return;
  const preIndDir = checkoutPreBuild(PRE_IND, PRE_IND_FILES);
  if (!check('...and the pre-reference Industry build (commit ' + PRE_IND + ')', !!preIndDir,
      'git or the commit is unavailable — the comparison cannot run')) return;
  const serverNew = await H.startServer();
  const serverOld = await H.startServer(preDir);
  const serverOldInd = await H.startServer(preIndDir);
  const browser = await H.launch();
  try {
    /* ---------- Sell ---------- */
    section('Sell: the owner-set broker % moves to the central record, the numbers do not');
    const sellBefore = await captureSell(browser, serverOld);
    const sellAfter = await captureSell(browser, serverNew);
    eq('the old build read the rate out of its own structBroker map', sellBefore.brokerBox, '4.5');
    eq('the new build reads the same rate off the structure record', sellAfter.brokerBox, '4.5');
    eq('...as the same fraction in the fee model', sellAfter.brokerFrac, 0.045);
    eq('four items priced against the structure book', sellBefore.rows.length, 4);
    check('...with all three plan shapes represented',
      new Set(sellBefore.rows.map(r => r.strategy)).size === 3,
      JSON.stringify(sellBefore.rows.map(r => r.name + '=' + r.strategy)));
    check('...and a row where the 100 ISK broker floor binds',
      sellBefore.rows.some(r => r.brokerEffPct != null && r.brokerEffPct > 4.5),
      JSON.stringify(sellBefore.rows.map(r => r.brokerEffPct)));
    same('every Sell fee and per-row plan is identical before and after',
      { ...sellBefore, summaryStats: undefined, summaryAgrees: undefined },
      { ...sellAfter, summaryStats: undefined, summaryAgrees: undefined });
    /* The summary line is deliberately terser than the old build's; what must not change
       is the set of totals it reports, and that each still equals the rows behind it. */
    check('the summary still reports one total per plan shape, plus the import list',
      sellAfter.summaryStats.length === sellBefore.summaryStats.length,
      JSON.stringify(sellAfter.summaryStats) + ' vs ' + JSON.stringify(sellBefore.summaryStats));
    const ag = sellAfter.summaryAgrees;
    check('...and every figure on it equals the rows behind it',
      ag && ag.all && ag.imm && ag.list && ag.split && ag.counts, JSON.stringify(ag));

    section('...and the Sell blob no longer owns the rate');
    const ctx = await browser.newContext();
    await H.seedStorage(ctx, serverNew.url, sellLegacy());
    await H.mockEsi(ctx, { skills: { accounting: 5, brokerRelations: 5 }, standings: {}, typeIds: SELL_TYPE_IDS });
    const p = await ctx.newPage();
    H.watchPage(p, 'sell-store');
    await p.goto(serverNew.url + '/index.html');
    await p.waitForFunction("typeof persist === 'function'");
    await p.evaluate(() => persist());
    const blob = await p.evaluate(() => JSON.parse(localStorage.getItem('eveSellHelper.v2')));
    check('a re-save drops structBroker from the Sell blob', blob.structBroker === undefined,
      JSON.stringify(blob.structBroker));
    const recBroker = await p.evaluate(id => EveStructures.facts(id).marketBroker, KEEPSTAR.id);
    eq('...because the rate is on the structure record now', recBroker, 4.5);
    // the fee line says where the rate comes from, and points at the record
    const feeSrc = await p.evaluate(() => document.getElementById('feeSrc').textContent);
    const feeTip = await p.evaluate(() => document.querySelector('#feeSrc span').title);
    check('the fee note names the owner-set rate as the source',
      /broker 4\.5% — Test Keepstar: owner-set/.test(feeSrc), feeSrc);
    check('...and the structure manager as where it lives',
      /structure manager/.test(feeTip), feeTip);
    eq('...and deep-links to this structure',
      await p.evaluate(() => document.querySelector('#feeSrc a').getAttribute('href')),
      'structures.html#s' + KEEPSTAR.id);
    eq('...as does the manage link next to the market picker',
      await p.evaluate(() => document.getElementById('manageStructs').getAttribute('href')),
      'structures.html#s' + KEEPSTAR.id);
    await ctx.close();

    /* ---------- Mine ---------- */
    section('Mine: the reprocessing rig moves to the central record, the numbers do not');
    const mineBefore = await captureMine(browser, serverOld);
    const mineAfter = await captureMine(browser, serverNew);
    // base = 55% Tatara × (1 + 3% T2 rig × 1.12 nullsec) = 56.848%
    check('the old build computed the T2-rig facility base', Math.abs(mineBefore.facilityBase - 56.848) < 1e-9,
      mineBefore.facilityBase);
    check('the new build gets the same base from the central record',
      Math.abs(mineAfter.facilityBase - 56.848) < 1e-9, mineAfter.facilityBase);
    eq('the implant stayed a page control, not a structure fact', mineAfter.implant, 4);
    eq('four ores priced in profit mode', mineBefore.rows.length, 4);
    same('every refine yield and profit-mode column is identical before and after',
      mineBefore, mineAfter);

    section('...and the rig is only shown, never edited, on the Mine page');
    const mctx = await browser.newContext();
    await H.seedStorage(mctx, serverNew.url, mineLegacy());
    await H.mockEsi(mctx, { skills: MINE_SKILLS, rawSkills: MINE_RAW_SKILLS, standings: {}, typeIds: MINE_TIDS });
    await mctx.route('**/data/ores.json', route => route.fulfill(H.json(ORES_FIXTURE)));
    const mp = await mctx.newPage();
    H.watchPage(mp, 'mine-rig');
    await mp.goto(serverNew.url + '/mine.html');
    await mp.waitForFunction(() => /per-ore refine from Miquel Dreamer/.test(document.body.textContent),
      null, { timeout: 20000 });
    check('the local rig control is gone', await mp.evaluate(() => !document.getElementById('facRig')));
    eq('the facility line mirrors the record instead',
      await mp.$eval('#facRigNote', el => el.textContent), 'T2 reprocessing rig +3%');
    eq('...and links to the record', await mp.$eval('#facManage', el => el.getAttribute('href')),
      'structures.html#s' + TATARA.id);
    eq('the rig landed on the central record', await mp.evaluate(id => EveStructures.facts(id).reproRig, TATARA.id), 't2');

    section('a structure with no reprocessing rig recorded says so, and costs no yield');
    await mp.evaluate(id => EveStructures.update(id, { reproRig: 'none' }), TATARA.id);
    await mp.waitForFunction(() => document.getElementById('facRigNote').textContent !== 'T2 reprocessing rig +3%');
    eq('the line names the manager as the place to fix it',
      await mp.$eval('#facRigNote', el => el.textContent),
      'no reprocessing rig set — configure it in the structure manager');
    check('...and it is flagged, not silent', await mp.$eval('#facRigNote', el => el.className.includes('warn')));
    const bareBase = await mp.evaluate(() => facilityBasePct());
    check('the yield falls back to the plain Tatara base, no invented rig bonus',
      Math.abs(bareBase - 55) < 1e-9, bareBase);
    await mctx.close();

    /* ---------- Industry ---------- */
    section('Industry: a profile references the structure instead of copying it, the numbers do not move');
    const indBefore = await captureIndustry(browser, serverOldInd);
    const indAfter = await captureIndustry(browser, serverNew);
    eq('the old build fed the engine one facility', indBefore.feed.length, 1);
    eq('...with the structure record\u2019s owner-set tax', indBefore.feed[0].tax, 2.5);
    eq('...its two recorded rigs', indBefore.feed[0].rigs.length, 2);
    check('...at the nullsec multiplier (2.4 \u00d7 2.1 ME)',
      Math.abs(indBefore.feed[0].rigs[0].me - 5.04) < 1e-9, indBefore.feed[0].rigs[0].me);
    same('the engine facility feed is identical before and after', indBefore.feed, indAfter.feed);
    eq('the corrected TE role bonus survived the move to the record', indAfter.feed[0].bonuses.te, 18);
    check('...and it really differs from the hull preset the app ships',
      indAfter.feed[0].bonuses.te !== 15, indAfter.feed[0].bonuses.te);
    eq('both products computed', indBefore.rows.length, 2);
    check('...with a build tree that spends job time', indBefore.trees[0].job.time > 0,
      JSON.stringify(indBefore.trees[0].job));
    check('...and a real cost', indBefore.rows[0].cost > 0, indBefore.rows[0].cost);
    same('every row of the computed table is identical before and after', indBefore.rows, indAfter.rows);
    same('...as is every cost and job time in both product trees', indBefore.trees, indAfter.trees);
    same('...and every batch total', indBefore.totals, indAfter.totals);

    section('...and the profile keeps only its routing');
    const ictx = await browser.newContext();
    await H.seedStorage(ictx, serverNew.url, industryLegacy());
    await H.mockEsi(ictx, { skills: { accounting: 5, brokerRelations: 5 }, standings: {} });
    await ictx.route('**/data/industry.json', route => route.fulfill(H.json(IND_FIXTURE)));
    const ip = await ictx.newPage();
    H.watchPage(ip, 'industry-store');
    await ip.goto(serverNew.url + '/industry.html');
    await ip.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
    await ip.waitForFunction(() => activeProfile().facilities[0].ref != null, null, { timeout: 20000 });
    await indCachesRestored(ip);   // same IndexedDB restore race as captureIndustry
    const fac = await ip.evaluate(() => JSON.parse(localStorage.getItem('eveHelper.industryProfiles.v1')).profiles[0].facilities[0]);
    eq('the stored facility references the structure', fac.ref, RAITARU.id);
    check('...and copies none of its facts any more',
      ['id', 'label', 'typeId', 'typeName', 'system', 'systemName', 'security', 'bonuses', 'tax', 'rigs']
        .every(k => fac[k] === undefined), JSON.stringify(Object.keys(fac)));
    check('...keeping exactly the routing: activities, scope, cost-index override, order',
      fac.activities.join(',') === 'man' && Array.isArray(fac.scope) && fac.sciOverride === null,
      JSON.stringify(fac));
    const bonusRec = await ip.evaluate(id => EveStructures.facts(id).bonuses, RAITARU.id);
    eq('the corrected role bonus lives on the record now', bonusRec.te, 18);
    check('...marked as an override, not a preset',
      await ip.evaluate(id => !EveStructures.facts(id).bonusesAreDefault, RAITARU.id));

    section('editing the structure in the manager makes the computed Industry table stale');
    await ip.evaluate(d => { book = d.book; adjusted = d.adjusted; indices = d.indices; },
      { book: IND_BOOK, adjusted: IND_ADJUSTED, indices: IND_INDICES });
    await ip.evaluate(() => computeAll());
    await indComputed(ip);
    // settle the demand cycle here too: nothing may still be re-planning rows while the
    // structure edits below fire EveStructures.subscribe -> clearEngines/markStale
    await indDemandSettled(ip);
    check('a fresh table is not stale', await ip.evaluate(() => document.getElementById('staleBanner').hidden));
    const sigBefore = await ip.evaluate(() => curSig());
    await ip.evaluate(id => EveStructures.update(id, { facilityTax: 4 }), RAITARU.id);
    check('...the tax edit changes the staleness signature',
      await ip.evaluate(() => curSig()) !== sigBefore);
    check('...and the banner is up', await ip.evaluate(() => !document.getElementById('staleBanner').hidden));
    eq('...with the new tax already in the engine feed',
      await ip.evaluate(() => facilityToEngine(activeProfile().facilities[0]).tax), 4);
    const sigTax = await ip.evaluate(() => curSig());
    await ip.evaluate(id => EveStructures.update(id, { rigs: [] }), RAITARU.id);
    check('...as does pulling the rigs out', await ip.evaluate(() => curSig()) !== sigTax);
    eq('...which the engine feed sees too',
      await ip.evaluate(() => facilityToEngine(activeProfile().facilities[0]).rigs.length), 0);
    await ictx.close();
  } finally {
    await browser.close();
    await serverNew.close();
    await serverOld.close();
    await serverOldInd.close();
    fs.rmSync(preDir, { recursive: true, force: true });
    fs.rmSync(preIndDir, { recursive: true, force: true });
  }
});
