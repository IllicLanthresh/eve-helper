/* industry-engine.js as a pure module — no browser, no fixture file.

   The engine takes all of its data through callbacks, so every case here builds the
   smallest SDE-shaped object that exercises one rule. Numbers are worked out by hand in
   the comments so a failure says which rule broke, not just that a total moved. */
'use strict';
const path = require('path');
const H = require('./helper');
const { check, eq, near, section } = H;

const Engine = require(path.join(H.REPO, 'industry-engine.js'));

/* ---------- fixture builders ---------- */

// type ids used throughout
const T = {
  WIDGET: 1001,        // the product
  PLATE: 2001,         // a buildable intermediate
  MINERAL: 3001,       // a raw input
  MINERAL_B: 3002,
  T2_WIDGET: 1002,     // invented product
  DATACORE: 4001,
  ATTAINMENT: 34201,   // 'Attainment Decryptor'
  PARITY: 34204,       // 'Parity Decryptor'
};

function baseData(over) {
  const data = {
    v: 1,
    types: {
      [T.WIDGET]: ['Widget', 5, 5, 100, 200, null],
      [T.PLATE]: ['Plate', 2, 2, 101, 200, null],
      [T.MINERAL]: ['Mineral', 0.01, 0.01, 102, 201, null],
      [T.MINERAL_B]: ['Mineral B', 0.01, 0.01, 102, 201, null],
      [T.T2_WIDGET]: ['Widget II', 5, 5, 100, 200, null],
      [T.DATACORE]: ['Datacore', 0.1, 0.1, 103, 202, null],
      [T.ATTAINMENT]: ['Attainment Decryptor', 0.1, 0.1, 104, 203, null],
      [T.PARITY]: ['Parity Decryptor', 0.1, 0.1, 104, 203, null],
    },
    groups: { 100: ['Widgets', 6], 101: ['Plates', 6], 102: ['Minerals', 4] },
    marketGroups: { 200: ['Widgets', 0], 201: ['Minerals', 0], 202: ['Datacores', 0], 203: ['Decryptors', 0] },
    skills: { 3380: 'Industry', 3388: 'Advanced Industry' },
    blueprints: {
      // Widget: 100 Mineral -> 1 Widget, 1000s/run, max 30 runs
      9001: { limit: 30, man: { t: 1000, m: [[T.MINERAL, 100]], p: [[T.WIDGET, 1]], s: [] } },
      // Plate: 50 Mineral -> 1 Plate
      9002: { limit: 30, man: { t: 500, m: [[T.MINERAL, 50]], p: [[T.PLATE, 1]], s: [] } },
    },
  };
  return Object.assign(data, over || {});
}

function facility(over) {
  return Object.assign({
    id: 'f1', label: 'Test Raitaru', system: 30000142, tax: 0,
    activities: ['man', 'rea', 'inv', 'cop', 'me', 'te'],
    bonuses: { me: 0, te: 0, cost: 0 },
    rigs: [],
  }, over || {});
}

function makeEngine(over) {
  over = over || {};
  const priceTable = over.priceTable || {};
  return Engine.create({
    data: over.data || baseData(),
    prices: tid => (priceTable[tid] !== undefined ? priceTable[tid] : null),
    adjusted: tid => (over.adjustedTable || {})[tid] || 0,
    indices: () => (over.costIndex != null ? over.costIndex : 0),
    profile: Object.assign({
      facilities: [facility(over.facility)],
      market: Object.assign({ inputSide: 'sell', outputSide: 'sellOrder', brokerPct: 0, taxPct: 0 }, over.market),
      shipping: over.shipping || null,
      assumptions: Object.assign({ ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0, decryptor: null }, over.assumptions),
      planning: Object.assign({ capital: null, slots: { man: 1, science: 1, reaction: 1 } }, over.planning),
    }, over.profile),
    skills: over.skills || { byName: {} },
    params: over.params || {},
  });
}

