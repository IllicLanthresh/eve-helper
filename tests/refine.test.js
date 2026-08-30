/* refine.js (EveRefine) as a pure module — THE refine-yield formula, pinned.

   mine.html used to hold this formula inline (twice); the Industry tool's ore sourcing
   needed it too, so it moved to refine.js and both pages delegate. This suite pins the
   extracted module against the LITERAL legacy formula over the whole input matrix, and
   pins the detail strings byte-for-byte — the extraction is only safe while a failure
   here is impossible. mine-fleet.test.js runs unchanged as the page-level guard. */
'use strict';
const path = require('path');
const H = require('./helper');
const { check, eq, near, section } = H;

const R = require(path.join(H.REPO, 'refine.js'));

(async () => {
  section('the constants are the ones the client uses');
  eq('NPC station base', R.FACILITY_BASE.npc, 50);
  eq('Athanor base', R.FACILITY_BASE.athanor, 52);
  eq('Tatara base', R.FACILITY_BASE.tatara, 55);
  eq('T1 rig', R.RIG_BONUS.t1, 0.01);
  eq('T2 rig', R.RIG_BONUS.t2, 0.03);
  eq('lowsec rig multiplier', R.SEC_MULT.ls, 1.06);
  eq('nullsec rig multiplier', R.SEC_MULT.ns, 1.12);

  section('the security band rounds to 1 decimal like the client');
  eq('0.45 rounds to 0.5 — highsec', R.secBandOf(0.45), 'hs');
  eq('0.44 rounds to 0.4 — lowsec', R.secBandOf(0.44), 'ls');
  eq('0.05 rounds to 0.1 — lowsec', R.secBandOf(0.05), 'ls');
  eq('0.04 rounds to 0.0 — nullsec', R.secBandOf(0.04), 'ns');
  eq('-0.42 — nullsec', R.secBandOf(-0.42), 'ns');

  section('facility base over the whole matrix, vs the literal legacy formula');
  const FB = { npc: 50, athanor: 52, tatara: 55 };
  const RB = { none: 0, t1: 0.01, t2: 0.03 };
  const SM = { hs: 1, ls: 1.06, ns: 1.12 };
  eq('null facility is the NPC 50', R.basePct(null), 50);
  eq('npc:true is the NPC 50', R.basePct({ npc: true }), 50);
  let baseMax = 0;
  for (const refinery of ['athanor', 'tatara', null])
    for (const rig of ['none', 't1', 't2'])
      for (const sec of ['hs', 'ls', 'ns']){
        const want = FB[refinery || 'npc'] * (1 + RB[rig] * SM[sec]);
        const got = R.basePct({ refinery, rig, sec });
        baseMax = Math.max(baseMax, Math.abs(got - want));
      }
  check('every refinery×rig×sec cell matches the legacy formula to 1e-12',
    baseMax < 1e-12, String(baseMax));
  // the mine.html rule: a non-refinery player structure bases at 50, rigs still scale
  near('a non-refinery hull with a T2 rig in nullsec', R.basePct({ refinery: null, rig: 't2', sec: 'ns' }),
    50 * (1 + 0.03 * 1.12), 1e-12);
  // defensive fallbacks never throw, they degrade to none/hs
  near('an unknown rig tier counts as none', R.basePct({ refinery: 'tatara', rig: 'wat', sec: 'hs' }), 55, 1e-12);
  near('an unknown sec band counts as highsec', R.basePct({ refinery: 'tatara', rig: 't1', sec: 'wat' }),
    55 * 1.01, 1e-12);

  section('the full multiply over skills × implant, vs the literal legacy formula');
  let pctMax = 0;
  for (const rep of [0, 1, 3, 5])
    for (const eff of [0, 2, 4, 5])
      for (const gl of [0, 1, 4, 5])
        for (const imp of [0, 1, 2, 4]){
          const base = R.basePct({ refinery: 'tatara', rig: 't2', sec: 'ns' });
          const want = base * (1 + 0.03 * rep) * (1 + 0.02 * eff) * (1 + 0.02 * gl) * (1 + imp / 100);
          const got = R.pct(base, { reprocessing: rep, reprocessingEfficiency: eff }, gl, imp);
          pctMax = Math.max(pctMax, Math.abs(got - want));
        }
  check('every skills×implant cell matches to 1e-12', pctMax < 1e-12, String(pctMax));

  section('yieldFor: the per-type model mine.html always had, detail strings pinned');
  const cs = { reprocessing: 5, reprocessingEfficiency: 4, groups: { 'Simple Ore Processing': 5 } };
  const base = R.basePct({ refinery: 'tatara', rig: 't2', sec: 'ns' });   // 56.848
  near('the base itself', base, 55 * (1 + 0.03 * 1.12), 1e-12);
  const y1 = R.yieldFor('Simple Ore Processing', 60377,
    { charSkills: cs, base, implantPct: 4, flatPct: 50, allSkills: null });
  near('yield with everything trained', y1.pct,
    base * 1.15 * 1.08 * 1.10 * 1.04, 1e-9);
  eq('...and the detail string is byte-identical to the legacy one', y1.detail,
    '80.8% = base 56.85% × Reprocessing 5 × Efficiency 4 × Simple Ore Processing 5 × implant +4%');
  const y0 = R.yieldFor(null, null, { charSkills: cs, base, implantPct: 0, flatPct: 50, allSkills: null });
  eq('a type with no skill in the SDE counts at level 0, and says so', y0.detail,
    `${Math.round(y0.pct * 10) / 10}% = base 56.85% × Reprocessing 5 × Efficiency 4 × no reprocessing skill on this type in the SDE — counted at level 0`);
  near('...at the level-0 multiply', y0.pct, base * 1.15 * 1.08, 1e-9);
  const yTid = R.yieldFor('Ice Processing', 18025,
    { charSkills: cs, base, implantPct: 0, flatPct: 50, allSkills: () => ({ 18025: 3 }) });
  near('a skill outside the group import resolves by tid', yTid.pct, base * 1.15 * 1.08 * 1.06, 1e-9);
  check('...naming the skill and level', /Ice Processing 3/.test(yTid.detail), yTid.detail);
  eq('...and the level is known', yTid.levelKnown, true);
  const yUnk = R.yieldFor('Ice Processing', 18025,
    { charSkills: cs, base, implantPct: 0, flatPct: 50, allSkills: () => null });
  check('with no full skill list the level is 0 and marked unknown',
    /Ice Processing 0 \(level unknown — refresh skills via the topbar\)/.test(yUnk.detail), yUnk.detail);
  eq('...flagged', yUnk.levelKnown, false);

  section('the two fallback gates: flat is a value, refusal is a null');
  const flat = R.yieldFor('x', 1, { charSkills: null, base, implantPct: 0, flatPct: 55, allSkills: null });
  eq('skills absent + flat set = the flat value', flat.pct, 55);
  eq('...with the legacy flat detail', flat.detail, 'flat refine (log in with EVE for per-ore yields)');
  const refuse = R.yieldFor('x', 1, { charSkills: null, base, implantPct: 0, flatPct: null, allSkills: null });
  eq('skills absent + flat null = NO yield — a guess never steers a cost', refuse.pct, null);
  const empty = R.yieldFor('x', 1,
    { charSkills: { reprocessing: 5, reprocessingEfficiency: 5, groups: {} }, base, implantPct: 0, flatPct: null });
  eq('an empty groups map is the same absence', empty.pct, null);

  section('outputsFor floors per material — the batch reading, not the Mine rate');
  eq('7 portions of Plagioclase at 55.2%: floor per output',
    JSON.stringify(R.outputsFor([[34, 175], [36, 70]], 7, 55.2)),
    JSON.stringify([[34, Math.floor(175 * 7 * 0.552)], [36, Math.floor(70 * 7 * 0.552)]]));
  eq('a yield of zero floors to zero everywhere',
    JSON.stringify(R.outputsFor([[34, 175]], 3, 0)), JSON.stringify([[34, 0]]));

  section('create() reads its accessors live');
  let rig = 't1';
  const inst = R.create({
    getFacility: () => ({ refinery: 'tatara', rig, sec: 'hs' }),
    getSkills: () => cs,
    getAllSkills: () => null,
    getImplantPct: () => 0,
    getFlatPct: () => null,
  });
  const before = inst.yieldFor('Simple Ore Processing', 60377).pct;
  rig = 't2';
  const after = inst.yieldFor('Simple Ore Processing', 60377).pct;
  check('a rig upgrade on the record moves the next call', after > before, `${before} -> ${after}`);
  near('...by exactly the rig delta', after / before,
    (55 * 1.03) / (55 * 1.01), 1e-12);
  eq('explain() is the detail string', inst.explain('Simple Ore Processing', 60377),
    inst.yieldFor('Simple Ore Processing', 60377).detail);

  H.finish('refine');
})().catch(e => { console.error(e); process.exit(1); });
