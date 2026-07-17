/* IndustryEngine — pure EVE Online industry profitability calculator.
   ZERO DOM access. Loadable as a browser script (window.IndustryEngine) or in Node
   (module.exports). All market/ESI data is caller-provided via callbacks.

   Usage:
     const engine = IndustryEngine.create({ data, prices, adjusted, indices, profile, skills, params });
     const result = engine.evaluate(productTypeId, { runs: 10 });

   create() options:
   - data:     static SDE-derived object:
               { v, types:{tid:[name, volume, packagedVolume|null, groupId, marketGroupId, metaGroupId]},
                 groups:{gid:[name,categoryId]}, marketGroups:{mgid:[name,parentId|0]}, skills:{tid:name},
                 blueprints:{bpid:{ limit, man?:{t,m:[[tid,qty]],p:[[tid,qty]],s:[[skillTid,lvl]]},
                                    rea?:{t,m,p,s}, cop?:{t}, inv?:{t,m,p:[[producedBpid,runs,probability]],s},
                                    me?:{t}, te?:{t} }} }
   - prices:   (tid) => { sell, buy, sellLevels?, buyLevels? } | null — real hub quotes.
               sell/buy are scalar best quotes. The optional depth arrays are price levels
               [price, volume, minVolume] (sellLevels ascending, buyLevels descending):
               · with sellLevels, input buying (inputSide 'sell') WALKS the book, taking
                 volume per level until the needed quantity fills; a book that runs dry
                 prices the remainder at the worst (deepest) filled level and flags the
                 node with thinBook = {filled, needed} (surfaced, never zeroed);
               · with buyLevels, instant revenue (outputSide 'instant') walks the buy book
                 top-down respecting each order's minVolume (unmeetable min-volume orders
                 are skipped — the Sell tool's rule); output the book cannot absorb earns
                 0 and totals.revenueThinBook = {filled, needed} is set.
               Without levels the scalar best-quote behavior applies unchanged.
   - adjusted: (tid) => number                    — ESI /markets/prices adjusted_price (EIV basis).
   - indices:  (systemNameOrId, activity) => costIndex — ESI /industry/systems values. The engine
               passes facility.system verbatim and the SHORT activity code; the caller maps codes
               to ESI names: man→manufacturing, rea→reaction, inv→invention, cop→copying,
               me→researching_material_efficiency, te→researching_time_efficiency.
   - profile:  { facilities:[{ id, label, system, tax, activities:['man','rea','inv','cop','me','te'],
                               bonuses:{me,te,cost},            // structure bonuses, percent
                               rigs:[{match:[ids]|null, me, te, cost, act?, n?}] }],
               // rig match: marketGroup ancestor ids or groupIds; null = matches EVERY product
               // (activity-wide rigs such as lab rigs); [] matches nothing.
               // act (optional): activity codes the rig applies to; absent = all activities.
               // n (optional): display label — surfaced in matModifierBreakdown.rigMeName/rigTeName.
                 market: { inputSide:'sell'|'buy', outputSide:'sellOrder'|'instant',
                           buyerBrokerPct, sellerBrokerPct, sellerTaxPct,
                           brokerPct, taxPct },   // legacy fallbacks for the seller fields
                 // buyerBrokerPct (default 0) is ADDED on top of buy-side quotes when
                 // inputSide='buy' — the buyer pays their own broker fee to place orders.
                 // sellerBrokerPct/sellerTaxPct fall back to brokerPct/taxPct.
                 shipping: { base, perM3, collateralPct, roundUpToMillion, applyInbound, applyOutbound },
                 assumptions: { ownedBpoMe, ownedBpoTe, sccPct, decryptor:'auto'|name|null },
                 planning: { capital,          // ISK for working inputs; null = unlimited
                             slots: {man, science, reaction},  // override auto-derivation
                             demandCapPct,     // default 100 — see opts.demandPerDay
                             maxHaulM3 } }     // default 350000 — shipping splits into hauls
   - skills:   { byName: {'Industry':5, ...} } and/or { byId: {tid:lvl} }.
   - params:   { maxDepth } — defaults for evaluate opts.

   evaluate(productTypeId, opts) opts:
   - runs — PINS the plan to exactly `runs` runs in one job (the pre-batch behavior).
     Omit it to let the batch planner size R (runs/job) × J (parallel jobs) from BPC
     runs / blueprint limit / ~24h job cap / slots / demand / capital — see evaluate()'s
     own doc comment for the full algorithm.
   - demandPerDay — market demand in units/day (planner mode only); with demandCapPct
     it caps the plan's daily output. null/omitted = uncapped.
   - meOverride/teOverride (root blueprint only), maxDepth,
     forceBuy: Set<tid>, forceBuild: Set<tid>,
     noInvention (root only) — price the root straight off its blueprint (owned
     BPO/BPC in hand), skipping the invention variants and their amortized overhead;
     pair it with meOverride/teOverride carrying the owned blueprint's research.

   Returns { tid, name, produced, runs, totals, tree, stats } — runs = R×J total.
   totals =
   { costPerItem, revenuePerItem, profitPerItem, marginPct, roiPct,
     iskPerHour,                       // pipeline: profit/unit × min stage units/hour
     profitPerDay,                     // iskPerHour × 24
     capitalUsed,                      // batch build total + inbound shipping
     batch: { runs, jobs, units, planned, cycleHours, bottleneck, unitsPerHour,
              stages:[{stage, unitsPerHour}], demandLimited, dailyLaunch, capitalLimited,
              capitalUsed, hauls:{in:{count,m3,costEach,cost}, out:{...}} },
     shippingIn, shippingOut, shippingInPerItem, shippingOutPerItem, salesTax, brokerFee,
     totalJobTime, treeDepth,
     thinBookCount,                    // chosen-tree bought inputs with a thin sell book
     revenueThinBook }                 // {filled, needed} | null — instant buy book ran dry
   and tree is the recursive node structure:
   { tid, name, decision:'buy'|'build', qty, buyCost, buildCost, cost, forced?, depthCapped?, note?,
     thinBook?,                        // {filled, needed} — sell book thinner than qty
     job:{activity, facilityLabel, runs, time, eiv, costBreakdown:{sciGross,bonus,scc,tax},
          matModifierBreakdown:{bpMe,structMe,rigMe,bpTe,structTe,rigTe,rigMeName,rigTeName}},
     invention?:{decryptor, chance, attemptsPerSuccess, bpcRuns, me, te, costPerSuccess, perUnit, options:[...]},
     children:[...] }.

   Documented v1 simplifications (kept deliberately, noted for v2):
   - The batch is priced as ONE aggregate job of R×J runs: job fees are linear in runs so
     they match exactly, but material rounding differs from J separate jobs by at most
     J−1 units per material (per-job ceilings), and totalJobTime stays the linear sum.
   - Intermediate BUILD nodes do not consume the top-level man/reaction/science slots —
     only the FINAL product's stages bound throughput; sub-node job fees/times still
     scale with the batch quantity.
   - iskPerHour/profitPerDay assume steady state: slots relaunch instantly, science keeps
     copies/BPCs flowing at the computed rates, demand absorbs at the capped rate.
   - Reaction formulas are assumed available for every parallel job (originals are cheap);
     no copy stage constrains reactions.
   - Shipping hauls split cargo and collateral EVENLY across ceil(m³/maxHaulM3) contracts.
   - Facility choice per activity = FIRST profile facility listing that activity.
   - Memoization key is (tid, qty); diamond dependencies with equal quantities share one
     resolved node object (the result tree is a DAG at those points).
   - Invented-BPC run limits do not split manufacturing jobs; job fees assume one job.
   - Invention & copy EIV use the T1 blueprint's manufacturing materials (1 run).
   - Invention consumables (datacores/decryptors/copies) are amortized into cost but are
     NOT added to the inbound shipping haul.
   - Buy-order inputs (inputSide 'buy') pay the buyer's broker fee on top of the raw top
     quote (buyerBrokerPct), but stay scalar — no depth walk on the buy side of inputs.
   - Invention consumables (datacores/decryptors) are priced at the scalar top quote,
     never depth-walked — their quantities are tiny next to build materials. */
