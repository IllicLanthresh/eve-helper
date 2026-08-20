/* The Structure Manager as a feature, end to end.

   A structure's INTRINSIC facts used to be smeared across three tools: the Sell tool kept
   the owner-set broker %, the Mine tool kept the fitted reprocessing rig inside a facility
   snapshot, and every Industry PROFILE kept its own copy of the rigs, the owner-set job tax
   and the hull role bonuses. They live once now, on a central record, and every tool merely
   SELECTS a structure.

   `structures.test.js` drives that store with all three legacy sources present at once.
   This suite takes the complementary angles the milestone asks for:

     a) the schema migration from EACH legacy source ON ITS OWN — including the oldest shape
        of all (the saved list inside the Sell tool's own blob), the coercion rules that
        refuse to invent a 0%, the rig de-duplication and slot cap, the two-profiles-disagree
        conflict and its dismissible note, and idempotency across a real page reload;
     b) the manager page: ADDING a structure through the picker, editing every managed fact
        and reading it back out of localStorage, removing one while all three tools point at
        it, the #s<id> deep link, and re-resolving the identity from ESI;
     c) the rig-inference wizard driven through its own UI on the manager, all the way to
        writing the rigs onto the central record (and refusing to overflow the rig slots);
     d) cross-page: Sell's broker box reading and writing the record, Mine's reprocessing rig
        read from the record (including the "no rig set" path), and the Industry engine feed
        built from central facts with its staleness banner firing on a central edit;
     e) the Structures topbar entry on all four pages;
     f) value equivalence across the migration: one Sell number, one Mine refine % and one
        Industry job cost, each compared against the closed form of the LEGACY facts.

   data/industry.json and data/ores.json are gitignored CI build products, so the pages'
   fetches of them are intercepted and served small hand-written fixtures. */
'use strict';
const H = require('./helper');
const { check, eq, near, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };

/* ---------- the structures these fixtures talk about ---------- */
const RAITARU = 1035000000001, TATARA = 1035000000002, ASTRAHUS = 1035000000003;
const KEEPSTAR = 1035466617946;
const NEWCOMER = 1035000000009;          // only ESI knows it — the picker adds it

const IDENT = {
  [RAITARU]: { id: RAITARU, name: 'Test Raitaru', typeId: 35825, typeName: 'Raitaru', refinery: null,
    systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999 },
  [TATARA]: { id: TATARA, name: 'Test Tatara', typeId: 35836, typeName: 'Tatara', refinery: 'tatara',
    systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999 },
  [ASTRAHUS]: { id: ASTRAHUS, name: 'Test Astrahus', typeId: 35832, typeName: 'Astrahus', refinery: null,
    systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999 },
  [KEEPSTAR]: { id: KEEPSTAR, name: 'Test Keepstar', typeId: 35834, typeName: 'Keepstar', refinery: null,
    systemId: 30000142, systemName: 'Jita', security: 0.946, regionId: 10000002 },
};

/* ---------- SDE-shaped fixture: the rig catalog, the structure map, two blueprints ---------- */
const RIG_T1 = 37146, RIG_T2 = 37147, RIG_OTHER = 37200;
const T = { WIDGET: 1001, PLATE: 2001, MINERAL: 3001 };
const G = { WIDGET: 100, PLATE: 101, MINERAL: 102 };
const SEC_RIG = { hs: 1, ls: 1.9, ns: 2.1 };
const FIT = [1657, 1404, 1406];          // Citadel / Engineering Complex / Refinery groups
const IND_FIXTURE = {
  v: 'structures-manager-fixture',
  types: {
    [T.WIDGET]: ['Test Widget', 5, 5, G.WIDGET, 200, null],
    [T.PLATE]: ['Test Plate', 2, 2, G.PLATE, 201, null],
    [T.MINERAL]: ['Test Mineral', 0.01, 0.01, G.MINERAL, 202, null],
  },
  groups: { [G.WIDGET]: ['Widgets', 6], [G.PLATE]: ['Plates', 6], [G.MINERAL]: ['Minerals', 4] },
  marketGroups: { 200: ['Manufactured', 0], 201: ['Components', 0], 202: ['Minerals', 0] },
  skills: { 3380: 'Industry', 3388: 'Advanced Industry' },
  rigs: {
    [RIG_T1]: { n: 'Standup M-Set Basic Medium Ship Manufacturing Material Efficiency I',
      sz: 'M', me: 2, te: 0, cost: 0, sec: SEC_RIG, scope: [G.WIDGET], act: ['man'], fit: FIT,
      dom: 'Basic Medium Ships' },
    [RIG_T2]: { n: 'Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II',
      sz: 'M', me: 2.4, te: 0, cost: 0, sec: SEC_RIG, scope: [G.WIDGET], act: ['man'], fit: FIT,
      dom: 'Basic Medium Ships' },
    // a SECOND domain, so "install replaces this domain and keeps the others" is testable
    [RIG_OTHER]: { n: 'Standup M-Set Basic Small Ship Manufacturing Material Efficiency I',
      sz: 'M', me: 2, te: 0, cost: 0, sec: SEC_RIG, scope: [G.PLATE], act: ['man'], fit: FIT,
      dom: 'Basic Small Ships' },
  },
  structures: {
    35825: ['Raitaru', 1404, 'M', 3],
    35836: ['Tatara', 1406, 'L', 3],
    35832: ['Astrahus', 1657, 'M', 1],    // one rig slot: the wizard's overflow guard
    35834: ['Keepstar', 1657, 'XL', 3],
  },
  blueprints: {
    9001: { limit: 20, man: { t: 1200, m: [[T.MINERAL, 1000]], p: [[T.WIDGET, 1]], s: [] } },
    9002: { limit: 50, man: { t: 400, m: [[T.MINERAL, 50]], p: [[T.PLATE, 1]], s: [] } },
  },
};

/* rig ME as the NS security band multiplies it — every ME assertion below derives from these */
const NS = SEC_RIG.ns;
const EFF_T1 = 2 * NS;      // 4.2
const EFF_T2 = 2.4 * NS;    // 5.04

/* ---------- ores fixture (Mine) ---------- */
const ORES_FIXTURE = {
  v: 'structures-manager-fixture',
  ores: {
    1230: { n: 'Veldspar', v: 0.1, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 400]], c: 62516, cv: 0.001, ice: 0, s: 60377 },
    17471: { n: 'Dense Veldspar', v: 0.1, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 440]], c: 62518, cv: 0.001, ice: 0, s: 60377 },
    62516: { n: 'Compressed Veldspar', v: 0.001, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 400]], c: null, cv: null, ice: 0, s: 60377 },
    62518: { n: 'Compressed Dense Veldspar', v: 0.001, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 440]], c: null, cv: null, ice: 0, s: 60377 },
  },
  names: { 'veldspar': 1230, 'dense veldspar': 17471,
           'compressed veldspar': 62516, 'compressed dense veldspar': 62518 },
  types: { 34: 'Tritanium', 60377: 'Simple Ore Processing' },
};
const MINE_TIDS = { Veldspar: 1230, 'Dense Veldspar': 17471,
                    'Compressed Veldspar': 62516, 'Compressed Dense Veldspar': 62518 };
const MINE_SKILLS = { reprocessing: 5, reprocessingEfficiency: 4, accounting: 5,
                      'Simple Ore Processing': 5 };

/* ---------- Sell fixture ---------- */
const SELL_TYPE_IDS = { Tritanium: 34, 'Cheap Trinket': 9002 };
const SELL_BOOK = {
  // a deep buy book far under the sell price: the whole stack is listed (a pure ORDER row)
  Tritanium: { buys: [{ p: 4.0, v: 1e6 }], sells: [{ p: 6.0, v: 1e6 }] },
  // a 450 ISK listing, where the flat 100 ISK per-order broker floor binds instead
  'Cheap Trinket': { buys: [{ p: 1.0, v: 1e6 }], sells: [{ p: 45, v: 1e6 }] },
};
const SELL_PASTE = ['Tritanium\t1.000.000\tMineral\t\t\t10.000,00 m3\t4.000.000,00 ISK',
                    'Cheap Trinket\t10'].join('\n');

/* ---------- Industry ESI datasets (handed to the page directly — no network) ---------- */
const IND_SYS = IDENT[RAITARU].systemId;
const SCI_MAN = 0.042;
const IND_BOOK = { fetched: 1700000000000, pages: 1, typeCount: 3, types: {
  [T.WIDGET]: { s: [[900000, 500, 1]], b: [[700000, 500, 1]] },
  [T.PLATE]: { s: [[120000, 5000, 1]], b: [[90000, 5000, 1]] },
  // cheap enough that building the widget beats buying it — the job node has to exist
  [T.MINERAL]: { s: [[600, 1e6, 1]], b: [[550, 1e6, 1]] },
} };
const IND_ADJUSTED = { fetched: 1700000000000,
  map: { [T.WIDGET]: 800000, [T.PLATE]: 110000, [T.MINERAL]: 950 } };
const IND_INDICES = { fetched: 1700000000000,
  map: { [IND_SYS]: { man: SCI_MAN, rea: 0.01, inv: 0.02, cop: 0.02, me: 0.02, te: 0.02 } } };

/* ---------- legacy storage, one tool at a time ---------------------------------------
   Each of these is exactly what ONE of the three tools used to write, with nothing else
   around it — no central list, and (where the tool never needed one) not even an ESI
   identity cache. The migration has to build the record from whatever is there. ----- */
const auth = () => ['eveHelper.auth.v1', H.authState([CHAR])];
const infoCache = ids => ['eveHelper.structInfo.v1',
  Object.fromEntries(ids.map(i => [i, IDENT[i]]))];

/* The OLDEST shape of all: before `eveHelper.structures.v1` existed, the saved structure
   list lived inside the Sell tool's own blob, next to its per-structure broker map. */
const sellOnlyLegacy = () => [
  auth(),
  ['eveSellHelper.v2', {
    inv: '', brokerFee: '2.20', salesTax: '3.00',
    structures: [IDENT[KEEPSTAR]],               // the pre-v1 saved list
    structBroker: { [KEEPSTAR]: '4.5', [RAITARU]: '' },   // '' = never recorded, not 0%
    market: 's:' + KEEPSTAR, ticked: [],
  }],
  infoCache([KEEPSTAR, RAITARU]),
];

/* The Mine tool never kept a saved list at all — only a facility snapshot. */
const mineOnlyLegacy = rig => [
  auth(),
  infoCache([TATARA]),
  ['eveHelper.mine.v1', { fac: { struct: 's:' + TATARA, rig: rig === undefined ? 't2' : rig,
                                sec: 'ns', imp: 4, structInfo: IDENT[TATARA] } }],
];

/* One Industry profile, self-contained the way profiles used to be. */
function legacyFacility(opts) {
  return {
    uid: opts.uid || 'f1', npc: false, id: RAITARU, label: opts.label || 'Test Raitaru',
    typeId: 35825, typeName: 'Raitaru', system: IND_SYS, systemName: 'TEST-1', security: -0.42,
    activities: ['man'], scope: [], sciOverride: null,
    bonuses: opts.bonuses || { me: 1, te: 15, cost: 3 },
    tax: opts.tax, rigs: (opts.rigs || []).map(tid => ({ tid })),
  };
}
function profile(id, name, facilities) {
  return {
    id, name, facilities,
    market: { auto: false, inputSide: 'sell', outputSide: 'sellOrder',
              brokerPct: 1.5, taxPct: 3.37, buyerBrokerPct: 1.5,
              buyerChar: CHAR.id, sellerChar: CHAR.id, manufChar: CHAR.id },
    shipping: { base: 0, perM3: 0, collateralPct: 0, roundUp: false, inbound: false, outbound: false },
    assumptions: { ownedBpoMe: 10, ownedBpoTe: 20, decryptor: null, sccPct: 4 },
    planning: { capital: null, slots: { man: 1, science: 1, reaction: 1 }, demandCapPct: 100, maxHaulM3: 350000 },
    forceBuy: [], forceBuild: [],
  };
}
const industryOnlyLegacy = () => [
  auth(),
  infoCache([RAITARU]),
  ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
    profile('pA', 'Alpha', [legacyFacility({ tax: 3, rigs: [RIG_T2], bonuses: { me: 1, te: 18, cost: 3 } })]),
  ] }],
];
/* Two profiles that disagree about the same structure's rigs AND its tax. */
const industryConflictLegacy = () => [
  auth(),
  infoCache([RAITARU]),
  ['eveHelper.industryProfiles.v1', { active: 'pB', profiles: [
    profile('pA', 'Alpha', [legacyFacility({ tax: 2, rigs: [RIG_T1] })]),
    profile('pB', 'Bravo', [legacyFacility({ tax: 3, rigs: [RIG_T2] })]),
  ] }],
];

/* ---------- page plumbing ---------- */
async function baseContext(browser, storage, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  await H.seedStorage(context, null, storage);
  await H.mockEsi(context, Object.assign({ skills: {}, standings: {} }, opts.esi || {}));
  // opts.industry overrides the catalog for one test (an extra rig domain, say) without
  // shifting the counts every other test asserts against the shared fixture
  await context.route('**/data/industry.json', r => r.fulfill(H.json(opts.industry || IND_FIXTURE)));
  await context.route('**/data/ores.json', r => r.fulfill(H.json(ORES_FIXTURE)));
  return context;
}

