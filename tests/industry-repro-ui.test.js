/* Ore sourcing on the Industry page, end to end.

   Same harness as industry-ui.test.js (which stays untouched as the off-state guard):
   fixture SDE data, an injected book — plus an ores.json fixture, a Tatara record in the
   Structure Manager store, and a profile with ore sourcing ON in flat-yield mode. The
   flat mode is the deliberate first path: it exercises the whole pipeline without a
   skills fetch, and the skills-absent refusal is its own section. */
'use strict';
const H = require('./helper');
const { check, eq, near, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };
const T = { WIDGET: 1001, GADGET: 1002, PLATE: 2001, MINERAL: 3001, COMP: 62001, SKILL: 60377 };
const SYSTEM = 30000142;
const TATARA = 1035000000031;

const FIXTURE = {
  v: 'test-fixture', build: 'test-build',
  types: {
    [T.WIDGET]: ['Test Widget', 5, 5, 100, 200, null],
    [T.GADGET]: ['Test Gadget', 3, 3, 100, 200, null],
    [T.PLATE]: ['Test Plate', 2, 2, 101, 201, null],
    [T.MINERAL]: ['Test Mineral', 0.01, 0.01, 102, 202, null],
  },
  groups: { 100: ['Widgets', 6], 101: ['Plates', 6], 102: ['Minerals', 4] },
  marketGroups: { 200: ['Manufactured', 0], 201: ['Components', 0], 202: ['Minerals', 0] },
  skills: { 3380: 'Industry', 3388: 'Advanced Industry' },
  rigs: {},
  structures: { 35836: ['Tatara', 1406, 'L', 3] },
  blueprints: {
    9001: { limit: 20, man: { t: 1200, m: [[T.PLATE, 4]], p: [[T.WIDGET, 1]], s: [] } },
    9002: { limit: 20, man: { t: 900, m: [[T.MINERAL, 300]], p: [[T.GADGET, 1]], s: [] } },
    9003: { limit: 50, man: { t: 400, m: [[T.MINERAL, 100]], p: [[T.PLATE, 1]], s: [] } },
  },
};

/* verbatim-SDE ore shape: outputs per portion of 100, compressed 1:1 in yield */
const ORES = {
  v: 'test-fixture', build: 'test-build',
  ores: {
    18: { n: 'Veldsparish', v: 0.1, p: 100, g: 'Veldsparish', b: 'Veldsparish',
          m: [[T.MINERAL, 400]], c: T.COMP, cv: 0.15, ice: 0, s: T.SKILL },
  },
  names: { veldsparish: 18 },
  types: { [T.SKILL]: 'Simple Ore Processing', [T.COMP]: 'Compressed Veldsparish' },
};

const BOOK = {
  fetched: Date.now(), pages: 1, typeCount: 5,
  types: {
    [T.WIDGET]: { s: [[900000, 500, 1]], b: [[700000, 500, 1]] },
    [T.GADGET]: { s: [[50000, 500, 1]], b: [[40000, 500, 1]] },
    [T.PLATE]: { s: [[120000, 5000, 1]], b: [[90000, 5000, 1]] },
    [T.MINERAL]: { s: [[1000, 1e6, 1]], b: [[900, 1e6, 1]] },
    [T.COMP]: { s: [[100, 1e6, 1]], b: [[50, 1e6, 1]] },
  },
};
const ADJUSTED = { fetched: Date.now(), map: { [T.WIDGET]: 800000, [T.GADGET]: 45000, [T.PLATE]: 110000, [T.MINERAL]: 950 } };
const INDICES = { fetched: Date.now(), map: { [SYSTEM]: { man: 0.02, rea: 0.01, inv: 0.02, cop: 0.02, me: 0.02, te: 0.02 } } };

const tataraRec = over => Object.assign({
  id: TATARA, name: 'Test Tatara', typeId: 35836, typeName: 'Tatara',
  systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999,
  refinery: 'tatara', marketBroker: null, facilityTax: null, rigs: [], reproRig: 't2',
  reproTaxPct: 1, roleBonus: null, industryActivities: null, notes: '', conflicts: [],
}, over || {});

function profileStore(reproOver, dropRepro) {
  const p = {
    id: 'p1', name: 'Test',
    facilities: [{
      uid: 'f1', label: 'Test Raitaru', system: SYSTEM, tax: 1,
      activities: ['man', 'rea', 'inv', 'cop', 'me', 'te'],
      bonuses: { me: 1, te: 15, cost: 3 }, rigs: [],
    }],
    market: {
      auto: false, inputSide: 'sell', outputSide: 'sellOrder',
      brokerPct: 1.5, taxPct: 3.37, buyerBrokerPct: 1.5,
      buyerChar: CHAR.id, sellerChar: CHAR.id, manufChar: CHAR.id, reproChar: CHAR.id,
    },
    shipping: { base: 10000000, perM3: 653.4, collateralPct: 1, roundUp: true, inbound: false, outbound: false },
    assumptions: { ownedBpoMe: 10, ownedBpoTe: 20, decryptor: null, sccPct: 4 },
    planning: { capital: null, slots: { man: 1, science: 1, reaction: 1 }, demandCapPct: 100, maxHaulM3: 350000 },
    forceBuy: [], forceBuild: [],
    repro: Object.assign({ enabled: true, ref: TATARA, implantPct: 0, flatPct: 50 }, reproOver || {}),
  };
  if (dropRepro) delete p.repro;
  return { active: 'p1', profiles: [p] };
}

