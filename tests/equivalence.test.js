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
function checkoutPreBuild() {
  try {
    execFileSync('git', ['-C', H.REPO, 'cat-file', '-e', PRE + '^{commit}'], { stdio: 'ignore' });
  } catch (_e) {
    return null;   // shallow clone or no git — the caller reports it as a failed check
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-pre-migration-'));
  for (const f of PRE_FILES)
    fs.writeFileSync(path.join(dir, f),
      execFileSync('git', ['-C', H.REPO, 'show', PRE + ':' + f], { maxBuffer: 128 << 20 }));
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
      flags: r.flags.map(f => f.t),
    })).sort((x, y) => x.name.localeCompare(y.name)),
    // the two artifacts the page hands back to the game
    importList: document.getElementById('preview').value,
    summary: document.getElementById('summary').textContent,
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

H.run('equivalence', async () => {
  const preDir = checkoutPreBuild();
  if (!check('the pre-migration build can be checked out of git (commit ' + PRE + ')', !!preDir,
      'git or the commit is unavailable — the comparison cannot run')) return;
  const serverNew = await H.startServer();
  const serverOld = await H.startServer(preDir);
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
    same('every Sell fee and per-row plan is identical before and after', sellBefore, sellAfter);

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
    check('the fee note names the structure manager as the source',
      /owner-set rate from the structure manager/.test(feeSrc), feeSrc);
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
  } finally {
    await browser.close();
    await serverNew.close();
    await serverOld.close();
    fs.rmSync(preDir, { recursive: true, force: true });
  }
});