/* ESI identity resolution: what EveStructures.info()/refresh() and the picker search need.
   `names` overrides the structure name so re-resolution has something new to find. */
async function mockIdentity(context, opts) {
  opts = opts || {};
  const names = opts.names || {};
  await context.route('**/characters/*/search/**', r =>
    r.fulfill(H.json({ structure: opts.searchHits || [] })));
  await context.route('**/universe/structures/**', r => {
    const id = Number((r.request().url().match(/structures\/(\d+)/) || [])[1]);
    const ident = IDENT[id] || { name: 'structure ' + id, typeId: 35825, systemId: 30000999 };
    r.fulfill(H.json({ name: names[id] || ident.name, type_id: ident.typeId,
                       solar_system_id: ident.systemId }));
  });
  await context.route('**/universe/systems/**', r => {
    const id = Number((r.request().url().match(/systems\/(\d+)/) || [])[1]);
    const src = Object.values(IDENT).find(e => e.systemId === id) || IDENT[RAITARU];
    r.fulfill(H.json({ name: src.systemName, constellation_id: 20000001,
                       security_status: src.security }));
  });
  await context.route('**/universe/constellations/**', r => {
    const src = Object.values(IDENT).find(e => e.systemName) || IDENT[RAITARU];
    r.fulfill(H.json({ region_id: opts.regionId != null ? opts.regionId : src.regionId }));
  });
  await context.route('**/universe/types/**', r => {
    const id = Number((r.request().url().match(/types\/(\d+)/) || [])[1]);
    const map = { 35825: 'Raitaru', 35832: 'Astrahus', 35834: 'Keepstar', 35836: 'Tatara' };
    r.fulfill(H.json({ name: map[id] || 'type ' + id }));
  });
}

async function openManager(browser, server, storage, opts) {
  opts = opts || {};
  const context = await baseContext(browser, storage, opts);
  if (opts.identity !== false) await mockIdentity(context, opts.identity || {});
  const page = await context.newPage();
  H.watchPage(page, 'manager');
  await page.goto(server.url + '/structures.html' + (opts.hash || ''));
  // the catalog has loaded and the list has been rendered from it — the page's own marker
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null
    && document.getElementById('sdeStatus').className === 'ok', null, { timeout: 20000 });
  return { context, page, close: () => context.close() };
}

async function openIndustry(browser, server, storage, opts) {
  opts = opts || {};
  const context = await baseContext(browser, storage, opts);
  await mockIdentity(context, opts.identity || {});
  const page = await context.newPage();
  H.watchPage(page, 'industry');
  await page.goto(server.url + '/industry.html');
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
  return { context, page, close: () => context.close() };
}

const factsOf = (page, id) => page.evaluate(i => EveStructures.facts(i), id);
const recOf = (page, id) => page.evaluate(i => EveStructures.get(i), id);
/* the record as it is actually PERSISTED — proves an edit reached localStorage, not just
   the in-memory list */
const storedRec = (page, id) => page.evaluate(i => {
  const s = JSON.parse(localStorage.getItem('eveHelper.structures.v1') || 'null');
  const arr = Array.isArray(s) ? s : (s && s.structures) || [];
  return arr.find(r => r.id === i) || null;
}, id);
const expand = async (page, id) => {
  await page.click('#s' + id + ' .sthead');
  await page.waitForSelector('#s' + id + ' .stbody:not([hidden])');
};
/* the next window.confirm's message, answered the given way — a real signal, so no sleep
   is needed to know the page has moved on */
function nextDialog(page, accept) {
  return new Promise(resolve => page.once('dialog', d => {
    const msg = d.message();
    (accept ? d.accept() : d.dismiss()).then(() => resolve(msg), () => resolve(msg));
  }));
}

