/* The Industry page end to end, against a hand-written data/industry.json fixture.

   data/industry.json is gitignored and built from the EVE SDE at deploy time, so it is
   normally absent from a checkout. Rather than depend on a ~100 MB SDE download, the
   fetch is intercepted and served a small SDE-shaped fixture — enough blueprints to
   produce a table, a drilldown with both BUY and BUILD nodes, and a force-buy toggle
   that visibly moves the cost. */
'use strict';
const H = require('./helper');
const { check, eq, near, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };

const T = {
  WIDGET: 1001,     // product, built from plates
  GADGET: 1002,     // product, built straight from mineral
  PLATE: 2001,      // buildable intermediate
  MINERAL: 3001,
};
const SYSTEM = 30000142;

/* SDE-shaped fixture: types[tid] = [name, volume, packagedVolume, groupId, marketGroupId, metaGroupId] */
const FIXTURE = {
  v: 'test-fixture',
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
  blueprints: {
    9001: { limit: 20, man: { t: 1200, m: [[T.PLATE, 4]], p: [[T.WIDGET, 1]], s: [] } },
    9002: { limit: 20, man: { t: 900, m: [[T.MINERAL, 300]], p: [[T.GADGET, 1]], s: [] } },
    9003: { limit: 50, man: { t: 400, m: [[T.MINERAL, 100]], p: [[T.PLATE, 1]], s: [] } },
  },
};

/* An order book in the page's IndexedDB shape: types[tid] = {s:[[p,v,minv]…asc], b:[…desc]} */
const BOOK = {
  fetched: Date.now(),
  pages: 1,
  typeCount: 4,
  types: {
    [T.WIDGET]: { s: [[900000, 500, 1]], b: [[700000, 500, 1]] },
    [T.GADGET]: { s: [[50000, 500, 1]], b: [[40000, 500, 1]] },
    // a plate costs 120,000 on the market but only ~100,000 to build from mineral
    [T.PLATE]: { s: [[120000, 5000, 1]], b: [[90000, 5000, 1]] },
    [T.MINERAL]: { s: [[1000, 1e6, 1]], b: [[900, 1e6, 1]] },
  },
};
const ADJUSTED = { fetched: Date.now(), map: { [T.WIDGET]: 800000, [T.GADGET]: 45000, [T.PLATE]: 110000, [T.MINERAL]: 950 } };
const INDICES = { fetched: Date.now(), map: { [SYSTEM]: { man: 0.02, rea: 0.01, inv: 0.02, cop: 0.02, me: 0.02, te: 0.02 } } };

function profileStore() {
  return {
    active: 'p1',
    profiles: [{
      id: 'p1', name: 'Test',
      facilities: [{
        uid: 'f1', label: 'Test Raitaru', system: SYSTEM, tax: 1,
        activities: ['man', 'rea', 'inv', 'cop', 'me', 'te'],
        bonuses: { me: 1, te: 15, cost: 3 }, rigs: [],
      }],
      market: {
        auto: false, inputSide: 'sell', outputSide: 'sellOrder',
        brokerPct: 1.5, taxPct: 3.37, buyerBrokerPct: 1.5,
        buyerChar: CHAR.id, sellerChar: CHAR.id, manufChar: CHAR.id,
      },
      shipping: { base: 10000000, perM3: 653.4, collateralPct: 1, roundUp: true, inbound: false, outbound: false },
      assumptions: { ownedBpoMe: 10, ownedBpoTe: 20, decryptor: null, sccPct: 4 },
      planning: { capital: null, slots: { man: 1, science: 1, reaction: 1 }, demandCapPct: 100, maxHaulM3: 350000 },
      forceBuy: [], forceBuild: [],
    }],
  };
}

async function openIndustry(browser, server) {
  const context = await browser.newContext();
  await H.seedStorage(context, server.url, [
    ['eveHelper.auth.v1', H.authState([CHAR])],
    ['eveHelper.industryProfiles.v1', profileStore()],
  ]);
  await H.mockEsi(context, { skills: { accounting: 5, brokerRelations: 5 }, standings: {} });
  // the fixture stands in for the CI-built static data
  await context.route('**/data/industry.json', route => route.fulfill(H.json(FIXTURE)));
  const page = await context.newPage();
  H.watchPage(page, 'industry');
  await page.goto(server.url + '/industry.html');
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 20000 });
  // loadCaches() restores book/adjusted/indices from IndexedDB after the static data lands
  // and overwrites each with `x || null` — writing the fixtures before that restore lands
  // gets them clobbered back to null. renderAges() fills #dataAges at the tail of
  // loadCaches: that is the page's own marker that the restore is done.
  await page.waitForFunction(() => document.getElementById('dataAges').children.length > 0,
    null, { timeout: 20000 });
  // hand the page its ESI datasets directly — the real Update button would hit the network
  await page.evaluate(d => {
    book = d.book; adjusted = d.adjusted; indices = d.indices;
  }, { book: BOOK, adjusted: ADJUSTED, indices: INDICES });
  return { context, page, close: () => context.close() };
}

