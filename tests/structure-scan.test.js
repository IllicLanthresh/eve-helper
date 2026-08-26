/* Paste a ship scan, get the rigs.

   The in-game ship scanner reads a structure's fit without ownership. Its readout is
   section headers over bare type names; the Structure Manager's "paste scan…" turns the
   Rig Slots section into the record's rig list (and the reprocessing tier, whose rigs
   are deliberately not in the industry catalog). Services are reported, never applied —
   which activities a service enables is not data this page holds. */
'use strict';
const H = require('./helper');
const { check, eq, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };
const SOTIYO = 1035000000021, TATARA = 1035000000022;

/* the three XL manufacturing-efficiency rigs the owner's real scan listed */
const RIG_EQUIP = 46001, RIG_SHIP = 46002, RIG_STRUCT = 46003, RIG_SMALL = 46004;
const SEC_RIG = { hs: 1, ls: 1.9, ns: 2.1 };
const FIT = [1657, 1404, 1406];
const IND_FIXTURE = {
  v: 'structure-scan-fixture',
  types: {}, groups: {}, marketGroups: {}, skills: {}, blueprints: {},
  rigs: {
    [RIG_EQUIP]: { n: 'Standup XL-Set Equipment and Consumable Manufacturing Efficiency I',
      sz: 'XL', me: 2, te: 0, cost: 0, sec: SEC_RIG, scope: [100], act: ['man'], fit: FIT,
      dom: 'Equipment and Consumables' },
    [RIG_SHIP]: { n: 'Standup XL-Set Ship Manufacturing Efficiency I',
      sz: 'XL', me: 2, te: 0, cost: 0, sec: SEC_RIG, scope: [101], act: ['man'], fit: FIT,
      dom: 'Ships' },
    [RIG_STRUCT]: { n: 'Standup XL-Set Structure and Component Manufacturing Efficiency I',
      sz: 'XL', me: 2, te: 0, cost: 0, sec: SEC_RIG, scope: [102], act: ['man'], fit: FIT,
      dom: 'Structures and Components' },
    [RIG_SMALL]: { n: 'Standup M-Set Basic Small Ship Manufacturing Material Efficiency I',
      sz: 'M', me: 2, te: 0, cost: 0, sec: SEC_RIG, scope: [103], act: ['man'], fit: FIT,
      dom: 'Basic Small Ships' },
  },
  structures: {
    35827: ['Sotiyo', 1404, 'XL', 3],
    35836: ['Tatara', 1406, 'L', 3],
  },
};

/* the owner's scan, verbatim */
const SCAN = [
  'High Power Slots',
  'Standup Anticapital Missile Launcher II',
  'Standup Anticapital Missile Launcher II',
  'Standup Anticapital Missile Launcher II',
  'Standup Point Defense Battery II',
  'Standup XL Energy Neutralizer II',
  'Standup XL Energy Neutralizer II',
  'Medium Power Slots',
  'Standup Cap Battery II',
  'Standup Energy Neutralization Burst Projector',
  'Standup Target Painter II',
  'Standup Target Painter II',
  'Low Power Slots',
  'Standup Ballistic Control System II',
  'Standup Ballistic Control System II',
  'Standup Ballistic Control System II',
  'Rig Slots',
  'Standup XL-Set Equipment and Consumable Manufacturing Efficiency I',
  'Standup XL-Set Ship Manufacturing Efficiency I',
  'Standup XL-Set Structure and Component Manufacturing Efficiency I',
  'Service Slots',
  'Standup Capital Shipyard I',
  'Standup Cloning Center I',
  'Standup Manufacturing Plant I',
].join('\n');

const rec = (id, name, typeId, extra) => Object.assign({
  id, name, typeId, systemId: 30000999, systemName: 'TEST-1', security: -0.42,
  regionId: 10000999, refinery: typeId === 35836 ? 'tatara' : null,
  marketBroker: null, facilityTax: null, rigs: [], reproRig: 'none',
  roleBonus: null, industryActivities: null, notes: '', conflicts: [],
}, extra || {});

async function openManager(browser, server, records) {
  const context = await browser.newContext();
  await H.seedStorage(context, null, [
    ['eveHelper.auth.v1', H.authState([CHAR])],
    ['eveHelper.structures.v1', { v: 2, structures: records }],
  ]);
  await H.mockEsi(context, { skills: {}, standings: {} });
  await context.route('**/data/industry.json', r => r.fulfill(H.json(IND_FIXTURE)));
  await context.route('**/data/ores.json', r => r.fulfill(H.json({ v: 'x', ores: {}, names: {}, types: {} })));
  const page = await context.newPage();
  H.watchPage(page, 'scan');
  await page.goto(server.url + '/structures.html');
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null
    && document.getElementById('sdeStatus').className === 'ok', null, { timeout: 20000 });
  return { context, page, close: () => context.close() };
}

const expand = async (page, id) => {
  await page.click('#s' + id + ' .sthead');
  await page.waitForSelector('#s' + id + ' .stbody:not([hidden])');
};
const openScan = async (page, id) => {
  await page.click('#s' + id + ' .scan-open');
  await page.waitForSelector('#s' + id + ' .scanrow:not([hidden])');
};
const pasteScan = async (page, id, text) => {
  await page.fill('#s' + id + ' .scanrow textarea', text);
  // fill dispatches input; the status line is written synchronously from that event
};
const scanStat = (page, id) => page.$eval('#s' + id + ' .scan-stat', el => el.textContent);
const factsOf = (page, id) => page.evaluate(i => EveStructures.facts(i), id);
const storedRec = (page, id) => page.evaluate(i => {
  const s = JSON.parse(localStorage.getItem('eveHelper.structures.v1') || 'null');
  return ((s && s.structures) || []).find(r => r.id === i) || null;
}, id);

