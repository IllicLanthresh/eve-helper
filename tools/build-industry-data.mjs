#!/usr/bin/env node
// build-industry-data.mjs
// Converts CCP's EVE Static Data Export (SDE, classic YAML layout) into one
// compact JSON blob (data/industry.json) consumed by the industry tools.
//
// Usage:
//   node --max-old-space-size=4096 tools/build-industry-data.mjs \
//     --sde /path/to/extracted-sde --out data/industry.json
//
// The --sde directory must contain the classic layout files:
//   fsd/blueprints.yaml, fsd/types.yaml, fsd/groups.yaml, fsd/marketGroups.yaml
// (types.yaml is ~150MB; it is stream-parsed entry-by-entry so the default
//  node heap is normally enough — the flag above is just headroom.)
//
// Output schema (fixed; the in-browser calc engine is written against it):
// {
//   "v": "<sde version (blueprints.yaml mtime date, or $SDE_VERSION)>",
//   "types": { "<tid>": [name, volume, packagedVolume|null, groupId, marketGroupId|0, metaGroupId|0] },
//   "groups": { "<gid>": [name, categoryId] },
//   "marketGroups": { "<mgid>": [name, parentId|0] },
//   "skills": { "<tid>": name },
//   "blueprints": { "<bpid>": {
//       "limit": maxProductionLimit,
//       "man"?: { "t": seconds, "m": [[tid,qty],...], "p": [[tid,qty],...], "s": [[skillTid,lvl],...] },
//       "rea"?: { ...same shape... },                     // post-2019 reactions live in blueprints.yaml
//       "cop"?: { "t": seconds },
//       "inv"?: { "t": seconds, "m": [[tid,qty],...], "p": [[producedBpid,runs,probability],...], "s": [[skillTid,lvl],...] },
//       "me"?:  { "t": seconds },                         // research_material
//       "te"?:  { "t": seconds }                          // research_time
//   } },
//   "rigs": { "<tid>": {
//       "n": name, "sz": "M"|"L"|"XL",
//       "me": %, "te": %, "cost": %,                      // base bonuses, POSITIVE numbers
//       "sec": { "hs": mult, "ls": mult, "ns": mult },    // security-band multipliers
//       "scope": [groupIds] | null,                       // products affected; null = any product
//                                                         //   (activity-wide rigs, e.g. lab rigs)
//       "act": ["man"|"rea"|"inv"|"cop"|"me"|"te", ...],  // activities the rig bonuses apply to
//       "fit": [structure groupIds],                      // which structure GROUPS accept it
//       "dom": domain label,                              // human bucket ("Basic Small Ships", …)
//       "thuk"?: { "me": %, "scope": [gids] },            // Thukker rigs: LOWSEC-only enhanced ME
//                                                         //   replacing `me` for these products
//       "unk"?: 1                                         // extraction could not scope this rig —
//   } },                                                  //   listed but flagged, treat as inert
//   "structures": { "<tid>": [name, groupId, "M"|"L"|"XL", rigSlots] }
// }
// `types` contains ONLY tids referenced by blueprint activities (materials,
// products, the blueprint itself) plus every skill tid; `groups`/`marketGroups`
// contain only the entries reachable from those types (market group parent
// chains are walked to the root).
// `rigs` covers every published Standup ENGINEERING and REACTOR rig (the rigs
// that modify industry jobs); combat/drilling/reprocessing rigs are skipped.
// `structures` covers the industry-capable Upwell hulls (engineering complexes,
// refineries, citadels) with their rig size and rig slot count from dogma.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

