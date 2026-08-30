/* Ore-basket sourcing in industry-engine.js, as a pure module.

   The engine's buy/build tree stays priced off the book; AFTER the plan is chosen its
   reprocessable buy leaves form one basket, and the engine asks whether a compressed-ore
   purchase refined at the owner's refinery covers that basket for less than it charged.
   Every case here is hand-computed in the comments; the yield flooring comes from the
   REAL EveRefine.outputsFor so there is exactly one yield model in the test too. */
'use strict';
const path = require('path');
const H = require('./helper');
const { check, eq, near, section } = H;

const Engine = require(path.join(H.REPO, 'industry-engine.js'));
const EveRefine = require(path.join(H.REPO, 'refine.js'));

const T = { WIDGET: 1001, MIN_A: 3001, MIN_B: 3002, ORE_J: 62001, ORE_A: 62002, ORE_B: 62003 };

function baseData(mats) {
  return {
    v: 1,
    types: {
      [T.WIDGET]: ['Widget', 5, 5, 100, 200, null],
      [T.MIN_A]: ['Mineral A', 0.01, 0.01, 102, 201, null],
      [T.MIN_B]: ['Mineral B', 0.01, 0.01, 102, 201, null],
    },
    groups: { 100: ['Widgets', 6], 102: ['Minerals', 4] },
    marketGroups: { 200: ['Widgets', 0], 201: ['Minerals', 0] },
    skills: {},
    blueprints: { 9001: { limit: 30, man: { t: 1000, m: mats, p: [[T.WIDGET, 1]], s: [] } } },
  };
}

function makeEngine(over) {
  over = over || {};
  const priceTable = over.priceTable || {};
  return Engine.create({
    data: over.data || baseData([[T.MIN_A, 100]]),
    prices: tid => (priceTable[tid] !== undefined ? priceTable[tid] : null),
    adjusted: tid => (over.adjustedTable || {})[tid] || 0,
    indices: () => 0,
    profile: {
      facilities: [{ id: 'f1', label: 'Test', system: 30000142, tax: 0,
        activities: ['man'], bonuses: { me: 0, te: 0, cost: 0 }, rigs: [] }],
      market: Object.assign({ inputSide: 'sell', outputSide: 'sellOrder', brokerPct: 0, taxPct: 0 }, over.market),
      shipping: over.shipping || null,
      assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0, decryptor: null },
      planning: Object.assign({ capital: null, slots: { man: 1, science: 1, reaction: 1 } }, over.planning),
    },
    skills: { byName: {} },
    params: {},
    repro: over.repro || null,
  });
}

const ore = (cTid, name, outputs, pct, over) => Object.assign(
  { cTid, name, portion: 100, cVol: 0.15, outputs, pct }, over || {});
const reproCfg = (ores, taxPct) => ({ ores, taxPct, outputsFor: EveRefine.outputsFor });