H.run('structure-scan', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    section('the parser on its own');
    {
      const s = await openManager(browser, server, [rec(SOTIYO, 'Test Sotiyo', 35827)]);
      const u = await s.page.evaluate(t => {
        const p = parseStructureScan(t);
        return { rig: p.rigs, svc: p.services, headerless: p.headerless };
      }, SCAN);
      eq('the rig section is three lines', u.rig.length, 3);
      eq('...the right three', u.rig[1], 'Standup XL-Set Ship Manufacturing Efficiency I');
      eq('the service section is three lines', u.svc.length, 3);
      eq('headers were seen', u.headerless, false);

      const h = await s.page.evaluate(() => parseStructureScan(
        'Standup XL-Set Ship Manufacturing Efficiency I\nStandup XL-Set Structure and Component Manufacturing Efficiency I'));
      eq('a headerless paste is taken as the rig list', h.rigs.length, 2);
      check('...and says so', h.headerless === true);

      const m = await s.page.evaluate(t => matchScanRigs(parseStructureScan(t).rigs), SCAN);
      eq('all three rigs match the catalog', m.rigs.join(','), [RIG_EQUIP, RIG_SHIP, RIG_STRUCT].join(','));
      eq('nothing unknown in the rig section', m.unknown.length, 0);
      eq('no reprocessing rig in this scan', m.repro, null);

      const r2 = await s.page.evaluate(() => matchScanRigs([
        'Standup L-Set Reprocessing Monitor II', 'Standup Mystery Doohickey I']));
      eq('a reprocessing rig becomes the T2 tier', r2.repro, 't2');
      eq('...T1 from the I mark', (await s.page.evaluate(() =>
        matchScanRigs(['Standup L-Set Reprocessing Monitor I']).repro)), 't1');
      eq('a name the catalog lacks is reported, not guessed', r2.unknown.join(','), 'Standup Mystery Doohickey I');
      await s.close();
    }

    section('the paste flow, end to end');
    {
      const s = await openManager(browser, server, [
        rec(SOTIYO, 'Test Sotiyo', 35827, { rigs: [RIG_SMALL] })]);
      await expand(s.page, SOTIYO);
      await openScan(s.page, SOTIYO);
      await pasteScan(s.page, SOTIYO, SCAN);
      eq('the status counts what the paste holds',
        await scanStat(s.page, SOTIYO), '3 rigs matched · 3 services (not applied)');
      check('apply is armed', !await s.page.$eval('#s' + SOTIYO + ' .scan-apply', el => el.disabled));
      await s.page.click('#s' + SOTIYO + ' .scan-apply');
      await s.page.waitForFunction((args) =>
        EveStructures.facts(args[0]).rigs.join(',') === args[1],
        [SOTIYO, [RIG_EQUIP, RIG_SHIP, RIG_STRUCT].join(',')]);
      const f = await factsOf(s.page, SOTIYO);
      eq('the scan REPLACES the rigs, not appends', f.rigs.join(','),
        [RIG_EQUIP, RIG_SHIP, RIG_STRUCT].join(','));
      const st = await storedRec(s.page, SOTIYO);
      eq('...and it persisted', st.rigs.join(','), [RIG_EQUIP, RIG_SHIP, RIG_STRUCT].join(','));
      eq('reproRig untouched when the scan has none', st.reproRig, 'none');
      await s.close();
    }

    section('a refinery scan sets the reprocessing tier');
    {
      const s = await openManager(browser, server, [rec(TATARA, 'Test Tatara', 35836)]);
      await expand(s.page, TATARA);
      await openScan(s.page, TATARA);
      await pasteScan(s.page, TATARA,
        'Rig Slots\nStandup L-Set Reprocessing Monitor II\nService Slots\nStandup Reprocessing Facility I');
      eq('the status names the tier',
        await scanStat(s.page, TATARA), 'reprocessing rig T2 · 1 service (not applied)');
      await s.page.click('#s' + TATARA + ' .scan-apply');
      await s.page.waitForFunction(id => EveStructures.facts(id).reproRig === 't2', TATARA);
      const f = await factsOf(s.page, TATARA);
      eq('the tier landed', f.reproRig, 't2');
      eq('the rig list stayed empty — the monitor is a tier, not a catalog rig',
        f.rigs.length, 0);
      await s.close();
    }

    section('a combat-fitted structure is a real scan the catalog cannot hold');
    {
      const s = await openManager(browser, server, [rec(SOTIYO, 'Test Sotiyo', 35827)]);
      await expand(s.page, SOTIYO);
      await openScan(s.page, SOTIYO);
      await pasteScan(s.page, SOTIYO,
        'Rig Slots\nStandup XL-Set Ballistic Extension I\nStandup XL-Set Ballistic Extension I');
      eq('the unknowns are counted, deduped is NOT applied to unknowns',
        await scanStat(s.page, SOTIYO), '2 not in the industry catalog');
      check('apply stays disabled — nothing representable',
        await s.page.$eval('#s' + SOTIYO + ' .scan-apply', el => el.disabled));
      await s.close();
    }

    section('garbage stays inert');
    {
      const s = await openManager(browser, server, [rec(SOTIYO, 'Test Sotiyo', 35827)]);
      await expand(s.page, SOTIYO);
      await openScan(s.page, SOTIYO);
      await pasteScan(s.page, SOTIYO, 'a shopping list\nmilk\neggs');
      check('nothing recognized is said in so many words',
        /nothing recognized/.test(await scanStat(s.page, SOTIYO)));
      check('apply stays disabled', await s.page.$eval('#s' + SOTIYO + ' .scan-apply', el => el.disabled));
      const f = await factsOf(s.page, SOTIYO);
      eq('the record never moved', f.rigs.length, 0);
      await s.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