// ---------------------------------------------------------------------------
// Repackaged (packaged) volumes by ship groupID.
// The SDE's types.yaml only carries the ASSEMBLED volume for ships; the client
// applies a fixed per-group repackaged volume when a ship is packaged. This is
// the canonical table (same data fuzzwork ships as invVolumes / the values in
// the EVE client). Types in any other group repackage to their listed volume,
// so packagedVolume is null for them.
// ---------------------------------------------------------------------------
const PACKAGED_VOLUME_BY_GROUP = {
  31: 500,        // Shuttle
  1022: 500,      // Prototype Exploration Ship (Zephyr)
  25: 2500,       // Frigate
  237: 2500,      // Corvette (rookie ship)
  324: 2500,      // Assault Frigate
  830: 2500,      // Covert Ops
  831: 2500,      // Interceptor
  834: 2500,      // Stealth Bomber
  893: 2500,      // Electronic Attack Ship
  1283: 2500,     // Expedition Frigate
  1527: 2500,     // Logistics Frigate
  1972: 2500,     // Flag Cruiser (Monitor)
  463: 3750,      // Mining Barge
  543: 3750,      // Exhumer
  420: 5000,      // Destroyer
  541: 5000,      // Interdictor
  1305: 5000,     // Tactical Destroyer
  1534: 5000,     // Command Destroyer
  963: 5000,      // Strategic Cruiser
  26: 10000,      // Cruiser
  358: 10000,     // Heavy Assault Cruiser
  832: 10000,     // Logistics
  833: 10000,     // Force Recon Ship
  894: 10000,     // Heavy Interdiction Cruiser
  906: 10000,     // Combat Recon Ship
  419: 15000,     // Combat Battlecruiser
  540: 15000,     // Command Ship
  1201: 15000,    // Attack Battlecruiser
  28: 20000,      // Industrial
  380: 20000,     // Deep Space Transport
  1202: 20000,    // Blockade Runner
  27: 50000,      // Battleship
  381: 50000,     // Elite Battleship
  898: 50000,     // Black Ops
  900: 50000,     // Marauder
  941: 500000,    // Industrial Command Ship (Orca, Porpoise)
  485: 1000000,   // Dreadnought
  547: 1000000,   // Carrier
  659: 1000000,   // Supercarrier
  883: 1000000,   // Capital Industrial Ship (Rorqual)
  1538: 1000000,  // Force Auxiliary
  4594: 1000000,  // Lancer Dreadnought
  513: 1050000,   // Freighter
  902: 1050000,   // Jump Freighter
  30: 10000000,   // Titan
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const sdeDir = arg('--sde');
const outFile = arg('--out', 'data/industry.json');
if (!sdeDir) {
  console.error('Usage: node tools/build-industry-data.mjs --sde <extracted-sde-dir> [--out data/industry.json]');
  process.exit(2);
}
const fsd = (f) => path.join(sdeDir, 'fsd', f);
for (const f of ['blueprints.yaml', 'types.yaml', 'groups.yaml', 'marketGroups.yaml', 'typeDogma.yaml']) {
  if (!fs.existsSync(fsd(f))) {
    console.error(`Missing required SDE file: ${fsd(f)}`);
    process.exit(2);
  }
}

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ---------------------------------------------------------------------------
// 1. Blueprints (~4MB — full parse is fine)
// ---------------------------------------------------------------------------
log('parsing blueprints.yaml ...');
const rawBps = yaml.load(fs.readFileSync(fsd('blueprints.yaml'), 'utf8'));

const referencedTids = new Set(); // everything that must appear in `types`
const skillTids = new Set();

const pairList = (list, keyB) =>
  (list || []).map((e) => [e.typeID, e[keyB]]);

function matProdSkills(act) {
  const m = pairList(act.materials, 'quantity');
  const p = pairList(act.products, 'quantity');
  const s = (act.skills || []).map((e) => [e.typeID, e.level]);
  for (const [tid] of m) referencedTids.add(tid);
  for (const [tid] of p) referencedTids.add(tid);
  for (const [tid] of s) { referencedTids.add(tid); skillTids.add(tid); }
  return { m, p, s };
}

const blueprints = {};
let nMan = 0, nRea = 0, nInv = 0;
for (const [bpidStr, bp] of Object.entries(rawBps)) {
  const bpid = Number(bpidStr);
  referencedTids.add(bpid);
  const acts = bp.activities || {};
  const out = { limit: bp.maxProductionLimit ?? 1 };

  if (acts.manufacturing) {
    const { m, p, s } = matProdSkills(acts.manufacturing);
    out.man = { t: acts.manufacturing.time ?? 0, m, p, s };
    nMan++;
  }
  if (acts.reaction) {
    const { m, p, s } = matProdSkills(acts.reaction);
    out.rea = { t: acts.reaction.time ?? 0, m, p, s };
    nRea++;
  }
  if (acts.copying) out.cop = { t: acts.copying.time ?? 0 };
  if (acts.invention) {
    const inv = acts.invention;
    const m = pairList(inv.materials, 'quantity');
    const s = (inv.skills || []).map((e) => [e.typeID, e.level]);
    // invention products: [producedBpid, runs (SDE quantity), probability]
    const p = (inv.products || []).map((e) => [e.typeID, e.quantity, e.probability ?? 1]);
    for (const [tid] of m) referencedTids.add(tid);
    for (const [tid] of p) referencedTids.add(tid);
    for (const [tid] of s) { referencedTids.add(tid); skillTids.add(tid); }
    out.inv = { t: inv.time ?? 0, m, p, s };
    nInv++;
  }
  if (acts.research_material) out.me = { t: acts.research_material.time ?? 0 };
  if (acts.research_time) out.te = { t: acts.research_time.time ?? 0 };

  blueprints[bpid] = out;
}
log(`blueprints: ${Object.keys(blueprints).length} total (man=${nMan}, rea=${nRea}, inv=${nInv}); referenced tids=${referencedTids.size}, skills=${skillTids.size}`);

// ---------------------------------------------------------------------------
// 1b. groups.yaml — parsed early: the types stream below needs the rig-group
//     and structure-group ids to know which extra (non-blueprint-referenced)
//     type entries to keep for the rig catalog.
// ---------------------------------------------------------------------------
log('parsing groups.yaml ...');
const rawGroups = yaml.load(fs.readFileSync(fsd('groups.yaml'), 'utf8'));

// Structure rig groups live in category 66 (Structure Module). Only the
// ENGINEERING and REACTOR rig families modify industry jobs — combat, drilling
// and reprocessing rigs are intentionally out of scope for the industry tool.
const RIG_GROUP_RE = /^Structure (?:Engineering|Composite Reactor|Hybrid Reactor|Biochemical Reactor|Reactor) Rig /;
const rigGroupIds = new Set();
let otherRigGroups = 0;
for (const [gidStr, g] of Object.entries(rawGroups)) {
  if ((g.categoryID ?? 0) !== 66) continue;
  const name = (g.name && g.name.en) || '';
  if (!/ Rig /.test(name) && !/Rigs$/.test(name)) continue;
  if (RIG_GROUP_RE.test(name)) rigGroupIds.add(Number(gidStr));
  else otherRigGroups++;
}
log(`rig groups: ${rigGroupIds.size} industry (engineering/reactor), ${otherRigGroups} non-industry skipped (combat/drilling/resource/legacy)`);

// Industry-capable Upwell structure groups: Engineering Complex, Refinery, Citadel.
const STRUCT_GROUP_IDS = new Set([1404, 1406, 1657]);

// ---------------------------------------------------------------------------
// 2. types.yaml (~150MB) — stream-parse one top-level entry at a time.
//    Top-level keys sit at column 0 (`123:`); every entry body is indented,
//    so a column-0 digit line safely delimits entries.
// ---------------------------------------------------------------------------
log('stream-parsing types.yaml ...');
const typesOut = {}; // tid -> [name, volume, packagedVolume|null, groupId, marketGroupId|0, metaGroupId|0]
const typeGroupIds = new Set();
const typeMarketGroupIds = new Set();
const rigTypes = {};    // tid -> {name, gid}   (published Standup engineering/reactor rigs)
const structTypes = {}; // tid -> {name, gid}   (published Upwell industry structures)
let typeCount = 0;

await new Promise((resolve, reject) => {
  const rl = readline.createInterface({
    input: fs.createReadStream(fsd('types.yaml'), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let curTid = null;
  let curLines = [];

  const flush = () => {
    if (curTid === null) return;
    typeCount++;
    // cheap pre-check: rig/structure entries are kept even when no blueprint
    // references them (Thukker rigs have no public blueprint, for example)
    let extraGid = 0;
    if (!referencedTids.has(curTid)) {
      for (const ln of curLines) {
        const g = /^\s{2}groupID: (\d+)\s*$/.exec(ln);
        if (g) { extraGid = Number(g[1]); break; }
      }
      if (!rigGroupIds.has(extraGid) && !STRUCT_GROUP_IDS.has(extraGid)) {
        curTid = null; curLines = [];
        return;
      }
    }
    let t;
    try {
      t = yaml.load(curLines.join('\n')) || {};
    } catch (e) {
      throw new Error(`YAML parse failed for typeID ${curTid}: ${e.message}`);
    }
    const gid = t.groupID ?? 0;
    const name = (t.name && (t.name.en || Object.values(t.name)[0])) || `type ${curTid}`;
    if (t.published) {
      if (rigGroupIds.has(gid) && /^Standup /.test(name)) rigTypes[curTid] = { name, gid };
      if (STRUCT_GROUP_IDS.has(gid)) structTypes[curTid] = { name, gid };
    }
    if (referencedTids.has(curTid)) {
      typesOut[curTid] = [
        name,
        t.volume ?? 0,
        PACKAGED_VOLUME_BY_GROUP[gid] ?? null,
        gid,
        t.marketGroupID ?? 0,
        t.metaGroupID ?? 0,
      ];
      typeGroupIds.add(gid);
      if (t.marketGroupID) typeMarketGroupIds.add(t.marketGroupID);
    }
    curTid = null;
    curLines = [];
  };

  rl.on('line', (line) => {
    const m = /^(\d+):\s*$/.exec(line);
    if (m) {
      flush();
      curTid = Number(m[1]);
    } else if (curTid !== null) {
      curLines.push(line);
    }
  });
  rl.on('close', () => { flush(); resolve(); });
  rl.on('error', reject);
});
log(`types.yaml: ${typeCount} entries scanned, ${Object.keys(typesOut).length} kept`);

// ---------------------------------------------------------------------------
// 2b. Prune dead blueprints. A handful of SDE blueprints reference material/
//     product typeIDs that no longer exist in types.yaml (items removed from
//     the game while their blueprint entry lingered). Those blueprints are
//     unusable in-game and would leave dangling tid references in our output,
//     so drop them and then re-restrict `types` to what is still referenced.
// ---------------------------------------------------------------------------
const deadBps = [];
for (const [bpidStr, bp] of Object.entries(blueprints)) {
  let dead = !typesOut[bpidStr];
  for (const k of ['man', 'rea', 'inv']) {
    if (dead || !bp[k]) continue;
    for (const [tid] of bp[k].m) if (!typesOut[tid]) { dead = true; break; }
    if (!dead) for (const [tid] of bp[k].p) if (!typesOut[tid]) { dead = true; break; }
  }
  if (dead) { deadBps.push(bpidStr); delete blueprints[bpidStr]; }
}
if (deadBps.length) {
  log(`pruned ${deadBps.length} blueprints with typeIDs missing from types.yaml: ${deadBps.join(', ')}`);
  // Recompute the referenced-tid set from the surviving blueprints and drop
  // now-unreferenced types (incl. skills only used by pruned blueprints).
  const alive = new Set();
  skillTids.clear();
  for (const [bpidStr, bp] of Object.entries(blueprints)) {
    alive.add(Number(bpidStr));
    for (const k of ['man', 'rea', 'inv']) {
      if (!bp[k]) continue;
      for (const [tid] of bp[k].m) alive.add(tid);
      for (const [tid] of bp[k].p) alive.add(tid);
      for (const [tid] of bp[k].s) { alive.add(tid); skillTids.add(tid); }
    }
  }
  typeGroupIds.clear();
  typeMarketGroupIds.clear();
  for (const tidStr of Object.keys(typesOut)) {
    if (!alive.has(Number(tidStr))) { delete typesOut[tidStr]; continue; }
    typeGroupIds.add(typesOut[tidStr][3]);
    if (typesOut[tidStr][4]) typeMarketGroupIds.add(typesOut[tidStr][4]);
  }
}

// ---------------------------------------------------------------------------
// 3. skills — names for every skill tid seen in any `s` list
// ---------------------------------------------------------------------------
const skills = {};
for (const tid of [...skillTids].sort((a, b) => a - b)) {
  if (typesOut[tid]) skills[tid] = typesOut[tid][0];
  else log(`WARNING: skill tid ${tid} missing from types.yaml`);
}

// ---------------------------------------------------------------------------
// 4. groups + marketGroups (only entries reachable from included types;
//    market-group parent chains walked to the root)
// ---------------------------------------------------------------------------
log('parsing marketGroups.yaml ...');
const rawMg = yaml.load(fs.readFileSync(fsd('marketGroups.yaml'), 'utf8'));

const groups = {};
for (const gid of [...typeGroupIds].sort((a, b) => a - b)) {
  const g = rawGroups[gid];
  if (g) groups[gid] = [(g.name && g.name.en) || `group ${gid}`, g.categoryID ?? 0];
}

const marketGroups = {};
const addMgChain = (mgid) => {
  while (mgid && !marketGroups[mgid]) {
    const mg = rawMg[mgid];
    if (!mg) break;
    const parent = mg.parentGroupID ?? 0;
    marketGroups[mgid] = [(mg.nameID && mg.nameID.en) || `marketGroup ${mgid}`, parent];
    mgid = parent;
  }
};
for (const mgid of typeMarketGroupIds) addMgChain(mgid);

// ---------------------------------------------------------------------------
// 4b. typeDogma.yaml (~26MB) — stream-parse, keeping only the rig/structure
//     entries. Attribute ids were identified empirically by inspecting known
//     rigs' typeDogma entries and cross-checked against fsd/dogmaAttributes.yaml
//     (verified again below when that file is present):
//       2593 attributeEngRigTimeBonus   — engineering-rig time bonus, % (negative)
//       2594 attributeEngRigMatBonus    — engineering-rig material bonus, % (negative)
//       2595 attributeEngRigCostBonus   — engineering-rig job-cost bonus, % (negative)
//       2713 RefRigTimeBonus            — REACTOR-rig time bonus, % (negative)
//       2714 RefRigMatBonus             — REACTOR-rig material bonus, % (negative)
//       2653 attributeThukkerEngRigMatBonus — Thukker rigs' LOWSEC material bonus
//       2355 hiSecModifier / 2356 lowSecModifier / 2357 nullSecModifier
//            — per-security-band bonus multipliers (reactor rigs carry no 2355:
//              reactions cannot run in highsec)
//       1547 rigSize (2=M, 3=L, 4=XL) — on rigs AND on structures
//       1137 rigSlots                  — rig slot count on structures (3 for all)
//       1298-1301 canFitShipGroup01-04 — structure GROUP ids accepting the rig
// ---------------------------------------------------------------------------
log('stream-parsing typeDogma.yaml ...');
const DOGMA_WANT = new Set([1137, 1298, 1299, 1300, 1301, 1547, 2355, 2356, 2357, 2593, 2594, 2595, 2653, 2713, 2714]);
const dogmaTids = new Set([...Object.keys(rigTypes), ...Object.keys(structTypes)].map(Number));
const dogmaOf = {}; // tid -> {attrId: value}

await new Promise((resolve, reject) => {
  const rl = readline.createInterface({
    input: fs.createReadStream(fsd('typeDogma.yaml'), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let curTid = null;
  let curLines = [];
  const flushD = () => {
    if (curTid === null) return;
    if (dogmaTids.has(curTid)) {
      const attrs = {};
      const txt = curLines.join('\n');
      const re = /attributeID: (\d+)\n\s+value: (-?[\d.]+)/g;
      let m;
      while ((m = re.exec(txt))) {
        const a = Number(m[1]);
        if (DOGMA_WANT.has(a)) attrs[a] = Number(m[2]);
      }
      dogmaOf[curTid] = attrs;
    }
    curTid = null;
    curLines = [];
  };
  rl.on('line', (line) => {
    const m = /^(\d+):\s*$/.exec(line);
    if (m) {
      flushD();
      curTid = Number(m[1]);
    } else if (curTid !== null && dogmaTids.has(curTid)) {
      curLines.push(line);
    }
  });
  rl.on('close', () => { flushD(); resolve(); });
  rl.on('error', reject);
});
log(`typeDogma.yaml: dogma kept for ${Object.keys(dogmaOf).length}/${dogmaTids.size} rig/structure types`);

// hard-verify the attribute ids against dogmaAttributes.yaml when it is there
// (guards against CCP renumbering dogma attributes in a future SDE)
if (fs.existsSync(fsd('dogmaAttributes.yaml'))) {
  const EXPECT = {
    1137: 'rigSlots', 1298: 'canFitShipGroup01', 1547: 'rigSize',
    2355: 'hiSecModifier', 2356: 'lowSecModifier', 2357: 'nullSecModifier',
    2593: 'attributeEngRigTimeBonus', 2594: 'attributeEngRigMatBonus',
    2595: 'attributeEngRigCostBonus', 2653: 'attributeThukkerEngRigMatBonus',
    2713: 'RefRigTimeBonus', 2714: 'RefRigMatBonus',
  };
  const txt = fs.readFileSync(fsd('dogmaAttributes.yaml'), 'utf8');
  for (const [aid, want] of Object.entries(EXPECT)) {
    const m = new RegExp(`^${aid}:\\n(?:  .*\\n)*?  name: (.+)$`, 'm').exec(txt);
    const got = m ? m[1].trim() : '(missing)';
    if (got !== want) {
      console.error(`FATAL: dogma attribute ${aid} is "${got}", expected "${want}" — rig extraction assumptions broke`);
      process.exit(1);
    }
  }
  log('dogmaAttributes.yaml: all rig attribute ids verified by name');
} else {
  log('WARNING: fsd/dogmaAttributes.yaml not present — skipping attribute-id name verification');
}

// ---------------------------------------------------------------------------
// 4c. Rig catalog. Bonus values come from dogma; APPLICABILITY (which products
//     a rig affects) is not machine-readable dogma, so it is derived from the
//     rig NAME via the curated table below. Every scope list was written from
//     the rigs' own SDE description texts ("...decrease material requirements
//     for manufacturing frigates, destroyers and shuttles..."), which spell the
//     affected product families out; entries where the description is vague
//     carry a VERIFY comment.
// ---------------------------------------------------------------------------

// product groups actually produced by man/rea blueprints, bucketed by category
const prodTids = new Set();
for (const bp of Object.values(blueprints))
  for (const k of ['man', 'rea'])
    if (bp[k]) for (const [tid] of bp[k].p) prodTids.add(tid);
const prodGroupsByCat = new Map(); // categoryId -> Set(groupId)
for (const tid of prodTids) {
  const row = typesOut[tid];
  if (!row) continue;
  const gid = row[3];
  const cat = rawGroups[gid] ? (rawGroups[gid].categoryID ?? 0) : 0;
  if (!prodGroupsByCat.has(cat)) prodGroupsByCat.set(cat, new Set());
  prodGroupsByCat.get(cat).add(gid);
}
const catGroups = (...cats) => {
  const out = [];
  for (const c of cats) for (const g of prodGroupsByCat.get(c) || []) out.push(g);
  return out.sort((a, b) => a - b);
};

// --- scope building blocks (groupIds; the engine matches product groupId OR
//     market-group ancestors, we use groupIds throughout for precision) -------
const SCOPES = {
  // "ship modules, ship rigs, personal deployables, implants and cargo containers"
  // cat 7 = Module (incl. ship rigs), cat 22 = Deployable; implants = the
  // implant-category groups MINUS Boosters (g303 — the description says
  // implants only; VERIFY: boosters are widely reported to get no rig bonus);
  // containers = the cat-2 container groups (VERIFY: the 4 container groups
  // below are the manufacturable ones; other cat-2 oddities like outpost
  // platforms / cyno fields excluded).
  equip: [...catGroups(7, 22), 300, 740, 1230, 12, 340, 448, 649].sort((a, b) => a - b),
  // "ammunition, charges and scripts" — cat 8 (Charge) incl. mining crystals,
  // scripts, nanite paste and Standup structure ammo (all category Charge)
  ammo: catGroups(8),
  // "drones and fighters" — cat 18 (Drone) + cat 87 (Fighter, incl. Standup
  // structure fighters; VERIFY: structure fighters assumed to count as fighters)
  droneFighter: catGroups(18, 87),
  // ships — curated hull groupId lists straight from the rig descriptions
  basicSmall: [25, 31, 237, 420],                    // frigate, shuttle, corvette, destroyer
  advSmall: [324, 541, 830, 831, 834, 893, 1283, 1305, 1527, 1534], // T2 frig/dessie + T3 dessie
  basicMedium: [26, 28, 419, 463, 1201],             // cruiser, hauler, combat BC, barge, attack BC
  // "T2 cruisers, T2 battlecruisers, T2 haulers, T3 cruisers, T3 subsystems and exhumers"
  // (954/956-958 = subsystems; 1972 Flag Cruiser VERIFY — T2 cruiser hull, not
  //  named in the description but Monitor is not player-built from public BPOs)
  advMedium: [358, 380, 540, 543, 832, 833, 894, 906, 954, 956, 957, 958, 963, 1202, 1972],
  basicLarge: [27, 513, 941],                        // battleship, freighter, industrial command
  advLarge: [898, 900, 902],                         // black ops, marauder, jump freighter
  capital: [30, 485, 547, 659, 883, 1538, 4594],     // titan…lancer dread (VERIFY: lancers as capitals)
  allShips: catGroups(6),                            // "any ship" (XL Ship rig)
  // "Tech 2 components, Tech 2 capital components, Tools, Data Interfaces and
  //  Tech 3 components" — g334 construction comps, g913 adv capital comps,
  //  g332 tools, g716 data interfaces, g964 hybrid tech (T3) comps
  advComp: [332, 334, 716, 913, 964],
  // "capital ship construction components"
  capComp: [873],
  // "structure components, structure modules, structure rigs, Upwell
  //  structures, starbase structures and fuel blocks" — cat 65 (Structure),
  //  cat 66 (Structure Module), cat 23 (Starbase), g536 structure components,
  //  g1136 fuel blocks. (VERIFY: sov hubs/upgrades (cat 40/39) and orbitals
  //  (cat 46) excluded — not named in any rig description.)
  structure: [...catGroups(65, 66, 23), 536, 1136].sort((a, b) => a - b),
  // reactions by family — reaction formula products by group:
  // composite = g428 intermediates + g429 composites; hybrid = g974 polymers;
  // biochemical = g712 (boosters). (VERIFY: g4096 molecular-forged reactions
  // are affected by NO reactor rig — they are deliberately absent here.)
  reaComposite: [428, 429],
  reaHybrid: [974],
  reaBiochem: [712],
  reaAll: [428, 429, 712, 974],
};
SCOPES.structureAndComp = [...new Set([...SCOPES.structure, ...SCOPES.advComp, ...SCOPES.capComp])].sort((a, b) => a - b);
SCOPES.equipConsumable = [...new Set([...SCOPES.equip, ...SCOPES.ammo])].sort((a, b) => a - b);

/* name-pattern → {scope, act, dom} rules; FIRST match wins, so the more
   specific patterns sit above the generic ones. */
const RIG_RULES = [
  [/Equipment and Consumable Manufacturing/, { scope: 'equipConsumable', act: ['man'], dom: 'Equipment & Consumables' }],
  [/Equipment Manufacturing/, { scope: 'equip', act: ['man'], dom: 'Equipment' }],
  [/Ammunition Manufacturing/, { scope: 'ammo', act: ['man'], dom: 'Ammunition' }],
  [/Drone and Fighter Manufacturing/, { scope: 'droneFighter', act: ['man'], dom: 'Drones & Fighters' }],
  [/Basic Small Ship Manufacturing/, { scope: 'basicSmall', act: ['man'], dom: 'Basic Small Ships' }],
  [/Advanced Small Ship Manufacturing/, { scope: 'advSmall', act: ['man'], dom: 'Advanced Small Ships' }],
  [/Basic Medium Ship Manufacturing/, { scope: 'basicMedium', act: ['man'], dom: 'Basic Medium Ships' }],
  [/Advanced Medium Ship Manufacturing/, { scope: 'advMedium', act: ['man'], dom: 'Advanced Medium Ships' }],
  [/Basic Large Ship Manufacturing/, { scope: 'basicLarge', act: ['man'], dom: 'Basic Large Ships' }],
  [/Advanced Large Ship Manufacturing/, { scope: 'advLarge', act: ['man'], dom: 'Advanced Large Ships' }],
  [/Capital Ship Manufacturing/, { scope: 'capital', act: ['man'], dom: 'Capital Ships' }],
  [/Structure and Component Manufacturing/, { scope: 'structureAndComp', act: ['man'], dom: 'Structures & Components' }],
  [/Structure Manufacturing/, { scope: 'structure', act: ['man'], dom: 'Structures' }],
  [/Advanced Component Manufacturing/, { scope: 'advComp', act: ['man'], dom: 'Advanced Components' }],
  [/Capital Component Manufacturing/, { scope: 'capComp', act: ['man'], dom: 'Basic Capital Components' }],
  [/-Set Ship Manufacturing/, { scope: 'allShips', act: ['man'], dom: 'All Ships' }],
  [/Invention (?:Cost Optimization|Accelerator|Optimization)/, { scope: null, act: ['inv'], dom: 'Invention' }],
  [/ME Research/, { scope: null, act: ['me'], dom: 'ME Research' }],
  [/TE Research/, { scope: null, act: ['te'], dom: 'TE Research' }],
  [/Blueprint Copy/, { scope: null, act: ['cop'], dom: 'Blueprint Copying' }],
  [/Laboratory Optimization/, { scope: null, act: ['inv', 'me', 'te', 'cop'], dom: 'All Science' }],
  [/Composite Reactor/, { scope: 'reaComposite', act: ['rea'], dom: 'Composite Reactions' }],
  [/Hybrid Reactor/, { scope: 'reaHybrid', act: ['rea'], dom: 'Hybrid Reactions' }],
  [/Biochemical Reactor/, { scope: 'reaBiochem', act: ['rea'], dom: 'Biochemical Reactions' }],
  [/Reactor Efficiency/, { scope: 'reaAll', act: ['rea'], dom: 'All Reactions' }],
];
// Thukker rigs: the LOWSEC-enhanced material bonus (attr 2653) applies to
// CAPITAL components only, per the rigs' own descriptions — normal `me` for
// the rest of the scope. Keyed by name fragment.
const THUKKER_SCOPE = [
  [/Thukker Advanced Component/, [913]],        // "enhanced … Tech 2 capital ship components"
  [/Thukker Basic Capital Component/, [873]],
  [/Thukker Structure and Component/, [873, 913]], // "basic and advanced capital ship components"
];

const SZ = { 2: 'M', 3: 'L', 4: 'XL' };
const rigsOut = {};
const unmatched = [];
let rigDropped = 0;
for (const [tidStr, rt] of Object.entries(rigTypes)) {
  const tid = Number(tidStr);
  const d = dogmaOf[tid] || {};
  const sz = SZ[d[1547]];
  if (!sz) { // no rig size — not a fittable rig (defensive; should not happen)
    console.error(`RIG DROPPED (no rigSize dogma): ${tid} ${rt.name}`);
    rigDropped++;
    continue;
  }
  // engineering rigs use 2593/2594/2595; reactor rigs use 2713/2714
  const me = -(d[2594] ?? d[2714] ?? 0);
  const te = -(d[2593] ?? d[2713] ?? 0);
  const cost = -(d[2595] ?? 0);
  const sec = { hs: d[2355] ?? 0, ls: d[2356] ?? 1, ns: d[2357] ?? 1 }; // no hiSecModifier ⇒ activity impossible in HS (reactors)
  const fit = [d[1298], d[1299], d[1300], d[1301]].filter((g) => g != null);
  const rule = RIG_RULES.find(([re]) => re.test(rt.name));
  const entry = { n: rt.name, sz, me, te, cost, sec, scope: null, act: ['man'], fit };
  if (rule) {
    const r = rule[1];
    entry.scope = r.scope ? SCOPES[r.scope].slice() : null;
    entry.act = r.act.slice();
    entry.dom = r.dom;
  } else {
    console.error(`RIG UNMATCHED by name rules (flagged, null scope): ${tid} ${rt.name}`);
    unmatched.push(rt.name);
    entry.unk = 1;
    entry.dom = 'Unknown';
  }
  if (d[2653] != null) {
    const th = THUKKER_SCOPE.find(([re]) => re.test(rt.name));
    entry.thuk = { me: -d[2653], scope: th ? th[1].slice() : (entry.scope || []).slice() };
    if (!th) console.error(`RIG WARNING: Thukker attr on ${rt.name} without a Thukker scope rule — using full scope`);
  }
  rigsOut[tid] = entry;
}

// structures: [name, groupId, size, rigSlots]
const structuresOut = {};
for (const [tidStr, st] of Object.entries(structTypes)) {
  const tid = Number(tidStr);
  const d = dogmaOf[tid] || {};
  const sz = SZ[d[1547]];
  if (!sz) { console.error(`STRUCTURE DROPPED (no rigSize): ${tid} ${st.name}`); continue; }
  structuresOut[tid] = [st.name, st.gid, sz, d[1137] ?? 3];
}
// sanity: the canonical hulls must map to the expected sizes
for (const [tid, wantSz] of [[35825, 'M'], [35835, 'M'], [35826, 'L'], [35836, 'L'], [35827, 'XL']]) {
  const s = structuresOut[tid];
  if (!s || s[2] !== wantSz) console.error(`STRUCTURE SANITY WARNING: ${tid} expected size ${wantSz}, got ${s ? s[2] : 'missing'}`);
}

{ // sanity report — the known XL ship rig with in-game-verified numbers
  const probe = Object.entries(rigsOut).find(([, r]) => r.n === 'Standup XL-Set Ship Manufacturing Efficiency I');
  if (probe) {
    const r = probe[1];
    log(`rig sanity: ${r.n} → ME ${r.me}% / TE ${r.te}% base, nullsec ×${r.sec.ns} ⇒ ${(r.me * r.sec.ns).toFixed(2)}% / ${(r.te * r.sec.ns).toFixed(1)}% (expect 4.20% / 42.0%)`);
  } else {
    console.error('RIG SANITY WARNING: Standup XL-Set Ship Manufacturing Efficiency I not found');
  }
  const covered = new Set();
  for (const r of Object.values(rigsOut)) if (r.scope) for (const g of r.scope) covered.add(g);
  const uncovered = [];
  for (const set of prodGroupsByCat.values())
    for (const g of set) if (!covered.has(g)) uncovered.push(`${g} (${rawGroups[g] && rawGroups[g].name ? rawGroups[g].name.en : '?'})`);
  log(`rigs: ${Object.keys(rigsOut).length} extracted, ${unmatched.length} unmatched, ${rigDropped} dropped; ` +
      `structures: ${Object.keys(structuresOut).length}; product groups no man/rea rig touches: ${uncovered.length}`);
  if (uncovered.length) log(`  uncovered (expected: boosters, clones, compressed ore, sov, molecular-forged…): ${uncovered.slice(0, 40).join(', ')}${uncovered.length > 40 ? ' …' : ''}`);
}

// ---------------------------------------------------------------------------
// 5. version + emit
// ---------------------------------------------------------------------------
const version =
  process.env.SDE_VERSION ||
  fs.statSync(fsd('blueprints.yaml')).mtime.toISOString().slice(0, 10);

const out = {
  v: version,
  types: typesOut,
  groups,
  marketGroups,
  skills,
  blueprints,
  rigs: rigsOut,
  structures: structuresOut,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out));
const bytes = fs.statSync(outFile).size;
log(`wrote ${outFile}: v=${version}, ${(bytes / 1024 / 1024).toFixed(2)} MB raw; ` +
    `types=${Object.keys(typesOut).length}, groups=${Object.keys(groups).length}, ` +
    `marketGroups=${Object.keys(marketGroups).length}, skills=${Object.keys(skills).length}, ` +
    `blueprints=${Object.keys(blueprints).length}, rigs=${Object.keys(rigsOut).length}, ` +
    `structures=${Object.keys(structuresOut).length}`);
