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
   - prices:   (tid) => { sell, buy } | null      — real hub quotes.
   - adjusted: (tid) => number                    — ESI /markets/prices adjusted_price (EIV basis).
   - indices:  (systemNameOrId, activity) => costIndex — ESI /industry/systems values. The engine
               passes facility.system verbatim and the SHORT activity code; the caller maps codes
               to ESI names: man→manufacturing, rea→reaction, inv→invention, cop→copying,
               me→researching_material_efficiency, te→researching_time_efficiency.
   - profile:  { facilities:[{ id, label, system, tax, activities:['man','rea','inv','cop','me','te'],
                               bonuses:{me,te,cost},            // structure bonuses, percent
                               rigs:[{match:[ids], me, te, cost}] }],  // match: marketGroup ancestor ids or groupIds
                 market: { inputSide:'sell'|'buy', outputSide:'sellOrder'|'instant', brokerPct, taxPct },
                 shipping: { base, perM3, collateralPct, roundUpToMillion, applyInbound, applyOutbound },
                 assumptions: { ownedBpoMe, ownedBpoTe, sccPct, decryptor:'auto'|name|null } }
   - skills:   { byName: {'Industry':5, ...} } and/or { byId: {tid:lvl} }.
   - params:   { maxDepth } — defaults for evaluate opts.

   evaluate(productTypeId, opts) opts:
   - runs (default 1), meOverride/teOverride (root blueprint only), maxDepth,
     forceBuy: Set<tid>, forceBuild: Set<tid>,
     noInvention (root only) — price the root straight off its blueprint (owned
     BPO/BPC in hand), skipping the invention variants and their amortized overhead;
     pair it with meOverride/teOverride carrying the owned blueprint's research.

   Returns { tid, name, produced, runs, totals, tree, stats } where totals =
   { costPerItem, revenuePerItem, profitPerItem, marginPct, roiPct, iskPerHour,
     shippingIn, shippingOut, shippingInPerItem, shippingOutPerItem, salesTax, brokerFee,
     totalJobTime, treeDepth } and tree is the recursive node structure:
   { tid, name, decision:'buy'|'build', qty, buyCost, buildCost, cost, forced?, depthCapped?, note?,
     job:{activity, facilityLabel, runs, time, eiv, costBreakdown:{sciGross,bonus,scc,tax},
          matModifierBreakdown:{bpMe,structMe,rigMe,bpTe,structTe,rigTe}},
     invention?:{decryptor, chance, attemptsPerSuccess, bpcRuns, me, te, costPerSuccess, perUnit, options:[...]},
     children:[...] }.

   Documented v1 simplifications (kept deliberately, noted for v2):
   - iskPerHour divides profit by the SUM of chosen-tree build-job times (not the critical
     path, no parallelism); invention/copy job times are excluded from that sum.
   - Facility choice per activity = FIRST profile facility listing that activity.
   - Memoization key is (tid, qty); diamond dependencies with equal quantities share one
     resolved node object (the result tree is a DAG at those points).
   - Invented-BPC run limits do not split manufacturing jobs; job fees assume one job.
   - Invention & copy EIV use the T1 blueprint's manufacturing materials (1 run).
   - Invention consumables (datacores/decryptors/copies) are amortized into cost but are
     NOT added to the inbound shipping haul.
   - Input-side broker fees for placing buy orders are not modeled (raw quote is used). */
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
    var shipping = profile.shipping || null;
    var assume = profile.assumptions || {};
    var ownedMe = assume.ownedBpoMe != null ? assume.ownedBpoMe : 10;
    var ownedTe = assume.ownedBpoTe != null ? assume.ownedBpoTe : 20;
    var sccPct = assume.sccPct != null ? assume.sccPct : 4;

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

    /* Best matching rig bonuses (max per attribute across matching rigs). */
    function rigBonuses(facility, productTid) {
      var out = { me: 0, te: 0, cost: 0 };
      if (!facility || !facility.rigs) return out;
      var anc = ancestrySet(productTid);
      for (var i = 0; i < facility.rigs.length; i++) {
        var rig = facility.rigs[i];
        var match = Array.isArray(rig.match) ? rig.match : [rig.match];
        var hit = false;
        for (var j = 0; j < match.length; j++) if (anc.has(match[j])) { hit = true; break; }
        if (!hit) continue;
        out.me = Math.max(out.me, rig.me || 0);
        out.te = Math.max(out.te, rig.te || 0);
        out.cost = Math.max(out.cost, rig.cost || 0);
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
      return (p == null || !(p > 0)) ? null : p;
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
        rigCostBonusPct: rigBonuses(fac, t1bp.man.p[0][0]).cost,
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
          rigCostBonusPct: rigBonuses(fac, t1bp.man.p[0][0]).cost,
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
      var rig = rigBonuses(fac, tid);
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
                                    bpTe: v.te, structTe: structB.te || 0, rigTe: rig.te },
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
      var unitBuy = inputUnitPrice(tid);
      var buyCost = unitBuy != null ? unitBuy * qty : null;
      var forced = ctx.forceBuy.has(tid) ? 'buy' : ctx.forceBuild.has(tid) ? 'build' : null;
      var capped = false, built = null;
      if (productToBp.has(tid) && forced !== 'buy') {
        if (depth >= ctx.maxDepth) capped = true;
        else built = buildFor(tid, qty, depth, ctx);
      }
      var node = { tid: tid, name: typeName(tid), qty: qty, buyCost: buyCost,
                   buildCost: built ? built.buildCost : null, children: built ? built.children : [] };
      if (built) { node.job = built.job; if (built.invention) node.invention = built.invention; }
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

    function evaluate(productTid, opts) {
      opts = opts || {};
      var pe = productToBp.get(productTid);
      if (!pe) throw new Error('IndustryEngine: no blueprint produces type ' + productTid);
      var ctx = {
        runs: opts.runs != null ? opts.runs : 1,
        maxDepth: opts.maxDepth != null ? opts.maxDepth : (params.maxDepth != null ? params.maxDepth : 10),
        forceBuy: opts.forceBuy || new Set(), forceBuild: opts.forceBuild || new Set(),
        meOverride: opts.meOverride, teOverride: opts.teOverride,
        noInvention: !!opts.noInvention,
        memo: new Map(), stats: { nodesResolved: 0, memoHits: 0 },
      };
      var produced = pe.qtyPerRun * ctx.runs;
      var built = buildFor(productTid, produced, 0, ctx);
      if (!built) throw new Error('IndustryEngine: no facility supports activity "' + pe.activity + '"');
      var root = { tid: productTid, name: typeName(productTid), decision: 'build', qty: produced,
                   buyCost: null, buildCost: built.buildCost, cost: built.buildCost,
                   job: built.job, children: built.children };
      var q = prices(productTid);
      root.buyCost = q && q.sell != null ? q.sell * produced : null; // informational
      if (built.invention) root.invention = built.invention;

      var acc = { boughtM3: 0, boughtCost: 0, jobTime: 0, maxDepth: 0 };
      walkChosen(root, 0, acc);

      var grossUnit = q ? (market.outputSide === 'instant' ? q.buy : q.sell) : null;
      var revenueUnit = null, salesTax = 0, brokerFee = 0;
      if (grossUnit != null) {
        salesTax = grossUnit * produced * (market.taxPct || 0) / 100;
        if (market.outputSide === 'instant') {
          revenueUnit = grossUnit * (1 - (market.taxPct || 0) / 100);
        } else {
          brokerFee = grossUnit * produced * (market.brokerPct || 0) / 100;
          revenueUnit = grossUnit * (1 - (market.brokerPct || 0) / 100 - (market.taxPct || 0) / 100);
        }
      }
      var shipIn = shipping && shipping.applyInbound && acc.boughtM3 > 0
        ? shipCost(acc.boughtM3, acc.boughtCost) : 0;
      var shipOut = shipping && shipping.applyOutbound && grossUnit != null
        ? shipCost(typeVol(productTid) * produced, grossUnit * produced) : 0;

      var costPerItem = (built.buildTotalForProduced + shipIn + shipOut) / produced;
      var profitPerItem = revenueUnit != null ? revenueUnit - costPerItem : null;
      var hours = acc.jobTime / 3600;
      return {
        tid: productTid, name: root.name, produced: produced, runs: ctx.runs,
        totals: {
          costPerItem: costPerItem,
          revenuePerItem: revenueUnit,
          profitPerItem: profitPerItem,
          marginPct: profitPerItem != null && revenueUnit ? profitPerItem / revenueUnit * 100 : null,
          roiPct: profitPerItem != null && costPerItem ? profitPerItem / costPerItem * 100 : null,
          // v1: profit ÷ SUM of chosen-tree build-job hours (not critical path)
          iskPerHour: profitPerItem != null && hours > 0 ? profitPerItem * produced / hours : null,
          shippingIn: shipIn, shippingOut: shipOut,
          shippingInPerItem: shipIn / produced, shippingOutPerItem: shipOut / produced,
          salesTax: salesTax, brokerFee: brokerFee,
          totalJobTime: acc.jobTime, treeDepth: acc.maxDepth,
        },
        tree: root, stats: ctx.stats,
      };
    }

    return { evaluate: evaluate };
  }

  var IndustryEngine = { create: create, matQty: matQty, jobCost: jobCost, DECRYPTORS: DECRYPTORS };
  if (typeof window !== 'undefined') window.IndustryEngine = IndustryEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = IndustryEngine;
})();