async function openIndustry(browser, server, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  const seeds = [
    ['eveHelper.industryProfiles.v1', opts.profiles || profileStore()],
    ['eveHelper.structures.v1', { v: 2, structures: [opts.rec || tataraRec()] }],
  ];
  // noAuth: nobody logged in — the reprocessor role has no skills to read, which is the
  // only way to reach flat mode (a logged-in character always resolves the skill list)
  if (!opts.noAuth) seeds.unshift(['eveHelper.auth.v1', H.authState([CHAR])]);
  await H.seedStorage(context, server.url, seeds);
  await H.mockEsi(context, { skills: Object.assign({ accounting: 5, brokerRelations: 5,
    reprocessing: 5, reprocessingEfficiency: 4, 'Simple Ore Processing': 5 },
    opts.skills || {}), standings: {} });
  await context.route('**/data/industry.json', route => route.fulfill(H.json(FIXTURE)));
  await context.route('**/data/ores.json', route => route.fulfill(H.json(ORES)));
  const page = await context.newPage();
  H.watchPage(page, 'industry-repro');
  await page.goto(server.url + '/industry.html');
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('dataAges').children.length > 0,
    null, { timeout: 20000 });
  await page.evaluate(d => { book = d.book; adjusted = d.adjusted; indices = d.indices; },
    { book: BOOK, adjusted: ADJUSTED, indices: INDICES });
  return { context, page, close: () => context.close() };
}

async function compute(page) {
  await page.click('#btnCompute');
  await page.waitForFunction(
    () => document.getElementById('compStatus').className === 'ok' && state.rows.length > 0,
    null, { timeout: 30000 });
}
const rowOf = (page, tid) => page.evaluate(t =>
  state.rows.filter(r => r.tid === t).map(r =>
    ({ cost: r.cost, reproActive: r.reproActive, savings: r.reproSavings }))[0], tid);

