/* The central structure store (structures.js) and the Structure Manager page.

   One record per structure: identity from ESI plus the facts a human has to supply
   (owner-set broker %, facility tax %, rigs, reprocessing rig, activities, notes). This
   suite covers the schema bump, the one-time import of the facts the three tools used to
   keep on their own, the conflict note two disagreeing Industry profiles produce, the
   manager's editors, and the fact that the Industry page now reads rigs/tax from the
   record rather than from its profile.

   data/industry.json is gitignored (CI builds it from the SDE), so the page's fetch of it
   is intercepted and served a small SDE-shaped fixture — enough of a rig catalog and
   structure map to drive the rig editor and the inference wizard's solver. */
'use strict';
const H = require('./helper');
const { check, eq, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };
const RAITARU = 9000001, TATARA = 9000002;
const RIG_T1 = 37146, RIG_T2 = 37147;
const GROUP = 100;   // the probe product's group id, inside both rigs' scope

const FIXTURE = {
  v: 'test-fixture',
  types: { 1001: ['Test Widget', 5, 5, GROUP, 200, null], 3001: ['Test Mineral', 0.01, 0.01, 102, 202, null] },
  groups: { [GROUP]: ['Widgets', 6], 102: ['Minerals', 4] },
  marketGroups: { 200: ['Manufactured', 0], 202: ['Minerals', 0] },
  skills: { 3380: 'Industry', 3388: 'Advanced Industry' },
  rigs: {
    [RIG_T1]: { n: 'Standup M-Set Basic Medium Ship Manufacturing Material Efficiency I',
      sz: 'M', me: 2, te: 0, cost: 0, sec: { hs: 1, ls: 1.9, ns: 2.1 },
      scope: [GROUP], act: ['man'], fit: [1657, 1404, 1406], dom: 'Basic Medium Ships' },
    [RIG_T2]: { n: 'Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II',
      sz: 'M', me: 2.4, te: 0, cost: 0, sec: { hs: 1, ls: 1.9, ns: 2.1 },
      scope: [GROUP], act: ['man'], fit: [1657, 1404, 1406], dom: 'Basic Medium Ships' },
  },
  structures: {
    35825: ['Raitaru', 1404, 'M', 3],
    35836: ['Tatara', 1406, 'L', 3],
  },
  blueprints: { 9001: { limit: 20, man: { t: 1200, m: [[3001, 1000]], p: [[1001, 1]], s: [] } } },
};

const IDENT = {
  [RAITARU]: { id: RAITARU, name: 'Test Raitaru', typeId: 35825, typeName: 'Raitaru', refinery: null,
    systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999 },
  [TATARA]: { id: TATARA, name: 'Test Tatara', typeId: 35836, typeName: 'Tatara', refinery: 'tatara',
    systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999 },
};

/* the three tools' storage exactly as they used to write it */
function legacyStorage() {
  return [
    ['eveHelper.auth.v1', H.authState([CHAR])],
    ['eveHelper.structInfo.v1', IDENT],
    // v1 schema: a bare array carrying identity only
    ['eveHelper.structures.v1', [IDENT[RAITARU]]],
    // Sell: owner-set broker % per structure id
    ['eveSellHelper.v2', { inv: '', brokerFee: '1.50', salesTax: '2.25',
      structBroker: { [RAITARU]: '4.5' }, market: 's:' + RAITARU, ticked: [] }],
    // Mine: the refining facility snapshot, rig included
    ['eveHelper.mine.v1', { fac: { struct: 's:' + TATARA, rig: 't2', sec: 'ns', imp: 4, structInfo: IDENT[TATARA] } }],
    // Industry: two profiles that disagree about the same structure's rigs AND tax
    ['eveHelper.industryProfiles.v1', {
      active: 'pB',
      profiles: [
        { id: 'pA', name: 'Alpha', facilities: [facility([{ tid: RIG_T1 }], 2)],
          market: {}, shipping: {}, assumptions: {}, planning: {}, forceBuy: [], forceBuild: [] },
        { id: 'pB', name: 'Bravo', facilities: [facility([{ tid: RIG_T2 }], 3)],
          market: {}, shipping: {}, assumptions: {}, planning: {}, forceBuy: [], forceBuild: [] },
      ],
    }],
  ];
}
function facility(rigs, tax) {
  return { uid: 'f' + tax, npc: false, id: RAITARU, label: 'Test Raitaru', typeId: 35825, typeName: 'Raitaru',
    system: 30000999, systemName: 'TEST-1', security: -0.42, activities: ['man'], scope: [],
    bonuses: { me: 1, te: 15, cost: 3 }, tax, sciOverride: null, rigs };
}