H.run('industry-engine', async () => {
  /* ================= material quantity: ME rounding ================= */
  section('material quantity — max(R, ceil(round(base x R x mods, 2)))');
  {
    // reach matQty through the public API: 1 run of Widget at various ME
    const cases = [
      { me: 0, runs: 1, expect: 100 },      // 100 x 1
      { me: 10, runs: 1, expect: 90 },      // 90 exactly
      { me: 10, runs: 3, expect: 270 },
      { me: 2, runs: 1, expect: 98 },
      { me: 1, runs: 1, expect: 99 },
    ];
    for (const c of cases) {
      const e = makeEngine({ assumptions: { ownedBpoMe: c.me, ownedBpoTe: 0 }, priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } } });
      const r = e.evaluate(T.WIDGET, { runs: c.runs });
      const mineral = r.tree.children.find(n => n.tid === T.MINERAL);
      eq('ME ' + c.me + ' over ' + c.runs + ' run(s) needs ' + c.expect + ' mineral', mineral.qty, c.expect);
    }

    // the round-to-2-decimals-FIRST rule: base 1 at ME 10 over 3 runs is 2.7 -> ceil 3
    const d = baseData();
    d.blueprints[9001].man.m = [[T.MINERAL, 1]];
    let e = makeEngine({ data: d, assumptions: { ownedBpoMe: 10, ownedBpoTe: 0 }, priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } } });
    eq('base 1 at ME 10 over 3 runs -> ceil(2.7) = 3',
      e.evaluate(T.WIDGET, { runs: 3 }).tree.children[0].qty, 3);

    // the floor: never fewer units than runs
    e = makeEngine({ data: d, assumptions: { ownedBpoMe: 10, ownedBpoTe: 0 }, priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } } });
    eq('a material can never drop below one unit per run',
      e.evaluate(T.WIDGET, { runs: 10 }).tree.children[0].qty, 10);

    // THE 0.01 edge: rounding to 2 decimals BEFORE the ceil is what keeps this at 3.
    // 3.0000000000000004 (floating point) would ceil to 4 without the pre-round.
    const d2 = baseData();
    d2.blueprints[9001].man.m = [[T.MINERAL, 10]];
    // 10 x 1 x (1-0.70) = 3.0000000000000004 in IEEE754
    e = makeEngine({ data: d2, assumptions: { ownedBpoMe: 70, ownedBpoTe: 0 }, priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } } });
    eq('the 0.01 edge: 10 at ME 70 rounds to 3.00 and ceils to 3 (not 4)',
      e.evaluate(T.WIDGET, { runs: 1 }).tree.children[0].qty, 3);

    // structure + rig ME stack multiplicatively with blueprint ME
    e = makeEngine({
      assumptions: { ownedBpoMe: 10, ownedBpoTe: 0 },
      facility: { bonuses: { me: 1, te: 0, cost: 0 }, rigs: [{ match: null, me: 2, te: 0, cost: 0 }] },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } },
    });
    // 100 x 0.90 x 0.99 x 0.98 = 87.318 -> 87.32 -> ceil 88
    eq('blueprint/structure/rig ME multiply: 100 -> 88',
      e.evaluate(T.WIDGET, { runs: 1 }).tree.children[0].qty, 88);
  }

  /* ================= job cost decomposition ================= */
  section('job installation cost');
  {
    // EIV = 100 mineral x adjusted 10 = 1000 for one run.
    // cost index 5% -> gross 50; structure cost bonus 3% and rig 2% stack
    // multiplicatively: combined = 1-(0.97 x 0.98) = 0.0494 -> bonus -2.47 (index only).
    // SCC 4% of EIV = 40, facility tax 1% of EIV = 10.  total = 50-2.47+40+10 = 97.53
    const e = makeEngine({
      adjustedTable: { [T.MINERAL]: 10 },
      costIndex: 0.05,
      assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 4 },
      facility: { tax: 1, bonuses: { me: 0, te: 0, cost: 3 }, rigs: [{ match: null, me: 0, te: 0, cost: 2 }] },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } },
    });
    const job = e.evaluate(T.WIDGET, { runs: 1 }).tree.job;
    near('EIV = sum(qty x adjusted price)', job.eiv, 1000, 1e-9);
    near('the cost index applies to EIV', job.costBreakdown.sciGross, 50, 1e-9);
    near('structure + rig cost bonuses stack multiplicatively, on the INDEX part only',
      job.costBreakdown.bonus, -(50 * (1 - 0.97 * 0.98)), 1e-9);
    near('the SCC surcharge is a flat % of EIV, unreduced', job.costBreakdown.scc, 40, 1e-9);
    near('the facility tax is a flat % of EIV, unreduced', job.costBreakdown.tax, 10, 1e-9);
    const total = job.costBreakdown.sciGross + job.costBreakdown.bonus + job.costBreakdown.scc + job.costBreakdown.tax;
    near('the four parts add up to the installation cost', total, 97.53, 1e-9);
    check('the structure bonus never touches SCC or tax',
      job.costBreakdown.scc === 40 && job.costBreakdown.tax === 10);
  }

  section('job cost base for copy/invention is 2% of EIV');
  {
    // Widget II is invented from the Widget blueprint. The invention job's base is
    // 0.02 x EIV(T1 manufacturing materials, 1 run) = 0.02 x 1000 = 20.
    // index 10% -> gross 2; structure 3% + rig 2% -> combined 4.94% of the index part;
    // SCC 0 and tax 0 here, so the invention job costs 2 x (1-0.0494) = 1.9012.
    const d = baseData();
    d.types[T.T2_WIDGET] = ['Widget II', 5, 5, 100, 200, null];
    d.blueprints[9001].inv = { t: 3600, m: [[T.DATACORE, 2]], p: [[9003, 1, 0.30]], s: [] };
    d.blueprints[9001].cop = { t: 480 };
    d.blueprints[9003] = { limit: 10, man: { t: 2000, m: [[T.MINERAL, 200]], p: [[T.T2_WIDGET, 1]], s: [] } };
    const e = makeEngine({
      data: d,
      adjustedTable: { [T.MINERAL]: 10 },
      costIndex: 0.10,
      assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0, decryptor: null },
      facility: { tax: 0, bonuses: { me: 0, te: 0, cost: 3 }, rigs: [{ match: null, me: 0, te: 0, cost: 2 }] },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 }, [T.DATACORE]: { sell: 100, buy: 90 } },
    });
    const r = e.evaluate(T.T2_WIDGET, { runs: 1 });
    check('the T2 product resolves through invention', !!r.tree.invention, JSON.stringify(r.tree.invention));
    const inv = r.tree.invention;
    // per attempt: 2 datacores x 100 = 200, plus TWO jobs whose base is 2% of the same
    // EIV (the invention job and the copy that feeds it), each 20 x 0.10 x (1-0.0494)
    const jobEach = 20 * 0.10 * (0.97 * 0.98);
    const perAttempt = 200 + 2 * jobEach;
    near('cost per success = per-attempt cost / chance, with the 2%-of-EIV job base',
      inv.costPerSuccess, perAttempt / 0.30, 1e-6);
    near('invention chance = base probability x skill multiplier (no skills here)', inv.chance, 0.30, 1e-12);
    near('attempts per success is 1/chance', inv.attemptsPerSuccess, 1 / 0.30, 1e-12);
  }

  /* ================= invention chance and decryptor auto-pick ================= */
  section('invention chance and decryptor auto-pick');
  {
    const d = baseData();
    d.skills[3403] = 'Hacking';                 // datacore skill
    d.skills[21790] = 'Gallente Encryption Methods';
    d.blueprints[9001].inv = { t: 3600, m: [[T.DATACORE, 2]], p: [[9003, 1, 0.30]], s: [[21790, 1], [3403, 1]] };
    d.blueprints[9001].cop = { t: 480 };
    d.blueprints[9003] = { limit: 10, man: { t: 2000, m: [[T.MINERAL, 200]], p: [[T.T2_WIDGET, 1]], s: [] } };

    // encryption 5 -> +5/40, datacore skill 5 -> +5/30; 0.30 x (1 + 0.125 + 0.16667)
    let e = makeEngine({
      data: d, adjustedTable: { [T.MINERAL]: 10 }, costIndex: 0,
      assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0, decryptor: null },
      skills: { byName: { 'Gallente Encryption Methods': 5, Hacking: 5 } },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 }, [T.DATACORE]: { sell: 100, buy: 90 } },
    });
    let r = e.evaluate(T.T2_WIDGET, { runs: 1 });
    near('encryption adds level/40 and each datacore skill level/30 to the multiplier',
      r.tree.invention.chance, 0.30 * (1 + 5 / 40 + 5 / 30), 1e-12);
    eq('with no decryptor configured, none is used', r.tree.invention.decryptor, null);
    eq('the invented BPC carries the blueprint base runs', r.tree.invention.bpcRuns, 1);
    eq('...with the standard invented ME 2', r.tree.invention.me, 2);
    eq('...and TE 4', r.tree.invention.te, 4);

    // auto mode: the engine picks the decryptor giving the cheapest build. Only two
    // decryptors are priced, so the choice is between them and using none.
    const priced = {
      [T.MINERAL]: { sell: 1, buy: 1 }, [T.DATACORE]: { sell: 100, buy: 90 },
      [T.ATTAINMENT]: { sell: 10, buy: 9 },
      [T.PARITY]: { sell: 10, buy: 9 },
    };
    const withDecryptor = name => makeEngine({
      data: d, adjustedTable: { [T.MINERAL]: 10 }, costIndex: 0,
      assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0, decryptor: name },
      skills: { byName: { 'Gallente Encryption Methods': 5, Hacking: 5 } },
      priceTable: priced,
    }).evaluate(T.T2_WIDGET, { runs: 1 });

    r = withDecryptor('auto');
    const opts = r.tree.invention.options || [];
    check('auto mode considers several decryptor options', opts.length >= 2, opts.length);
    check('...including the no-decryptor option', opts.some(o => o.decryptor === null), JSON.stringify(opts.map(o => o.decryptor)));
    // the pick must actually be the cheapest — compare against pinning each candidate
    const pinned = [null, 'Attainment Decryptor', 'Parity Decryptor']
      .map(n => ({ name: n, cost: withDecryptor(n).totals.costPerItem }));
    const cheapest = pinned.reduce((a, b) => (b.cost < a.cost ? b : a));
    near('...and the auto pick costs exactly what the cheapest pinned choice costs',
      r.totals.costPerItem, cheapest.cost, 1e-9);
    eq('...which here is the Attainment Decryptor (x1.8 chance, +4 runs, -1 ME)',
      r.tree.invention.decryptor, 'Attainment Decryptor');
    near('the picked decryptor multiplies the chance',
      r.tree.invention.chance, 0.30 * (1 + 5 / 40 + 5 / 30) * 1.8, 1e-12);
    eq('...and adds its run bonus to the BPC', r.tree.invention.bpcRuns, 1 + 4);
    eq('...and its ME modifier', r.tree.invention.me, 2 - 1);
    check('...beating the option the engine did not pick',
      pinned.find(p => p.name === 'Parity Decryptor').cost > cheapest.cost,
      JSON.stringify(pinned));

    // pinning a decryptor by name overrides the auto pick
    e = makeEngine({
      data: d, adjustedTable: { [T.MINERAL]: 10 }, costIndex: 0,
      assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0, decryptor: 'Attainment Decryptor' },
      skills: { byName: { 'Gallente Encryption Methods': 5, Hacking: 5 } },
      priceTable: {
        [T.MINERAL]: { sell: 1, buy: 1 }, [T.DATACORE]: { sell: 100, buy: 90 },
        [T.ATTAINMENT]: { sell: 10, buy: 9 }, [T.PARITY]: { sell: 10, buy: 9 },
      },
    });
    r = e.evaluate(T.T2_WIDGET, { runs: 1 });
    eq('a named decryptor is used verbatim', r.tree.invention.decryptor, 'Attainment Decryptor');
    near('...with its 1.8x chance multiplier',
      r.tree.invention.chance, 0.30 * (1 + 5 / 40 + 5 / 30) * 1.8, 1e-12);
    eq('...its -1 ME', r.tree.invention.me, 2 - 1);

    // noInvention prices the root straight off the blueprint
    r = e.evaluate(T.T2_WIDGET, { runs: 1, noInvention: true });
    check('noInvention skips the invention overhead entirely', !r.tree.invention, JSON.stringify(r.tree.invention));
  }

  /* ================= buy vs build ================= */
  section('buy vs build flips when a price crosses build cost');
  {
    // Plate builds from 50 mineral at 1 ISK = 50 ISK (no job fee here).
    const mk = platePrice => makeEngine({
      data: (() => {
        const d = baseData();
        d.blueprints[9001].man.m = [[T.PLATE, 2]];
        return d;
      })(),
      costIndex: 0,
      adjustedTable: {},
      assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 }, [T.PLATE]: { sell: platePrice, buy: platePrice * 0.9 } },
    });
    let plate = mk(80).evaluate(T.WIDGET, { runs: 1 }).tree.children[0];
    eq('an expensive market plate is built', plate.decision, 'build');
    near('...at the cost of its own materials', plate.buildCost, 100, 1e-9);
    plate = mk(40).evaluate(T.WIDGET, { runs: 1 }).tree.children[0];
    eq('a cheap market plate is bought instead', plate.decision, 'buy');
    near('...at the market price', plate.buyCost, 80, 1e-9);
    plate = mk(50).evaluate(T.WIDGET, { runs: 1 }).tree.children[0];
    eq('at exactly build cost the tie goes to buying', plate.decision, 'buy');

    // force flags override the economics in both directions
    const e = mk(40);
    let forced = e.evaluate(T.WIDGET, { runs: 1, forceBuild: new Set([T.PLATE]) }).tree.children[0];
    eq('forceBuild overrides a cheaper market price', forced.decision, 'build');
    eq('...and says so', forced.forced, 'build');
    forced = mk(80).evaluate(T.WIDGET, { runs: 1, forceBuy: new Set([T.PLATE]) }).tree.children[0];
    eq('forceBuy overrides a cheaper build', forced.decision, 'buy');
    eq('...and says so', forced.forced, 'buy');
    check('a force-bought node grows no children', forced.children.length === 0, forced.children.length);

    // maxDepth cuts the build branch and marks it
    const capped = mk(80).evaluate(T.WIDGET, { runs: 1, maxDepth: 1 }).tree.children[0];
    eq('maxDepth stops the recursion', capped.decision, 'buy');
    check('...and flags the node', capped.depthCapped === true, JSON.stringify(capped));
  }

  /* ================= depth-aware input walking ================= */
  section('depth-aware input walking and the thin-book flag');
  {
    const priceTable = {
      [T.MINERAL]: {
        sell: 1, buy: 0.9,
        // 40 at 1, 40 at 2, then dry
        sellLevels: [[1, 40, 1], [2, 40, 1]],
      },
    };
    let e = makeEngine({ costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 }, priceTable });
    // 1 run needs 100 mineral: 40x1 + 40x2 = 120, then 20 short priced at the worst
    // filled level (2) = 40 -> 160 total
    let node = e.evaluate(T.WIDGET, { runs: 1 }).tree.children[0];
    near('the sell book is walked level by level', node.buyCost, 160, 1e-9);
    check('a book that runs dry flags the node', !!node.thinBook, JSON.stringify(node.thinBook));
    eq('...saying how much it could fill', node.thinBook.filled, 80);
    eq('...against how much was needed', node.thinBook.needed, 100);

    // a book deep enough leaves no flag
    priceTable[T.MINERAL].sellLevels = [[1, 40, 1], [2, 200, 1]];
    e = makeEngine({ costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 }, priceTable });
    node = e.evaluate(T.WIDGET, { runs: 1 }).tree.children[0];
    near('a deep book fills exactly', node.buyCost, 40 * 1 + 60 * 2, 1e-9);
    check('...with no thin-book flag', !node.thinBook, JSON.stringify(node.thinBook));

    // without levels the scalar quote is used unchanged
    e = makeEngine({ costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      priceTable: { [T.MINERAL]: { sell: 3, buy: 2 } } });
    near('without depth data the scalar sell quote applies',
      e.evaluate(T.WIDGET, { runs: 1 }).tree.children[0].buyCost, 300, 1e-9);
  }

  /* ================= the 100 ISK per-order broker floor ================= */
  section('flat 100 ISK minimum broker fee per order (engine side)');
  {
    // input side: buying on buy orders. 100 mineral at 1 ISK = 100 ISK of material;
    // a 1% buyer broker would be 1 ISK, so the 100 ISK floor binds.
    let e = makeEngine({
      costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      market: { inputSide: 'buy', outputSide: 'sellOrder', buyerBrokerPct: 1, sellerBrokerPct: 0, sellerTaxPct: 0 },
      priceTable: { [T.MINERAL]: { sell: 2, buy: 1 } },
    });
    near('a tiny material buy order pays the 100 ISK floor, not 1% of 100 ISK',
      e.evaluate(T.WIDGET, { runs: 1 }).tree.children[0].buyCost, 100 + 100, 1e-9);

    // the same order, large enough that the percentage wins
    e = makeEngine({
      costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      market: { inputSide: 'buy', outputSide: 'sellOrder', buyerBrokerPct: 1, sellerBrokerPct: 0, sellerTaxPct: 0 },
      priceTable: { [T.MINERAL]: { sell: 2000, buy: 1000 } },
    });
    near('a large material buy order pays the percentage',
      e.evaluate(T.WIDGET, { runs: 1 }).tree.children[0].buyCost, 100000 * 1.01, 1e-6);

    // output side: the batch's own sell order
    const sellSide = (widgetPrice, runs) => makeEngine({
      costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      market: { inputSide: 'sell', outputSide: 'sellOrder', sellerBrokerPct: 1, sellerTaxPct: 0 },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 }, [T.WIDGET]: { sell: widgetPrice, buy: widgetPrice * 0.8 } },
    }).evaluate(T.WIDGET, { runs: runs });
    let r = sellSide(1000, 1);          // one widget at 1000 -> 1% = 10, floor 100 wins
    near('a tiny batch sell order pays the 100 ISK floor', r.totals.brokerFee, 100, 1e-9);
    r = sellSide(1000, 30);             // 30 widgets at 1000 = 30000 -> 1% = 300
    near('a big batch sell order pays the percentage', r.totals.brokerFee, 300, 1e-9);
    near('...and the revenue per unit nets tax and broker off the gross',
      r.totals.revenuePerItem, (30000 - 300) / 30, 1e-9);

    // an INSTANT sale pays no broker at all, floor included
    r = makeEngine({
      costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      market: { inputSide: 'sell', outputSide: 'instant', sellerBrokerPct: 1, sellerTaxPct: 0 },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 }, [T.WIDGET]: { sell: 1000, buy: 800 } },
    }).evaluate(T.WIDGET, { runs: 1 });
    eq('selling into a buy order pays no broker fee at all', r.totals.brokerFee, 0);
  }

  /* ================= shipping ================= */
  section('shipping — ceil-to-million(10,000,000 + 653.4 x m3 + 1% x collateral)');
  {
    const shipping = { base: 10000000, perM3: 653.4, collateralPct: 0.01, roundUpToMillion: true,
                       applyInbound: true, applyOutbound: false };
    // 1 run = 100 mineral at 0.01 m3 = 1 m3, cost 100 ISK
    // 10,000,000 + 653.4 + 1 = 10,000,654.4 -> ceil to 11,000,000
    let e = makeEngine({ costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      shipping, priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } } });
    let r = e.evaluate(T.WIDGET, { runs: 1 });
    near('one haul: base + per-m3 + collateral, rounded up to the million',
      r.totals.shippingIn, 11000000, 1e-6);
    eq('...as a single haul', r.totals.batch.hauls.in.count, 1);

    // THE regression: a batch of 100 units of a 5 m3 item pays the base ONCE.
    // Inbound ships the INPUTS (100 x 100 mineral = 10,000 units x 0.01 m3 = 100 m3):
    // 10,000,000 + 65,340 + 100 = 10,065,440 -> 11,000,000 over 100 units = 110,000/unit.
    e = makeEngine({ costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      planning: { capital: null, slots: { man: 1, science: 1, reaction: 1 } },
      shipping, priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } } });
    r = e.evaluate(T.WIDGET, { runs: 100 });
    eq('a 100-unit batch still ships as ONE haul', r.totals.batch.hauls.in.count, 1);
    near('...paying the base once, not once per unit', r.totals.shippingIn, 11000000, 1e-6);
    near('...so per-item shipping is ~110k, not ~11M', r.totals.shippingInPerItem, 110000, 1e-6);
    check('...which is three orders of magnitude below the per-item base',
      r.totals.shippingInPerItem < shipping.base / 50, r.totals.shippingInPerItem);

    // haul splitting: cargo above maxHaulM3 becomes several contracts, each paying base
    e = makeEngine({ costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      planning: { capital: null, maxHaulM3: 50, slots: { man: 1, science: 1, reaction: 1 } },
      shipping, priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } } });
    r = e.evaluate(T.WIDGET, { runs: 100 });   // 100 m3 of inputs, 50 m3 per haul
    eq('cargo over the haul limit splits into contracts', r.totals.batch.hauls.in.count, 2);
    // each haul: 10,000,000 + 653.4x50 + 1%x5,000 = 10,032,720 -> 11,000,000 each
    near('...each paying its own base', r.totals.shippingIn, 22000000, 1e-6);
    near('...evenly split by m3', r.totals.batch.hauls.in.m3, 100, 1e-9);

    // outbound uses the product volume and the gross revenue as collateral
    e = makeEngine({ costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      shipping: Object.assign({}, shipping, { applyInbound: false, applyOutbound: true }),
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 }, [T.WIDGET]: { sell: 1e6, buy: 9e5 } } });
    r = e.evaluate(T.WIDGET, { runs: 10 });    // 10 widgets x 5 m3 = 50 m3, 10M collateral
    near('outbound ships the product volume and insures the revenue',
      r.totals.shippingOut, Math.ceil((10000000 + 653.4 * 50 + 0.01 * 10e6) / 1e6) * 1e6, 1e-6);

    // no rounding when the profile says so
    e = makeEngine({ costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      shipping: Object.assign({}, shipping, { roundUpToMillion: false }),
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 } } });
    near('rounding to the million is optional',
      e.evaluate(T.WIDGET, { runs: 1 }).totals.shippingIn, 10000000 + 653.4 + 1, 1e-6);
  }

  /* ================= the batch planner ================= */
  section('batch planner — runs x jobs bounded separately');
  {
    const base = {
      costIndex: 0, assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 0 },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 }, [T.WIDGET]: { sell: 10000, buy: 9000 } },
    };
    // 1000 s/run -> 86400/1000 = 86 runs by the 24h soft cap, but the blueprint limit is 30
    let r = makeEngine(Object.assign({}, base, {
      planning: { capital: null, slots: { man: 4, science: 1, reaction: 1 } },
    })).evaluate(T.WIDGET, {});
    eq('R is capped by the blueprint run limit', r.totals.batch.runs, 30);
    eq('J comes from the manufacturing slots', r.totals.batch.jobs, 4);
    eq('...so the batch is R x J runs', r.runs, 120);
    eq('...producing R x J x qtyPerRun units', r.produced, 120);

    // the ~24h soft cap when the blueprint allows more
    const dLong = baseData();
    dLong.blueprints[9001].limit = 1000;
    dLong.blueprints[9001].man.t = 10000;    // 8.64 runs fit in 24h
    r = makeEngine(Object.assign({}, base, {
      data: dLong, planning: { capital: null, slots: { man: 2, science: 1, reaction: 1 } },
    })).evaluate(T.WIDGET, {});
    eq('a generous blueprint limit falls back to the ~24h soft cap', r.totals.batch.runs, 8);

    // demand cap shrinks J
    r = makeEngine(Object.assign({}, base, {
      planning: { capital: null, demandCapPct: 100, slots: { man: 8, science: 1, reaction: 1 } },
    })).evaluate(T.WIDGET, { demandPerDay: 200 });
    // one slot sustains 86400/1000 = 86.4 units/day, so 200/86.4 = 2 slots
    eq('demand caps the number of parallel jobs', r.totals.batch.jobs, 2);
    check('...and says demand is the bottleneck', r.totals.batch.demandLimited === true);
    eq('...naming it in the bottleneck field', r.totals.batch.bottleneck, 'demand');

    // demand below even one continuous slot becomes a single daily job
    r = makeEngine(Object.assign({}, base, {
      planning: { capital: null, slots: { man: 8, science: 1, reaction: 1 } },
    })).evaluate(T.WIDGET, { demandPerDay: 10 });
    eq('demand under one slot collapses to a single job', r.totals.batch.jobs, 1);
    eq('...sized to the daily demand', r.totals.batch.runs, 10);
    check('...and flagged as a daily launch', r.totals.batch.dailyLaunch === true);
    check('...with the cycle floored at 24 h', r.totals.batch.cycleHours >= 24, r.totals.batch.cycleHours);

    // capital shrinks the batch
    r = makeEngine(Object.assign({}, base, {
      planning: { capital: 3000, slots: { man: 4, science: 1, reaction: 1 } },
    })).evaluate(T.WIDGET, {});
    check('capital limits the batch', r.totals.batch.capitalLimited === true);
    eq('...naming itself as the bottleneck', r.totals.batch.bottleneck, 'capital');
    check('...to something the capital covers', r.totals.capitalUsed <= 3000, r.totals.capitalUsed);
    check('...but never below a single run', r.runs >= 1, r.runs);

    // an invented product takes R from the BPC run count, not the 24h cap
    const dInv = baseData();
    dInv.blueprints[9001].inv = { t: 3600, m: [[T.DATACORE, 2]], p: [[9003, 5, 0.30]], s: [] };
    dInv.blueprints[9001].cop = { t: 480 };
    dInv.blueprints[9003] = { limit: 10, man: { t: 1000, m: [[T.MINERAL, 200]], p: [[T.T2_WIDGET, 1]], s: [] } };
    r = makeEngine(Object.assign({}, base, {
      data: dInv,
      priceTable: Object.assign({}, base.priceTable,
        { [T.DATACORE]: { sell: 100, buy: 90 }, [T.T2_WIDGET]: { sell: 50000, buy: 45000 } }),
      planning: { capital: null, slots: { man: 3, science: 4, reaction: 1 } },
    })).evaluate(T.T2_WIDGET, {});
    eq('an invented product runs exactly its BPC run count per job', r.totals.batch.runs, 5);
    eq('...across the manufacturing slots', r.totals.batch.jobs, 3);
    check('...and the science pipeline appears as a stage',
      (r.totals.batch.stages || []).some(st => st.stage === 'copying' || st.stage === 'invention'),
      JSON.stringify(r.totals.batch.stages));

    // pipeline bottleneck: the slowest stage sets the rate
    const rates = (r.totals.batch.stages || []).map(st => st.unitsPerHour);
    if (check('the plan reports stage rates', rates.length >= 2, JSON.stringify(r.totals.batch.stages)))
      near('the plan runs at the slowest stage', r.totals.batch.unitsPerHour, Math.min.apply(null, rates), 1e-9);

    // a pinned run count bypasses the planner entirely
    r = makeEngine(Object.assign({}, base, {
      planning: { capital: null, slots: { man: 4, science: 1, reaction: 1 } },
    })).evaluate(T.WIDGET, { runs: 7 });
    eq('opts.runs pins the plan to exactly that many runs', r.runs, 7);
    eq('...in a single job', r.totals.batch.jobs, 1);
  }

  /* ================= totals sanity ================= */
  section('totals hang together');
  {
    const r = makeEngine({
      costIndex: 0.05, adjustedTable: { [T.MINERAL]: 10 },
      assumptions: { ownedBpoMe: 0, ownedBpoTe: 0, sccPct: 4 },
      market: { inputSide: 'sell', outputSide: 'sellOrder', sellerBrokerPct: 3, sellerTaxPct: 7.5 },
      shipping: { base: 1e6, perM3: 100, collateralPct: 0.01, roundUpToMillion: false,
                  applyInbound: true, applyOutbound: true },
      priceTable: { [T.MINERAL]: { sell: 1, buy: 1 }, [T.WIDGET]: { sell: 100000, buy: 90000 } },
    }).evaluate(T.WIDGET, { runs: 10 });
    near('cost per item = (build total + both shipping legs) / units',
      r.totals.costPerItem,
      (r.totals.capitalUsed - r.totals.shippingIn + r.totals.shippingIn + r.totals.shippingOut) / r.produced,
      1e-6);
    near('profit per item = revenue - cost',
      r.totals.profitPerItem, r.totals.revenuePerItem - r.totals.costPerItem, 1e-9);
    near('margin is profit over revenue',
      r.totals.marginPct, r.totals.profitPerItem / r.totals.revenuePerItem * 100, 1e-9);
    near('roi is profit over cost',
      r.totals.roiPct, r.totals.profitPerItem / r.totals.costPerItem * 100, 1e-9);
    near('profit per day is the hourly rate over 24 h',
      r.totals.profitPerDay, r.totals.iskPerHour * 24, 1e-6);
    near('sales tax is the seller rate on the gross',
      r.totals.salesTax, 100000 * 10 * 0.075, 1e-6);
  }
});