H.run('industry-reproc', async () => {
  section('a null repro config changes nothing, and the walks are exported');
  {
    const twin = makeEngine({ priceTable: { [T.MIN_A]: { sell: 10, buy: 9 } } });
    const r = twin.evaluate(T.WIDGET, { runs: 1 });
    eq('totals carry repro: null', r.totals.repro, null);
    eq('walkSellCost is exported', typeof Engine.walkSellCost, 'function');
    eq('walkBuyRevenue is exported', typeof Engine.walkBuyRevenue, 'function');
    eq('brokerOnOrder is exported', typeof Engine.brokerOnOrder, 'function');
    eq('solveBasket is exported', typeof Engine.solveBasket, 'function');
    // the export IS the pricing rule: dry books price the remainder at the worst level
    eq('exported walkSellCost prices a dry book at the worst level',
      Engine.walkSellCost([[1, 50], [2, 30]], 100).cost, 50 * 1 + 30 * 2 + 20 * 2);
  }

  section('single ore, single mineral — every ISK hand-computed');
  {
    /* 1 run needs 100 A. Direct: A at 10/u -> 1000 charged.
       Ore J: portion 100, outputs 400 A per portion, pct 50 -> floor(400x1x0.5)=200 A.
       Ore book 1/u -> 100 units cost 100. Tax 5% on 200 A at adjusted 9 -> 90.
       planCost 190 < 1000 -> active, savings 810; costPerItem (1000-810)/1 = 190. */
    const e = makeEngine({
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.ORE_J]: { sell: 1, buy: 0.5, sellLevels: [[1, 1e6, 1]] },
      },
      adjustedTable: { [T.MIN_A]: 9 },
      repro: reproCfg([ore(T.ORE_J, 'Compressed Testite', [[T.MIN_A, 400]], 50)], 5),
    });
    const r = e.evaluate(T.WIDGET, { runs: 1 });
    const rp = r.totals.repro;
    check('the route is adopted', rp && rp.active, JSON.stringify(rp && rp.why));
    eq('the basket is the 100 A the tree charged for', JSON.stringify(rp.basket),
      JSON.stringify([{ tid: T.MIN_A, qty: 100, charged: 1000 }]));
    eq('one mix line: one whole portion of the ore', JSON.stringify(rp.mix[0]),
      JSON.stringify({ cTid: T.ORE_J, name: 'Compressed Testite', portions: 1, units: 100,
        cost: 100, m3: 100 * 0.15, thin: null }));
    eq('no residual buys', rp.residuals.length, 0);
    eq('the joint excess is listed', JSON.stringify(rp.excess),
      JSON.stringify([{ tid: T.MIN_A, qty: 100 }]));
    near('tax = 5% of floored outputs at adjusted', rp.tax, 0.05 * 200 * 9, 1e-9);
    near('planCost = ore + tax', rp.planCost, 190, 1e-9);
    near('savings = direct - plan', rp.savings, 810, 1e-9);
    near('...and Cost/Item embeds exactly that', r.totals.costPerItem, 190, 1e-9);
    near('...and so does capital', r.totals.capitalUsed, 190, 1e-9);
    // the excess is valued at the buy book net of seller tax, and NOT credited
    near('excess instant value: 100 A at buy 9, no seller tax', rp.excessInstantValue, 900, 1e-9);
    check('...which is not inside planCost', Math.abs(rp.planCost - 190) < 1e-9, String(rp.planCost));
  }

  section('joint production beats per-mineral greedy — the reason this is an LP');
  {
    /* Needs 100 A + 100 B. Directs at 100/u each -> direct 20000.
       oreJ: 200A+200B per portion, 100 units at 50/u = 5000.
       oreA: 250A per portion, 100 units at 20/u = 2000. oreB: 250B at 49/u = 4900.
       Greedy per mineral: oreA + oreB = 6900. Joint optimum: oreJ alone = 5000. */
    const e = makeEngine({
      data: baseData([[T.MIN_A, 100], [T.MIN_B, 100]]),
      priceTable: {
        [T.MIN_A]: { sell: 100, buy: 90, sellLevels: [[100, 1e6, 1]] },
        [T.MIN_B]: { sell: 100, buy: 90, sellLevels: [[100, 1e6, 1]] },
        [T.ORE_J]: { sell: 50, buy: 1, sellLevels: [[50, 1e6, 1]] },
        [T.ORE_A]: { sell: 20, buy: 1, sellLevels: [[20, 1e6, 1]] },
        [T.ORE_B]: { sell: 49, buy: 1, sellLevels: [[49, 1e6, 1]] },
      },
      repro: reproCfg([
        ore(T.ORE_J, 'Joint', [[T.MIN_A, 200], [T.MIN_B, 200]], 100),
        ore(T.ORE_A, 'Single A', [[T.MIN_A, 250]], 100),
        ore(T.ORE_B, 'Single B', [[T.MIN_B, 250]], 100),
      ], 0),
    });
    const rp = e.evaluate(T.WIDGET, { runs: 1 }).totals.repro;
    check('adopted', rp.active, rp.why);
    eq('the mix is the joint ore alone', JSON.stringify(rp.mix.map(m => [m.cTid, m.units])),
      JSON.stringify([[T.ORE_J, 100]]));
    near('at the joint optimum, not the greedy 6900', rp.planCost, 5000, 1e-9);
    near('savings vs the charged 20000', rp.savings, 15000, 1e-9);
  }

  section('hybrid: the ore covers what it is good at, the rest stays a direct buy');
  {
    /* Needs 1000 A + 100 B. oreJ 200A+200B/portion at 100 units x 30/u = 3000/portion.
       1 portion covers all B (+100 excess... no, exactly 200 -> covers 100 B, 100 excess B)
       and 200 A; remaining 800 A direct at 10/u = 8000 < 4 more portions (12000).
       Optimal: 1 portion (3000) + 800 A direct (8000) = 11000 vs direct 10x1000+100x100
       = 20000. */
    const e = makeEngine({
      data: baseData([[T.MIN_A, 1000], [T.MIN_B, 100]]),
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.MIN_B]: { sell: 100, buy: 90, sellLevels: [[100, 1e6, 1]] },
        [T.ORE_J]: { sell: 30, buy: 1, sellLevels: [[30, 1e6, 1]] },
      },
      repro: reproCfg([ore(T.ORE_J, 'Joint', [[T.MIN_A, 200], [T.MIN_B, 200]], 100)], 0),
    });
    const rp = e.evaluate(T.WIDGET, { runs: 1 }).totals.repro;
    check('adopted', rp.active, rp.why);
    eq('one portion of ore', rp.mix[0].units, 100);
    eq('the residual is 800 A', JSON.stringify(rp.residuals.map(x => [x.tid, x.qty])),
      JSON.stringify([[T.MIN_A, 800]]));
    // the residual leg is priced by the very walk buyQuote uses
    near('...at exactly walkSellCost of that quantity', rp.residuals[0].cost,
      Engine.walkSellCost([[10, 1e6, 1]], 800).cost, 1e-9);
    near('planCost 3000 + 8000', rp.planCost, 11000, 1e-9);
    eq('the excess B is listed', JSON.stringify(rp.excess),
      JSON.stringify([{ tid: T.MIN_B, qty: 100 }]));
  }

  section('depth and thin books flow through the ore legs like any other input');
  {
    /* Ore book [[1,50],[2,30]] runs dry for 100 units: 50+60+2x20 = 150, thin 80/100. */
    const e = makeEngine({
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.ORE_J]: { sell: 1, buy: 0.5, sellLevels: [[1, 50, 1], [2, 30, 1]] },
      },
      repro: reproCfg([ore(T.ORE_J, 'Thin ore', [[T.MIN_A, 400]], 50)], 0),
    });
    const rp = e.evaluate(T.WIDGET, { runs: 1 }).totals.repro;
    check('adopted', rp.active, rp.why);
    near('the ore leg is walkSellCost of 100 units on that book', rp.mix[0].cost, 150, 1e-9);
    eq('...and carries the thin flag', JSON.stringify(rp.mix[0].thin),
      JSON.stringify({ filled: 80, needed: 100 }));
  }

  section('a 1-unit basket still buys a whole portion — reprocessing eats portions');
  {
    const e = makeEngine({
      data: baseData([[T.MIN_A, 1]]),
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.ORE_J]: { sell: 0.01, buy: 0.005, sellLevels: [[0.01, 1e6, 1]] },
      },
      repro: reproCfg([ore(T.ORE_J, 'Cheap', [[T.MIN_A, 400]], 50)], 0),
    });
    const rp = e.evaluate(T.WIDGET, { runs: 1 }).totals.repro;
    check('adopted', rp.active, rp.why);
    eq('a whole 100-unit portion, never a fraction', rp.mix[0].units, 100);
    eq('excess 199 of 200 refined', JSON.stringify(rp.excess), JSON.stringify([{ tid: T.MIN_A, qty: 199 }]));
    near('planCost is the 1 ISK portion', rp.planCost, 1, 1e-9);
  }

  section('...and when the whole portion is dearer than the residual, it is dropped');
  {
    /* Need 1 A. Ore portion costs 100x2=200 -> worse than 10 direct. The LP wants a
       fraction; the integerizer prices ceil (200) vs floor+residual (10), keeps 10 —
       and 10 is NOT < 10 charged, so the route is reported, not adopted. */
    const e = makeEngine({
      data: baseData([[T.MIN_A, 1]]),
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.ORE_J]: { sell: 2, buy: 1, sellLevels: [[2, 1e6, 1]] },
      },
      repro: reproCfg([ore(T.ORE_J, 'Dear', [[T.MIN_A, 400]], 50)], 0),
    });
    const r = e.evaluate(T.WIDGET, { runs: 1 });
    const rp = r.totals.repro;
    eq('not adopted', rp.active, false);
    eq('...with the reason', rp.why, 'ore route dearer');
    near('...and the plan it lost with is the all-residual one', rp.planCost, 10, 1e-9);
    near('Cost/Item stays the market figure', r.totals.costPerItem, 10, 1e-9);
  }

  section('the equivalence pin: an uncompetitive route changes NOTHING');
  {
    const mk = repro => makeEngine({
      data: baseData([[T.MIN_A, 100], [T.MIN_B, 100]]),
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.MIN_B]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.WIDGET]: { sell: 5000, buy: 4000 },
        [T.ORE_J]: { sell: 1e6, buy: 1, sellLevels: [[1e6, 1e6, 1]] },
      },
      shipping: { base: 1000, perM3: 100, collateralPct: 0.01, maxHaulM3: 1e6,
        applyInbound: true, applyOutbound: true },
      repro,
    });
    const off = mk(null).evaluate(T.WIDGET, { runs: 3 });
    const lost = mk(reproCfg([ore(T.ORE_J, 'Absurd', [[T.MIN_A, 400]], 50)], 0))
      .evaluate(T.WIDGET, { runs: 3 });
    for (const k of ['costPerItem', 'capitalUsed', 'shippingIn', 'shippingOut', 'profitPerItem'])
      near('losing route leaves ' + k + ' identical', lost.totals[k], off.totals[k], 1e-9);
    eq('...and says why it lost', lost.totals.repro.why, 'ore route dearer');
    // no candidate at all (the ore yields something outside the basket)
    const noCand = mk(reproCfg([ore(T.ORE_J, 'OffBasket', [[T.MIN_A, 400], [9999, 10]], 50)], 0))
      .evaluate(T.WIDGET, { runs: 3 });
    near('no-candidate route leaves costPerItem identical', noCand.totals.repro && off.totals.costPerItem,
      noCand.totals.costPerItem, 1e-9);
    eq('...with the reason', noCand.totals.repro.why, 'no candidate ore');
  }

  section('an unset tax is a refusal upstream — the engine treats null as OFF');
  {
    const e = makeEngine({
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.ORE_J]: { sell: 0.01, buy: 0.005, sellLevels: [[0.01, 1e6, 1]] },
      },
      repro: { ores: [ore(T.ORE_J, 'X', [[T.MIN_A, 400]], 50)], taxPct: null,
               outputsFor: EveRefine.outputsFor },
    });
    eq('taxPct null disables the whole path — 0 is never assumed',
      e.evaluate(T.WIDGET, { runs: 1 }).totals.repro, null);
  }

  section('tax can be exactly what kills the route');
  {
    const mk = taxPct => makeEngine({
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.ORE_J]: { sell: 2, buy: 1, sellLevels: [[2, 1e6, 1]] },
      },
      adjustedTable: { [T.MIN_A]: 10 },
      repro: reproCfg([ore(T.ORE_J, 'Taxed', [[T.MIN_A, 400]], 50)], taxPct),
    });
    /* 100 A needed: ore 100u x 2 = 200 + tax% x 200 out x 10 adj; direct 1000.
       At 5% the taxed ore column (2 + 0.05x400x0.5x10/100 = 3/u) beats direct 10/u.
       At 45% the column costs 2+9 = 11/u > 10/u — the LP itself walks away from the
       ore (the tax lives in the objective, not just the gate) and the losing plan it
       reports is the all-direct one at the charged 1000, tying, never beating. */
    const lo = mk(5).evaluate(T.WIDGET, { runs: 1 }).totals.repro;
    check('at 5% the route wins', lo.active, lo.why);
    near('...at ore + tax', lo.planCost, 200 + 0.05 * 200 * 10, 1e-9);
    const hi = mk(45).evaluate(T.WIDGET, { runs: 1 }).totals.repro;
    eq('at 45% it loses', hi.active, false);
    near('...because the LP already refused the taxed ore', hi.planCost, 1000, 1e-9);
    eq('...buying no ore at all', hi.mix.length, 0);
  }

  section('an unpriced mineral stays unpriced — no NaN, no invented rescue');
  {
    const mk = repro => makeEngine({
      data: baseData([[T.MIN_A, 100], [T.MIN_B, 100]]),
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.MIN_B]: null,                                    // no market at all
        [T.ORE_J]: { sell: 1, buy: 0.5, sellLevels: [[1, 1e6, 1]] },
      },
      repro,
    });
    const off = mk(null).evaluate(T.WIDGET, { runs: 1 });
    const on = mk(reproCfg([ore(T.ORE_J, 'J', [[T.MIN_A, 400], [T.MIN_B, 400]], 50)], 0))
      .evaluate(T.WIDGET, { runs: 1 });
    check('cost stays Infinity in both — the row reads unpriced either way',
      !isFinite(off.totals.costPerItem) && !isFinite(on.totals.costPerItem),
      off.totals.costPerItem + ' / ' + on.totals.costPerItem);
    check('nothing is NaN', !Number.isNaN(on.totals.costPerItem) && !Number.isNaN(on.totals.capitalUsed));
    check('the unpriced mineral is flagged rescuable, advisory only',
      on.totals.repro && on.totals.repro.rescuable.includes(T.MIN_B),
      JSON.stringify(on.totals.repro && on.totals.repro.rescuable));
    check('...and the ore was excluded (its B output is outside the priceable basket)',
      on.totals.repro.why === 'no candidate ore', on.totals.repro.why);
  }

  section('the inbound haul is re-sized for ore volume, at the real shipLeg formula');
  {
    /* Same adopted case as the first section, with shipping on. Basket m3: 100 A x 0.01
       = 1; ore m3: 100 x 0.15 = 15. Collateral moves from 1000 to 190. */
    const mk = repro => makeEngine({
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e6, 1]] },
        [T.ORE_J]: { sell: 1, buy: 0.5, sellLevels: [[1, 1e6, 1]] },
      },
      adjustedTable: { [T.MIN_A]: 9 },
      shipping: { base: 100, perM3: 10, collateralPct: 0.02, maxHaulM3: 1e6,
        applyInbound: true, applyOutbound: false },
      repro,
    });
    const off = mk(null).evaluate(T.WIDGET, { runs: 1 });
    const on = mk(reproCfg([ore(T.ORE_J, 'J', [[T.MIN_A, 400]], 50)], 5)).evaluate(T.WIDGET, { runs: 1 });
    const rp = on.totals.repro;
    check('adopted', rp.active, rp.why);
    near('shipping off-route: base + 1m3 + 2% of 1000', off.totals.shippingIn, 100 + 10 + 20, 1e-9);
    near('shipping on-route: base + 15m3 + 2% of 190', on.totals.shippingIn, 100 + 150 + 0.02 * 190, 1e-9);
    near('the displayed haul shift IS that difference', rp.haulShiftCost,
      on.totals.shippingIn - off.totals.shippingIn, 1e-9);
    near('...and the m3 shift matches', rp.haulShiftM3, 15 - 1, 1e-9);
    near('Cost/Item = materials - savings + shipIn', on.totals.costPerItem,
      1000 - rp.savings + on.totals.shippingIn, 1e-9);
    near('capitalUsed = build - savings + shipIn', on.totals.capitalUsed,
      1000 - rp.savings + on.totals.shippingIn, 1e-9);
  }

  section('capital shrink sizes against market-direct — conservative by construction');
  {
    /* Widget run costs 1000 at market. Capital 2500 -> 2 runs at market sizing, even
       though the ore route would afford more; the adopted totals still carry savings. */
    const e = makeEngine({
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[10, 1e7, 1]] },
        [T.ORE_J]: { sell: 1, buy: 0.5, sellLevels: [[1, 1e7, 1]] },
        [T.WIDGET]: { sell: 5000, buy: 4000 },
      },
      planning: { capital: 2500, slots: { man: 1, science: 1, reaction: 1 } },
      repro: reproCfg([ore(T.ORE_J, 'J', [[T.MIN_A, 400]], 50)], 0),
    });
    const r = e.evaluate(T.WIDGET, {});
    check('the batch was capital-shrunk on market prices', r.totals.batch.capitalLimited
      && r.produced <= 2, r.produced + ' units');
    check('...and the final totals still carry the ore savings',
      r.totals.repro.active && r.totals.capitalUsed < 2500 - 1,
      r.totals.capitalUsed);
  }

  section('determinism: identical runs, identical plans');
  {
    const mk = () => makeEngine({
      data: baseData([[T.MIN_A, 700], [T.MIN_B, 300]]),
      priceTable: {
        [T.MIN_A]: { sell: 10, buy: 9, sellLevels: [[9, 200, 1], [10, 1e6, 1]] },
        [T.MIN_B]: { sell: 20, buy: 18, sellLevels: [[20, 1e6, 1]] },
        [T.ORE_J]: { sell: 6, buy: 3, sellLevels: [[5, 150, 1], [6, 1e6, 1]] },
        [T.ORE_A]: { sell: 4, buy: 2, sellLevels: [[4, 1e6, 1]] },
      },
      adjustedTable: { [T.MIN_A]: 9, [T.MIN_B]: 18 },
      repro: reproCfg([
        ore(T.ORE_J, 'J', [[T.MIN_A, 200], [T.MIN_B, 100]], 60),
        ore(T.ORE_A, 'A', [[T.MIN_A, 300]], 60),
      ], 3),
    });
    const a = mk().evaluate(T.WIDGET, { runs: 1 }).totals.repro;
    const b = mk().evaluate(T.WIDGET, { runs: 1 }).totals.repro;
    eq('two identical evaluations produce byte-identical plans',
      JSON.stringify(a), JSON.stringify(b));
  }

  section('the LP is fast enough to run per row');
  {
    // 8 ores x 40 levels + 6 minerals x 40 levels, one solve
    const rows = [], cols = [];
    for (let m = 0; m < 6; m++) rows.push({ tid: 5000 + m, need: 10000 + m * 777 });
    for (let o = 0; o < 8; o++) {
      const a = {};
      for (let m = 0; m < 6; m++) if ((o + m) % 2 === 0) a[5000 + m] = 1 + (o % 3);
      for (let L = 0; L < 40; L++)
        cols.push({ key: `o${o}:${L}`, cost: 10 + L + o, u: 500, a });
      cols.push({ key: `o${o}:t`, cost: 49 + o + 1, u: Infinity, a });
    }
    for (let m = 0; m < 6; m++) {
      for (let L = 0; L < 40; L++)
        cols.push({ key: `d${m}:${L}`, cost: 30 + L, u: 800, a: { [5000 + m]: 1 } });
      cols.push({ key: `d${m}:t`, cost: 70, u: Infinity, a: { [5000 + m]: 1 } });
    }
    Engine.solveBasket(rows.slice(0, 2), cols.slice(0, 90));   // JIT warmup — steady-state is what runs per row
    const t0 = process.hrtime.bigint();
    const sol = Engine.solveBasket(rows, cols);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check('a full-size solve returns', !!sol, 'null');
    check('...in under 50ms (' + ms.toFixed(1) + 'ms)', ms < 50, ms + 'ms');
  }

  section('solveBasket vs brute force on small joint cases');
  {
    let lcg = 42;
    const rnd = () => ((lcg = (lcg * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let worse = 0, nulls = 0;
    for (let t = 0; t < 60; t++) {
      const minerals = [34, 35, 36].slice(0, 1 + Math.floor(rnd() * 3));
      const rows = minerals.map(tid => ({ tid, need: Math.floor(rnd() * 900) + 100 }));
      const nOre = 1 + Math.floor(rnd() * 3);
      const cols = [], oreDefs = [];
      for (let o = 0; o < nOre; o++) {
        const a = {};
        for (const tid of minerals) if (rnd() < 0.8) a[tid] = Math.floor(rnd() * 4) + 1;
        if (!Object.keys(a).length) a[minerals[0]] = 2;
        const p1 = 1 + rnd() * 10, v1 = Math.floor(rnd() * 300) + 50;
        const p2 = p1 * (1 + rnd()), v2 = Math.floor(rnd() * 300) + 50;
        cols.push({ key: `o${o}:0`, cost: p1, u: v1, a });
        cols.push({ key: `o${o}:1`, cost: p2, u: v2, a });
        cols.push({ key: `o${o}:t`, cost: p2, u: Infinity, a });
        oreDefs.push({ a, price: q => {
          let c2 = 0, r = q, tk;
          tk = Math.min(r, v1); c2 += tk * p1; r -= tk;
          tk = Math.min(r, v2); c2 += tk * p2; r -= tk;
          if (r > 0) c2 += r * p2;
          return c2;
        } });
      }
      const dPrice = {};
      for (const tid of minerals) {
        dPrice[tid] = 5 + rnd() * 30;
        cols.push({ key: `d${tid}`, cost: dPrice[tid], u: Infinity, a: { [tid]: 1 } });
      }
      const sol = Engine.solveBasket(rows, cols);
      if (!sol) { nulls++; continue; }
      let best = Infinity;
      const loop = (oi, units) => {
        if (oi === oreDefs.length) {
          let cost = 0;
          for (let k = 0; k < oreDefs.length; k++) cost += units[k] > 0 ? oreDefs[k].price(units[k]) : 0;
          for (const rw of rows) {
            let got = 0;
            for (let k = 0; k < oreDefs.length; k++) got += (oreDefs[k].a[rw.tid] || 0) * units[k];
            cost += Math.max(0, rw.need - got) * dPrice[rw.tid];
          }
          if (cost < best) best = cost;
          return;
        }
        for (let u = 0; u <= 1248; u += 24) { units.push(u); loop(oi + 1, units); units.pop(); }
      };
      loop(0, []);
      if (sol.cost > best + 1e-6) worse++;
    }
    eq('no case ever solved worse than a brute-force grid', worse, 0);
    eq('...and none returned null', nulls, 0);
  }
});