H.run('industry-repro-ui', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    const s = await openIndustry(browser, server);
    const page = s.page;

    section('the reprocessing fieldset reflects the stored profile');
    eq('the enable box is on', await page.$eval('#rpOn', el => el.checked), true);
    check('the refinery is named', /Test Tatara/.test(await page.$eval('#rpFac', el => el.textContent)),
      await page.$eval('#rpFac', el => el.textContent));
    const note = await page.$eval('#rpNote', el => el.textContent);
    check('skills mode counts its candidates', /1 candidate ore/.test(note), note);
    check('...states the measured base: Tatara + T2 rig in null', /base 56\.85%/.test(note), note);
    check('...names the tax it will charge', /tax 1%/.test(note), note);
    check('...and shows a worked sample yield',
      /e\.g\. Compressed Veldsparish → 77\.7%/.test(note), note);

    section('the route prices the mineral basket and the row says so');
    await compute(page);
    const on = await rowOf(page, T.GADGET);
    check('the Gadget row adopted the ore route', on.reproActive, JSON.stringify(on));
    check('...and its cost dropped well below the mineral-book cost',
      on.cost < 50000, String(on.cost));
    const tag = await page.evaluate(t => {
      const tr = [...document.querySelectorAll('#tbl tbody tr')].find(x => x.dataset.tid === String(t));
      const el = tr && tr.querySelector('.oretag');
      return el ? { t: el.textContent, tip: el.title } : null;
    }, T.GADGET);
    check('the Cost/Item cell carries the ore tag', tag && tag.t === 'ore', JSON.stringify(tag));
    check('...whose tooltip names the batch savings', tag && /saves .+ on the batch/.test(tag.tip), tag && tag.tip);

    section('the drilldown shows the mix, the basket, the excess — and reconciles');
    await page.evaluate(t => { toggleDrill(t); }, T.GADGET);
    await page.waitForSelector('.srcpanel');
    const panel = await page.$eval('.srcpanel', el => el.textContent);
    check('the mix names the compressed ore', /Compressed Veldsparish/.test(panel), panel.slice(0, 200));
    check('the basket table shows needed/from ore/direct', /needed/.test(panel) && /from ore/.test(panel));
    check('both cost bases are printed side by side', /via book .+ vs via ore /.test(panel), panel);
    check('the excess is valued but NOT credited', /excess if instant-sold: .+ — not credited/.test(panel), panel);
    const sumTxt = await page.$eval('.dsummary', el => el.textContent);
    check('the summary carries the reconciliation line — tree minus this equals the row',
      /incl\. ore route/.test(sumTxt), sumTxt);
    const tsv = await page.evaluate(t => treeTsv(evalOne(t, null)), T.GADGET);
    check('the tree TSV ends with a paste-ready multibuy block',
      /Ore route — Jita multibuy\nItem\tQty\nCompressed Veldsparish\t\d+/.test(tsv), tsv.slice(-200));
    await page.evaluate(t => { toggleDrill(t); }, T.GADGET);

    section('a force toggle round-trip leaves the cost exactly where it started');
    const before = await rowOf(page, T.WIDGET);
    await page.evaluate(t => { setForce(t, 2001, 'buy'); }, T.WIDGET);
    await page.waitForFunction((c) => {
      const r = state.rows.find(x => x.tid === 1001);
      return r && r.cost !== c;
    }, before.cost, { timeout: 15000 });
    await page.evaluate(t => { setForce(t, 2001, 'auto'); }, T.WIDGET);
    await page.waitForFunction((c) => {
      const r = state.rows.find(x => x.tid === 1001);
      return r && Math.abs(r.cost - c) < 1e-6;
    }, before.cost, { timeout: 15000 });
    const after = await rowOf(page, T.WIDGET);
    near('the Widget cost is restored', after.cost, before.cost, 1e-6);

    section('switching the feature off returns every cost to market-direct, exactly');
    await page.evaluate(() => { document.getElementById('rpOn').checked = false;
      document.getElementById('rpOn').dispatchEvent(new Event('change')); });
    check('the table is marked stale by the toggle',
      await page.evaluate(() => !document.getElementById('staleBanner').hidden));
    await compute(page);
    const off = await rowOf(page, T.GADGET);
    eq('no row claims the route any more', off.reproActive, false);
    /* market-direct Gadget: hand check — 300 mineral × 1000 = 300k + job fee; the exact
       figure is whatever the engine says with repro null, which the off-state twin
       (industry-ui.test.js's whole suite) already pins. Here: strictly more than the
       adopted figure, and stable across a re-toggle. */
    check('the market-direct cost is back above the ore-route cost', off.cost > on.cost,
      `${off.cost} vs ${on.cost}`);
    await page.evaluate(() => { document.getElementById('rpOn').checked = true;
      document.getElementById('rpOn').dispatchEvent(new Event('change')); });
    await compute(page);
    const on2 = await rowOf(page, T.GADGET);
    near('re-enabling reproduces the identical adopted cost', on2.cost, on.cost, 1e-6);

    section('editing the record in the manager stales the table');
    await page.evaluate(id => { EveStructures.update(id, { reproTaxPct: 30 }); }, TATARA);
    check('the stale banner is up', await page.evaluate(() => !document.getElementById('staleBanner').hidden));
    await compute(page);
    const taxed = await rowOf(page, T.GADGET);
    check('the new tax landed in the recompute', taxed.cost > on.cost, `${taxed.cost} vs ${on.cost}`);
    await s.close();

    section('an unset reprocessing tax turns the feature OFF — 0 is never assumed');
    {
      const s2 = await openIndustry(browser, server, { rec: tataraRec({ reproTaxPct: null }) });
      const n2 = await s2.page.$eval('#rpNote', el => el.textContent);
      check('the off-chip names the missing tax', /reprocessing tax unset/.test(n2), n2);
      await compute(s2.page);
      const r2 = await rowOf(s2.page, T.GADGET);
      eq('no route is adopted', r2.reproActive, false);
      await s2.close();
    }

    section('nobody logged in + a typed flat % = flat mode, disclosed as unchecked');
    {
      const sF = await openIndustry(browser, server, { noAuth: true });
      const nF = await sF.page.$eval('#rpNote', el => el.textContent);
      check('flat mode names its yield and its blind spot',
        /flat 50% yield — per-ore skills UNCHECKED/.test(nF), nF);
      await compute(sF.page);
      const rF = await rowOf(sF.page, T.GADGET);
      check('the route still adopts — the owner asserted the yield', rF.reproActive, JSON.stringify(rF));
      await sF.close();
    }

    section('skills absent and no flat % is a refusal, not a guess');
    {
      const s3 = await openIndustry(browser, server,
        { noAuth: true, profiles: profileStore({ flatPct: null }) });
      const n3 = await s3.page.$eval('#rpNote', el => el.textContent);
      check('the off-chip asks for skills or a flat value', /skills not fetched/.test(n3), n3);
      await compute(s3.page);
      const r3 = await rowOf(s3.page, T.GADGET);
      eq('no route is adopted', r3.reproActive, false);
      await s3.close();
    }

    section('a stored profile that predates the feature still computes');
    {
      const s4 = await openIndustry(browser, server, { profiles: profileStore(null, true) });
      await compute(s4.page);
      const r4 = await rowOf(s4.page, T.GADGET);
      check('rows computed with the backfilled default (off)', r4 && r4.cost > 0 && !r4.reproActive,
        JSON.stringify(r4));
      eq('...and the checkbox renders unchecked', await s4.page.$eval('#rpOn', el => el.checked), false);
      await s4.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