async function openManager(browser, server, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, opts.storage || legacyStorage());
  await H.mockEsi(context, { skills: {}, standings: {} });
  await context.route('**/data/industry.json', route => route.fulfill(H.json(FIXTURE)));
  const page = await context.newPage();
  H.watchPage(page, 'structures');
  await page.goto(server.url + '/structures.html' + (opts.hash || ''));
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
  return { context, page, close: () => context.close() };
}

const factsOf = (page, id) => page.evaluate(i => EveStructures.facts(i), id);
const storeOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('eveHelper.structures.v1')));

H.run('structures', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    let s = await openManager(browser, server);
    const page = s.page;

    /* ---------- schema ---------- */
    section('the store bumps to the v2 schema without losing a v1 list');
    const store = await storeOf(page);
    eq('the stored blob is the v2 shape', store && store.v, 2);
    check('...carrying the structures as an array', Array.isArray(store.structures), JSON.stringify(store).slice(0, 120));
    const rec = store.structures.find(r => r.id === RAITARU);
    eq('the v1 entry keeps its identity', rec && rec.name, 'Test Raitaru');
    eq('...its system', rec.systemName, 'TEST-1');
    eq('...and gains the hull rig size from the structure map', rec.size, 'M');
    eq('...with the hull rig slot count', rec.rigSlots, 3);
    check('every managed fact exists on the record',
      'marketBroker' in rec && 'facilityTax' in rec && 'rigs' in rec && 'reproRig' in rec
      && 'industryActivities' in rec && 'notes' in rec, JSON.stringify(Object.keys(rec)));
    eq('a structure only the Mine tool knew about was created too',
      (store.structures.find(r => r.id === TATARA) || {}).name, 'Test Tatara');

    /* ---------- import ---------- */
    section('the facts the tools used to keep are imported, not dropped');
    let f = await factsOf(page, RAITARU);
    eq("Sell's owner-set broker % lands on the record", f.marketBroker, 4.5);
    eq("Industry's facility tax lands on the record", f.facilityTax, 3);
    eq('...from the ACTIVE profile, which is the most recently saved one', f.rigs.join(','), String(RIG_T2));
    const fT = await factsOf(page, TATARA);
    eq("Mine's reprocessing rig lands on the refinery record", fT.reproRig, 't2');
    eq('a hull with no stored activities gets its type default (refinery → reactions)',
      fT.industryActivities.join(','), 'rea');
    eq('...and an engineering complex gets the manufacturing set',
      f.industryActivities.join(','), 'man,inv,cop,me,te');

    section('two profiles disagreeing produce a conflict note, never a silent drop');
    eq('one note per disagreeing fact (rigs and tax)', f.conflicts.length, 2);
    const ctext = f.conflicts.map(c => c.text).join(' | ');
    check('...naming both profiles', /Alpha/.test(ctext) && /Bravo/.test(ctext), ctext);
    check('...saying which one was kept', /kept "Bravo"/.test(ctext), ctext);
    check('...covering the rigs', /rigs/.test(ctext), ctext);
    check('...and the tax', /facility tax/.test(ctext), ctext);

    /* ---------- idempotency ---------- */
    section('the import is idempotent and never clobbers a later edit');
    await page.evaluate(id => EveStructures.update(id, { marketBroker: 9.9 }), RAITARU);
    // the tools' legacy blobs are still in storage — a second import run must not read
    // them again (the marker key is what makes it a one-time move)
    await page.evaluate(() => EveStructures.migrateLegacy());
    f = await factsOf(page, RAITARU);
    eq('a re-run leaves a hand-edited rate alone', f.marketBroker, 9.9);
    eq('...and adds no further conflict notes', f.conflicts.length, 2);
    eq('...and does not duplicate any record',
      await page.evaluate(() => EveStructures.saved().length), 2);
    await page.evaluate(id => EveStructures.update(id, { marketBroker: 4.5 }), RAITARU);

    /* ---------- the manager UI ---------- */
    section('the manager lists every structure and expands one');
    eq('one card per saved structure',
      await page.evaluate(() => document.querySelectorAll('#list .st').length), 2);
    check('the card is collapsed until it is clicked',
      await page.evaluate(id => document.querySelector('#s' + id + ' .stbody').hidden, RAITARU));
    await page.click('#s' + RAITARU + ' .sthead');
    await page.waitForSelector('#s' + RAITARU + ' [data-f="marketBroker"]');
    check('the identity block is read-only text, not inputs',
      await page.evaluate(id => !document.querySelector('#s' + id + ' .ident input'), RAITARU));
    eq('the broker input shows the record value',
      await page.$eval('#s' + RAITARU + ' [data-f="marketBroker"]', el => el.value), '4.5');
    eq('...and the tax input too',
      await page.$eval('#s' + RAITARU + ' [data-f="facilityTax"]', el => el.value), '3');
    const conflictShown = await page.$eval('#s' + RAITARU + ' .conflict', el => el.textContent);
    check('the conflict note is shown on the record', /Alpha/.test(conflictShown), conflictShown);

    section('editing a fact writes it straight through to the store');
    await page.fill('#s' + RAITARU + ' [data-f="marketBroker"]', '2.5');
    await page.dispatchEvent('#s' + RAITARU + ' [data-f="marketBroker"]', 'change');
    await page.waitForFunction(id => EveStructures.facts(id).marketBroker === 2.5, RAITARU);
    eq('the broker rate is persisted', (await factsOf(page, RAITARU)).marketBroker, 2.5);
    await page.fill('#s' + RAITARU + ' [data-f="facilityTax"]', '1.25');
    await page.dispatchEvent('#s' + RAITARU + ' [data-f="facilityTax"]', 'change');
    await page.waitForFunction(id => EveStructures.facts(id).facilityTax === 1.25, RAITARU);
    eq('...and so is the facility tax', (await factsOf(page, RAITARU)).facilityTax, 1.25);
    await page.fill('#s' + RAITARU + ' [data-f="notes"]', 'ask Bravo about the tax');
    await page.dispatchEvent('#s' + RAITARU + ' [data-f="notes"]', 'change');
    await page.waitForFunction(id => /ask Bravo/.test(EveStructures.facts(id).notes), RAITARU);
    check('notes persist', true);

    section('rigs come from the size-appropriate catalog with security-adjusted %s');
    const rigSel = '#s' + RAITARU + ' [data-f="rig"]';
    eq('the record already has one rig row', await page.$$eval(rigSel, els => els.length), 1);
    const opts = await page.$$eval(rigSel + ' option', els => els.map(o => o.textContent));
    eq('...offering both M-Set catalog rigs', opts.length, 2);
    check('...by their short names', opts.every(o => /^M-Set/.test(o)), JSON.stringify(opts));
    const eff = await page.$eval('#s' + RAITARU + ' .rig .hint', el => el.textContent);
    check('the effective % is the nullsec-multiplied one (2.4 × 2.1 = 5.04)',
      /ME 5\.04%/.test(eff), eff);
    await page.selectOption(rigSel, String(RIG_T1));
    await page.waitForFunction(t => EveStructures.facts(9000001).rigs[0] === t, RIG_T1);
    eq('switching the rig is written to the record',
      (await factsOf(page, RAITARU)).rigs.join(','), String(RIG_T1));
    // "+ rig" offers a rig that is not already fitted; with both catalog rigs on, the
    // hull's remaining slot has nothing left to add
    await page.click('#s' + RAITARU + ' .rig-add');
    await page.waitForFunction(() => EveStructures.facts(9000001).rigs.length === 2);
    eq('adding a rig picks one that is not already fitted',
      (await factsOf(page, RAITARU)).rigs.join(','), RIG_T1 + ',' + RIG_T2);
    check('...and the add button stops once the catalog is exhausted',
      await page.$eval('#s' + RAITARU + ' .rig-add', el => el.disabled));

    section('activities default from the hull and can be overridden');
    await page.click('#s' + RAITARU + ' [data-act="rea"]');
    await page.waitForFunction(() => EveStructures.facts(9000001).industryActivities.includes('rea'));
    check('ticking an activity overrides the hull default',
      !(await factsOf(page, RAITARU)).activitiesAreDefault);
    await page.click('#s' + RAITARU + ' [data-act="rea"]');
    await page.waitForFunction(() => !EveStructures.facts(9000001).industryActivities.includes('rea'));
    check('...and unticking it again leaves the rest alone',
      (await factsOf(page, RAITARU)).industryActivities.join(','), 'man,inv,cop,me,te');

    section('a conflict note is dismissed by hand');
    await page.click('#s' + RAITARU + ' .conflict-dismiss');
    await page.waitForFunction(id => EveStructures.facts(id).conflicts.length === 1, RAITARU);
    eq('dismissing drops that note and keeps the other',
      (await factsOf(page, RAITARU)).conflicts.length, 1);

    section('the reprocessing rig is edited on the refinery record');
    await page.click('#s' + TATARA + ' .sthead');
    await page.waitForSelector('#s' + TATARA + ' [data-f="reproRig"]');
    eq('the select shows what the Mine tool used to store',
      await page.$eval('#s' + TATARA + ' [data-f="reproRig"]', el => el.value), 't2');
    await page.selectOption('#s' + TATARA + ' [data-f="reproRig"]', 't1');
    await page.waitForFunction(id => EveStructures.facts(id).reproRig === 't1', TATARA);
    eq('changing it is persisted', (await factsOf(page, TATARA)).reproRig, 't1');

    /* ---------- the wizard moved here ---------- */
    section('the rig-inference wizard lives on this page now');
    check('its solver is available here', await page.evaluate(() => typeof wizSolve === 'function'));
    const solved = await page.evaluate(t => {
      const rec = EveStructures.get(t.raitaru);
      const eff = D.rigs[t.t2].me * D.rigs[t.t2].sec.ns;              // 2.4 × 2.1
      const structMe = EveStructures.roleBonuses(rec.typeId).me;      // Raitaru role bonus
      const shown = IndustryEngine.matQty(1000, 1, 10, structMe, eff);
      return wizSolve({
        rec, domRigs: [[t.t1, D.rigs[t.t1]], [t.t2, D.rigs[t.t2]]], groupId: 100, act: 'man',
        baseT: 0, bpMe: 10, bpTe: 0, mats: [{ base: 1000, shown }], dur: null,
      });
    }, { raitaru: RAITARU, t1: RIG_T1, t2: RIG_T2 });
    check('a quantity produced by the T2 rig solves back to the T2 rig',
      solved.meCands.includes(RIG_T2), JSON.stringify(solved));
    check('...and not to "no rig"', !solved.meCands.includes(null), JSON.stringify(solved));
    eq('duration parsing still handles the in-game format',
      await page.evaluate(() => wizParseDur('3h 42m 10s').sec), 3 * 3600 + 42 * 60 + 10);

    section('removing a structure names where it is used');
    let dialog = '';
    page.on('dialog', d => { dialog = d.message(); d.accept(); });
    await page.click('#s' + TATARA + ' .sthead .x');
    await page.waitForFunction(id => !EveStructures.get(id), TATARA);
    check('the confirm names the Mine tool', /Mine tool/.test(dialog), dialog);
    eq('...and the record is gone',
      await page.evaluate(() => EveStructures.saved().length), 1);
    await s.close();

    /* ---------- deep link ---------- */
    section('structures.html#s<id> expands that structure on load');
    s = await openManager(browser, server, { hash: '#s' + RAITARU });
    await s.page.waitForFunction(id => {
      const b = document.querySelector('#s' + id + ' .stbody');
      return b && !b.hidden;
    }, RAITARU, { timeout: 20000 });
    check('the linked record is open', true);
    check('...and the other one is not',
      await s.page.evaluate(id => document.querySelector('#s' + id + ' .stbody').hidden, TATARA));
    await s.close();

    /* ---------- the tools read the record ---------- */
    section('the Industry page takes rigs and tax from the record, not from its profile');
    const ctx = await browser.newContext();
    await H.seedStorage(ctx, server.url, legacyStorage());
    await H.mockEsi(ctx, { skills: {}, standings: {} });
    await ctx.route('**/data/industry.json', route => route.fulfill(H.json(FIXTURE)));
    const ip = await ctx.newPage();
    H.watchPage(ip, 'industry');
    await ip.goto(server.url + '/industry.html');
    await ip.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
    const eng = await ip.evaluate(() => facilityToEngine(activeProfile().facilities[0]));
    eq('the engine facility gets the record tax', eng.tax, 3);
    eq('...and the record rig', eng.rigs.length, 1);
    check('...at its security-adjusted ME (2.4 × 2.1)', Math.abs(eng.rigs[0].me - 5.04) < 1e-9, eng.rigs[0].me);
    check('the profile no longer keeps its own rig list',
      await ip.evaluate(() => activeProfile().facilities[0].rigs === undefined),
      await ip.evaluate(() => JSON.stringify(activeProfile().facilities[0].rigs)));
    check('the rig editor is gone from the Industry page',
      await ip.evaluate(() => typeof openRigWizard === 'undefined'
        && !document.querySelector('#facList select[class], #facList .rig select')));
    check('...replaced by a link into the manager',
      await ip.evaluate(() => [...document.querySelectorAll('#facList a')].some(a => /structures\.html#s/.test(a.getAttribute('href')))));
    await ctx.close();

    /* ---------- every page offers the manager ---------- */
    section('the topbar carries a Structures tab on every page');
    for (const p of ['index.html', 'mine.html', 'industry.html', 'structures.html']) {
      const c = await browser.newContext();
      await H.mockEsi(c, { skills: {}, standings: {} });
      await c.route('**/data/industry.json', route => route.fulfill(H.json(FIXTURE)));
      const pg = await c.newPage();
      await pg.goto(server.url + '/' + p);
      const tab = await pg.evaluate(() => {
        const a = [...document.querySelectorAll('#topbar a')].find(x => x.getAttribute('href') === 'structures.html');
        return a ? { text: a.textContent, active: a.classList.contains('active') } : null;
      });
      check(p + ' links to the manager', !!tab && tab.text === 'Structures', JSON.stringify(tab));
      if (p === 'structures.html') check('...and marks it active there', tab.active);
      await c.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