'use strict';
(function () {

  /* ---- Decryptors ----------------------------------------------------------------
     NEEDS-VERIFICATION: hardcoded decryptor table (chance multiplier, +runs, +ME, +TE).
     Cross-check against the SDE dogma attributes before trusting real-ISK output. */
  var DECRYPTORS = {
    'Accelerant Decryptor':           { mult: 1.2, runs: 1, me: 2,  te: 10 },
    'Attainment Decryptor':           { mult: 1.8, runs: 4, me: -1, te: 4 },
    'Augmentation Decryptor':         { mult: 0.6, runs: 9, me: -2, te: 2 },
    'Optimized Attainment Decryptor': { mult: 1.9, runs: 2, me: 1,  te: -2 },
    'Optimized Augmentation Decryptor': { mult: 0.9, runs: 7, me: 2, te: 0 },
    'Parity Decryptor':               { mult: 1.5, runs: 3, me: 1,  te: -2 },
    'Process Decryptor':              { mult: 1.1, runs: 0, me: 3,  te: 6 },
    'Symmetry Decryptor':             { mult: 1.0, runs: 2, me: 1,  te: 8 },
  };

  /* Material quantity for a job of R runs.
     qty = max(R, ceil(round(base·R·(1−bpME/100)·(1−structME/100)·(1−rigME/100), 2))) */
  function matQty(base, runs, bpMe, structMe, rigMe) {
    var raw = base * runs * (1 - (bpMe || 0) / 100) * (1 - (structMe || 0) / 100) * (1 - (rigMe || 0) / 100);
    var rounded = Math.round(raw * 100) / 100; // round to 2 decimals FIRST (EveGuru-validated)
    return Math.max(runs, Math.ceil(rounded));
  }

  /* Job installation cost.
     man/rea: base = EIV;  cop/inv/me/te: base = 0.02·EIV (job cost base, "JCB").
     total = base·SCI·(1 − combinedCostBonus) + base·scc% + base·tax%
     combinedCostBonus stacks structure and rig multiplicatively: 1−(1−s)(1−r). */
  function jobCost(activity, eiv, costIndex, o) {
    o = o || {};
    var base = (activity === 'man' || activity === 'rea') ? eiv : 0.02 * eiv;
    var gross = base * costIndex;
    var combined = 1 - (1 - (o.structCostBonusPct || 0) / 100) * (1 - (o.rigCostBonusPct || 0) / 100);
    var bonus = -(gross * combined);
    var scc = base * (o.sccPct || 0) / 100;
    var tax = base * (o.taxPct || 0) / 100;
    return { sciGross: gross, bonus: bonus, scc: scc, tax: tax, total: gross + bonus + scc + tax };
  }

  /* Per-activity time multiplier from skills (structure/rig/blueprint TE applied separately). */
  function timeSkillMult(activity, sk) {
    if (activity === 'man') return (1 - 0.04 * sk.industry) * (1 - 0.03 * sk.advanced);
    if (activity === 'cop') return (1 - 0.05 * sk.science) * (1 - 0.03 * sk.advanced);
    if (activity === 'rea') return (1 - 0.04 * sk.reactions); // spec formula; AdvIndustry not applied
    if (activity === 'me')  return (1 - 0.05 * sk.metallurgy) * (1 - 0.03 * sk.advanced);
    if (activity === 'te')  return (1 - 0.05 * sk.research) * (1 - 0.03 * sk.advanced);
    if (activity === 'inv') return (1 - 0.03 * sk.advanced);
    return 1;
  }

  function roundUpToMillion(x) { return Math.ceil(x / 1e6) * 1e6; }

  function create(cfg) {
    var data = cfg.data, prices = cfg.prices, adjusted = cfg.adjusted, indices = cfg.indices;
    var profile = cfg.profile || {};
    var params = cfg.params || {};
    var market = profile.market || { inputSide: 'sell', outputSide: 'sellOrder', brokerPct: 0, taxPct: 0 };
    // role fees: seller fields fall back to the legacy names; buyer broker defaults to 0
    // (the pre-role behavior — raw buy quotes) so old profiles/fixtures are unchanged
    var buyerBrokerPct = market.buyerBrokerPct != null ? market.buyerBrokerPct : 0;
    var sellerBrokerPct = market.sellerBrokerPct != null ? market.sellerBrokerPct : (market.brokerPct || 0);
    var sellerTaxPct = market.sellerTaxPct != null ? market.sellerTaxPct : (market.taxPct || 0);
    var shipping = profile.shipping || null;
    var assume = profile.assumptions || {};
    var ownedMe = assume.ownedBpoMe != null ? assume.ownedBpoMe : 10;
    var ownedTe = assume.ownedBpoTe != null ? assume.ownedBpoTe : 20;
    var sccPct = assume.sccPct != null ? assume.sccPct : 4;
    var planning = profile.planning || {};
    var capital = planning.capital != null ? planning.capital : null;   // null = unlimited
    var demandCapPct = planning.demandCapPct != null ? planning.demandCapPct : 100;
    var maxHaulM3 = planning.maxHaulM3 != null && planning.maxHaulM3 > 0 ? planning.maxHaulM3 : 350000;

    // ---- indexes over the static data ------------------------------------------
    var productToBp = new Map();   // product tid -> {bpid, bp, activity, qtyPerRun}
    var inventedBy = new Map();    // produced T2 bpid -> {t1bpid, baseRuns, baseProb}
    var bpid, bp, act, i, e;
    for (bpid in data.blueprints) {
      bp = data.blueprints[bpid];
      ['man', 'rea'].forEach(function (a) {
        if (!bp[a] || !bp[a].p) return;
        for (var j = 0; j < bp[a].p.length; j++) {
          var pe = bp[a].p[j];
          if (!productToBp.has(pe[0])) productToBp.set(pe[0], { bpid: Number(bpid), bp: bp, activity: a, qtyPerRun: pe[1] });
        }
      });
      if (bp.inv && bp.inv.p) {
        for (i = 0; i < bp.inv.p.length; i++) {
          e = bp.inv.p[i];
          if (!inventedBy.has(e[0])) inventedBy.set(e[0], { t1bpid: Number(bpid), baseRuns: e[1], baseProb: e[2] });
        }
      }
    }
    var skillNameToTid = {};
    for (var stid in (data.skills || {})) skillNameToTid[data.skills[stid]] = Number(stid);
    var typeNameToTid = null; // lazy (only needed for decryptor lookup)
    function tidByTypeName(name) {
      if (!typeNameToTid) {
        typeNameToTid = {};
        for (var t in data.types) typeNameToTid[data.types[t][0]] = Number(t);
      }
      return typeNameToTid[name];
    }

    var byName = (cfg.skills && cfg.skills.byName) || {};
    var byId = (cfg.skills && cfg.skills.byId) || {};
    function skillLevel(tidOrName) {
      if (typeof tidOrName === 'number') {
        if (byId[tidOrName] != null) return byId[tidOrName];
        var n = (data.skills || {})[tidOrName];
        return n != null && byName[n] != null ? byName[n] : 0;
      }
      if (byName[tidOrName] != null) return byName[tidOrName];
      var tid = skillNameToTid[tidOrName];
      return tid != null && byId[tid] != null ? byId[tid] : 0;
    }
    var sk = {
      industry: skillLevel('Industry'), advanced: skillLevel('Advanced Industry'),
      science: skillLevel('Science'), reactions: skillLevel('Reactions'),
      metallurgy: skillLevel('Metallurgy'), research: skillLevel('Research'),
    };

    /* Job-slot counts. planning.slots overrides win; otherwise derived from the
       (manufacturer) character's skills: man = 1 + Mass Production + Advanced Mass
       Production, science = 1 + Laboratory Operation + Advanced Laboratory Operation,
       reaction = 1 + Mass Reactions + Advanced Mass Reactions. The slot skills are NOT
       part of data.skills (that map only carries blueprint-required skills), so each is
       resolved by name via skillLevel() AND by its well-known SDE type id against
       skills.byId — whichever yields the higher trained level wins. */
    var SLOT_SKILL_IDS = { 'Mass Production': 3387, 'Advanced Mass Production': 24625,
      'Laboratory Operation': 3406, 'Advanced Laboratory Operation': 24624,
      'Mass Reactions': 45748, 'Advanced Mass Reactions': 45749 };
    function slotSkill(name) {
      var byNameLvl = skillLevel(name) || 0;
      var wk = byId[SLOT_SKILL_IDS[name]];
      return Math.max(byNameLvl, wk != null ? wk : 0);
    }
    var slotsCfg = planning.slots || {};
    var slots = {
      man: slotsCfg.man != null ? Math.max(1, slotsCfg.man)
        : 1 + slotSkill('Mass Production') + slotSkill('Advanced Mass Production'),
      science: slotsCfg.science != null ? Math.max(1, slotsCfg.science)
        : 1 + slotSkill('Laboratory Operation') + slotSkill('Advanced Laboratory Operation'),
      reaction: slotsCfg.reaction != null ? Math.max(1, slotsCfg.reaction)
        : 1 + slotSkill('Mass Reactions') + slotSkill('Advanced Mass Reactions'),
    };

    function typeRow(tid) { return data.types[tid] || null; }
    function typeName(tid) { var r = typeRow(tid); return r ? r[0] : ('type#' + tid); }
    function typeVol(tid) { var r = typeRow(tid); return r ? (r[2] != null ? r[2] : r[1]) : 0; } // packagedVolume ?? volume

    function facilityFor(activity) {
      var fs = profile.facilities || [];
      for (var i = 0; i < fs.length; i++) if ((fs[i].activities || []).indexOf(activity) >= 0) return fs[i];
      return null;
    }

    /* Market-group ancestry (+ groupId) of a product, for rig matching. */
    function ancestrySet(tid) {
      var r = typeRow(tid), set = new Set();
      if (!r) return set;
      if (r[3] != null) set.add(r[3]);           // groupId
      var mg = r[4], hop = 0;
      while (mg && data.marketGroups[mg] && hop++ < 50) {
        set.add(mg);
        mg = data.marketGroups[mg][1] || 0;
      }
      return set;
    }

    /* Best matching rig bonuses (max per attribute across matching rigs).
       activity filters rigs carrying an `act` list (rigs without one apply to every
       activity — the legacy behavior). Alongside the maxima the SOURCE rig's label
       (entry.n) is tracked per attribute so the UI can name the actual rig. */
    function rigBonuses(facility, productTid, activity) {
      var out = { me: 0, te: 0, cost: 0, meRig: null, teRig: null, costRig: null };
      if (!facility || !facility.rigs) return out;
      var anc = null; // ancestry computed lazily — activity-filtered rigs may skip it
      for (var i = 0; i < facility.rigs.length; i++) {
        var rig = facility.rigs[i];
        if (rig.act && activity && rig.act.indexOf(activity) < 0) continue;
        var hit;
        if (rig.match == null) hit = true; // null scope = applies to every product
        else {
          var match = Array.isArray(rig.match) ? rig.match : [rig.match];
          if (!anc) anc = ancestrySet(productTid);
          hit = false;
          for (var j = 0; j < match.length; j++) if (anc.has(match[j])) { hit = true; break; }
        }
        if (!hit) continue;
        if ((rig.me || 0) > out.me) { out.me = rig.me || 0; out.meRig = rig.n || null; }
        if ((rig.te || 0) > out.te) { out.te = rig.te || 0; out.teRig = rig.n || null; }
        if ((rig.cost || 0) > out.cost) { out.cost = rig.cost || 0; out.costRig = rig.n || null; }
      }
      return out;
    }

    /* EIV: Σ(base per-run qty × adjusted_price) × runs — NO ME reduction. */
    function eivOf(mats, runs) {
      var s = 0;
      for (var i = 0; i < mats.length; i++) s += mats[i][1] * (adjusted(mats[i][0]) || 0);
      return s * runs;
    }

    function inputUnitPrice(tid) {
      var q = prices(tid);
      if (!q) return null;
      var p = market.inputSide === 'buy' ? q.buy : q.sell;
      if (p == null || !(p > 0)) return null;
      // placing buy orders costs the buyer their own broker fee on top of the quote
      return market.inputSide === 'buy' ? p * (1 + buyerBrokerPct / 100) : p;
    }

    /* Depth-aware cost of buying `qty` off the sell book (levels [price, vol, minVol] asc).
       min_volume is irrelevant on sells — we are the buyer and take volume per level.
       A dry book prices the remainder at the worst (deepest) filled level. */
    function walkSellCost(levels, qty) {
      var cost = 0, remaining = qty, worst = null;
      for (var i = 0; i < levels.length && remaining > 0; i++) {
        var take = Math.min(levels[i][1], remaining);
        if (!(take > 0)) continue;
        cost += take * levels[i][0];
        worst = levels[i][0];
        remaining -= take;
      }
      if (worst == null) return null;   // pathological all-zero-volume book — caller falls back
      if (remaining > 0) cost += remaining * worst;
      return { cost: cost, filled: qty - Math.max(0, remaining) };
    }

    /* Instant-sale proceeds for `qty` against the buy book (levels desc). Orders whose
       min_volume exceeds what is left to sell are skipped (the Sell tool's rule);
       output the book cannot absorb earns 0. */
    function walkBuyRevenue(levels, qty) {
      var proceeds = 0, remaining = qty;
      for (var i = 0; i < levels.length && remaining > 0; i++) {
        if ((levels[i][2] || 1) > remaining) continue;
        var take = Math.min(levels[i][1], remaining);
        if (!(take > 0)) continue;
        proceeds += take * levels[i][0];
        remaining -= take;
      }
      return { proceeds: proceeds, filled: qty - remaining };
    }

    /* Full acquisition quote for `qty` units: {cost, thinBook?} | null. */
    function buyQuote(tid, qty) {
      var q = prices(tid);
      if (!q) return null;
      if (market.inputSide === 'buy') {
        var pb = q.buy;
        if (pb == null || !(pb > 0)) return null;
        return { cost: pb * qty * (1 + buyerBrokerPct / 100) };
      }
      var lv = q.sellLevels;
      if (lv && lv.length) {
        var w = walkSellCost(lv, qty);
        if (w) {
          var out = { cost: w.cost };
          if (w.filled < qty) out.thinBook = { filled: w.filled, needed: qty };
          return out;
        }
      }
      var ps = q.sell;
      if (ps == null || !(ps > 0)) return null;
      return { cost: ps * qty };
    }

    /* Copy job cost for a 1-run T1 copy (v1: EIV = T1 man materials × 1 run). */
    function copyCost(t1bp) {
      if (!t1bp.cop || !t1bp.man || !t1bp.man.p.length) return { total: 0 };
      var fac = facilityFor('cop');
      if (!fac) return { total: 0 };
      var eiv = eivOf(t1bp.man.m, 1);
      var sci = indices(fac.system, 'cop') || 0;
      var b = (fac.bonuses || {});
      return jobCost('cop', eiv, sci, {
        structCostBonusPct: b.cost || 0,
        rigCostBonusPct: rigBonuses(fac, t1bp.man.p[0][0], 'cop').cost,
        sccPct: sccPct, taxPct: fac.tax || 0,
      });
    }

    /* Invention options for a T2 blueprint. Returns per-decryptor
       { decryptor, chance, runs, me, te, costPerSuccess } (unit amortization done by caller,
       who knows the product qty/run). */
    function inventionOptions(t2bpid, ctx) {
      var src = inventedBy.get(t2bpid);
      if (!src) return null;
      var t1bp = data.blueprints[src.t1bpid];
      var inv = t1bp.inv;
      var enc = 0, dat = 0;
      for (var i = 0; i < (inv.s || []).length; i++) {
        var sid = inv.s[i][0], lvl = skillLevel(sid);
        if (/Encryption/.test((data.skills || {})[sid] || '')) enc = lvl; else dat += lvl;
      }
      var skillMult = 1 + enc / 40 + dat / 30;
      var matCost = 0; // datacores etc., per attempt
      for (i = 0; i < (inv.m || []).length; i++) {
        var p = inputUnitPrice(inv.m[i][0]);
        matCost += (p || 0) * inv.m[i][1];
      }
      var fac = facilityFor('inv');
      var invJob = { total: 0 };
      // SDE edge: a handful of T1 blueprints carry an empty man.p (e.g. Standup rig BPOs)
      if (fac && t1bp.man && t1bp.man.p.length) {
        var b = (fac.bonuses || {});
        invJob = jobCost('inv', eivOf(t1bp.man.m, 1), indices(fac.system, 'inv') || 0, {
          structCostBonusPct: b.cost || 0,
          rigCostBonusPct: rigBonuses(fac, t1bp.man.p[0][0], 'inv').cost,
          sccPct: sccPct, taxPct: fac.tax || 0,
        });
      }
      var copy = copyCost(t1bp);
      var wanted = assume.decryptor === undefined ? 'auto' : assume.decryptor;
      var names = wanted === 'auto' ? [null].concat(Object.keys(DECRYPTORS))
                : wanted ? [wanted] : [null];
      var options = [];
      for (i = 0; i < names.length; i++) {
        var name = names[i], d = name ? DECRYPTORS[name] : { mult: 1, runs: 0, me: 0, te: 0 };
        if (!d) continue; // unknown decryptor name
        var decCost = 0;
        if (name) {
          var dtid = tidByTypeName(name);
          var dp = dtid != null ? inputUnitPrice(dtid) : null;
          if (dp == null && wanted === 'auto') continue; // can't price it — skip in auto mode
          decCost = dp || 0;
        }
        var chance = Math.min(1, src.baseProb * skillMult * d.mult);
        if (!(chance > 0)) continue;
        options.push({
          decryptor: name, chance: chance, attemptsPerSuccess: 1 / chance,
          runs: src.baseRuns + d.runs, me: 2 + d.me, te: 4 + d.te,
          costPerSuccess: (matCost + decCost + invJob.total + copy.total) / chance,
        });
      }
      return { options: options, auto: wanted === 'auto' };
    }

    /* Build-side evaluation of one product for `qty` units at recursion `depth`.
       Returns { buildCost(total for qty), job, children, invention } or null. */
    function buildFor(tid, qty, depth, ctx) {
      var pe = productToBp.get(tid);
      if (!pe) return null;
      var actData = pe.bp[pe.activity];
      var fac = facilityFor(pe.activity);
      if (!fac) return null;
      var runsNeeded = Math.ceil(qty / pe.qtyPerRun);
      var produced = runsNeeded * pe.qtyPerRun;
      var structB = fac.bonuses || {};
      var rig = rigBonuses(fac, tid, pe.activity);
      var sci = indices(fac.system, pe.activity) || 0;
      var eiv = eivOf(actData.m, runsNeeded);
      var isRoot = depth === 0;

      // ME/TE variants: plain BPO, or invention options (each with its own ME/TE + overhead)
      var invInfo = pe.activity === 'man' && !(isRoot && ctx.noInvention)
        ? inventionOptions(pe.bpid, ctx) : null;
      var variants;
      if (invInfo && invInfo.options.length) {
        variants = invInfo.options.map(function (o) {
          return { me: o.me, te: o.te, overheadPerUnit: o.costPerSuccess / (o.runs * pe.qtyPerRun), inv: o };
        });
      } else {
        variants = [{ me: pe.activity === 'man' ? ownedMe : 0, te: pe.activity === 'man' ? ownedTe : 0, overheadPerUnit: 0, inv: null }];
      }
      if (isRoot && ctx.meOverride != null) variants.forEach(function (v) { v.me = ctx.meOverride; });
      if (isRoot && ctx.teOverride != null) variants.forEach(function (v) { v.te = ctx.teOverride; });

      var best = null;
      for (var vi = 0; vi < variants.length; vi++) {
        var v = variants[vi];
        var children = [];
        var matTotal = 0;
        for (var i = 0; i < actData.m.length; i++) {
          var mTid = actData.m[i][0];
          var mQty = matQty(actData.m[i][1], runsNeeded, v.me, structB.me || 0, rig.me);
          var child = resolveNode(mTid, mQty, depth + 1, ctx);
          children.push(child);
          matTotal += child.cost;
        }
        var jc = jobCost(pe.activity, eiv, sci, {
          structCostBonusPct: structB.cost || 0, rigCostBonusPct: rig.cost,
          sccPct: sccPct, taxPct: fac.tax || 0,
        });
        var time = (actData.t || 0) * runsNeeded * timeSkillMult(pe.activity, sk)
                   * (1 - (v.te || 0) / 100) * (1 - (structB.te || 0) / 100) * (1 - rig.te / 100);
        var total = jc.total + matTotal + v.overheadPerUnit * produced;
        var cand = {
          buildTotalForProduced: total, produced: produced,
          buildCost: total / produced * qty,
          job: {
            activity: pe.activity, facilityLabel: fac.label, runs: runsNeeded, time: time, eiv: eiv,
            costBreakdown: { sciGross: jc.sciGross, bonus: jc.bonus, scc: jc.scc, tax: jc.tax },
            matModifierBreakdown: { bpMe: v.me, structMe: structB.me || 0, rigMe: rig.me,
                                    bpTe: v.te, structTe: structB.te || 0, rigTe: rig.te,
                                    rigMeName: rig.meRig, rigTeName: rig.teRig },
          },
          children: children,
          invention: v.inv ? {
            decryptor: v.inv.decryptor, chance: v.inv.chance, attemptsPerSuccess: v.inv.attemptsPerSuccess,
            bpcRuns: v.inv.runs, me: v.me, te: v.te,
            costPerSuccess: v.inv.costPerSuccess, perUnit: v.overheadPerUnit,
          } : null,
        };
        if (!best || cand.buildCost < best.buildCost) best = cand;
      }
      if (best && best.invention && invInfo) {
        best.invention.options = variants.map(function (v2) {
          return v2.inv && {
            decryptor: v2.inv.decryptor, chance: v2.inv.chance, bpcRuns: v2.inv.runs,
            me: v2.me, te: v2.te, costPerSuccess: v2.inv.costPerSuccess, perUnit: v2.overheadPerUnit,
          };
        }).filter(Boolean);
      }
      return best;
    }

    /* Resolve one material node: buy vs build, memoized per (tid, qty). */
    function resolveNode(tid, qty, depth, ctx) {
      var key = tid + ':' + qty;
      var hit = ctx.memo.get(key);
      if (hit && (!hit.truncated || depth >= hit.depth)) { ctx.stats.memoHits++; return hit.node; }
      ctx.stats.nodesResolved++;
      var bq = buyQuote(tid, qty);
      var buyCost = bq ? bq.cost : null;
      var forced = ctx.forceBuy.has(tid) ? 'buy' : ctx.forceBuild.has(tid) ? 'build' : null;
      var capped = false, built = null;
      if (productToBp.has(tid) && forced !== 'buy') {
        if (depth >= ctx.maxDepth) capped = true;
        else built = buildFor(tid, qty, depth, ctx);
      }
      var node = { tid: tid, name: typeName(tid), qty: qty, buyCost: buyCost,
                   buildCost: built ? built.buildCost : null, children: built ? built.children : [] };
      if (built) { node.job = built.job; if (built.invention) node.invention = built.invention; }
      if (bq && bq.thinBook) node.thinBook = bq.thinBook;
      if (forced) node.forced = forced;
      if (capped) node.depthCapped = true; // build branch cut off by maxDepth
      if (forced === 'build' && built) node.decision = 'build';
      else if (forced === 'buy' || !built) node.decision = 'buy';
      else if (buyCost == null) node.decision = 'build';
      else node.decision = buyCost <= node.buildCost ? 'buy' : 'build';
      if (node.decision === 'buy' && buyCost == null) node.note = 'unpriced';
      node.cost = node.decision === 'buy' ? (buyCost != null ? buyCost : Infinity) : node.buildCost;
      ctx.memo.set(key, { node: node, truncated: capped, depth: depth });
      return node;
    }

    /* Walk the CHOSEN tree: bought leaves feed inbound shipping; build nodes feed times/depth. */
    function walkChosen(node, depth, acc) {
      if (node.decision === 'buy') {
        acc.boughtM3 += typeVol(node.tid) * node.qty;
        acc.boughtCost += (node.buyCost || 0);
        if (node.thinBook) acc.thinBookCount++;
        return;
      }
      acc.jobTime += node.job ? node.job.time : 0;
      acc.maxDepth = Math.max(acc.maxDepth, depth);
      for (var i = 0; i < node.children.length; i++) walkChosen(node.children[i], depth + 1, acc);
    }

    function shipCost(m3, collateral) {
      if (!shipping) return 0;
      var c = (shipping.base || 0) + (shipping.perM3 || 0) * m3 + (shipping.collateralPct || 0) * collateral;
      return shipping.roundUpToMillion ? roundUpToMillion(c) : c;
    }

    /* One full tree evaluation for `runs` total runs of the product. */
    function evalTree(productTid, pe, runs, opts) {
      var ctx = {
        runs: runs,
        maxDepth: opts.maxDepth != null ? opts.maxDepth : (params.maxDepth != null ? params.maxDepth : 10),
        forceBuy: opts.forceBuy || new Set(), forceBuild: opts.forceBuild || new Set(),
        meOverride: opts.meOverride, teOverride: opts.teOverride,
        noInvention: !!opts.noInvention,
        memo: new Map(), stats: { nodesResolved: 0, memoHits: 0 },
      };
      var produced = pe.qtyPerRun * runs;
      var built = buildFor(productTid, produced, 0, ctx);
      if (!built) throw new Error('IndustryEngine: no facility supports activity "' + pe.activity + '"');
      var root = { tid: productTid, name: typeName(productTid), decision: 'build', qty: produced,
                   buyCost: null, buildCost: built.buildCost, cost: built.buildCost,
                   job: built.job, children: built.children };
      var q = prices(productTid);
      root.buyCost = q && q.sell != null ? q.sell * produced : null; // informational
      if (built.invention) root.invention = built.invention;
      var acc = { boughtM3: 0, boughtCost: 0, jobTime: 0, maxDepth: 0, thinBookCount: 0 };
      walkChosen(root, 0, acc);
      return { ctx: ctx, produced: produced, built: built, root: root, acc: acc, q: q };
    }

    /* Real job duration of a copy/invention step: blueprint seconds × skill multiplier
       × the chosen facility's structure/rig TE (v1: blueprint TE research not applied). */
    function jobTimeFor(baseT, activity, productTid) {
      var fac = facilityFor(activity);
      var b = fac ? (fac.bonuses || {}) : {};
      var rigTe = fac ? rigBonuses(fac, productTid, activity).te : 0;
      return (baseT || 0) * timeSkillMult(activity, sk) * (1 - (b.te || 0) / 100) * (1 - rigTe / 100);
    }

    /* Split one direction of shipping into hauls of ≤ maxHaulM3 each. EACH haul pays the
       base + its own per-m³/collateral share, ceil'd to the million when configured —
       cargo and collateral split evenly across hauls (v1 simplification). */
    function shipLeg(m3, collateral) {
      var count = Math.max(1, Math.ceil(m3 / maxHaulM3));
      var each = shipCost(m3 / count, (collateral || 0) / count);
      return { count: count, m3: m3, costEach: each, cost: each * count };
    }
    var NO_LEG = { count: 0, m3: 0, costEach: 0, cost: 0 };

    /* Steady-state pipeline stage rates (units/hour) for a plan of J jobs × R runs.
       - manufacturing|reaction: J·qtyPerRun·3600/perRunTime (slots relaunch continuously).
       - invented products: every job consumes an invented BPC; the science slots are a
         POOLED pipeline — each success costs attemptsPerSuccess × (copyTime + invTime)
         science-seconds (equivalent to a proportional copy/invention slot split); the
         stage is labeled by the larger time consumer (copying vs invention).
       - owned-BPO products at J > 1: one job runs the BPO itself, the other J−1 need
         R-run BPCs from the science slots; the copying stage's capacity is the BPO-fed
         job plus whatever the copy rate sustains. Blueprints without a copy activity
         (reaction formulas) put no copy constraint on parallel jobs. */
    function stageRates(pe, productTid, R, J, root) {
      var qtyPerRun = pe.qtyPerRun;
      var totalRuns = R * J;
      var perRunTime = root.job && root.job.time > 0 ? root.job.time / totalRuns : 0;
      var stages = [];
      if (perRunTime > 0)
        stages.push({ stage: pe.activity === 'rea' ? 'reaction' : 'manufacturing',
                      unitsPerHour: J * qtyPerRun * 3600 / perRunTime });
      if (pe.activity === 'man' && root.invention) {
        var src = inventedBy.get(pe.bpid);
        var t1bp = src && data.blueprints[src.t1bpid];
        if (t1bp && t1bp.inv) {
          var copT = t1bp.cop ? jobTimeFor(t1bp.cop.t, 'cop', productTid) : 0;
          var invT = jobTimeFor(t1bp.inv.t, 'inv', productTid);
          var perSuccess = root.invention.attemptsPerSuccess * (copT + invT);
          if (perSuccess > 0)
            stages.push({ stage: copT >= invT ? 'copying' : 'invention',
                          unitsPerHour: slots.science * 3600 / perSuccess * root.invention.bpcRuns * qtyPerRun });
        }
      } else if (pe.activity === 'man' && J > 1 && pe.bp.cop && perRunTime > 0) {
        var copPerRun = jobTimeFor(pe.bp.cop.t, 'cop', productTid);
        if (copPerRun > 0)
          stages.push({ stage: 'copying',
                        unitsPerHour: qtyPerRun * (3600 / perRunTime + slots.science * 3600 / copPerRun) });
      }
      return { stages: stages, perRunTime: perRunTime };
    }

    /* evaluate(productTid, opts) — plans a batch (runs omitted) or prices a pinned run
       count (opts.runs set: R = runs, J = 1, no constraint scaling — the pre-batch
       behavior, kept for fixtures and pinned what-ifs). Planner:
         R (runs/job) = invented product: the invented BPC's run count;
                        owned BPO/T1:    min(blueprint maxProductionLimit, soft cap of
                        floor(24h / perRunTime) so one job lasts ≲ a day — parallel slots
                        beat marathon jobs and a dead BPO slot re-queues daily anyway).
         J (parallel jobs) = man/reaction slot count for the product's activity.
         Demand cap: daily output ≤ demandPerDay × demandCapPct/100. J is floored to the
         largest slot count that fits; when even ONE continuously-relaunched slot
         over-produces, the plan becomes a single demand-sized job per day (cycle floored
         at 24 h). Capital: while the batch's working capital (depth-walked input cost +
         job fees + invention overhead + inbound shipping) exceeds `capital`, the batch
         shrinks proportionally (full-R jobs preferred, then shorter jobs; ≥ 1 run
         always remains — a batch of one run over capital is flagged, not hidden). */
    function evaluate(productTid, opts) {
      opts = opts || {};
      var pe = productToBp.get(productTid);
      if (!pe) throw new Error('IndustryEngine: no blueprint produces type ' + productTid);
      var planned = opts.runs == null;
      var R, J, res, demandLimited = false, dailyLaunch = false, capitalLimited = false;

      if (!planned) {
        R = opts.runs; J = 1;
        res = evalTree(productTid, pe, R, opts);
      } else {
        var probe = evalTree(productTid, pe, 1, opts);
        var perRun = probe.root.job ? probe.root.job.time : 0;  // time of exactly 1 run
        J = Math.max(1, pe.activity === 'rea' ? slots.reaction : slots.man);
        if (probe.root.invention) {
          R = Math.max(1, probe.root.invention.bpcRuns);
        } else {
          R = perRun > 0 ? Math.max(1, Math.floor(86400 / perRun)) : 1;   // ~24h soft cap
          if (pe.bp.limit > 0) R = Math.min(R, pe.bp.limit);
        }
        if (opts.demandPerDay != null) {
          var capRate = opts.demandPerDay * demandCapPct / 100;           // units/day allowed
          var slotRate = perRun > 0 ? pe.qtyPerRun * 86400 / perRun : Infinity;
          var jMax = Math.floor(capRate / slotRate);
          if (jMax >= 1) {
            if (jMax < J) { J = jMax; demandLimited = true; }
          } else {
            demandLimited = true; dailyLaunch = true; J = 1;
            R = Math.min(R, Math.max(1, Math.floor(capRate / pe.qtyPerRun)));
          }
        }
        res = R * J === 1 ? probe : evalTree(productTid, pe, R * J, opts);
        if (capital != null) {
          for (var iter = 0; iter < 8; iter++) {
            var used = res.built.buildTotalForProduced
              + (shipping && shipping.applyInbound && res.acc.boughtM3 > 0
                 ? shipLeg(res.acc.boughtM3, res.acc.boughtCost).cost : 0);
            if (used <= capital || R * J <= 1) break;
            capitalLimited = true;
            var newRuns = Math.floor(R * J * capital / used);
            if (newRuns >= R * J) newRuns = R * J - 1;
            if (newRuns < 1) newRuns = 1;
            if (newRuns < R) { J = 1; R = newRuns; }
            else J = Math.max(1, Math.min(J, Math.floor(newRuns / R)));
            res = R * J === 1 ? probe : evalTree(productTid, pe, R * J, opts);
          }
        }
      }

      var produced = res.produced, built = res.built, root = res.root, acc = res.acc, q = res.q;
      var grossUnit = q ? (market.outputSide === 'instant' ? q.buy : q.sell) : null;
      var grossTotal = grossUnit != null ? grossUnit * produced : null;
      var revenueThinBook = null;
      if (market.outputSide === 'instant' && q && q.buyLevels && q.buyLevels.length) {
        // depth-aware instant sale: walk the buy book (min_volume respected)
        var wr = walkBuyRevenue(q.buyLevels, produced);
        grossTotal = wr.proceeds;
        grossUnit = grossTotal / produced;
        if (wr.filled < produced) revenueThinBook = { filled: wr.filled, needed: produced };
      }
      var revenueUnit = null, salesTax = 0, brokerFee = 0;
      if (grossTotal != null) {
        salesTax = grossTotal * sellerTaxPct / 100;
        if (market.outputSide === 'instant') {
          revenueUnit = grossTotal * (1 - sellerTaxPct / 100) / produced;
        } else {
          brokerFee = grossTotal * sellerBrokerPct / 100;
          revenueUnit = grossTotal * (1 - sellerBrokerPct / 100 - sellerTaxPct / 100) / produced;
        }
      }
      var haulIn = shipping && shipping.applyInbound && acc.boughtM3 > 0
        ? shipLeg(acc.boughtM3, acc.boughtCost) : NO_LEG;
      var haulOut = shipping && shipping.applyOutbound && grossTotal != null
        ? shipLeg(typeVol(productTid) * produced, grossTotal) : NO_LEG;
      var shipIn = haulIn.cost, shipOut = haulOut.cost;
      var capitalUsed = built.buildTotalForProduced + shipIn;

      // steady-state pipeline: units/hour = min over stages; limits that shrank the
      // plan (capital, then demand) take priority in the bottleneck label
      var sr = stageRates(pe, productTid, R, J, root);
      var minStage = null;
      for (var si = 0; si < sr.stages.length; si++)
        if (!minStage || sr.stages[si].unitsPerHour < minStage.unitsPerHour) minStage = sr.stages[si];
      var effRate = minStage ? minStage.unitsPerHour : null;
      var bottleneck = minStage ? minStage.stage : null;
      if (dailyLaunch && effRate != null && produced / 24 < effRate) effRate = produced / 24;
      if (capitalLimited) bottleneck = 'capital';
      else if (demandLimited) bottleneck = 'demand';
      var cycleHours = sr.perRunTime > 0 ? sr.perRunTime * R / 3600 : 0;
      if (dailyLaunch) cycleHours = Math.max(cycleHours, 24);

      var costPerItem = (built.buildTotalForProduced + shipIn + shipOut) / produced;
      var profitPerItem = revenueUnit != null ? revenueUnit - costPerItem : null;
      var iskPerHour = profitPerItem != null && effRate != null && effRate > 0
        ? profitPerItem * effRate : null;
      return {
        tid: productTid, name: root.name, produced: produced, runs: R * J,
        totals: {
          costPerItem: costPerItem,
          revenuePerItem: revenueUnit,
          profitPerItem: profitPerItem,
          marginPct: profitPerItem != null && revenueUnit ? profitPerItem / revenueUnit * 100 : null,
          roiPct: profitPerItem != null && costPerItem ? profitPerItem / costPerItem * 100 : null,
          // pipeline number: profit/unit × steady-state units/hour (min stage rate)
          iskPerHour: iskPerHour,
          profitPerDay: iskPerHour != null ? iskPerHour * 24 : null,
          capitalUsed: capitalUsed,
          batch: {
            runs: R, jobs: J, units: produced, planned: planned,
            cycleHours: cycleHours, bottleneck: bottleneck,
            unitsPerHour: effRate, stages: sr.stages,
            demandLimited: demandLimited, dailyLaunch: dailyLaunch, capitalLimited: capitalLimited,
            capitalUsed: capitalUsed,
            hauls: { in: haulIn, out: haulOut },
          },
          shippingIn: shipIn, shippingOut: shipOut,
          shippingInPerItem: shipIn / produced, shippingOutPerItem: shipOut / produced,
          salesTax: salesTax, brokerFee: brokerFee,
          totalJobTime: acc.jobTime, treeDepth: acc.maxDepth,
          thinBookCount: acc.thinBookCount, revenueThinBook: revenueThinBook,
        },
        tree: root, stats: res.ctx.stats,
      };
    }

    return { evaluate: evaluate };
  }

  var IndustryEngine = { create: create, matQty: matQty, jobCost: jobCost,
    timeSkillMult: timeSkillMult, DECRYPTORS: DECRYPTORS };
  if (typeof window !== 'undefined') window.IndustryEngine = IndustryEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = IndustryEngine;
})();
