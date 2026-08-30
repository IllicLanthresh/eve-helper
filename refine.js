/* EveRefine — THE refine-yield model, shared by every tool.

   One formula, one place. The Mine tool displays it per ore; the Industry tool prices
   compressed-ore input sourcing with it. Two pages computing refine yield from their own
   copies of the formula is the class of bug this project exists to kill (the Sell tool's
   "ONE clearing time" precedent), so mine.html delegates here rather than keeping its own.

     yield% = facilityBase × (1 + 3% × Reprocessing) × (1 + 2% × Reprocessing Efficiency)
              × (1 + 2% × the type's exact reprocessing skill) × (1 + implant%)

     facilityBase: NPC station = flat 50% (stations have no rigs, so rig/security never
     apply there); player structure = type base (Athanor 52 / Tatara 55 / any other
     structure 50) × (1 + rigBonus × securityMultiplier)

   Loadable as a browser script (window.EveRefine) or in Node (module.exports) — the
   same dual shape industry-engine.js uses, so the formula can be pinned by a Node test.
   ZERO DOM access, zero fetches: every input is caller-provided. */
'use strict';
(function(){
  const FACILITY_BASE = { npc: 50, athanor: 52, tatara: 55 };
  const RIG_BONUS = { none: 0, t1: 0.01, t2: 0.03 };
  const SEC_MULT = { hs: 1, ls: 1.06, ns: 1.12 };
  // security band from the system's security_status, rounded to 1 decimal like the client
  const secBandOf = sec => {
    const r = Math.round(sec * 10) / 10;
    return r >= 0.5 ? 'hs' : r >= 0.1 ? 'ls' : 'ns';
  };

  /* Facility base %, before any skills.
     fac = null | { npc:true } → the NPC flat 50.
     fac = { refinery:'athanor'|'tatara'|null, rig:'none'|'t1'|'t2', sec:'hs'|'ls'|'ns' }
     — a non-refinery player structure carries refinery null and bases at 50 like the
     original mine.html rule (FACILITY_BASE[refinery || 'npc']). */
  function basePct(fac){
    if (!fac || fac.npc) return FACILITY_BASE.npc;
    const typeBase = FACILITY_BASE[fac.refinery || 'npc'];
    const rig = RIG_BONUS[fac.rig] != null ? fac.rig : 'none';
    const mult = SEC_MULT[fac.sec] != null ? SEC_MULT[fac.sec] : SEC_MULT.hs;
    return typeBase * (1 + RIG_BONUS[rig] * mult);
  }

  /* The full multiply, in the ONE canonical order — every caller goes through here so a
     reordering can never make two pages disagree in the last decimal. skills carries the
     names auth.js stores: { reprocessing, reprocessingEfficiency }. */
  function pct(base, skills, groupLevel, implantPct){
    return base * (1 + 0.03 * skills.reprocessing) * (1 + 0.02 * skills.reprocessingEfficiency)
      * (1 + 0.02 * groupLevel) * (1 + implantPct / 100);
  }

  /* { pct, detail } for one type whose EXACT reprocessing skill (ores.json "s") is the
     given name/tid — the model mine.html's refineWithSkill has always been, verbatim,
     including the detail strings its tests and owner read.

     env = {
       charSkills,        // auth.js skills blob {reprocessing, reprocessingEfficiency,
                          //   groups:{skillName:level}} or null
       base,              // facility base % (basePct above)
       implantPct,        // 0/1/2/4
       flatPct,           // fallback yield % when skills are unusable — or null, which
                          //   makes the fallback a refusal (pct null) instead of a guess:
                          //   no assumed yield may ever steer a displayed cost
       allSkills,         // () => {tid: level}|null — full trained list, for skills
                          //   outside the ore-group import (Ice Processing, legacy ores)
     } */
  function yieldFor(skillName, skillTid, env){
    const cs = env.charSkills;
    if (!cs || !cs.groups || !Object.keys(cs.groups).length){
      return env.flatPct != null
        ? { pct: env.flatPct, detail: 'flat refine (log in with EVE for per-ore yields)' }
        : { pct: null, detail: 'skills unavailable — no yield assumed' };
    }
    const base = env.base;
    let gl = 0, grpTxt, known = true;
    if (skillTid == null){
      grpTxt = 'no reprocessing skill on this type in the SDE — counted at level 0';
      known = null;                     // there is no skill whose level could be known
    } else if (cs.groups[skillName] != null){
      gl = cs.groups[skillName];
      grpTxt = `${skillName} ${gl}`;
    } else {
      const all = env.allSkills ? env.allSkills() : null;
      gl = all ? (all[skillTid] || 0) : 0;
      grpTxt = `${skillName} ${gl}${all ? '' : ' (level unknown — refresh skills via the topbar)'}`;
      known = !!all;
    }
    const p = pct(base, cs, gl, env.implantPct);
    const detail = `${Math.round(p * 10) / 10}% = base ${Math.round(base * 100) / 100}% × Reprocessing ${cs.reprocessing} × Efficiency ${cs.reprocessingEfficiency} × ${grpTxt}${env.implantPct ? ` × implant +${env.implantPct}%` : ''}`;
    return { pct: p, detail, level: gl, levelKnown: known };
  }

  /* Outputs of reprocessing `portions` whole portions of an ore at `pct` yield.
     materials = the ores.json "m" list [[tid, qtyPerPortion], ...].
     NEEDS-VERIFICATION in-client: assumed floor(qtyPerPortion × portions × yield) per
     material — the same per-quantity floor the client shows in the reprocess window.
     The Mine tool deliberately does NOT use this: its per-m³ values are continuous
     RATES, not a batch, and the two readings are both stated in DECISIONS.md. */
  function outputsFor(materials, portions, pctVal){
    return materials.map(([tid, q]) => [tid, Math.floor(q * portions * pctVal / 100)]);
  }

  /* Live-config instance for a page: accessors are read on every call so a structure
     record edited in the manager, or a skills refresh, is picked up without any
     snapshot going stale (the structures.js "facts stay on the record" rule). */
  function create(cfg){
    const env = () => ({
      charSkills: cfg.getSkills ? cfg.getSkills() : null,
      base: basePct(cfg.getFacility ? cfg.getFacility() : null),
      implantPct: cfg.getImplantPct ? (cfg.getImplantPct() || 0) : 0,
      flatPct: cfg.getFlatPct ? cfg.getFlatPct() : null,
      allSkills: cfg.getAllSkills || null,
    });
    return {
      basePct: () => (cfg.getFacility && cfg.getFacility()) ? basePct(cfg.getFacility()) : null,
      yieldFor: (skillName, skillTid) => yieldFor(skillName, skillTid, env()),
      explain: (skillName, skillTid) => yieldFor(skillName, skillTid, env()).detail,
    };
  }

  const EveRefine = {
    FACILITY_BASE, RIG_BONUS, SEC_MULT, secBandOf,
    basePct, pct, yieldFor, outputsFor, create,
  };
  if (typeof window !== 'undefined') window.EveRefine = EveRefine;
  if (typeof module !== 'undefined' && module.exports) module.exports = EveRefine;
})();