const rowsOf = page => page.evaluate(() => state.rows.map(r => ({
  tid: r.tid, name: r.name, cost: r.cost, profit: r.profit, unpriced: r.unpriced,
})));

H.run('industry-ui', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    const s = await openIndustry(browser, server);
    const page = s.page;

    /* ---------- static data ---------- */
    section('the page loads its static data');
    const status = await page.$eval('#sdeStatus', el => ({ text: el.textContent, cls: el.className }));
    eq('data/industry.json loads without error', status.cls, 'ok');
    check('...and the status line names the fixture', /test-fixture/.test(status.text), status.text);
    eq('the blueprint index is built', await page.evaluate(() => productToBp.size), 3);
    eq('...and only market-grouped products are offered', await page.evaluate(() => PRODUCTS.length), 3);

    /* ---------- facility migration ----------
       Structure facilities are references into the central store now, so a profile row
       that never named a structure has nothing to reference. It carries all its own facts,
       which is exactly what an NPC station is here — it must become one rather than lose
       them, and every number below still has to come out of those facts. */
    section('a self-contained legacy facility keeps its facts as an NPC station');
    const fac0 = await page.evaluate(() => activeProfile().facilities[0]);
    check('a facility that referenced no structure is marked NPC', fac0.npc === true, JSON.stringify(fac0));
    eq('...keeping its own label', fac0.label, 'Test Raitaru');
    eq('...its owner-set tax', fac0.tax, 1);
    eq('...and its role bonuses', fac0.bonuses.me + '/' + fac0.bonuses.te + '/' + fac0.bonuses.cost, '1/15/3');
    const fac0Eng = await page.evaluate(() => facilityToEngine(activeProfile().facilities[0]));
    eq('the engine is fed that tax', fac0Eng.tax, 1);
    eq('...and those bonuses', fac0Eng.bonuses.te, 15);

    /* ---------- compute ---------- */
    section('a profile computes the table');
    eq('the seeded profile is active', await page.evaluate(() => activeProfile().name), 'Test');
    eq('...with its facility', await page.evaluate(() => activeProfile().facilities.length), 1);
    await page.click('#btnCompute');
    // computeAll sets the status class last — wait on that, not on rows appearing
    await page.waitForFunction(
      () => document.getElementById('compStatus').className === 'ok' && state.rows.length > 0,
      null, { timeout: 20000 });
    const compStatus = await page.$eval('#compStatus', el => ({ text: el.textContent, cls: el.className }));
    eq('the compute finishes cleanly', compStatus.cls, 'ok');
    let rows = await rowsOf(page);
    eq('every product got a row', rows.length, 3);
    const widget = rows.find(r => r.tid === T.WIDGET);
    check('the product is priced', !widget.unpriced, JSON.stringify(widget));
    check('...with a real cost per item', widget.cost > 0, widget.cost);
    const domRows = await page.evaluate(() => document.querySelectorAll('#tblBody tr:not(.drill)').length);
    eq('the table renders one row per product', domRows, 3);

    /* ---------- drilldown ---------- */
    section('the drilldown renders buy and build nodes');
    await page.evaluate(tid => toggleDrill(tid), T.WIDGET);
    await page.waitForFunction(() => !!document.querySelector('tr.drill'));
    const drill = await page.evaluate(() => {
      const tr = document.querySelector('tr.drill');
      return {
        badges: [...tr.querySelectorAll('.badge')].map(b => b.textContent.trim()),
        names: [...tr.querySelectorAll('.nm')].map(n => n.textContent),
        stats: tr.querySelector('.dsummary') ? tr.querySelector('.dsummary').textContent : '',
        batch: tr.querySelector('.batchpanel') ? tr.querySelector('.batchpanel').textContent : '',
      };
    });
    check('the drilldown shows the cost summary', /cost\/item/.test(drill.stats), drill.stats);
    check('...and the batch panel', /batch/.test(drill.batch), drill.batch);
    check('...and the broker fee line (the 100 ISK floor lives behind it)',
      /broker fee/.test(drill.stats), drill.stats);
    check('the tree names the intermediate', drill.names.some(n => /Plate/.test(n)), JSON.stringify(drill.names));
    check('...and the raw material', drill.names.some(n => /Mineral/.test(n)), JSON.stringify(drill.names));
    check('the tree carries BUILD nodes', drill.badges.some(b => /BUILD/.test(b)), JSON.stringify(drill.badges));
    check('...and BUY nodes', drill.badges.some(b => /BUY/.test(b)), JSON.stringify(drill.badges));
    // the plate is cheaper to build (100k of mineral) than to buy (120k), so it builds
    const plateDecision = await page.evaluate(tid => {
      const res = evalOne(tid, null);
      const plate = res.tree.children.find(n => n.name === 'Test Plate');
      return { decision: plate.decision, buyCost: plate.buyCost, buildCost: plate.buildCost };
    }, T.WIDGET);
    eq('a plate cheaper to build than to buy is built', plateDecision.decision, 'build');
    check('...because its build cost really is lower',
      plateDecision.buildCost < plateDecision.buyCost,
      plateDecision.buildCost + ' vs ' + plateDecision.buyCost);

    /* ---------- force-buy ----------
       The row's plan is refined asynchronously: an IntersectionObserver calls needHist(),
       which fetches history and then re-plans the batch against real demand (refineRow).
       That lands whenever it lands and changes cost/item substantially — with this
       fixture demand is 0, which collapses the batch from 20 runs to 1. Comparing a cost
       captured before that refinement with one captured after is a coin flip, which is
       exactly how this assertion used to fail.

       So: drive the refinement to its FIXED POINT first. needHist() is idempotent, so
       calling it explicitly removes the dependency on scroll position, and refineRow's
       own no-op guard (row.planDemand === histMem.get(tid).demand) is the deterministic
       signal that no further async re-plan can occur. After that every capture below is
       taken in the same state. */
    section('the force-buy toggle changes the cost');
    await page.evaluate(tid => needHist(tid), T.WIDGET);
    await page.waitForFunction(tid => {
      const h = histMem.get(tid);
      if (!h || h === 'loading') return false;
      const r = state.rows.find(x => x.tid === tid);
      return !!r && r.planDemand === h.demand;      // refineRow is now a no-op: settled
    }, T.WIDGET, { timeout: 20000 });

    const costBefore = (await rowsOf(page)).find(r => r.tid === T.WIDGET).cost;
    await page.evaluate(t => setForce(t.root, t.node, 'buy'), { root: T.WIDGET, node: T.PLATE });
    // setForce -> recomputeOne is synchronous, but assert the observable end state rather
    // than assuming it: the profile carries the force AND the row has been re-planned
    await page.waitForFunction(t => {
      const r = state.rows.find(x => x.tid === t.root);
      return activeProfile().forceBuy.includes(t.node) && r && r.cost !== t.before;
    }, { root: T.WIDGET, node: T.PLATE, before: costBefore }, { timeout: 20000 });
    const costAfter = (await rowsOf(page)).find(r => r.tid === T.WIDGET).cost;
    check('forcing the intermediate to BUY raises the cost',
      costAfter > costBefore, costBefore + ' -> ' + costAfter);
    eq('...and the profile remembers the force',
      await page.evaluate(() => activeProfile().forceBuy.join(',')), String(T.PLATE));
    // the drilldown is rebuilt by render(); wait for the forced badge to actually appear
    await page.waitForFunction(() => {
      const tr = document.querySelector('tr.drill');
      return !!tr && [...tr.querySelectorAll('.badge')].some(b => /⚑/.test(b.textContent));
    }, null, { timeout: 20000 });
    check('...and the tree marks the node as forced', true);

    await page.evaluate(t => setForce(t.root, t.node, 'auto'), { root: T.WIDGET, node: T.PLATE });
    await page.waitForFunction(t => {
      const r = state.rows.find(x => x.tid === t.root);
      return activeProfile().forceBuy.length === 0 && r && r.cost !== t.forced;
    }, { root: T.WIDGET, forced: costAfter }, { timeout: 20000 });
    const costBack = (await rowsOf(page)).find(r => r.tid === T.WIDGET).cost;
    near('clearing the force restores the original cost', costBack, costBefore, 1e-6);
    eq('...and empties the profile list',
      await page.evaluate(() => activeProfile().forceBuy.length), 0);

    /* ---------- fees reach the engine ---------- */
    section('the profile fees reach the engine');
    const fees = await page.evaluate(tid => {
      const r = evalOne(tid, null);
      return { salesTax: r.totals.salesTax, brokerFee: r.totals.brokerFee, produced: r.produced };
    }, T.GADGET);
    check('a sell-order plan pays sales tax', fees.salesTax > 0, fees.salesTax);
    check('...and a broker fee', fees.brokerFee > 0, fees.brokerFee);
    check('...never below the 100 ISK per-order floor', fees.brokerFee >= 100, fees.brokerFee);

    await s.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
