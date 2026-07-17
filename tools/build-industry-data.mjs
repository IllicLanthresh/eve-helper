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
//   } }
// }
// `types` contains ONLY tids referenced by blueprint activities (materials,
// products, the blueprint itself) plus every skill tid; `groups`/`marketGroups`
// contain only the entries reachable from those types (market group parent
// chains are walked to the root).

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
for (const f of ['blueprints.yaml', 'types.yaml', 'groups.yaml', 'marketGroups.yaml']) {
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
// 2. types.yaml (~150MB) — stream-parse one top-level entry at a time.
//    Top-level keys sit at column 0 (`123:`); every entry body is indented,
//    so a column-0 digit line safely delimits entries.
// ---------------------------------------------------------------------------
log('stream-parsing types.yaml ...');
const typesOut = {}; // tid -> [name, volume, packagedVolume|null, groupId, marketGroupId|0, metaGroupId|0]
const typeGroupIds = new Set();
const typeMarketGroupIds = new Set();
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
    if (referencedTids.has(curTid)) {
      let t;
      try {
        t = yaml.load(curLines.join('\n')) || {};
      } catch (e) {
        throw new Error(`YAML parse failed for typeID ${curTid}: ${e.message}`);
      }
      const gid = t.groupID ?? 0;
      const name = (t.name && (t.name.en || Object.values(t.name)[0])) || `type ${curTid}`;
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
log('parsing groups.yaml + marketGroups.yaml ...');
const rawGroups = yaml.load(fs.readFileSync(fsd('groups.yaml'), 'utf8'));
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
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out));
const bytes = fs.statSync(outFile).size;
log(`wrote ${outFile}: v=${version}, ${(bytes / 1024 / 1024).toFixed(2)} MB raw; ` +
    `types=${Object.keys(typesOut).length}, groups=${Object.keys(groups).length}, ` +
    `marketGroups=${Object.keys(marketGroups).length}, skills=${Object.keys(skills).length}, ` +
    `blueprints=${Object.keys(blueprints).length}`);