H.run('structures-manager', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    /* ================================================================================
       (a) the schema migration, one legacy source at a time
       ================================================================================ */
    section('the Sell tool alone: its own blob carried both the list and the broker rates');
    {
      const s = await openManager(browser, server, sellOnlyLegacy());
      const store = await s.page.evaluate(() =>
        JSON.parse(localStorage.getItem('eveHelper.structures.v1')));
      eq('a store that never existed is written in the v2 shape', store && store.v, 2);
      check('...as {v, structures}', Array.isArray(store.structures), JSON.stringify(store).slice(0, 140));
      eq('the structure list is rescued out of the Sell blob', store.structures.length, 1);
      eq('...keeping its identity', store.structures[0].name, 'Test Keepstar');
      eq("...and Sell's owner-set broker % becomes a fact of the structure",
        (await factsOf(s.page, KEEPSTAR)).marketBroker, 4.5);
      eq('a blank rate is NOT imported as 0% — it was never known',
        await s.page.evaluate(() => EveStructures.get(1035000000001)
          ? EveStructures.facts(1035000000001).marketBroker : 'no record'), 'no record');
      eq('...and nothing else was invented for it',
        await s.page.evaluate(() => EveStructures.saved().length), 1);
      const rec = store.structures[0];
      check('every managed key exists on the migrated record',
        ['marketBroker', 'facilityTax', 'rigs', 'reproRig', 'roleBonus', 'industryActivities',
         'notes', 'conflicts'].every(k => k in rec), JSON.stringify(Object.keys(rec)));
      eq('the rig list starts empty, not absent', JSON.stringify(rec.rigs), '[]');
      eq('the reprocessing rig starts at "none"', rec.reproRig, 'none');
      eq('the hull role bonuses start unrecorded (the preset is used)', rec.roleBonus, null);
      const f = await factsOf(s.page, KEEPSTAR);
      eq('the facility tax stays unknown rather than becoming 0%', f.facilityTax, null);
      eq('a citadel hull defaults to no industry activities', f.industryActivities.length, 0);
      eq('...and the slot count comes from the structure map', f.rigSlots, 3);
      await s.close();
    }

    section('the Mine tool alone: only a facility snapshot, no saved list anywhere');
    {
      const s = await openManager(browser, server, mineOnlyLegacy());
      eq('a record is created for a structure only Mine ever knew',
        await s.page.evaluate(() => EveStructures.saved().length), 1);
      const rec = await recOf(s.page, TATARA);
      eq('...with the identity out of the ESI cache', rec.name, 'Test Tatara');
      eq('...its hull', rec.typeName, 'Tatara');
      eq('...and the refinery kind re-derived from the type id', rec.refinery, 'tatara');
      const f = await factsOf(s.page, TATARA);
      eq('the fitted reprocessing rig moves onto the record', f.reproRig, 't2');
      eq('...and a refinery hull defaults to reactions', f.industryActivities.join(','), 'rea');
      eq("the pilot's implant is NOT a structure fact and stays with the tool",
        await s.page.evaluate(() =>
          JSON.parse(localStorage.getItem('eveHelper.mine.v1')).fac.imp), 4);
      await s.close();
    }

    section('...and a refinery with no rig recorded is still registered');
    {
      const s = await openManager(browser, server, mineOnlyLegacy('none'));
      eq('the selected refinery gets a record even with nothing to import',
        await s.page.evaluate(() => EveStructures.saved().length), 1);
      eq('...so the manager can offer it at all', (await recOf(s.page, TATARA)).name, 'Test Tatara');
      eq('...with no rig invented for it', (await factsOf(s.page, TATARA)).reproRig, 'none');
      check('...which is what the manager shows on the card',
        /no repro rig/.test(await s.page.$eval('#s' + TATARA + ' .tags', el => el.textContent)));
      await s.close();
    }

    section('the Industry tool alone: rigs, owner-set tax and corrected role bonuses');
    {
      const s = await openManager(browser, server, industryOnlyLegacy());
      const f = await factsOf(s.page, RAITARU);
      eq("the profile's rig list becomes the record's", f.rigs.join(','), String(RIG_T2));
      eq('...the owner-set job tax too', f.facilityTax, 3);
      eq('...and an engineering complex defaults to the manufacturing activity set',
        f.industryActivities.join(','), 'man,inv,cop,me,te');
      eq('a hand-corrected TE role bonus is recorded as an override', f.bonuses.te, 18);
      check('...and stops being flagged as a preset', !f.bonusesAreDefault, JSON.stringify(f.bonuses));
      eq('...while the fields that matched the preset are carried along', f.bonuses.me + '/' + f.bonuses.cost, '1/3');
      eq('no conflict note is produced by a single profile', f.conflicts.length, 0);
      await s.close();
    }

    section('...and role bonuses left at the hull preset carry no information');
    {
      const store = [auth(), infoCache([RAITARU]),
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [legacyFacility({ tax: 1, bonuses: { me: 1, te: 15, cost: 3 } })]),
        ] }]];
      const s = await openManager(browser, server, store);
      eq('an untouched preset is not written as an override',
        (await recOf(s.page, RAITARU)).roleBonus, null);
      check('...so the record still reports the preset', (await factsOf(s.page, RAITARU)).bonusesAreDefault);
      eq('...and the Raitaru preset is what the tools see', (await factsOf(s.page, RAITARU)).bonuses.te, 15);
      await s.close();
    }

    section('two profiles disagreeing keep the newest value AND a note about the other');
    {
      const s = await openManager(browser, server, industryConflictLegacy());
      const f = await factsOf(s.page, RAITARU);
      eq('the ACTIVE profile is treated as the most recently saved one', f.facilityTax, 3);
      eq('...so its rigs win too', f.rigs.join(','), String(RIG_T2));
      eq('one note per disagreeing fact — rigs and tax', f.conflicts.length, 2);
      const text = f.conflicts.map(c => c.text).join(' | ');
      check('...naming both profiles', /Alpha/.test(text) && /Bravo/.test(text), text);
      check('...and which one was kept', /kept "Bravo"/.test(text), text);
      check('...covering the rigs', /rigs/.test(text), text);
      check('...and the facility tax', /facility tax/.test(text), text);

      await expand(s.page, RAITARU);
      eq('both notes are surfaced on the record',
        await s.page.$$eval('#s' + RAITARU + ' .conflict', els => els.length), 2);
      check('...each with a dismiss button',
        await s.page.$$eval('#s' + RAITARU + ' .conflict-dismiss', els => els.length) === 2);
      await s.page.click('#s' + RAITARU + ' .conflict-dismiss');
      await s.page.waitForFunction(id => EveStructures.facts(id).conflicts.length === 1, RAITARU);
      eq('dismissing one drops exactly that one', (await factsOf(s.page, RAITARU)).conflicts.length, 1);
      eq('...and the dismissal is persisted', (await storedRec(s.page, RAITARU)).conflicts.length, 1);
      await s.page.reload();
      await s.page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
      eq('...and survives a reload', (await factsOf(s.page, RAITARU)).conflicts.length, 1);
      await s.close();
    }

    section('the values a record is loaded with are coerced, never guessed');
    {
      const store = [auth(), ['eveHelper.structures.v1', { v: 2, structures: [
        Object.assign({}, IDENT[RAITARU], {
          marketBroker: '', facilityTax: 'nonsense',
          rigs: [RIG_T1, String(RIG_T1), RIG_T2, 'junk', null],
          reproRig: 'wat', industryActivities: ['man', 'nope'], notes: 42,
        }),
        Object.assign({}, IDENT[ASTRAHUS], { rigs: [RIG_T1, RIG_T2, RIG_OTHER], rigSlots: 1 }),
      ] }]];
      const s = await openManager(browser, server, store);
      const f = await factsOf(s.page, RAITARU);
      eq('an empty broker string is "not known", not 0%', f.marketBroker, null);
      eq('...and so is unparseable tax', f.facilityTax, null);
      eq('a rig listed twice is fitted once', f.rigs.filter(t => t === RIG_T1).length, 1);
      eq('...and non-numeric rig entries are dropped', f.rigs.join(','), RIG_T1 + ',' + RIG_T2);
      eq('an unknown reprocessing rig tier falls back to "none"', f.reproRig, 'none');
      eq('an unknown activity code is filtered out', f.industryActivities.join(','), 'man');
      eq('a non-string note becomes an empty note', f.notes, '');
      eq('a hull with one rig slot cannot carry three rigs',
        (await factsOf(s.page, ASTRAHUS)).rigs.length, 1);
      // the structure map has loaded by now, so update() caps against the REAL slot count
      await s.page.evaluate(t => EveStructures.update(1035000000003, { rigs: t }), [RIG_T1, RIG_T2, RIG_OTHER]);
      eq('...and a later write is capped against the map, not a guess',
        (await factsOf(s.page, ASTRAHUS)).rigs.length, 1);
      eq('...at the Astrahus slot count from data/industry.json',
        (await factsOf(s.page, ASTRAHUS)).rigSlots, 1);
      await s.close();
    }

    section('the import is one-time: a reload never re-runs it over a hand edit');
    {
      const s = await openManager(browser, server, industryOnlyLegacy());
      await s.page.evaluate(id => EveStructures.update(id, { facilityTax: 7.25, rigs: [] }), RAITARU);
      // the Industry blob is still in storage, unchanged — only the marker key stops a re-import
      await s.page.reload();
      await s.page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
      eq('the hand-edited tax survives a reload', (await factsOf(s.page, RAITARU)).facilityTax, 7.25);
      eq('...and so does a deliberately emptied rig list',
        (await factsOf(s.page, RAITARU)).rigs.length, 0);
      eq('...with no duplicate record created',
        await s.page.evaluate(() => EveStructures.saved().length), 1);
      eq('...and no new conflict notes', (await factsOf(s.page, RAITARU)).conflicts.length, 0);
      const mark = await s.page.evaluate(() =>
        JSON.parse(localStorage.getItem('eveHelper.structMigration.v1')));
      check('every legacy source is marked as imported',
        mark && mark.sell === 1 && mark.mine === 1 && mark.mineStruct === 1
        && mark.industry === 1 && mark.industryBonus === 1, JSON.stringify(mark));
      await s.close();
    }

    /* ================================================================================
       (b) the manager page
       ================================================================================ */
    section('a structure is ADDED through the shared picker and lands in the store');
    {
      const s = await openManager(browser, server, [auth()], {
        identity: { searchHits: [NEWCOMER], names: { [NEWCOMER]: 'Brand New Raitaru' } },
      });
      check('the list starts empty and says so',
        /no structures yet/.test(await s.page.$eval('#list', el => el.textContent)));
      await s.page.click('#btnAdd');
      await s.page.waitForSelector('#structPicker #structSearch');
      check('the picker opens with the search enabled for a logged-in character',
        await s.page.$eval('#structPicker #structSearch', el => !el.disabled));
      await s.page.fill('#structPicker #structSearch', 'brand');
      await s.page.waitForSelector('#structResults .row', { timeout: 15000 });
      await s.page.click('#structResults .row');
      await s.page.waitForFunction(id => !!EveStructures.get(id), NEWCOMER, { timeout: 15000 });
      const rec = await recOf(s.page, NEWCOMER);
      eq('the picked structure is saved with the name ESI gave', rec.name, 'Brand New Raitaru');
      eq('...its hull', rec.typeName, 'Raitaru');
      eq('...its system', rec.systemName, 'TEST-1');
      near('...its security', rec.security, -0.42, 1e-9);
      eq('...and the rig size the structure map knows', rec.size, 'M');
      eq('a fresh record records no facts it was not told', rec.marketBroker, null);
      await s.page.waitForSelector('#s' + NEWCOMER + ' .stbody:not([hidden])', { timeout: 10000 });
      check('...and the new card is opened for editing straight away', true);
      await s.close();
    }

    section('every managed fact is edited here and written straight to storage');
    {
      const s = await openManager(browser, server, [auth(), infoCache([RAITARU, TATARA]),
        ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU], IDENT[TATARA]] }]]);
      const page = s.page;
      eq('one card per saved structure',
        await page.evaluate(() => document.querySelectorAll('#list .st').length), 2);
      check('a card is collapsed until it is clicked',
        await page.evaluate(id => document.querySelector('#s' + id + ' .stbody').hidden, RAITARU));
      await expand(page, RAITARU);
      check('the identity block is read-only text, never inputs',
        await page.evaluate(id => !document.querySelector('#s' + id + ' .ident input'), RAITARU));

      const num = async (field, value) => {
        await page.fill('#s' + RAITARU + ' [data-f="' + field + '"]', String(value));
        await page.dispatchEvent('#s' + RAITARU + ' [data-f="' + field + '"]', 'change');
      };
      await num('marketBroker', 2.75);
      await page.waitForFunction(id => EveStructures.facts(id).marketBroker === 2.75, RAITARU);
      eq('the owner-set broker % is persisted', (await storedRec(page, RAITARU)).marketBroker, 2.75);
      await num('facilityTax', 1.25);
      await page.waitForFunction(id => EveStructures.facts(id).facilityTax === 1.25, RAITARU);
      eq('the owner-set facility tax is persisted', (await storedRec(page, RAITARU)).facilityTax, 1.25);
      await num('marketBroker', '');
      await page.waitForFunction(id => EveStructures.facts(id).marketBroker === null, RAITARU);
      eq('clearing a rate goes back to "not known", not to 0%',
        (await storedRec(page, RAITARU)).marketBroker, null);
      await num('marketBroker', 2.75);
      await page.waitForFunction(id => EveStructures.facts(id).marketBroker === 2.75, RAITARU);

      section('rigs come from the size-appropriate catalog, at this system’s multipliers');
      eq('a record with no rigs shows no rig rows',
        await page.$$eval('#s' + RAITARU + ' [data-f="rig"]', els => els.length), 0);
      await page.click('#s' + RAITARU + ' .rig-add');
      await page.waitForFunction(id => EveStructures.facts(id).rigs.length === 1, RAITARU);
      const opts = await page.$$eval('#s' + RAITARU + ' [data-f="rig"] option', els => els.map(o => o.textContent));
      eq('the select offers every M-Set catalog rig this hull accepts', opts.length, 3);
      check('...by their short names', opts.every(o => /^M-Set/.test(o)), JSON.stringify(opts));
      await page.selectOption('#s' + RAITARU + ' [data-f="rig"]', String(RIG_T2));
      await page.waitForFunction(t => EveStructures.facts(1035000000001).rigs[0] === t, RIG_T2);
      eq('picking a rig is persisted', (await storedRec(page, RAITARU)).rigs.join(','), String(RIG_T2));
      const eff = await page.$eval('#s' + RAITARU + ' .rig .hint', el => el.textContent);
      check('the effective % is the nullsec-multiplied one (2.4 × 2.1 = 5.04)',
        new RegExp('ME ' + EFF_T2.toFixed(2) + '%').test(eff), eff);
      await page.click('#s' + RAITARU + ' .rig-add');
      await page.waitForFunction(() => EveStructures.facts(1035000000001).rigs.length === 2);
      check('adding another rig never repeats one already fitted',
        new Set((await factsOf(page, RAITARU)).rigs).size === 2);
      await page.click('#s' + RAITARU + ' .rig .x');
      await page.waitForFunction(() => EveStructures.facts(1035000000001).rigs.length === 1);
      eq('removing a rig row is persisted', (await storedRec(page, RAITARU)).rigs.length, 1);

      section('activities default from the hull and can be overridden');
      check('an engineering complex is defaulted, not recorded',
        (await factsOf(page, RAITARU)).activitiesAreDefault);
      await page.click('#s' + RAITARU + ' [data-act="rea"]');
      await page.waitForFunction(() => EveStructures.facts(1035000000001).industryActivities.includes('rea'));
      check('ticking one records an explicit set', !(await factsOf(page, RAITARU)).activitiesAreDefault);
      check('...persisted as a list', Array.isArray((await storedRec(page, RAITARU)).industryActivities));
      await page.click('#s' + RAITARU + ' .acts button.mini');
      await page.waitForFunction(() => EveStructures.facts(1035000000001).activitiesAreDefault);
      eq('...and "reset to hull default" clears the override rather than copying it in',
        (await storedRec(page, RAITARU)).industryActivities, null);

      section('the hull role bonuses are a fact of the structure, preset until corrected');
      eq('the Raitaru preset applies while nothing is recorded',
        (await factsOf(page, RAITARU)).bonuses.te, 15);
      await num('bonusTe', 18);
      await page.waitForFunction(id => EveStructures.facts(id).bonuses.te === 18, RAITARU);
      eq('a correction is persisted as an override', (await storedRec(page, RAITARU)).roleBonus.te, 18);
      eq('...leaving the other two at the hull values',
        (await factsOf(page, RAITARU)).bonuses.me + '/' + (await factsOf(page, RAITARU)).bonuses.cost, '1/3');
      await page.click('#s' + RAITARU + ' .bonus-reset');
      await page.waitForFunction(id => EveStructures.facts(id).bonusesAreDefault, RAITARU);
      eq('resetting clears the override, it does not copy the preset in',
        (await storedRec(page, RAITARU)).roleBonus, null);
      // typing the preset back in by hand is also "no override recorded"
      await num('bonusTe', 18);
      await page.waitForFunction(id => !EveStructures.facts(id).bonusesAreDefault, RAITARU);
      await num('bonusTe', 15);
      await page.waitForFunction(id => EveStructures.facts(id).bonusesAreDefault, RAITARU);
      eq('...and typing every preset value back by hand means the same thing',
        (await storedRec(page, RAITARU)).roleBonus, null);

      section('the reprocessing rig is its own tier, edited on the refinery record');
      await expand(page, TATARA);
      eq('a fresh refinery record starts with no reprocessing rig',
        await page.$eval('#s' + TATARA + ' [data-f="reproRig"]', el => el.value), 'none');
      await page.selectOption('#s' + TATARA + ' [data-f="reproRig"]', 't2');
      await page.waitForFunction(id => EveStructures.facts(id).reproRig === 't2', TATARA);
      eq('picking a tier is persisted', (await storedRec(page, TATARA)).reproRig, 't2');
      check('...and a non-refinery hull says a reprocessing rig would not pay off',
        /not a refinery hull/.test(await page.$eval('#s' + RAITARU + ' .stbody', el => el.textContent)));

      section('notes are free text on the record');
      await page.fill('#s' + RAITARU + ' [data-f="notes"]', 'ask Bravo about the tax');
      await page.dispatchEvent('#s' + RAITARU + ' [data-f="notes"]', 'change');
      await page.waitForFunction(id => /ask Bravo/.test(EveStructures.facts(id).notes), RAITARU);
      eq('a note is persisted', (await storedRec(page, RAITARU)).notes, 'ask Bravo about the tax');
      await s.close();
    }

    section('the identity is re-resolved from ESI on demand');
    {
      const stale = Object.assign({}, IDENT[RAITARU], { name: 'Old Name', systemName: 'STALE-1' });
      const s = await openManager(browser, server,
        [auth(), ['eveHelper.structInfo.v1', { [RAITARU]: stale }],
         ['eveHelper.structures.v1', { v: 2, structures: [Object.assign({}, stale,
           { marketBroker: 4.5, facilityTax: 2, rigs: [RIG_T2], notes: 'keep me' })] }]],
        { identity: { names: { [RAITARU]: 'Test Raitaru (renamed)' } } });
      await expand(s.page, RAITARU);
      eq('the stale name is what the card shows first',
        await s.page.$eval('#s' + RAITARU + ' .sthead b', el => el.textContent), 'Old Name');
      await s.page.click('#s' + RAITARU + ' .ident button.mini');
      await s.page.waitForFunction(id => EveStructures.get(id).name === 'Test Raitaru (renamed)',
        RAITARU, { timeout: 15000 });
      const rec = await recOf(s.page, RAITARU);
      eq('re-resolving replaces the identity', rec.name, 'Test Raitaru (renamed)');
      eq('...including the system it was stale about', rec.systemName, 'TEST-1');
      eq('...and it is persisted', (await storedRec(s.page, RAITARU)).name, 'Test Raitaru (renamed)');
      eq('the managed facts are untouched by a re-resolve', rec.marketBroker, 4.5);
      eq('...all of them', rec.facilityTax + '/' + rec.rigs.join(',') + '/' + rec.notes,
        '2/' + RIG_T2 + '/keep me');
      eq('...and the ESI identity cache is refreshed too, not just the record',
        await s.page.evaluate(id => JSON.parse(localStorage.getItem('eveHelper.structInfo.v1'))[id].name,
          RAITARU), 'Test Raitaru (renamed)');
      await s.close();
    }

    section('removing a structure names every tool that is pointing at it');
    {
      const usedEverywhere = [
        auth(), infoCache([RAITARU]),
        ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU]] }],
        ['eveSellHelper.v2', { inv: '', market: 's:' + RAITARU, ticked: [] }],
        ['eveHelper.mine.v1', { fac: { struct: 's:' + RAITARU, sec: 'ns', imp: 0, structInfo: IDENT[RAITARU] } }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [{ uid: 'f1', npc: false, ref: RAITARU, activities: ['man'], scope: [], sciOverride: null }]),
        ] }],
      ];
      const s = await openManager(browser, server, usedEverywhere);
      await expand(s.page, RAITARU);
      const usedLine = await s.page.$eval('#s' + RAITARU + ' .used', el => el.textContent);
      check('the open card lists where it is used', /Sell/.test(usedLine) && /Mine/.test(usedLine)
        && /Alpha/.test(usedLine), usedLine);
      const asked = nextDialog(s.page, true);
      await s.page.click('#s' + RAITARU + ' .sthead .x');
      const dialog = await asked;
      await s.page.waitForFunction(id => !EveStructures.get(id), RAITARU, { timeout: 10000 });
      check('the confirm names the Sell tool', /Sell tool/.test(dialog), dialog);
      check('...the Mine tool', /Mine tool/.test(dialog), dialog);
      check('...and the Industry profile by name', /Alpha/.test(dialog), dialog);
      // "those will fall back to their defaults" was one blanket promise for three tools
      // that behave differently — the confirm now names the fallback each one performs,
      // and every one of these is asserted against the tool itself further down
      check('...and names the fallback Sell performs', /Sell tool → Jita/.test(dialog), dialog);
      check('...the one Mine performs', /Mine tool → NPC station/.test(dialog), dialog);
      check('...and that an Industry facility instead stops computing',
        /Industry: the facility cannot be computed until this structure is added back/.test(dialog), dialog);
      eq('the record really is gone', await s.page.evaluate(() => EveStructures.saved().length), 0);
      eq('...from storage too', await storedRec(s.page, RAITARU), null);
      await s.close();
    }

    section('a structure nothing points at says so before it is removed');
    {
      const s = await openManager(browser, server,
        [auth(), ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU]] }]]);
      await expand(s.page, RAITARU);
      const usage = await s.page.$eval('#s' + RAITARU + ' .used', el => el.textContent);
      check('the usage line is explicit rather than empty', /nothing right now/.test(usage), usage);
      const asked = nextDialog(s.page, false);
      await s.page.click('#s' + RAITARU + ' .sthead .x');
      const dialog = await asked;
      check('the confirm says nothing is using it', /Nothing is using it/.test(dialog), dialog);
      eq('...and dismissing the confirm keeps the record',
        await s.page.evaluate(() => EveStructures.saved().length), 1);
      await s.close();
    }

    section('structures.html#s<id> opens that record, and only that one');
    {
      const s = await openManager(browser, server,
        [auth(), ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU], IDENT[TATARA]] }]],
        { hash: '#s' + RAITARU });
      await s.page.waitForSelector('#s' + RAITARU + ' .stbody:not([hidden])', { timeout: 15000 });
      check('the linked record is expanded on load', true);
      check('...and the other one is left collapsed',
        await s.page.evaluate(id => document.querySelector('#s' + id + ' .stbody').hidden, TATARA));
      await s.close();
    }

    /* ================================================================================
       (c) the rig-inference wizard, now a manager feature, writing central rigs
       ================================================================================ */
    section('the rig wizard is driven from the manager and writes onto the record');
    {
      const s = await openManager(browser, server,
        [auth(), infoCache([RAITARU]), ['eveHelper.structures.v1', { v: 2, structures: [
          Object.assign({}, IDENT[RAITARU], { rigs: [RIG_OTHER] }),
        ] }]], { esi: { skills: {} } });
      const page = s.page;
      await expand(page, RAITARU);
      // the in-game quantity a T2 ME rig would produce for the probe blueprint
      const shown = await page.evaluate(t => IndustryEngine.matQty(1000, 1, 10, 1, t), EFF_T2);
      eq('the probe quantity a T2 rig produces is a single integer', shown, 847);
      check('...which no other catalog rig reproduces', await page.evaluate(t =>
        IndustryEngine.matQty(1000, 1, 10, 1, t.t1) !== t.want
        && IndustryEngine.matQty(1000, 1, 10, 1, 0) !== t.want,
        { t1: EFF_T1, want: shown }));

      const wizBtn = '#s' + RAITARU + ' .rig-add + button.mini';
      await page.click(wizBtn);
      await page.waitForSelector('#rigWizard #wizProbe', { timeout: 10000 });
      check('the wizard names the structure it is solving for',
        /Test Raitaru/.test(await page.$eval('#rigWizard h3', el => el.textContent)));
      await page.selectOption('#rigWizard #wizDom', 'Basic Medium Ships');
      await page.waitForFunction(() => document.querySelector('#rigWizard #wizProbe').options.length > 0);
      await page.selectOption('#rigWizard #wizProbe', String(T.WIDGET));
      await page.click('#rigWizard .wbtns button.primary');
      await page.waitForSelector('#rigWizard #wizQty1', { timeout: 10000 });
      await page.fill('#rigWizard #wizBpMe', '10');
      await page.fill('#rigWizard #wizQty1', String(shown));
      await page.click('#rigWizard #wizSolveBtn');
      await page.waitForSelector('#rigWizard #wizInstall', { timeout: 10000 });
      const verdict = await page.$eval('#rigWizard .res', el => el.textContent);
      check('the solver reports exactly one candidate', /detected: M-Set/.test(verdict), verdict);
      check('...the T2 rig', /Material Efficiency II \(T2\)/.test(verdict), verdict);
      await page.click('#rigWizard #wizInstall');
      await page.waitForFunction(t => EveStructures.facts(1035000000001).rigs.includes(t), RIG_T2,
        { timeout: 10000 });
      const rigs = (await factsOf(page, RAITARU)).rigs;
      check('installing writes the detected rig onto the central record', rigs.includes(RIG_T2),
        JSON.stringify(rigs));
      check('...and keeps the rig from the other domain', rigs.includes(RIG_OTHER), JSON.stringify(rigs));
      eq('...without inventing a third', rigs.length, 2);
      eq('...persisted, not just in memory', (await storedRec(page, RAITARU)).rigs.length, 2);

      section('...replacing this domain’s previous rig rather than stacking onto it');
      const after = await page.evaluate(t => {
        const r = wizInstallRigs(EveStructures.get(1035000000001), [t.t1]);
        return { ok: r.ok, rigs: EveStructures.facts(1035000000001).rigs };
      }, { t1: RIG_T1 });
      check('a second solve of the same domain swaps the rig', after.rigs.includes(RIG_T1)
        && !after.rigs.includes(RIG_T2), JSON.stringify(after));
      check('...and still keeps the other domain', after.rigs.includes(RIG_OTHER), JSON.stringify(after));

      section('...and refusing to install more rigs than the hull has slots');
      await page.evaluate(e => EveStructures.remember(e), IDENT[ASTRAHUS]);
      const over = await page.evaluate(t => {
        const r = wizInstallRigs(EveStructures.get(1035000000003), [t.t1, t.other]);
        return { ok: r.ok, msg: r.msg, rigs: EveStructures.facts(1035000000003).rigs };
      }, { t1: RIG_T1, other: RIG_OTHER });
      check('a one-slot hull refuses a two-rig install', over.ok === false, JSON.stringify(over));
      check('...saying how many slots it has', /needs 2 rig slots.*has 1/.test(over.msg || ''), over.msg);
      eq('...and nothing is written', over.rigs.length, 0);

      section('the duration parser still reads what the in-game window shows');
      const durs = await page.evaluate(() => ({
        hms: wizParseDur('3h 42m 10s'),
        colon: wizParseDur('3:42:10'),
        mins: wizParseDur('90'),
        junk: wizParseDur('sometime next week'),
      }));
      eq('"3h 42m 10s"', durs.hms.sec, 3 * 3600 + 42 * 60 + 10);
      eq('...to the second, so the tolerance is tight', durs.hms.tol, 2);
      eq('"3:42:10" is the same duration', durs.colon.sec, durs.hms.sec);
      eq('a bare number is minutes', durs.mins.sec, 5400);
      eq('...with a looser tolerance, since the window truncated it', durs.mins.tol, 61);
      eq('nonsense parses to nothing rather than to zero', durs.junk, null);
      await s.close();
    }

    section('the Industry page hands a structure straight to the wizard by deep link');
    {
      const s = await openManager(browser, server,
        [auth(), ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU]] }]],
        { hash: '#s' + RAITARU + '/rigs' });
      await s.page.waitForSelector('#rigWizard', { timeout: 15000 });
      check('#s<id>/rigs opens the wizard on that structure',
        /Test Raitaru/.test(await s.page.$eval('#rigWizard h3', el => el.textContent)));
      await s.close();
    }

    /* ================================================================================
       (d) + (f) Sell: the broker box reads and writes the central record
       ================================================================================ */
    section('Sell reads the owner-set broker % off the record and writes it back');
    let sellNumbers = null;
    {
      const context = await baseContext(browser, sellOnlyLegacy(), {
        esi: { skills: { accounting: 5, brokerRelations: 5 }, standings: {},
               typeIds: SELL_TYPE_IDS, books: {} },
      });
      await mockIdentity(context);
      // a structure market is its own order book — one page, every type at once
      await context.route('**/markets/structures/**', route => {
        const orders = [];
        let oid = 700000;
        for (const [name, book] of Object.entries(SELL_BOOK)) {
          const typeId = SELL_TYPE_IDS[name];
          for (const b of book.buys) orders.push({ order_id: oid++, type_id: typeId, is_buy_order: true,
            price: b.p, volume_remain: b.v, min_volume: 1, location_id: KEEPSTAR,
            system_id: IDENT[KEEPSTAR].systemId, range: 'station' });
          for (const x of book.sells) orders.push({ order_id: oid++, type_id: typeId, is_buy_order: false,
            price: x.p, volume_remain: x.v, min_volume: 1, location_id: KEEPSTAR,
            system_id: IDENT[KEEPSTAR].systemId, range: 'station' });
        }
        route.fulfill(H.json(orders));
      });
      const page = await context.newPage();
      H.watchPage(page, 'sell');
      await page.goto(server.url + '/index.html');
      await page.waitForFunction("typeof rebuild === 'function' && typeof hub === 'function'");
      // settled = the structure is the market, its owner-set rate is in the box, and the
      // skills-driven sales tax auto-fill has finished (the ⚡ note is its end marker)
      await page.waitForFunction(() => hub().structure === 1035466617946
        && document.getElementById('brokerFee').value === '4.5'
        && /⚡/.test(document.body.textContent), null, { timeout: 20000 });
      eq('the legacy rate is in the box, straight off the record',
        await page.$eval('#brokerFee', el => el.value), '4.5');
      const src = await page.$eval('#feeSrc', el => el.textContent);
      check('the fee box says where that rate came from',
        /broker 4\.5% — Test Keepstar: owner-set/.test(src), src);
      check('...naming the structure manager on hover',
        /structure manager/.test(await page.$eval('#feeSrc span', el => el.title)),
        await page.$eval('#feeSrc span', el => el.title));
      eq('...and offers the record itself',
        await page.$eval('#feeSrc a', el => el.getAttribute('href')), 'structures.html#s' + KEEPSTAR);
      eq('...as does the manage link beside the market picker',
        await page.$eval('#manageStructs', el => el.getAttribute('href')), 'structures.html#s' + KEEPSTAR);

      // the round trip: typing here is an edit of the structure, not of the Sell tool
      await page.fill('#brokerFee', '3.25');
      await page.dispatchEvent('#brokerFee', 'change');
      await page.waitForFunction(id => EveStructures.facts(id).marketBroker === 3.25, KEEPSTAR);
      eq('typing a rate updates the central record', await page.evaluate(id =>
        EveStructures.facts(id).marketBroker, KEEPSTAR), 3.25);
      await page.fill('#brokerFee', '4.5');
      await page.dispatchEvent('#brokerFee', 'change');
      await page.waitForFunction(id => EveStructures.facts(id).marketBroker === 4.5, KEEPSTAR);

      // switching away to an NPC hub and back must not lose the structure's own rate
      await page.selectOption('#market', 'jita');
      await page.waitForFunction(() => hub().structure === undefined || hub().structure == null);
      check('an NPC hub hides the structure-source line',
        await page.$eval('#feeSrc', el => el.hidden));
      await page.selectOption('#market', 's:' + KEEPSTAR);
      await page.waitForFunction(() => document.getElementById('brokerFee').value === '4.5',
        null, { timeout: 15000 });
      eq('coming back to the structure restores its own rate',
        await page.$eval('#brokerFee', el => el.value), '4.5');

      section('...and the Sell blob stops owning the rate entirely');
      await page.evaluate(() => persist());
      const blob = await page.evaluate(() => JSON.parse(localStorage.getItem('eveSellHelper.v2')));
      check('a re-save drops the per-structure rate map', blob.structBroker === undefined,
        JSON.stringify(blob.structBroker));
      check('...and the structure list it used to keep', blob.structures === undefined,
        JSON.stringify(blob.structures));

      section('(f) the Sell numbers are unchanged by the move');
      await page.evaluate(() => { document.getElementById('histOn').checked = false; });
      await page.fill('#inv', SELL_PASTE);
      await page.dispatchEvent('#inv', 'input');
      await page.click('#btnEsi');
      await page.waitForFunction(() => !state.esiRunning && state.rows.length === 2,
        null, { timeout: 25000 });
      sellNumbers = await page.evaluate(() => ({
        brokerFrac: feePct('brokerFee'), taxFrac: feePct('salesTax'),
        rows: state.rows.map(r => ({ name: r.name, qty: r.qty, L: r.L, strategy: r.strategy,
          netOrder: r.netOrder, splitFill: r.splitFill, brokerEffPct: r.brokerEffPct })),
      }));
      eq('the legacy 4.5% is the fraction the fee model uses', sellNumbers.brokerFrac, 0.045);
      const trit = sellNumbers.rows.find(r => r.name === 'Tritanium');
      eq('the big stack is a pure listing', trit.strategy, 'ord');
      eq('...with nothing dumped into the buy book', trit.splitFill, 0);
      const expectNet = trit.qty * trit.L * (1 - sellNumbers.taxFrac)
        - Math.max(100, 0.045 * (trit.qty * trit.L));
      near('...and its net ISK is exactly the closed form of the legacy 4.5%',
        trit.netOrder, expectNet, 1e-6);
      near('...so the nominal rate is what it pays', trit.brokerEffPct, 4.5, 1e-9);
      const cheap = sellNumbers.rows.find(r => r.name === 'Cheap Trinket');
      const cheapValue = cheap.qty * cheap.L;
      check('the 100 ISK per-order floor still binds on the cheap stack',
        0.045 * cheapValue < 100, cheapValue);
      near('...so its effective rate is the floor, not 4.5%',
        cheap.brokerEffPct, 100 / cheapValue * 100, 1e-9);
      await context.close();
    }

    /* ================================================================================
       (d) + (f) Mine: the reprocessing rig is read off the record
       ================================================================================ */
    section('Mine reads the reprocessing rig off the record, including when there is none');
    {
      const context = await baseContext(browser, mineOnlyLegacy('none'), {
        esi: { skills: MINE_SKILLS, standings: {}, typeIds: MINE_TIDS, books: {} },
      });
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'mine');
      await page.goto(server.url + '/mine.html');
      await page.waitForFunction(() => /per-ore refine — Miquel Dreamer/.test(document.body.textContent),
        null, { timeout: 25000 });
      await page.waitForFunction(() => !document.getElementById('facRigNote').hidden,
        null, { timeout: 15000 });
      check('with nothing recorded the rig line warns instead of staying silent',
        /no rig set/.test(await page.$eval('#facRigNote', el => el.textContent)));
      check('...and names the manager as the place to fix it',
        /set it on the structure record/i.test(await page.$eval('#facRigNote', el => el.title)));
      check('...and it is flagged, not a plain hint',
        (await page.$eval('#facRigNote', el => el.className)).includes('warn'));
      eq('...and the manage link points at this structure’s record',
        await page.$eval('#facManage', el => el.getAttribute('href')), 'structures.html#s' + TATARA);
      check('the rig is never edited on this page',
        await page.evaluate(() => !document.getElementById('facRig')));
      near('the yield falls back to the plain Tatara base — no invented rig bonus',
        await page.evaluate(() => facilityBasePct()), 55, 1e-9);

      // an edit made in the manager (or another tab) has to reach this page live
      await page.evaluate(id => EveStructures.update(id, { reproRig: 't2' }), TATARA);
      await page.waitForFunction(() => !/no rig set/.test(
        document.getElementById('facRigNote').textContent), null, { timeout: 15000 });
      check('recording a rig centrally updates the line here',
        /T2 reprocessing rig/.test(await page.$eval('#facRigNote', el => el.textContent)));
      const base = await page.evaluate(() => facilityBasePct());
      near('(f) ...and the facility base is the closed form of the legacy T2/nullsec pair',
        base, 55 * (1 + 0.03 * 1.12), 1e-9);
      near('...which is 56.848%', base, 56.848, 1e-9);
      const yieldPct = await page.evaluate(() =>
        refineWithSkill('Simple Ore Processing', 60377).pct);
      near('(f) ...and a per-ore yield is that base through the same skills and implant',
        yieldPct, 55 * (1 + 0.03 * 1.12) * (1 + 0.03 * 5) * (1 + 0.02 * 4) * (1 + 0.02 * 5) * (1 + 4 / 100),
        1e-9);
      // ...and back again, to prove the page is reading rather than caching
      await page.evaluate(id => EveStructures.update(id, { reproRig: 'none' }), TATARA);
      await page.waitForFunction(() => /no rig set/.test(
        document.getElementById('facRigNote').textContent), null, { timeout: 15000 });
      near('clearing the rig centrally removes the bonus here again',
        await page.evaluate(() => facilityBasePct()), 55, 1e-9);
      eq("the pilot's implant stayed a page control throughout",
        await page.evaluate(() => state.fac.imp), 4);
      await context.close();
    }

    /* ================================================================================
       (d) + (f) Industry: the engine feed is built from the record
       ================================================================================ */
    section('Industry feeds the engine from the record and goes stale when it changes');
    {
      const context = await baseContext(browser, industryOnlyLegacy(), {
        esi: { skills: { accounting: 5, brokerRelations: 5 }, standings: {} },
      });
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'industry');
      await page.goto(server.url + '/industry.html');
      await page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });

      const fac = await page.evaluate(() => activeProfile().facilities[0]);
      eq('the stored facility references the structure', fac.ref, RAITARU);
      check('...and copies none of its facts any more',
        ['id', 'label', 'typeId', 'typeName', 'system', 'systemName', 'security', 'bonuses', 'tax', 'rigs']
          .every(k => fac[k] === undefined), JSON.stringify(Object.keys(fac)));
      check('...keeping exactly its own routing',
        JSON.stringify(fac.activities) === '["man"]' && Array.isArray(fac.scope)
        && 'sciOverride' in fac, JSON.stringify(fac));

      const eng = await page.evaluate(() => facilityToEngine(activeProfile().facilities[0]));
      eq('the engine facility takes the tax from the record', eng.tax, 3);
      eq('...its label', eng.label, 'Test Raitaru');
      eq('...its system', eng.system, IND_SYS);
      eq('...the corrected role bonus', eng.bonuses.te, 18);
      eq('...one rig', eng.rigs.length, 1);
      near('...at the nullsec-multiplied ME', eng.rigs[0].me, EFF_T2, 1e-9);
      check('the rig editor is gone from this page',
        await page.evaluate(() => typeof openRigWizard === 'undefined'));
      check('...replaced by a link into the manager',
        await page.evaluate(() => [...document.querySelectorAll('#facList a')]
          .some(a => /structures\.html#s\d+$/.test(a.getAttribute('href')))));
      check('...and a link straight into the rig wizard',
        await page.evaluate(() => [...document.querySelectorAll('#facList a')]
          .some(a => /structures\.html#s\d+\/rigs$/.test(a.getAttribute('href')))));

      section('(f) the computed job cost is the closed form of the legacy facts');
      // loadCaches() restores book/adjusted/indices from IndexedDB asynchronously and
      // overwrites each with `x || null`; the fixtures have to be written after it has
      // landed or they are clobbered. #dataAges is filled at the tail of loadCaches.
      await page.waitForFunction(() => document.getElementById('dataAges').children.length > 0,
        null, { timeout: 25000 });
      await page.evaluate(d => { book = d.book; adjusted = d.adjusted; indices = d.indices; },
        { book: IND_BOOK, adjusted: IND_ADJUSTED, indices: IND_INDICES });
      await page.evaluate(() => computeAll());
      await page.waitForFunction(() => state.rows.length > 0, null, { timeout: 25000 });
      const job = await page.evaluate(t => {
        const tree = evalOne(t).tree;
        return { eiv: tree.job.eiv, runs: tree.job.runs, breakdown: tree.job.costBreakdown,
                 mods: tree.job.matModifierBreakdown,
                 matQty: (tree.children[0] || {}).qty, matBase: 1000 };
      }, T.WIDGET);
      near('the rig ME the job used is the legacy rig at this security band',
        job.mods.rigMe, EFF_T2, 1e-9);
      eq('...the structure ME is the legacy hull role bonus', job.mods.structMe, 1);
      eq('...and the structure TE is the hand-corrected one', job.mods.structTe, 18);
      const expectedQty = await page.evaluate(o =>
        IndustryEngine.matQty(o.base, o.runs, o.bpMe, o.structMe, o.rigMe),
        { base: 1000, runs: job.runs, bpMe: job.mods.bpMe, structMe: 1, rigMe: EFF_T2 });
      eq('the material quantity is exactly what those facts produce', job.matQty, expectedQty);
      const expectedCost = await page.evaluate(o => IndustryEngine.jobCost('man', o.eiv, o.sci, {
        structCostBonusPct: 3, rigCostBonusPct: 0, sccPct: 4, taxPct: 3,
      }), { eiv: job.eiv, sci: SCI_MAN });
      near('the installation tax is the record’s 3%, on the EIV',
        job.breakdown.tax, expectedCost.tax, 1e-6);
      near('...the cost bonus is the hull’s 3%, on the gross', job.breakdown.bonus, expectedCost.bonus, 1e-6);
      near('...the SCC surcharge is unchanged', job.breakdown.scc, expectedCost.scc, 1e-6);
      near('...and the whole job cost matches the legacy facts exactly',
        job.breakdown.sciGross + job.breakdown.bonus + job.breakdown.scc + job.breakdown.tax,
        expectedCost.total, 1e-6);

      section('editing the record in the manager makes the computed table stale');
      await page.waitForFunction(() => document.getElementById('staleBanner').hidden,
        null, { timeout: 15000 });
      check('a freshly computed table is not stale', true);
      const sig0 = await page.evaluate(() => curSig());
      await page.evaluate(id => EveStructures.update(id, { facilityTax: 9 }), RAITARU);
      await page.waitForFunction(() => !document.getElementById('staleBanner').hidden,
        null, { timeout: 15000 });
      check('a central tax edit raises the banner', true);
      check('...because it changed the staleness signature',
        await page.evaluate(() => curSig()) !== sig0);
      eq('...and the engine feed already carries the new tax',
        await page.evaluate(() => facilityToEngine(activeProfile().facilities[0]).tax), 9);
      const sig1 = await page.evaluate(() => curSig());
      await page.evaluate(() => EveStructures.update(1035000000001, { rigs: [] }));
      await page.waitForFunction(() =>
        facilityToEngine(activeProfile().facilities[0]).rigs.length === 0, null, { timeout: 15000 });
      check('pulling the rigs out changes it again',
        await page.evaluate(() => curSig()) !== sig1);

      section('a facility whose record was removed refuses to compute');
      await page.evaluate(id => EveStructures.remove(id), RAITARU);
      await page.waitForSelector('#facList .facGone', { timeout: 15000 });
      check('the facility card is flagged',
        /no longer in the Structure Manager/.test(
          await page.$eval('#facList .facGone', el => el.textContent)));
      await page.evaluate(() => computeAll());
      await page.waitForFunction(() => /no longer in the Structure Manager/.test(
        document.getElementById('compStatus').textContent), null, { timeout: 15000 });
      check('...and computing says so instead of inventing a facility', true);
      await context.close();
    }

    /* ================================================================================
       (g) the review's findings, each pinned by the case that used to break
       ================================================================================ */
    section('removing a record never destroys the last surviving copy of its facts');
    {
      // structures.js imports on the FIRST load of any page, so the facts can already be
      // central before Industry is ever opened. If the record is then removed in the
      // manager, this profile's pre-refactor copy is the only one left — deleting it here
      // (which is what the facility migration used to do, unconditionally) would lose the
      // owner-set tax, the rigs and the corrected role bonuses for good.
      const storage = [auth(), infoCache([RAITARU]),
        ['eveHelper.structMigration.v1',
          { v: 1, sell: 1, mine: 1, mineStruct: 1, industry: 1, industryBonus: 1 }],
        ['eveHelper.structures.v1', { v: 2, structures: [] }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [legacyFacility({ tax: 3, rigs: [RIG_T2], bonuses: { me: 1, te: 18, cost: 3 } })]),
        ] }]];
      const s = await openIndustry(browser, server, storage);
      const page = s.page;
      eq('the structure really is out of the store', await page.evaluate(() => EveStructures.saved().length), 0);
      const fac = await page.evaluate(() => activeProfile().facilities[0]);
      eq('the facility keeps the owner-set tax it carries', fac.tax, 3);
      eq('...its rigs', JSON.stringify((fac.rigs || []).map(r => r.tid)), JSON.stringify([RIG_T2]));
      eq('...and the corrected role bonuses', fac.bonuses && fac.bonuses.te, 18);
      const goneTxt = await page.$eval('#facList .facGone', el => el.textContent);
      check('the card says the structure is gone', /no longer in the Structure Manager/.test(goneTxt), goneTxt);
      check('...and that what it still carries is kept', /kept and go back onto the record/.test(goneTxt), goneTxt);

      section('...and adding it back hands them straight over to the record');
      await page.evaluate(e => EveStructures.remember(e), IDENT[RAITARU]);
      await page.waitForFunction(id => {
        const f = EveStructures.facts(id);
        return f && f.facilityTax === 3;
      }, RAITARU, { timeout: 15000 });
      const f = await factsOf(page, RAITARU);
      eq('the owner-set tax is on the record again', f.facilityTax, 3);
      eq('...the rigs too', f.rigs.join(','), String(RIG_T2));
      eq('...and the corrected role bonus', f.bonuses.te, 18);
      const fac2 = await page.evaluate(() => activeProfile().facilities[0]);
      check('...after which the profile stops carrying its own copy',
        fac2.tax === undefined && fac2.rigs === undefined && fac2.bonuses === undefined, JSON.stringify(fac2));
      eq('...and the facility computes again',
        await page.evaluate(() => facilityToEngine(activeProfile().facilities[0]).tax), 3);
      await s.close();
    }

    section('a record created without identity takes it from the pass that has one');
    {
      // the oldest Sell blob carried a list with nothing but ids, and the ESI identity
      // cache it would otherwise fall back to is wiped by the topbar's "refresh ESI data".
      // The Industry profile still knows the hull, the system and the security band.
      const storage = [auth(),
        ['eveSellHelper.v2', { inv: '', brokerFee: '2.20',
          structures: [{ id: RAITARU, name: 'structure ' + RAITARU }],
          structBroker: { [RAITARU]: '4.5' }, market: 's:' + RAITARU, ticked: [] }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [legacyFacility({ tax: 3, rigs: [RIG_T2] })]),
        ] }]];
      const s = await openManager(browser, server, storage);
      const rec = await recOf(s.page, RAITARU);
      eq('the placeholder name gives way to the real one', rec.name, 'Test Raitaru');
      eq('...the hull comes over', rec.typeId, 35825);
      eq('...the system, so cost indices resolve at all', rec.systemId, IND_SYS);
      near('...the security, so rigs are computed in the right band', rec.security, -0.42, 1e-9);
      eq('...and the rig size the structure map derives from the hull', rec.size, 'M');
      const f = await factsOf(s.page, RAITARU);
      eq("Sell's rate still lands on that same record", f.marketBroker, 4.5);
      eq('...next to the Industry facts', f.facilityTax + '/' + f.rigs.join(','), '3/' + RIG_T2);
      eq('...on ONE record, not two', await s.page.evaluate(() => EveStructures.saved().length), 1);
      await expand(s.page, RAITARU);
      const body = await s.page.$eval('#s' + RAITARU + ' .stbody', el => el.textContent);
      check('...so the rig catalog knows what fits it', !/unknown structure type/.test(body), body.slice(0, 160));
      await s.close();
    }

    section('the Sell import never resurrects a structure that was removed');
    {
      // the old Sell page rewrote structBroker on EVERY market switch and nothing pruned
      // it, so it still names a structure that has since been deleted
      const storage = [auth(), infoCache([RAITARU, KEEPSTAR]),
        ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU]] }],
        ['eveSellHelper.v2', { inv: '', brokerFee: '2.20',
          structBroker: { [RAITARU]: '4.5', [KEEPSTAR]: '3' }, market: 'jita', ticked: [] }]];
      const s = await openManager(browser, server, storage);
      eq('the deleted structure stays deleted', await recOf(s.page, KEEPSTAR), null);
      eq('...so the saved list still holds exactly the one structure',
        await s.page.evaluate(() => EveStructures.saved().length), 1);
      eq('...while the rate of the structure that IS saved still lands',
        (await factsOf(s.page, RAITARU)).marketBroker, 4.5);
      const listed = await s.page.$eval('#list', el => el.textContent);
      check('...and no nameless "structure <id>" card appears', !/structure 1035/.test(listed), listed.slice(0, 160));
      await s.close();
    }

    section('a legacy facility tax of 0 is the "never entered" placeholder, not a fact');
    {
      const s = await openManager(browser, server, [auth(), infoCache([RAITARU]),
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [legacyFacility({ tax: 0, rigs: [RIG_T2] })]),
        ] }]]);
      eq('nothing is recorded for a tax nobody ever typed',
        (await factsOf(s.page, RAITARU)).facilityTax, null);
      const tags = await s.page.$eval('#s' + RAITARU + ' .tags', el => el.textContent);
      check('...so the card asks for it instead of showing a recorded 0%', /tax —/.test(tags), tags);
      eq('...and the rigs beside it still came over',
        (await factsOf(s.page, RAITARU)).rigs.join(','), String(RIG_T2));
      await s.close();
    }

    section('...and it can never overwrite a rate another profile did record');
    {
      // the ACTIVE profile (which wins every tie) still carries the untouched 0
      const s = await openManager(browser, server, [auth(), infoCache([RAITARU]),
        ['eveHelper.industryProfiles.v1', { active: 'pB', profiles: [
          profile('pA', 'Alpha', [legacyFacility({ tax: 2.5, rigs: [RIG_T2] })]),
          profile('pB', 'Bravo', [legacyFacility({ tax: 0, rigs: [RIG_T2] })]),
        ] }]]);
      const f = await factsOf(s.page, RAITARU);
      eq('the real rate survives the placeholder', f.facilityTax, 2.5);
      check('...with no note claiming the two profiles disagreed about tax',
        !f.conflicts.some(c => /facility tax/.test(c.text)), JSON.stringify(f.conflicts));
      await s.close();
    }

    section('emptying the Sell broker box records "not known", never 0%');
    {
      const context = await baseContext(browser, sellOnlyLegacy(), {
        esi: { skills: { accounting: 5, brokerRelations: 5 }, standings: {},
               typeIds: SELL_TYPE_IDS, books: {} },
      });
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'sell-broker');
      await page.goto(server.url + '/index.html');
      await page.waitForFunction(() => hub().structure === 1035466617946
        && document.getElementById('brokerFee').value === '4.5'
        && /⚡/.test(document.body.textContent), null, { timeout: 20000 });
      await page.fill('#brokerFee', '');
      await page.dispatchEvent('#brokerFee', 'change');
      await page.waitForFunction(id => EveStructures.facts(id).marketBroker === null,
        KEEPSTAR, { timeout: 15000 });
      eq('the record says "not known" rather than an owner-set 0%',
        await page.evaluate(id => EveStructures.facts(id).marketBroker, KEEPSTAR), null);
      const src = await page.$eval('#feeSrc', el => el.textContent);
      check('...and the fee line asks for the rate again', /none recorded yet/.test(src), src);
      await page.fill('#brokerFee', '3.5');
      await page.dispatchEvent('#brokerFee', 'change');
      await page.waitForFunction(id => EveStructures.facts(id).marketBroker === 3.5, KEEPSTAR);
      eq('...while a real rate is still written straight through',
        await page.evaluate(id => EveStructures.facts(id).marketBroker, KEEPSTAR), 3.5);
      await context.close();
    }

    section('removing the selected market structure in another tab resets Sell cleanly');
    {
      const context = await baseContext(browser, sellOnlyLegacy(), {
        esi: { skills: { accounting: 5, brokerRelations: 5 }, standings: {},
               typeIds: SELL_TYPE_IDS, books: {} },
      });
      await mockIdentity(context);
      const sell = await context.newPage();
      H.watchPage(sell, 'sell-crosstab');
      await sell.goto(server.url + '/index.html');
      await sell.waitForFunction(() => hub().structure === 1035466617946
        && document.getElementById('brokerFee').value === '4.5'
        && /⚡/.test(document.body.textContent), null, { timeout: 20000 });
      // a book fetched AT the structure: it must not survive under an NPC hub's name
      await sell.evaluate(() => state.esi.set('probe', { sell: 1 }));
      const mgr = await context.newPage();
      H.watchPage(mgr, 'manager-crosstab');
      await mgr.goto(server.url + '/structures.html');
      await mgr.waitForFunction(id => !!EveStructures.get(id), KEEPSTAR, { timeout: 20000 });
      await mgr.evaluate(id => EveStructures.remove(id), KEEPSTAR);
      await sell.waitForFunction(() => document.getElementById('market').value === 'jita',
        null, { timeout: 15000 });
      eq('the market falls back to an NPC hub', await sell.$eval('#market', el => el.value), 'jita');
      check("...and stops calling itself a structure market",
        await sell.evaluate(() => marketWasStructure === false));
      check("...so the structure's owner-set rate is out of the broker box",
        await sell.$eval('#brokerFee', el => el.value) !== '4.5',
        await sell.$eval('#brokerFee', el => el.value));
      eq('...the structure order book is dropped', await sell.evaluate(() => state.esi.size), 0);
      const st = await sell.$eval('#esiStatus', el => el.textContent);
      check('...and the page says why', /structure removed in the Structure Manager/.test(st), st);
      await sell.evaluate(() => persist());
      const blob = await sell.evaluate(() => JSON.parse(localStorage.getItem('eveSellHelper.v2')));
      eq('...with the dead market not persisted', blob.market, 'jita');
      check("...nor the structure's rate persisted as the NPC-hub broker fee",
        String(blob.brokerFee) !== '4.5', String(blob.brokerFee));
      await context.close();
    }

    section('a corrupt legacy blob cannot abort the import of the others');
    {
      const storage = [auth(), infoCache([TATARA]),
        ['eveHelper.mine.v1', { fac: { struct: 's:' + TATARA, rig: 't2', sec: 'ns', imp: 4,
                                       structInfo: IDENT[TATARA] } }],
        // hand-edited/corrupt: facilities is not an array, and one rig list is a string
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          { id: 'pA', name: 'Alpha', facilities: { nope: true } },
          { id: 'pB', name: 'Bravo', facilities: [{ uid: 'f9', npc: false, id: RAITARU,
            label: 'Test Raitaru', typeId: 35825, rigs: 'not-a-list', tax: 2 }] },
        ] }],
        ['eveSellHelper.v2', { inv: '', structBroker: { [TATARA]: '1.5' }, market: 'jita', ticked: [] }]];
      const s = await openManager(browser, server, storage);
      eq("the Mine tool's rig still came over", (await factsOf(s.page, TATARA)).reproRig, 't2');
      eq("...and Sell's rate for the same structure with it",
        (await factsOf(s.page, TATARA)).marketBroker, 1.5);
      eq('...as did the tax of the profile that IS readable',
        (await factsOf(s.page, RAITARU)).facilityTax, 2);
      const mark = await s.page.evaluate(() =>
        JSON.parse(localStorage.getItem('eveHelper.structMigration.v1')));
      check('every pass is marked done, so none of them runs over a later edit',
        mark && mark.sell === 1 && mark.mine === 1 && mark.mineStruct === 1
        && mark.industry === 1 && mark.industryBonus === 1, JSON.stringify(mark));
      await s.close();
    }

    section('an import that runs again cannot pile up the same conflict note');
    {
      const s = await openManager(browser, server, industryConflictLegacy());
      eq('the first run leaves one note per disagreeing fact',
        (await factsOf(s.page, RAITARU)).conflicts.length, 2);
      // exactly what a marker that never landed (a full origin) used to do on every load
      await s.page.evaluate(() => {
        for (let i = 0; i < 2; i++) {
          localStorage.removeItem('eveHelper.structMigration.v1');
          EveStructures.migrateLegacy();
        }
      });
      const f = await factsOf(s.page, RAITARU);
      eq('...and two further runs add none', f.conflicts.length, 2);
      eq('...nor a duplicate record', await s.page.evaluate(() => EveStructures.saved().length), 1);
      eq('...with the same values still recorded', f.facilityTax + '/' + f.rigs.join(','), '3/' + RIG_T2);
      await s.close();
    }

    section('a deep link to a structure that is not here any more says so');
    {
      const s = await openManager(browser, server,
        [auth(), ['eveHelper.structures.v1', { v: 2, structures: [IDENT[TATARA]] }]],
        { hash: '#s' + RAITARU });
      await s.page.waitForFunction(() => !document.getElementById('hashMsg').hidden,
        null, { timeout: 15000 });
      const msg = await s.page.$eval('#hashMsg', el => el.textContent);
      check('the page names the structure the link asked for', new RegExp(String(RAITARU)).test(msg), msg);
      check('...says it is not in the list', /not in this list/.test(msg), msg);
      check('...and how to get it back', /add structure/.test(msg), msg);
      await s.close();
    }

    section('legacy preset rigs follow the same "active profile wins" rule as everything else');
    {
      const EQ1 = 37301, EQ2 = 37302;
      const fixture = JSON.parse(JSON.stringify(IND_FIXTURE));
      fixture.marketGroups[9] = ['Ship Equipment', 0];      // the legacy scope's top group
      fixture.rigs[EQ1] = { n: 'Standup M-Set Equipment Manufacturing Material Efficiency I',
        sz: 'M', me: 2, te: 0, cost: 0, sec: SEC_RIG, scope: [G.PLATE], act: ['man'], fit: FIT,
        dom: 'Equipment' };
      fixture.rigs[EQ2] = { n: 'Standup M-Set Equipment Manufacturing Material Efficiency II',
        sz: 'M', me: 2.4, te: 0, cost: 0, sec: SEC_RIG, scope: [G.PLATE], act: ['man'], fit: FIT,
        dom: 'Equipment' };
      const presetFac = preset => Object.assign(legacyFacility({ tax: 3 }), { rigs: [{ preset, scope: [9] }] });
      const storage = [auth(), infoCache([RAITARU]),
        ['eveHelper.industryProfiles.v1', { active: 'pB', profiles: [
          profile('pA', 'Alpha', [presetFac('t1me')]),
          profile('pB', 'Bravo', [presetFac('t2me')]),
        ] }]];
      const s = await openIndustry(browser, server, storage, { industry: fixture });
      const f = await factsOf(s.page, RAITARU);
      eq('the ACTIVE profile’s mapped rig is the one on the record', f.rigs.join(','), String(EQ2));
      check('...and the other profile’s is not dropped in silence',
        f.conflicts.some(c => /disagreed about rigs/.test(c.text)
          && /Alpha/.test(c.text) && /Bravo/.test(c.text)), JSON.stringify(f.conflicts));
      await s.close();
    }

    /* ================================================================================
       (h) one case per finding of the second review round: dead ends and stale state,
           the empty/logged-out picker, and the two correctness bugs
       ================================================================================ */
    section('Mine’s legacy rig follows the structure it was fitted to, not the selection');
    {
      // the old Mine tool kept the rig as a PAGE-level field: switching the facility back
      // to "NPC station" left `struct: 'npc'` with both the rig and the structure's own
      // identity snapshot intact, and reading only the selection dropped the rig for good
      const s = await openManager(browser, server, [auth(), infoCache([TATARA]),
        ['eveHelper.mine.v1', { fac: { struct: 'npc', rig: 't2', sec: 'ns', imp: 4,
                                       structInfo: IDENT[TATARA] } }]]);
      const rec = await recOf(s.page, TATARA);
      check('the refinery still gets a record', !!rec, JSON.stringify(rec));
      eq('...named from the snapshot the page kept', rec && rec.name, 'Test Tatara');
      eq('...carrying the rig that would otherwise have been dropped',
        (await factsOf(s.page, TATARA)).reproRig, 't2');
      const mark = await s.page.evaluate(() =>
        JSON.parse(localStorage.getItem('eveHelper.structMigration.v1')));
      check('...with the pass marked done, so it never runs over a later edit',
        mark && mark.mine === 1 && mark.mineStruct === 1, JSON.stringify(mark));
      await s.close();
    }

    section('the rig wizard strips the record’s corrected role bonuses, not the hull preset');
    {
      // a Raitaru whose ME role bonus was corrected from the 1% preset to 5% — that is the
      // set the Industry engine computes with (facts().bonuses), so it is the one the
      // wizard has to strip before matching the residual against the catalog
      const s = await openManager(browser, server,
        [auth(), infoCache([RAITARU]), ['eveHelper.structures.v1', { v: 2, structures: [
          Object.assign({}, IDENT[RAITARU], { roleBonus: { me: 5, te: 15, cost: 3 } }),
        ] }]], { esi: { skills: {} } });
      const page = s.page;
      eq('the record’s effective ME bonus is the correction, not the preset',
        (await factsOf(page, RAITARU)).bonuses.me, 5);
      // what the in-game industry window shows at THIS structure with a T2 rig fitted
      const shown = await page.evaluate(t => IndustryEngine.matQty(1000, 1, 10, 5, t), EFF_T2);
      eq('the quantity a T2 rig produces here is a single integer', shown, 812);
      check('...which the 1% PRESET explains with no catalog rig at all — the old wizard '
        + 'would have reported a conflict', await page.evaluate(t =>
          [0, t.t1, t.t2].every(r => IndustryEngine.matQty(1000, 1, 10, 1, r) !== t.shown),
          { shown, t1: EFF_T1, t2: EFF_T2 }));
      await expand(page, RAITARU);
      await page.click('#s' + RAITARU + ' .rig-add + button.mini');
      await page.waitForSelector('#rigWizard #wizProbe', { timeout: 10000 });
      await page.selectOption('#rigWizard #wizDom', 'Basic Medium Ships');
      await page.waitForFunction(() => document.querySelector('#rigWizard #wizProbe').options.length > 0);
      await page.selectOption('#rigWizard #wizProbe', String(T.WIDGET));
      await page.click('#rigWizard .wbtns button.primary');
      await page.waitForSelector('#rigWizard #wizQty1', { timeout: 10000 });
      await page.fill('#rigWizard #wizBpMe', '10');
      await page.fill('#rigWizard #wizQty1', String(shown));
      await page.click('#rigWizard #wizSolveBtn');
      await page.waitForSelector('#rigWizard #wizInstall', { timeout: 10000 });
      const verdict = await page.$eval('#rigWizard .res', el => el.textContent);
      check('the wizard detects the rig that is actually fitted',
        /Material Efficiency II \(T2\)/.test(verdict), verdict);
      check('...rather than reporting a conflict', !/CONFLICT/.test(verdict), verdict);
      await s.close();
    }

    section('the picker’s empty state says it is empty and offers the manager');
    {
      // a first-time user: nothing saved anywhere. The picker used to render a title, a
      // blank strip and a search box — and the Sell page hid its own manage link too
      const context = await baseContext(browser, [auth()], {
        esi: { skills: { accounting: 5, brokerRelations: 5 }, standings: {},
               typeIds: SELL_TYPE_IDS, books: {} },
      });
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'sell-empty');
      await page.goto(server.url + '/index.html');
      await page.waitForFunction(() => typeof hub === 'function' && /⚡/.test(document.body.textContent),
        null, { timeout: 20000 });
      check('with nothing saved the Sell page still shows the way to the manager',
        !(await page.$eval('#manageStructs', el => el.hidden)));
      await page.selectOption('#market', '__add');
      await page.waitForSelector('#structPicker #structNone', { timeout: 15000 });
      const none = await page.$eval('#structPicker #structNone', el => el.textContent);
      check('the picker says there is nothing saved yet', /no saved structures yet/.test(none), none);
      check('...and still links to the Structure Manager', await page.evaluate(() =>
        !!document.querySelector('#structSaved a[href="structures.html"]')));
      check('...with the search box left usable', await page.$eval('#structSearch', el => !el.disabled));
      await page.keyboard.press('Escape');
      await context.close();
    }

    section('the logged-out picker offers the login it asks for');
    {
      // .eveModal is z-index 100 over a z-index 20 topbar, so the SSO button the message
      // points at is behind the overlay — the action has to be inside it
      const s = await openManager(browser, server, []);
      await s.page.evaluate(() => { window.__logins = 0; EveAuth.login = () => { window.__logins++; }; });
      await s.page.click('#btnAdd');
      await s.page.waitForSelector('#structPicker #structMsg.err', { timeout: 15000 });
      const msg = await s.page.$eval('#structPicker #structMsg', el => el.textContent);
      check('it still says a login is needed', /log in with EVE — the search runs as your character/.test(msg), msg);
      check('...and now carries the action itself',
        await s.page.evaluate(() => !!document.getElementById('structLogin')));
      await s.page.click('#structLogin');
      await s.page.waitForFunction(() => !document.getElementById('structPicker'), null, { timeout: 10000 });
      eq('...which closes the picker covering the topbar', await s.page.evaluate(() => window.__logins), 1);
      await s.close();
    }

    section('Sell never carries one market’s broker rate into a structure that has none');
    {
      const context = await baseContext(browser, [auth(), infoCache([KEEPSTAR, RAITARU]),
        ['eveHelper.structures.v1', { v: 2, structures: [
          Object.assign({}, IDENT[KEEPSTAR], { marketBroker: 4.5 }),
          Object.assign({}, IDENT[RAITARU]),
        ] }]], {
        esi: { skills: { accounting: 5, brokerRelations: 5 }, standings: {},
               typeIds: SELL_TYPE_IDS, books: {} },
      });
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'sell-carry');
      await page.goto(server.url + '/index.html');
      // settled = the skills-driven NPC-hub rate has been auto-filled at Jita
      await page.waitForFunction(() => document.getElementById('brokerFee').value === '1.50'
        && /⚡/.test(document.body.textContent), null, { timeout: 20000 });
      await page.selectOption('#market', 's:' + KEEPSTAR);
      await page.waitForFunction(() => document.getElementById('brokerFee').value === '4.5',
        null, { timeout: 15000 });
      await page.selectOption('#market', 's:' + RAITARU);
      await page.waitForFunction(id => hub().structure === id, RAITARU, { timeout: 15000 });
      eq('a structure with no recorded rate does not inherit the last one',
        await page.$eval('#brokerFee', el => el.value), '1.50');
      near('...and the fee model prices with that, not with 4.5%',
        await page.evaluate(() => feePct('brokerFee')), 0.015, 1e-12);
      const src = await page.$eval('#feeSrc', el => el.textContent);
      check('the fee line still says nothing is recorded', /none recorded yet/.test(src), src);
      check('...and names the number in the box as a stand-in', /stand-in/.test(src), src);

      // and the same hole cross-tab: clearing the rate in the manager must not leave the
      // old number pricing every order here
      await page.selectOption('#market', 's:' + KEEPSTAR);
      await page.waitForFunction(() => document.getElementById('brokerFee').value === '4.5',
        null, { timeout: 15000 });
      const mgr = await context.newPage();
      H.watchPage(mgr, 'manager-clear');
      await mgr.goto(server.url + '/structures.html');
      await mgr.waitForFunction(id => !!EveStructures.get(id), KEEPSTAR, { timeout: 20000 });
      await mgr.evaluate(id => EveStructures.update(id, { marketBroker: null }), KEEPSTAR);
      await page.waitForFunction(() => document.getElementById('brokerFee').value === '1.50',
        null, { timeout: 15000 });
      eq('clearing the rate centrally drops it out of the box too',
        await page.$eval('#brokerFee', el => el.value), '1.50');
      await context.close();
    }

    section('Mine offers the shared saved list and falls back when a structure is removed');
    {
      const context = await baseContext(browser, [auth(), infoCache([TATARA, RAITARU]),
        ['eveHelper.structures.v1', { v: 2, structures: [
          Object.assign({}, IDENT[TATARA], { reproRig: 't2' }),
          Object.assign({}, IDENT[RAITARU]),
        ] }],
        ['eveHelper.mine.v1', { fac: { struct: 's:' + TATARA, sec: 'ns', imp: 4,
                                       structInfo: IDENT[TATARA] } }]], {
        esi: { skills: MINE_SKILLS, standings: {}, typeIds: MINE_TIDS, books: {} },
      });
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'mine-list');
      await page.goto(server.url + '/mine.html');
      await page.waitForFunction(() => /per-ore refine — Miquel Dreamer/.test(document.body.textContent),
        null, { timeout: 25000 });
      await page.waitForFunction(() => !document.getElementById('facStruct').disabled,
        null, { timeout: 15000 });
      const opts = await page.$$eval('#facStruct option', els => els.map(o => o.value));
      eq('the facility dropdown offers every saved structure, not just the selected one',
        opts.join(','), ['npc', 's:' + TATARA, 's:' + RAITARU].join(','));
      near('the selected refinery is the T2-rigged Tatara', await page.evaluate(() => facilityBasePct()),
        55 * (1 + 0.03 * 1.12), 1e-9);
      // switching straight from the dropdown, with no modal in between
      await page.selectOption('#facStruct', 's:' + RAITARU);
      await page.waitForFunction(id => state.fac.structInfo && state.fac.structInfo.id === id,
        RAITARU, { timeout: 15000 });
      eq('picking another saved structure switches the facility from the list itself',
        await page.evaluate(() => state.fac.structInfo.name), 'Test Raitaru');
      await page.selectOption('#facStruct', 's:' + TATARA);
      await page.waitForFunction(id => state.fac.structInfo && state.fac.structInfo.id === id,
        TATARA, { timeout: 15000 });

      // the manager's remove confirm promises Mine falls back to its default — so it must
      await page.evaluate(id => EveStructures.remove(id), TATARA);
      await page.waitForFunction(() => state.fac.struct === 'npc', null, { timeout: 15000 });
      near('a removed structure really does fall back to the NPC station',
        await page.evaluate(() => facilityBasePct()), 50, 1e-9);
      const gone = await page.$eval('#facRigNote', el => el.textContent);
      check('...and the page says which structure went and what it fell back to',
        /Test Tatara/.test(gone) && /NPC station/.test(gone), gone);
      const opts2 = await page.$$eval('#facStruct option', els => els.map(o => o.value));
      check('...and the dropdown stops offering it', !opts2.includes('s:' + TATARA), opts2.join(','));
      eq('...with the fallback persisted, not just displayed', await page.evaluate(() =>
        JSON.parse(localStorage.getItem('eveHelper.mine.v1')).fac.struct), 'npc');
      await context.close();
    }

    section('Mine re-reads the security band a central identity refresh changes');
    {
      // the case structures.js's "saved before type/security were tracked" path exists for:
      // the record's security is filled in centrally, and the band scales the rig bonus
      const bandless = Object.assign({}, IDENT[TATARA], { security: null, reproRig: 't2' });
      const context = await baseContext(browser, [auth(),
        ['eveHelper.structInfo.v1', { [TATARA]: Object.assign({}, IDENT[TATARA], { security: null }) }],
        ['eveHelper.structures.v1', { v: 2, structures: [bandless] }],
        ['eveHelper.mine.v1', { fac: { struct: 's:' + TATARA, sec: 'hs', imp: 4,
                                       structInfo: Object.assign({}, IDENT[TATARA], { security: null }) } }]], {
        esi: { skills: MINE_SKILLS, standings: {}, typeIds: MINE_TIDS, books: {} },
      });
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'mine-band');
      await page.goto(server.url + '/mine.html');
      await page.waitForFunction(() => /per-ore refine — Miquel Dreamer/.test(document.body.textContent),
        null, { timeout: 25000 });
      near('with no security recorded the rig is scaled by the highsec ×1',
        await page.evaluate(() => facilityBasePct()), 55 * (1 + 0.03 * 1), 1e-9);
      await page.evaluate(id => EveStructures.refresh(id), TATARA);
      await page.waitForFunction(() => state.fac.sec === 'ns', null, { timeout: 20000 });
      near('re-resolving the identity centrally moves the band here, and the yield with it',
        await page.evaluate(() => facilityBasePct()), 55 * (1 + 0.03 * 1.12), 1e-9);
      check('...and the facility note stops claiming the old multiplier',
        /nullsec.*×1\.12/.test(await page.$eval('#facNote', el => el.textContent)),
        await page.$eval('#facNote', el => el.textContent));
      await context.close();
    }

    section('a record with no system or security says so where it is used');
    {
      // a record can exist without either — built from a legacy blob that never carried
      // them, or created while the ESI identity cache was cold. Both fail silently: the
      // cost index reads as 0 and the security bands as highsec
      const storage = [auth(),
        ['eveHelper.structures.v1', { v: 2, structures: [
          { id: RAITARU, name: 'Test Raitaru', typeId: 35825, typeName: 'Raitaru' },
        ] }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [{ uid: 'f1', npc: false, ref: RAITARU, activities: ['man'],
                                    scope: [], sciOverride: null }]),
        ] }]];
      const s = await openIndustry(browser, server, storage, { identity: {} });
      await s.page.waitForSelector('.fac .facIdentGap', { timeout: 15000 });
      const gap = await s.page.$eval('.fac .facIdentGap', el => el.textContent);
      check('the facility card names the gap', /no system or security recorded/.test(gap), gap);
      check('...and what it silently costs — a cost index of 0', /cost index below counts as 0/.test(gap), gap);
      check('...and highsec rig multipliers', /highsec multipliers/.test(gap), gap);
      check('...with a link to the record that can fix it', await s.page.evaluate(() =>
        !!document.querySelector('.fac .facIdentGap a[href="structures.html#s1035000000001"]')));
      eq('...which is exactly the system the engine would have been fed',
        await s.page.evaluate(() => facilityToEngine(IndustryPage.activeProfile().facilities[0]).system), null);
      await s.close();
      const m = await openManager(browser, server, storage);
      await expand(m.page, RAITARU);
      const flag = await m.page.$eval('#identGap' + RAITARU, el => el.textContent);
      check('the manager’s own record flags it too', /no system or security recorded/.test(flag), flag);
      check('...and names re-resolve as the fix', /re-resolve/.test(flag), flag);
      await m.close();
    }

    section('the Industry link on a facility whose record is gone offers to add it back');
    {
      const s = await openIndustry(browser, server, [auth(),
        // already imported once, and the record removed in the manager since
        ['eveHelper.structMigration.v1',
          { v: 1, sell: 1, mine: 1, mineStruct: 1, industry: 1, industryBonus: 1 }],
        ['eveHelper.structures.v1', { v: 2, structures: [IDENT[TATARA]] }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [{ uid: 'f1', npc: false, ref: RAITARU, activities: ['man'],
                                    scope: [], sciOverride: null }]),
        ] }]]);
      await s.page.waitForSelector('.fac .facGone', { timeout: 15000 });
      const link = await s.page.$eval('.fac .fhead a', el => ({ t: el.textContent, h: el.getAttribute('href') }));
      check('the one offered action is not called "edit" any more',
        !/edit in the structure manager/.test(link.t), JSON.stringify(link));
      check('...but says what it can actually do', /add this structure back/.test(link.t), JSON.stringify(link));
      eq('...and still deep-links to the record the manager will explain',
        link.h, 'structures.html#s' + RAITARU);
      await s.close();
    }

    /* ================================================================================
       (i) the leftovers: controls that lied about what they could do
       ================================================================================ */
    section('Industry only offers "infer rigs…" where the wizard can actually run');
    {
      // one hull the catalog knows and one it does not — the wizard's first step dead-ends
      // with "No probeable rig domains for this structure." on the second
      const UNKNOWN = { id: 1035000000077, name: 'Test Oddity', typeId: 34567, typeName: 'Oddity',
        systemId: IND_SYS, systemName: 'TEST-1', security: -0.42, regionId: 10000999 };
      const s = await openIndustry(browser, server, [auth(),
        ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU], UNKNOWN] }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [
            { uid: 'f1', npc: false, ref: RAITARU, activities: ['man'], scope: [], sciOverride: null },
            { uid: 'f2', npc: false, ref: UNKNOWN.id, activities: ['man'], scope: [], sciOverride: null },
          ]),
        ] }]]);
      await s.page.waitForSelector('.fac[data-ref="' + UNKNOWN.id + '"]', { timeout: 15000 });
      const links = await s.page.evaluate(ref => {
        const sel = c => [...document.querySelectorAll(`.fac[data-ref="${c}"] a`)].map(a => a.getAttribute('href'));
        return { known: sel(1035000000001), unknown: sel(ref) };
      }, UNKNOWN.id);
      check('a hull the catalog knows keeps the wizard link',
        links.known.some(h => /\/rigs$/.test(h)), JSON.stringify(links.known));
      check('...and one it does not is not sent to a wizard with nothing to probe',
        !links.unknown.some(h => /\/rigs$/.test(h)), JSON.stringify(links.unknown));
      check('...while the record itself is still reachable from it',
        links.unknown.some(h => h === 'structures.html#s' + UNKNOWN.id), JSON.stringify(links.unknown));
      const cap = await s.page.$$eval('.fac[data-ref="' + UNKNOWN.id + '"] .hint',
        els => els.map(e => e.textContent).join(' | '));
      check('...and the rig line says why', /unknown structure type/.test(cap), cap);
      await s.close();
    }

    section('the record’s "activities this structure can run" is checked, not just stored');
    {
      // a Tatara is a refinery: the hull default is reactions only, and this profile routes
      // manufacturing there. The field used to be written in the manager and read by
      // nothing except the next facility added.
      const s = await openIndustry(browser, server, [auth(),
        ['eveHelper.structures.v1', { v: 2, structures: [IDENT[TATARA]] }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [{ uid: 'f1', npc: false, ref: TATARA, activities: ['man', 'rea'],
                                    scope: [], sciOverride: null }]),
        ] }]]);
      await s.page.waitForSelector('.fac .facActWarn', { timeout: 15000 });
      const w = await s.page.$eval('.fac .facActWarn', el => el.textContent);
      check('the facility card names the activity the structure cannot run',
        /routes Manufacturing here/.test(w), w);
      check('...and does not accuse it of the one it can', !/Reactions/.test(w), w);
      check('...saying the record is still on the hull default', /default for this hull/.test(w), w);
      check('...with the record one click away', await s.page.evaluate(() =>
        !!document.querySelector('.fac .facActWarn a[href="structures.html#s1035000000002"]')));
      // recording that it CAN manufacture clears the flag — the field drives something real
      await s.page.evaluate(id => EveStructures.update(id, { industryActivities: ['man', 'rea'] }), TATARA);
      await s.page.waitForFunction(() => !document.querySelector('.fac .facActWarn'), null, { timeout: 15000 });
      check('correcting the record on the manager side clears it', true);
      await s.close();
    }

    section('Industry’s mirrored structure facts do not look like its editable NPC fields');
    {
      const s = await openIndustry(browser, server, [auth(),
        ['eveHelper.structures.v1', { v: 2, structures: [
          Object.assign({}, IDENT[RAITARU], { facilityTax: 2.5 }),
        ] }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [
            { uid: 'f1', npc: false, ref: RAITARU, activities: ['man'], scope: [], sciOverride: null },
            { uid: 'f2', npc: true, label: 'Jita 4-4', system: null, systemName: null, security: null,
              activities: ['man'], scope: [], bonuses: { me: 0, te: 0, cost: 0 }, tax: 0.25, sciOverride: null },
          ]),
        ] }]]);
      await s.page.waitForSelector('.fac[data-ref] .kv.ro', { timeout: 15000 });
      const marked = await s.page.evaluate(() => ({
        roOnStruct: document.querySelectorAll('.fac[data-ref] .kv.ro').length,
        roOnNpc: document.querySelectorAll('.fac:not([data-ref]) .kv.ro').length,
        inputsInRo: document.querySelectorAll('.fac .kv.ro input').length,
        inputsOnNpc: document.querySelectorAll('.fac:not([data-ref]) .kv input').length,
        taxTxt: document.getElementById('facTaxf1').textContent,
      }));
      eq('the two mirrored facts on a structure card are marked read-only', marked.roOnStruct, 2);
      eq('...and nothing on the NPC card is', marked.roOnNpc, 0);
      eq('...a mirror never carries an input', marked.inputsInRo, 0);
      check('...while the NPC station keeps its real ones', marked.inputsOnNpc >= 4, marked.inputsOnNpc);
      check('the mirrored tax names where it comes from, without hovering',
        /from Structures/.test(marked.taxTxt) && /2\.5%/.test(marked.taxTxt), marked.taxTxt);
      await s.close();
    }

    section('a failed SDE fetch cannot destroy a profile’s unmapped legacy rig rows');
    {
      // migrateRigs bails when data/industry.json is unreadable, so a {preset, scope} row
      // is mapped to no catalog tid and handed to nobody — deleting it with the rest of
      // the per-profile copy would lose it on a single fetch failure, permanently
      const EQ1 = 37301;
      const fixture = JSON.parse(JSON.stringify(IND_FIXTURE));
      fixture.marketGroups[9] = ['Ship Equipment', 0];
      fixture.rigs[EQ1] = { n: 'Standup M-Set Equipment Manufacturing Material Efficiency I',
        sz: 'M', me: 2, te: 0, cost: 0, sec: SEC_RIG, scope: [G.PLATE], act: ['man'], fit: FIT,
        dom: 'Equipment' };
      const storage = [auth(), infoCache([RAITARU]),
        ['eveHelper.structMigration.v1',
          { v: 1, sell: 1, mine: 1, mineStruct: 1, industry: 1, industryBonus: 1 }],
        ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU]] }],
        ['eveHelper.industryProfiles.v1', { active: 'pA', profiles: [
          profile('pA', 'Alpha', [Object.assign(legacyFacility({ tax: 3 }),
            { rigs: [{ preset: 't1me', scope: [9] }] })]),
        ] }]];
      const context = await browser.newContext();
      await H.seedStorage(context, null, storage);
      await H.mockEsi(context, { skills: {}, standings: {} });
      await mockIdentity(context);
      await context.route('**/data/ores.json', r => r.fulfill(H.json(ORES_FIXTURE)));
      let sdeOk = false;      // read at request time: the reload below gets the catalog
      await context.route('**/data/industry.json', r =>
        sdeOk ? r.fulfill(H.json(fixture)) : r.fulfill({ status: 404, body: 'not built by CI' }));
      const page = await context.newPage();
      H.watchPage(page, 'industry-nosde');
      await page.goto(server.url + '/industry.html');
      await page.waitForFunction(() => document.getElementById('sdeStatus').className === 'err',
        null, { timeout: 20000 });
      // the facility migration has run once its own effect is visible: the copies it CAN
      // hand over are gone from the profile
      await page.waitForFunction(() => activeProfile().facilities[0].tax === undefined,
        null, { timeout: 15000 });
      const kept = await page.evaluate(() => activeProfile().facilities[0].rigs);
      check('the unmapped preset row is still there', Array.isArray(kept) && kept.length === 1
        && kept[0].preset === 't1me', JSON.stringify(kept));
      eq('...and persisted, not just held in memory', await page.evaluate(() =>
        JSON.parse(localStorage.getItem('eveHelper.industryProfiles.v1')).profiles[0].facilities[0].rigs[0].preset),
        't1me');
      eq('...while the facts that COULD be handed over were', await page.evaluate(id =>
        EveStructures.facts(id).facilityTax, RAITARU), 3);

      sdeOk = true;
      await page.reload();
      await page.waitForFunction(() => document.getElementById('sdeStatus').className === 'ok',
        null, { timeout: 20000 });
      await page.waitForFunction(id => EveStructures.facts(id).rigs.length === 1, RAITARU,
        { timeout: 15000 });
      eq('the first load that has the catalog maps it onto the record',
        (await factsOf(page, RAITARU)).rigs[0], EQ1);
      eq('...and only then is the profile copy dropped',
        await page.evaluate(() => activeProfile().facilities[0].rigs), undefined);
      await context.close();
    }

    section('Mine states the security band instead of offering a dropdown it never enables');
    {
      const context = await baseContext(browser, [auth(), infoCache([TATARA]),
        ['eveHelper.structures.v1', { v: 2, structures: [IDENT[TATARA]] }],
        ['eveHelper.mine.v1', { fac: { struct: 's:' + TATARA, sec: 'ns', imp: 4,
                                       structInfo: IDENT[TATARA] } }]], {
        esi: { skills: MINE_SKILLS, standings: {}, typeIds: MINE_TIDS, books: {} },
      });
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'mine-band-text');
      await page.goto(server.url + '/mine.html');
      await page.waitForFunction(() => /per-ore refine — Miquel Dreamer/.test(document.body.textContent),
        null, { timeout: 25000 });
      await page.waitForFunction(() => /nullsec/.test(document.getElementById('facNote').textContent),
        null, { timeout: 15000 });
      check('the permanently-disabled band dropdown is gone',
        await page.evaluate(() => !document.getElementById('facSec')));
      const note = await page.$eval('#facNote', el => el.textContent);
      check('...and the band it displayed is stated in the facility note',
        /nullsec/.test(note) && /×1\.12/.test(note), note);
      check('...with where it was detected from in the title', /security: -0\.42 at TEST-1/.test(
        await page.$eval('#facNote', el => el.title)), await page.$eval('#facNote', el => el.title));
      await context.close();
    }

    /* ================================================================================
       (e) the manager is reachable from everywhere
       ================================================================================ */
    section('every page carries the Structures tab');
    for (const p of ['index.html', 'mine.html', 'industry.html', 'structures.html']) {
      const context = await baseContext(browser, [auth()]);
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, p);
      await page.goto(server.url + '/' + p);
      await page.waitForSelector('#topbar a[href="structures.html"]', { timeout: 20000 });
      const tab = await page.evaluate(() => {
        const a = document.querySelector('#topbar a[href="structures.html"]');
        return { text: a.textContent, active: a.classList.contains('active') };
      });
      eq(p + ' links to the manager', tab.text, 'Structures');
      if (p === 'structures.html') check('...and marks the tab active on the manager itself', tab.active);
      else check('...without claiming to BE the manager', !tab.active, p);
      await context.close();
    }

    section('the shared picker selects a structure — it never manages one');
    {
      const context = await baseContext(browser,
        [auth(), ['eveHelper.structures.v1', { v: 2, structures: [IDENT[RAITARU]] }]]);
      await mockIdentity(context);
      const page = await context.newPage();
      H.watchPage(page, 'picker');
      await page.goto(server.url + '/index.html');
      await page.waitForFunction(() => !!window.EveStructures);
      await page.evaluate(() => { window.__picked = 'pending';
        EveStructures.pick({ title: 'Market structure', list: true })
          .then(v => { window.__picked = v; }); });
      await page.waitForSelector('#structPicker #structSaved .row');
      check('the saved structures are offered for selection',
        await page.$$eval('#structPicker #structSaved .row', els => els.length) >= 1);
      check('...with no remove button on any row',
        await page.evaluate(() => !document.querySelector('#structPicker .del')));
      check('...and not one of the manager’s fact editors',
        await page.evaluate(() => !document.querySelector('#structPicker [data-f], #structPicker [data-act]')));
      eq('...just one link to the place that does manage them',
        await page.$eval('#structPicker #structSaved a', el => el.getAttribute('href')), 'structures.html');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.__picked !== 'pending');
      eq('escaping the picker selects nothing', await page.evaluate(() => window.__picked), null);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
