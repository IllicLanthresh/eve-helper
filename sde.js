/* sde.js — CCP's Static Data Export, read by the client.

   The tools used to eat two JSON blobs that CI derived from the SDE at deploy
   time. That made refreshing game data a code deploy: a patch changed the game
   and the site kept serving last month's blueprints until someone pushed a
   commit. This file removes the build from that path. The browser fetches the
   SDE itself, derives the same two blobs, and keeps them in IndexedDB; a
   version check says when CCP has published a newer build and one button
   replaces the local copy.

   THIS IS NOT A CACHE. Market data is still fetched fresh every time — that
   constraint stands. This is a local copy of *static* data, the kind that
   changes only when CCP ships a patch, held deliberately, stamped with the
   build it came from, and never used without showing you which build that is.

   The source is CCP's own, not a mirror:
     https://developers.eveonline.com/static-data/tranquility/latest.jsonl
     https://developers.eveonline.com/static-data/tranquility/
       eve-online-static-data-<build>-jsonl.zip
   Both answer with `Access-Control-Allow-Origin: *`, so a page can read them
   directly, and the archive honours byte ranges.

   The archive is 99 MB and we want nine files out of it totalling 26 MB
   compressed. So this reads it like a zip is meant to be read: range-fetch the
   end-of-central-directory record, range-fetch the central directory, then
   range-fetch only the entries we want and inflate them with the platform's own
   DecompressionStream. Nothing else is downloaded. The one big member,
   types.jsonl (23 MB compressed, 153 MB raw), is streamed line by line and
   filtered as it arrives, so it is never held whole.

   Works unchanged in a browser and in Node 18+ (both have fetch,
   DecompressionStream and TextDecoder). Node gets it through module.exports at
   the bottom, which is how CI builds the seed copy from the same code — one
   implementation, so the file the site ships and the file your browser derives
   cannot disagree. */
(function (root) {
  'use strict';

  const HOST = 'https://developers.eveonline.com/static-data';
  /* read through SDE.HOST at call time, so a test can point the whole module at
     a local fixture without every function growing a url argument */
  const host = () => (SDE && SDE.HOST) || HOST;
  const latestUrl = () => host() + '/tranquility/latest.jsonl';
  const zipUrl = (build) => host() + '/tranquility/eve-online-static-data-' + build + '-jsonl.zip';

  /* the nine members we read, in the order the passes below want them */
  const MEMBERS = [
    'blueprints.jsonl', 'categories.jsonl', 'groups.jsonl', 'marketGroups.jsonl',
    'industryTargetFilters.jsonl', 'industryModifierSources.jsonl',
    'compressibleTypes.jsonl', 'typeMaterials.jsonl', 'dogmaAttributes.jsonl',
    'types.jsonl', 'typeDogma.jsonl',
  ];

  /* ------------------------------------------------------------------ */
  /* zip over HTTP byte ranges                                          */
  /* ------------------------------------------------------------------ */

  /* `Range: bytes=<start>-<end>` is a CORS-safelisted header, so this stays a
     simple request — no preflight, which matters because CCP's bucket answers
     OPTIONS with nothing useful. Suffix ranges ("bytes=-4096") are NOT
     safelisted, which is why the total length is asked for separately. */
  async function fetchRange(url, start, end) {
    const res = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } });
    if (res.status !== 206 && res.status !== 200) throw new Error('HTTP ' + res.status + ' reading ' + url);
    return res;
  }

  async function byteLength(url) {
    const res = await fetchRange(url, 0, 0);
    const cr = res.headers.get('content-range');
    await res.arrayBuffer();
    const m = cr && /\/(\d+)\s*$/.exec(cr);
    if (!m) throw new Error('the server would not serve a byte range, so the archive cannot be read piecewise');
    return Number(m[1]);
  }

  async function openZip(url) {
    const total = await byteLength(url);
    // the EOCD record is at most 22 + 65535 bytes from the end (the comment field)
    const tailLen = Math.min(total, 22 + 65535);
    const tail = new DataView(await (await fetchRange(url, total - tailLen, total - 1)).arrayBuffer());
    let p = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
    }
    if (p < 0) throw new Error('no end-of-central-directory record: this is not a zip');
    const count = tail.getUint16(p + 10, true);
    const cdSize = tail.getUint32(p + 12, true);
    const cdOff = tail.getUint32(p + 16, true);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('zip64 archive: not supported');

    const cd = new DataView(await (await fetchRange(url, cdOff, cdOff + cdSize - 1)).arrayBuffer());
    const dec = new TextDecoder();
    const entries = new Map();
    let q = 0;
    for (let i = 0; i < count && q + 46 <= cd.byteLength; i++) {
      if (cd.getUint32(q, true) !== 0x02014b50) break;
      const method = cd.getUint16(q + 10, true);
      const csz = cd.getUint32(q + 20, true);
      const usz = cd.getUint32(q + 24, true);
      const nl = cd.getUint16(q + 28, true);
      const el = cd.getUint16(q + 30, true);
      const cl = cd.getUint16(q + 32, true);
      const off = cd.getUint32(q + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + q + 46, nl));
      entries.set(name, { method, csz, usz, off });
      q += 46 + nl + el + cl;
    }
    return { url, total, entries };
  }

  /* A member's bytes do not start at its central-directory offset: a local file
     header of variable length sits in front of it. Read the fixed 30 bytes to
     learn how long, then range-fetch exactly the compressed run. */
  async function entryStream(zip, name) {
    const e = zip.entries.get(name);
    if (!e) throw new Error('the archive has no ' + name);
    const head = new DataView(await (await fetchRange(zip.url, e.off, e.off + 29)).arrayBuffer());
    const start = e.off + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const res = await fetchRange(zip.url, start, start + e.csz - 1);
    if (e.method === 0) return res.body;
    if (e.method !== 8) throw new Error(name + ': zip compression method ' + e.method + ' is not deflate');
    return res.body.pipeThrough(new DecompressionStream('deflate-raw'));
  }

  /* Feeds one decoded line at a time and never holds more than a chunk plus a
     partial line, which is what keeps a 153 MB member inside a tab's budget.
     `onLine` gets the raw string so a caller can reject a line with a regex
     before paying for JSON.parse. */
  async function eachLine(stream, onLine, onBytes) {
    const rd = stream.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      if (onBytes) onBytes(value.byteLength);
      buf += dec.decode(value, { stream: true });
      let i = 0, j;
      while ((j = buf.indexOf('\n', i)) >= 0) {
        if (j > i) onLine(buf.slice(i, j));
        i = j + 1;
      }
      buf = i ? buf.slice(i) : buf;
    }
    buf += dec.decode();
    if (buf.trim()) onLine(buf);
  }

  /* ------------------------------------------------------------------ */
  /* the derivation                                                      */
  /* ------------------------------------------------------------------ */

  const KEY_RE = /"_key":\s*(-?\d+)/;
  const GID_RE = /"groupID":\s*(\d+)/;
  const keyOf = (line) => { const m = KEY_RE.exec(line); return m ? Number(m[1]) : null; };
  const enOf = (o) => (o && (o.en || Object.values(o)[0])) || null;

  /* Dogma attributes carrying rig magnitudes and the ore reprocessing skill.
     Every id is verified by name against dogmaAttributes.jsonl below, so a
     renumbering fails loudly instead of silently zeroing every rig. */
  const ATTR = {
    reprocSkill: 790,
    rigSlots: 1137,
    fit1: 1298, fit2: 1299, fit3: 1300, fit4: 1301,
    rigSize: 1547,
    hiSec: 2355, lowSec: 2356, nullSec: 2357,
    engTime: 2593, engMat: 2594, engCost: 2595,
    thukMat: 2653,
    reaTime: 2713, reaMat: 2714,
  };
  const ATTR_NAMES = {
    790: 'reprocessingSkillType',
    1137: 'rigSlots',
    1298: 'canFitShipGroup01', 1299: 'canFitShipGroup02',
    1300: 'canFitShipGroup03', 1301: 'canFitShipGroup04',
    1547: 'rigSize',
    2355: 'hiSecModifier', 2356: 'lowSecModifier', 2357: 'nullSecModifier',
    2593: 'attributeEngRigTimeBonus', 2594: 'attributeEngRigMatBonus',
    2595: 'attributeEngRigCostBonus', 2653: 'attributeThukkerEngRigMatBonus',
    2713: 'RefRigTimeBonus', 2714: 'RefRigMatBonus',
  };
  const WANT_ATTRS = new Set(Object.values(ATTR));

  /* Industry-capable Upwell structure groups: Engineering Complex, Refinery,
     Citadel. Read as group ids because that is what the structure entries
     carry; the names are checked below. */
  const STRUCT_GROUPS = new Set([1404, 1406, 1657]);

  /* CCP's activity names -> the short keys the tools are written against */
  const ACT_KEY = {
    manufacturing: 'man', reaction: 'rea', copying: 'cop',
    invention: 'inv', research_material: 'me', research_time: 'te',
  };
  /* industryModifierSources uses camelCase for the two research activities */
  const MOD_ACT_KEY = {
    manufacturing: 'man', reaction: 'rea', copying: 'cop',
    invention: 'inv', researchMaterial: 'me', researchTime: 'te',
  };

  /* Rig display names. This table is LABELS ONLY — which products a rig
     touches and which activities it changes come from CCP's own
     industryModifierSources/industryTargetFilters below, not from these
     patterns. The labels stay hand-written because the structures tool groups
     rigs by them, treats one label as one rig slot's worth of domain, and
     stores them in saved fits. First match wins. */
  const DOM_RULES = [
    [/Equipment and Consumable Manufacturing/, 'Equipment & Consumables'],
    [/Equipment Manufacturing/, 'Equipment'],
    [/Ammunition Manufacturing/, 'Ammunition'],
    [/Drone and Fighter Manufacturing/, 'Drones & Fighters'],
    [/Basic Small Ship Manufacturing/, 'Basic Small Ships'],
    [/Advanced Small Ship Manufacturing/, 'Advanced Small Ships'],
    [/Basic Medium Ship Manufacturing/, 'Basic Medium Ships'],
    [/Advanced Medium Ship Manufacturing/, 'Advanced Medium Ships'],
    [/Basic Large Ship Manufacturing/, 'Basic Large Ships'],
    [/Advanced Large Ship Manufacturing/, 'Advanced Large Ships'],
    [/Capital Ship Manufacturing/, 'Capital Ships'],
    [/Structure and Component Manufacturing/, 'Structures & Components'],
    [/Structure Manufacturing/, 'Structures'],
    [/Advanced Component Manufacturing/, 'Advanced Components'],
    [/Capital Component Manufacturing/, 'Basic Capital Components'],
    [/-Set Ship Manufacturing/, 'All Ships'],
    [/Invention (?:Cost Optimization|Accelerator|Optimization)/, 'Invention'],
    [/ME Research/, 'ME Research'],
    [/TE Research/, 'TE Research'],
    [/Blueprint Copy/, 'Blueprint Copying'],
    [/Laboratory Optimization/, 'All Science'],
    [/Composite Reactor/, 'Composite Reactions'],
    [/Hybrid Reactor/, 'Hybrid Reactions'],
    [/Biochemical Reactor/, 'Biochemical Reactions'],
    [/Reactor Efficiency/, 'All Reactions'],
  ];

  /* Thukker rigs carry a second, larger material bonus (attributeThukker-
     EngRigMatBonus) that applies to capital components only. CCP's modifier
     data says the rig touches both filters but not which magnitude goes with
     which, so the split comes from the rigs' own description text — a
     published rule, written down here rather than guessed. */
  const THUKKER_SCOPE = [
    [/Thukker Advanced Component/, [913]],
    [/Thukker Basic Capital Component/, [873]],
    [/Thukker Structure and Component/, [873, 913]],
  ];

  const SZ = { 2: 'M', 3: 'L', 4: 'XL' };

  /* Emitted for every step so a caller can draw a progress bar. `phase` is what
     is being read, `done`/`total` are bytes of that member when known. */
  function reporter(onProgress) {
    let phase = '', done = 0, total = 0;
    return {
      start(p, t) { phase = p; done = 0; total = t || 0; this.tick(0); },
      tick(n) {
        done += n || 0;
        if (onProgress) onProgress({ phase, done, total });
      },
      note(p) { phase = p; done = 0; total = 0; if (onProgress) onProgress({ phase, done, total }); },
    };
  }

  async function derive(zip, opts) {
    const o = opts || {};
    const rep = reporter(o.onProgress);
    const warn = o.onWarn || (() => {});
    const read = async (name, onLine) => {
      const e = zip.entries.get(name);
      rep.start(name, e ? e.usz : 0);
      await eachLine(await entryStream(zip, name), onLine, (n) => rep.tick(n));
    };

    /* ---- 1. blueprints ---------------------------------------------- */
    const blueprints = {};
    const referenced = new Set();
    const skillTids = new Set();
    const pairs = (list, k) => (list || []).map((e) => [e.typeID, e[k]]);
    const take = (act) => {
      const m = pairs(act.materials, 'quantity');
      const p = pairs(act.products, 'quantity');
      const s = (act.skills || []).map((e) => [e.typeID, e.level]);
      for (const [t] of m) referenced.add(t);
      for (const [t] of p) referenced.add(t);
      for (const [t] of s) { referenced.add(t); skillTids.add(t); }
      return { m, p, s };
    };
    await read('blueprints.jsonl', (line) => {
      const bp = JSON.parse(line);
      const bpid = bp._key;
      referenced.add(bpid);
      const acts = bp.activities || {};
      const out = { limit: bp.maxProductionLimit != null ? bp.maxProductionLimit : 1 };
      for (const [ccpName, key] of Object.entries(ACT_KEY)) {
        const a = acts[ccpName];
        if (!a) continue;
        if (key === 'man' || key === 'rea') {
          const { m, p, s } = take(a);
          out[key] = { t: a.time || 0, m, p, s };
        } else if (key === 'inv') {
          const m = pairs(a.materials, 'quantity');
          const s = (a.skills || []).map((e) => [e.typeID, e.level]);
          const p = (a.products || []).map((e) => [e.typeID, e.quantity, e.probability != null ? e.probability : 1]);
          for (const [t] of m) referenced.add(t);
          for (const [t] of p) referenced.add(t);
          for (const [t] of s) { referenced.add(t); skillTids.add(t); }
          out.inv = { t: a.time || 0, m, p, s };
        } else {
          out[key] = { t: a.time || 0 };
        }
      }
      blueprints[bpid] = out;
    });

    /* ---- 2. categories, groups -------------------------------------- */
    let asteroidCat = null;
    const catName = new Map();
    await read('categories.jsonl', (line) => {
      const c = JSON.parse(line);
      const n = enOf(c.name);
      catName.set(c._key, n);
      if (n === 'Asteroid') asteroidCat = c._key;
    });
    if (asteroidCat == null) throw new Error('no "Asteroid" category in the SDE — ore extraction cannot proceed');

    const groupCat = new Map();      // gid -> categoryId
    const groupName = new Map();     // gid -> English name
    const asteroidGroups = new Set();
    await read('groups.jsonl', (line) => {
      const g = JSON.parse(line);
      const cat = g.categoryID || 0;
      groupCat.set(g._key, cat);
      groupName.set(g._key, enOf(g.name) || ('group ' + g._key));
      if (cat === asteroidCat) asteroidGroups.add(g._key);
    });
    for (const gid of STRUCT_GROUPS) {
      if (!groupName.has(gid)) warn('structure group ' + gid + ' is missing from this SDE');
    }

    /* ---- 3. rig applicability, straight from CCP --------------------- */
    const filters = new Map();       // filterId -> {categoryIDs, groupIDs, name}
    await read('industryTargetFilters.jsonl', (line) => {
      const f = JSON.parse(line);
      filters.set(f._key, f);
    });
    const modSrc = new Map();        // tid -> the raw modifier-source record
    await read('industryModifierSources.jsonl', (line) => {
      const m = JSON.parse(line);
      modSrc.set(m._key, m);
    });

    /* ---- 4. market groups ------------------------------------------- */
    const mgRaw = new Map();
    await read('marketGroups.jsonl', (line) => {
      const g = JSON.parse(line);
      mgRaw.set(g._key, [enOf(g.nameID || g.name) || ('marketGroup ' + g._key), g.parentGroupID || 0]);
    });

    /* ---- 5. compressed counterparts, also straight from CCP ---------- */
    const compressedOf = new Map();
    await read('compressibleTypes.jsonl', (line) => {
      const c = JSON.parse(line);
      compressedOf.set(c._key, c.compressedTypeID);
    });

    /* ---- 6. reprocessing outputs ------------------------------------ */
    const materialsOf = new Map();
    await read('typeMaterials.jsonl', (line) => {
      const t = JSON.parse(line);
      materialsOf.set(t._key, (t.materials || []).map((e) => [e.materialTypeID, e.quantity]));
    });

    /* ---- 7. verify the dogma attribute ids by name ------------------- */
    await read('dogmaAttributes.jsonl', (line) => {
      const a = JSON.parse(line);
      const want = ATTR_NAMES[a._key];
      if (want && a.name !== want) {
        throw new Error('dogma attribute ' + a._key + ' is "' + a.name + '", expected "' + want
          + '" — CCP renumbered the attributes and the rig/ore extraction would be wrong');
      }
    });

    /* ---- 8. types (the big one) -------------------------------------- */
    const types = {};                // tid -> [name, vol, packagedVol|null, gid, mgid, metaGid]
    const allNames = new Map();      // tid -> name, for every type in the game
    const typeGroups = new Set();
    const typeMarketGroups = new Set();
    const rigCandidates = new Map(); // tid -> {name, gid}
    const structCandidates = new Map();
    const ores = new Map();          // tid -> {name, gid, mgid, vol, portion}
    let scanned = 0, unpublishedOres = 0;
    await read('types.jsonl', (line) => {
      scanned++;
      const tid = keyOf(line);
      if (tid == null) return;
      // Cheap pre-check. Most of the 53k types are of no interest and parsing
      // them all costs more than everything else here put together.
      let wanted = referenced.has(tid) || modSrc.has(tid);
      if (!wanted) {
        const g = GID_RE.exec(line);
        const gid = g ? Number(g[1]) : 0;
        wanted = STRUCT_GROUPS.has(gid) || asteroidGroups.has(gid);
      }
      const t = JSON.parse(line);
      const name = enOf(t.name) || ('type ' + tid);
      allNames.set(tid, name);
      if (!wanted) return;
      const gid = t.groupID || 0;
      if (t.published) {
        // A rig with no market group cannot be bought, so it cannot be chosen:
        // that is what separates the fittable Standup rigs from the 88 legacy
        // Outpost Conversion rigs handed out when outposts became structures.
        if (modSrc.has(tid) && !STRUCT_GROUPS.has(gid) && t.marketGroupID) rigCandidates.set(tid, { name, gid });
        if (STRUCT_GROUPS.has(gid)) structCandidates.set(tid, { name, gid });
        if (asteroidGroups.has(gid)) {
          ores.set(tid, {
            name, gid,
            mgid: t.marketGroupID || 0,
            vol: t.volume || 0,
            portion: t.portionSize != null ? t.portionSize : 1,
          });
        }
      } else if (asteroidGroups.has(gid)) {
        unpublishedOres++;
      }
      if (referenced.has(tid)) {
        const vol = t.volume || 0;
        // packagedVolume is an SDE field now; null means "repackages to its own
        // volume", which is what the consumers expect from this slot
        const pv = t.packagedVolume != null && t.packagedVolume !== vol ? t.packagedVolume : null;
        types[tid] = [name, vol, pv, gid, t.marketGroupID || 0, t.metaGroupID || 0];
        typeGroups.add(gid);
        if (t.marketGroupID) typeMarketGroups.add(t.marketGroupID);
      }
    });

    /* ---- 9. drop blueprints whose types no longer exist --------------- */
    const dead = [];
    for (const [bpid, bp] of Object.entries(blueprints)) {
      let isDead = !types[bpid];
      for (const k of ['man', 'rea', 'inv']) {
        if (isDead || !bp[k]) continue;
        for (const [t] of bp[k].m) if (!types[t]) { isDead = true; break; }
        if (!isDead) for (const [t] of bp[k].p) if (!types[t]) { isDead = true; break; }
      }
      if (isDead) { dead.push(bpid); delete blueprints[bpid]; }
    }
    if (dead.length) {
      warn(dead.length + ' blueprints reference types this SDE does not have; dropped: ' + dead.join(', '));
      const alive = new Set();
      skillTids.clear();
      for (const [bpid, bp] of Object.entries(blueprints)) {
        alive.add(Number(bpid));
        for (const k of ['man', 'rea', 'inv']) {
          if (!bp[k]) continue;
          for (const [t] of bp[k].m) alive.add(t);
          for (const [t] of bp[k].p) alive.add(t);
          for (const [t] of bp[k].s) { alive.add(t); skillTids.add(t); }
        }
      }
      typeGroups.clear(); typeMarketGroups.clear();
      for (const tid of Object.keys(types)) {
        if (!alive.has(Number(tid))) { delete types[tid]; continue; }
        typeGroups.add(types[tid][3]);
        if (types[tid][4]) typeMarketGroups.add(types[tid][4]);
      }
    }

    /* ---- 10. skills, groups, market-group chains ---------------------- */
    const skills = {};
    for (const tid of [...skillTids].sort((a, b) => a - b)) {
      if (types[tid]) skills[tid] = types[tid][0];
      else warn('skill ' + tid + ' is referenced by a blueprint but missing from types');
    }
    const groups = {};
    for (const gid of [...typeGroups].sort((a, b) => a - b)) {
      if (groupName.has(gid)) groups[gid] = [groupName.get(gid), groupCat.get(gid) || 0];
    }
    const marketGroups = {};
    const addChain = (mgid) => {
      while (mgid && !marketGroups[mgid]) {
        const mg = mgRaw.get(mgid);
        if (!mg) break;
        marketGroups[mgid] = [mg[0], mg[1]];
        mgid = mg[1];
      }
    };
    for (const mgid of typeMarketGroups) addChain(mgid);

    /* ---- 11. dogma for rigs, structures and ores --------------------- */
    const dogmaWanted = new Set([...rigCandidates.keys(), ...structCandidates.keys()]);
    const dogmaOf = new Map();
    const oreSkill = new Map();
    await read('typeDogma.jsonl', (line) => {
      const tid = keyOf(line);
      if (tid == null) return;
      const isDogma = dogmaWanted.has(tid);
      const isOre = ores.has(tid);
      if (!isDogma && !isOre) return;
      const d = JSON.parse(line);
      const attrs = {};
      for (const a of d.dogmaAttributes || []) {
        if (isDogma && WANT_ATTRS.has(a.attributeID)) attrs[a.attributeID] = a.value;
        if (isOre && a.attributeID === ATTR.reprocSkill) oreSkill.set(tid, a.value);
      }
      if (isDogma) dogmaOf.set(tid, attrs);
    });

    /* ---- 12. rigs ---------------------------------------------------- */
    /* Which groups a filter selects. Categories expand to the groups anything
       is actually produced in, which keeps the lists short without changing
       what they match; explicit group ids are taken as given. */
    const producedGroups = new Map();  // categoryId -> Set(groupId)
    for (const bp of Object.values(blueprints)) {
      for (const k of ['man', 'rea']) {
        if (!bp[k]) continue;
        for (const [tid] of bp[k].p) {
          const row = types[tid];
          if (!row) continue;
          const cat = groupCat.get(row[3]) || 0;
          if (!producedGroups.has(cat)) producedGroups.set(cat, new Set());
          producedGroups.get(cat).add(row[3]);
        }
      }
    }
    const filterGroups = (fid) => {
      const f = filters.get(fid);
      if (!f) { warn('rig modifier names filter ' + fid + ', which this SDE does not define'); return []; }
      const out = new Set(f.groupIDs || []);
      for (const cat of f.categoryIDs || []) for (const g of producedGroups.get(cat) || []) out.add(g);
      return [...out];
    };

    const rigs = {};
    let rigsDropped = 0;
    for (const [tid, rt] of rigCandidates) {
      const d = dogmaOf.get(tid) || {};
      const sz = SZ[d[ATTR.rigSize]];
      if (!sz) { warn('rig ' + tid + ' "' + rt.name + '" carries no rigSize; dropped'); rigsDropped++; continue; }
      const num = (a) => (d[a] != null ? d[a] : null);
      const me = -(num(ATTR.engMat) != null ? num(ATTR.engMat) : (num(ATTR.reaMat) || 0));
      const te = -(num(ATTR.engTime) != null ? num(ATTR.engTime) : (num(ATTR.reaTime) || 0));
      const cost = -(num(ATTR.engCost) || 0);
      // no hiSecModifier at all means the activity cannot run in highsec, which
      // is how reactor rigs are expressed
      const sec = {
        hs: d[ATTR.hiSec] != null ? d[ATTR.hiSec] : 0,
        ls: d[ATTR.lowSec] != null ? d[ATTR.lowSec] : 1,
        ns: d[ATTR.nullSec] != null ? d[ATTR.nullSec] : 1,
      };
      const fit = [d[ATTR.fit1], d[ATTR.fit2], d[ATTR.fit3], d[ATTR.fit4]].filter((g) => g != null);

      // activity + scope from CCP's modifier record
      const mod = modSrc.get(tid) || {};
      const act = [];
      const scope = new Set();
      let anyFilter = false;
      for (const [ccpAct, byKind] of Object.entries(mod)) {
        const key = MOD_ACT_KEY[ccpAct];
        if (!key) continue;
        act.push(key);
        for (const list of Object.values(byKind)) {
          for (const entry of list || []) {
            if (entry.filterID == null) continue;
            anyFilter = true;
            for (const g of filterGroups(entry.filterID)) scope.add(g);
          }
        }
      }
      act.sort();
      const rule = DOM_RULES.find(([re]) => re.test(rt.name));
      const entry = {
        n: rt.name, sz, me, te, cost, sec,
        scope: anyFilter ? [...scope].sort((a, b) => a - b) : null,
        act: act.length ? act : ['man'],
        fit,
        dom: rule ? rule[1] : null,
      };
      if (!entry.dom) {
        // a rig CCP added since these labels were written: still fully usable,
        // because the numbers and the scope came from the SDE, so it is given a
        // label from the game's own filter names rather than being shelved
        const names = [];
        for (const byKind of Object.values(mod)) {
          for (const list of Object.values(byKind || {})) {
            for (const e of list || []) {
              const f = e.filterID != null && filters.get(e.filterID);
              if (f && f.name && !names.includes(f.name)) names.push(f.name);
            }
          }
        }
        entry.dom = names.length ? names.join(' + ') : 'Other';
        warn('rig "' + rt.name + '" has no display label rule; using "' + entry.dom + '" from the SDE filters');
      }
      if (d[ATTR.thukMat] != null) {
        const th = THUKKER_SCOPE.find(([re]) => re.test(rt.name));
        entry.thuk = { me: -d[ATTR.thukMat], scope: th ? th[1].slice() : (entry.scope || []).slice() };
        if (!th) warn('Thukker bonus on "' + rt.name + '" with no scope rule; applying it to the whole scope');
      }
      rigs[tid] = entry;
    }

    const structures = {};
    for (const [tid, st] of structCandidates) {
      const d = dogmaOf.get(tid) || {};
      const sz = SZ[d[ATTR.rigSize]];
      if (!sz) { warn('structure ' + tid + ' "' + st.name + '" carries no rigSize; dropped'); continue; }
      structures[tid] = [st.name, st.gid, sz, d[ATTR.rigSlots] != null ? d[ATTR.rigSlots] : 3];
    }

    /* ---- 13. ores ---------------------------------------------------- */
    const oreNames = {};
    for (const [tid, o] of ores) {
      const k = o.name.toLowerCase();
      if (oreNames[k] !== undefined) { warn('two published ore types are both named "' + o.name + '"'); continue; }
      oreNames[k] = tid;
    }
    /* Base family, in three rules, each tried in turn.

       1. The type sharing its market group's name names the family for that
          whole market group ("Veldspar" for the Veldspar market group). This
          catches almost everything.
       2. Failing that, strip the naming convention off the variant: an
          optional "Compressed "/"Batch Compressed " in front and an optional
          "<grade>-Grade" behind, so "Compressed Blue Ice IV-Grade" asks
          whether "Blue Ice" is a type, and takes it if so. Ice and moon-ore
          market groups are pluralised, so rule 1 misses there.
       3. Failing that, the longest type name that is a word-suffix of this one
          ("Compressed Thick Blue Ice" -> "Blue Ice"), which is the older
          adjective-in-front convention, still used by a handful of ores.
       Anything matching none of them — one-off mission and event ores — is its
       own family, which is also how the base of every family reports itself. */
    const isSuffix = (name, base) => name === base || name.endsWith(' ' + base);
    const oreNameList = [...ores.values()].map((o) => o.name);
    const familyNames = oreNameList.filter((n) => !oreNameList.some((x) => x !== n && isSuffix(n, x)));
    const mgFamily = new Map();
    for (const o of ores.values()) {
      if (!o.mgid || mgFamily.has(o.mgid)) continue;
      const mg = mgRaw.get(o.mgid);
      const mgName = mg ? mg[0] : '';
      const tid = oreNames[mgName.toLowerCase()];
      if (tid !== undefined && ores.get(tid).mgid === o.mgid) mgFamily.set(o.mgid, mgName);
    }
    const GRADE_RE = /\s+[IVXL0]+-Grade$/;
    const COMPRESSED_RE = /^(?:Batch\s+)?Compressed\s+/;
    const bareTid = (name) => {
      const bare = name.replace(COMPRESSED_RE, '').replace(GRADE_RE, '');
      if (bare === name) return undefined;
      return oreNames[bare.toLowerCase()];
    };
    /* Rule 2 asks for the FAMILY of the stripped type, not the stripped name
       itself: "Compressed Brimful Bitumens" strips to "Brimful Bitumens",
       whose own family is "Bitumens" by rule 1, and that is the answer. */
    const familyOf = (o, depth) => {
      if (mgFamily.has(o.mgid)) return mgFamily.get(o.mgid);
      const tid = bareTid(o.name);
      if (tid !== undefined && (depth || 0) < 4) return familyOf(ores.get(tid), (depth || 0) + 1);
      let best = null;
      for (const f of familyNames) if (isSuffix(o.name, f) && (!best || f.length > best.length)) best = f;
      return best || o.name;
    };

    const oresOut = {};
    for (const [tid, o] of ores) {
      const cTid = compressedOf.has(tid) ? compressedOf.get(tid) : null;
      oresOut[tid] = {
        n: o.name,
        v: o.vol,
        p: o.portion,
        g: groupName.get(o.gid) || ('group ' + o.gid),
        b: familyOf(o),
        m: materialsOf.get(tid) || [],
        c: cTid,
        cv: cTid != null && ores.has(cTid) ? ores.get(cTid).vol : null,
        ice: /\bIce\b/.test(groupName.get(o.gid) || '') ? 1 : 0,
        s: oreSkill.has(tid) ? oreSkill.get(tid) : null,
      };
    }
    const oreTypeNames = {};
    for (const o of Object.values(oresOut)) {
      for (const [mtid] of o.m) if (!oreTypeNames[mtid]) oreTypeNames[mtid] = allNames.get(mtid) || ('type ' + mtid);
      if (o.s != null && !oreTypeNames[o.s]) oreTypeNames[o.s] = allNames.get(o.s) || ('type ' + o.s);
      // the compressed variant's real name, for the Industry tool's ore-sourcing tables
      if (o.c != null && !oreTypeNames[o.c]) oreTypeNames[o.c] = allNames.get(o.c) || ('type ' + o.c);
    }

    /* ---- 14. anchors ------------------------------------------------ */
    /* Numbers with a known in-game value. If one of these moves, the
       extraction has misread the SDE and the result must not be installed —
       silently wrong game data is worse than no data at all. */
    const fail = (m) => { throw new Error('SDE sanity check failed: ' + m); };
    const oreByName = (n) => oresOut[oreNames[n.toLowerCase()]];
    const veld = oreByName('Veldspar');
    if (!veld) fail('there is no Veldspar');
    if (veld.p !== 100) fail('Veldspar reprocesses in batches of ' + veld.p + ', expected 100');
    const trit = (veld.m.find(([t]) => t === 34) || [])[1];
    if (!trit) fail('Veldspar yields no Tritanium');
    for (const [ore, want] of [
      ['Veldspar', 'Simple Ore Processing'],
      ['Zeolites', 'Ubiquitous Moon Ore Processing'],
      ['Mercoxit', 'Mercoxit Ore Processing'],
      ['Clear Icicle', 'Ice Processing'],
    ]) {
      const o = oreByName(ore);
      const got = o && o.s != null ? oreTypeNames[o.s] : null;
      if (got !== want) fail(ore + ' reprocesses with "' + got + '", expected "' + want + '"');
    }
    const anchorRig = Object.values(rigs).find((r) => r.n === 'Standup XL-Set Ship Manufacturing Efficiency I');
    if (!anchorRig) fail('the XL ship rig is missing from the catalog');
    const anchorMe = anchorRig.me * anchorRig.sec.ns, anchorTe = anchorRig.te * anchorRig.sec.ns;
    if (Math.abs(anchorMe - 4.2) > 0.01 || Math.abs(anchorTe - 42) > 0.1) {
      fail('the XL ship rig reads ' + anchorMe.toFixed(2) + '% ME / ' + anchorTe.toFixed(1)
        + '% TE in nullsec, expected 4.20% / 42.0%');
    }
    for (const [tid, wantSz] of [[35825, 'M'], [35835, 'M'], [35826, 'L'], [35836, 'L'], [35827, 'XL']]) {
      const st = structures[tid];
      if (!st) fail('structure ' + tid + ' is missing');
      if (st[2] !== wantSz) fail(st[0] + ' is size ' + st[2] + ', expected ' + wantSz);
    }
    for (const [what, n] of [['types', Object.keys(types).length], ['blueprints', Object.keys(blueprints).length],
      ['rigs', Object.keys(rigs).length], ['ores', Object.keys(oresOut).length]]) {
      if (!n) fail('no ' + what + ' came out of this SDE');
    }

    return {
      industry: { types, groups, marketGroups, skills, blueprints, rigs, structures },
      ores: { ores: oresOut, names: oreNames, types: oreTypeNames },
      stats: {
        typesScanned: scanned,
        types: Object.keys(types).length,
        blueprints: Object.keys(blueprints).length,
        rigs: Object.keys(rigs).length,
        rigsDropped,
        structures: Object.keys(structures).length,
        ores: Object.keys(oresOut).length,
        unpublishedOres,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* public build entry points                                           */
  /* ------------------------------------------------------------------ */

  async function latest() {
    const res = await fetch(latestUrl(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' asking CCP for the latest SDE build');
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec._key === 'sde') return { build: rec.buildNumber, released: rec.releaseDate };
    }
    throw new Error('CCP\'s build index has no "sde" record');
  }

  /* Fetch and derive. Returns the two blobs plus the build they came from. */
  async function build(opts) {
    const o = opts || {};
    const info = o.build ? { build: o.build, released: o.released || null } : await latest();
    const zip = await openZip(zipUrl(info.build));
    const missing = MEMBERS.filter((m) => !zip.entries.has(m));
    if (missing.length) throw new Error('SDE build ' + info.build + ' is missing ' + missing.join(', '));
    const out = await derive(zip, o);
    const v = (info.released || '').slice(0, 10) || String(info.build);
    return {
      v, build: info.build, released: info.released,
      industry: Object.assign({ v, build: info.build }, out.industry),
      ores: Object.assign({ v, build: info.build }, out.ores),
      stats: out.stats,
    };
  }

  /* ------------------------------------------------------------------ */
  /* the local copy                                                      */
  /* ------------------------------------------------------------------ */

  const DB_NAME = 'eve-helper-sde';
  const STORE = 'sde';
  const DB_VER = 1;

  function idb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('this browser has no IndexedDB')); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function readLocal(key) {
    const db = await idb();
    try { return await tx(db, 'readonly', (s) => s.get(key)); } finally { db.close(); }
  }
  async function writeLocal(key, value) {
    const db = await idb();
    try { return await tx(db, 'readwrite', (s) => s.put(value, key)); } finally { db.close(); }
  }
  async function dropLocal() {
    const db = await idb();
    try { return await tx(db, 'readwrite', (s) => s.clear()); } finally { db.close(); }
  }

  /* ------------------------------------------------------------------ */
  /* what the pages call                                                 */
  /* ------------------------------------------------------------------ */

  /* One in-flight refresh at a time, shared by every caller on the page. */
  let refreshing = null;

  /* Reads the two blobs. Order of preference:
       1. the local copy in IndexedDB, if there is one
       2. the seed the site ships (data/*.json), so a first visit works at once
     Never fetches the SDE on its own — refreshing is a deliberate act, because
     it is a 26 MB download. `meta()` says whether what you have is current. */
  async function load(which) {
    const local = await readLocal('data').catch(() => null);
    if (local && local[which]) return { data: local[which], source: 'local', build: local.build, v: local.v };
    const res = await fetch('data/' + (which === 'industry' ? 'industry' : 'ores') + '.json');
    if (!res.ok) throw new Error('HTTP ' + res.status + ' reading the bundled data/' + which + '.json');
    const data = await res.json();
    return { data, source: 'bundled', build: data.build || null, v: data.v };
  }

  /* Downloads and derives, then replaces the local copy. */
  function refresh(opts) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const out = await build(opts);
        await writeLocal('data', {
          v: out.v, build: out.build, released: out.released,
          fetchedAt: new Date().toISOString(),
          industry: out.industry, ores: out.ores,
        });
        return out;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  /* What is held locally and whether CCP has moved on. Costs one 80-byte
     request; it is the only thing that talks to CCP without being asked. */
  async function status() {
    const local = await readLocal('data').catch(() => null);
    let remote = null, err = null;
    try { remote = await latest(); } catch (e) { err = e.message || String(e); }
    return {
      local: local ? { v: local.v, build: local.build, released: local.released, fetchedAt: local.fetchedAt } : null,
      remote, err,
      stale: !!(local && remote && remote.build > local.build),
      missing: !local,
    };
  }

  /* ------------------------------------------------------------------ */
  /* the status line every page mounts                                   */
  /* ------------------------------------------------------------------ */

  const STATUS_CSS = `
  .sdebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .sdebar .sdemsg{font-family:inherit}
  .sdebar .sdever{opacity:.75}
  .sdebar button.sdeupd{font:inherit;font-size:11px;padding:1px 8px;cursor:pointer;
    border:1px solid currentColor;border-radius:3px;background:transparent;color:inherit}
  .sdebar button.sdeupd[disabled]{opacity:.5;cursor:default}
  .sdebar .sdenew{color:var(--amber,#e0a030)}
  .sdebar .sdeerr{color:var(--red,#d05050)}
  `;
  function injectCss() {
    if (typeof document === 'undefined' || document.getElementById('sde-css')) return;
    const st = document.createElement('style');
    st.id = 'sde-css';
    st.textContent = STATUS_CSS;
    document.head.appendChild(st);
  }

  const fmtBytes = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB';

  /* Renders "<what the page loaded> · SDE <version>" and, when CCP has a newer
     build than the local copy, says so and offers the button that replaces it.
     The check costs one 80-byte request; the download only happens on a click,
     because 26 MB is not something to start behind someone's back. */
  function mountStatus(el, opts) {
    const o = opts || {};
    injectCss();
    el.className = (el.className ? el.className + ' ' : '') + 'sdebar';
    el.textContent = '';
    const msg = document.createElement('span'); msg.className = 'sdemsg';
    const ver = document.createElement('span'); ver.className = 'sdever';
    const note = document.createElement('span');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sdeupd'; btn.hidden = true;
    el.append(msg, ver, note, btn);

    const say = (text, cls) => { note.textContent = text ? ' ' + text : ''; note.className = cls || ''; };

    const paint = (info) => {
      msg.textContent = o.summary ? o.summary() : '';
      if (!info) { ver.textContent = ''; return; }
      ver.textContent = (msg.textContent ? ' · ' : '') + 'SDE ' + info.v
        + (info.build ? ' (build ' + info.build + ')' : '')
        + (info.source === 'bundled' ? ', as shipped' : '');
      ver.title = info.source === 'bundled'
        ? 'this is the copy the site was deployed with; Update replaces it with one you fetch yourself'
        : 'your own copy, fetched from CCP and kept in this browser';
    };

    const run = async () => {
      btn.disabled = true;
      btn.textContent = 'updating…';
      try {
        const out = await refresh({
          onProgress: (p) => {
            btn.textContent = p.total
              ? 'reading ' + p.phase.replace(/\.jsonl$/, '') + ' ' + fmtBytes(p.done) + '/' + fmtBytes(p.total)
              : 'reading ' + p.phase;
          },
          onWarn: (m) => console.warn('SDE: ' + m),
        });
        btn.hidden = true;
        say('');
        if (o.onUpdated) await o.onUpdated();
        paint({ v: out.v, build: out.build, source: 'local' });
        say('updated to build ' + out.build);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Retry update';
        say('update failed: ' + (e.message || e), 'sdeerr');
      }
    };
    btn.addEventListener('click', run);

    return {
      /* Called once the page knows what it loaded. `info` may be null — a page
         that loads its data lazily has nothing to report yet, and this must not
         make it load anything, so the local build is read from IndexedDB and
         the remote one from an 80-byte request. */
      async ready(info) {
        if (info) paint(info);
        let st;
        try { st = await status(); } catch (e) { return; }
        if (st.err) { say('could not reach CCP to check for a newer build', 'sdeerr'); return; }
        if (!st.remote) return;
        const offer = (why, cls) => {
          say(why, cls);
          btn.textContent = 'Update';
          btn.title = 'download the current SDE from CCP and derive your own copy — about 26 MB';
          btn.hidden = false;
        };
        const localBuild = st.local ? st.local.build : (info && info.source === 'bundled' ? info.build : null);
        if (localBuild == null) {
          offer('using the copy this site shipped with; Update makes one of your own');
        } else if (st.remote.build > localBuild) {
          offer('CCP has build ' + st.remote.build + ' (' + (st.remote.released || '').slice(0, 10) + ')', 'sdenew');
        } else {
          say('current');
        }
      },
      update: run,
      paint,
      /* the page could not read the data at all: keep the bar, because the
         Update button is the way out of exactly this state */
      fail(text) {
        msg.textContent = text;
        ver.textContent = '';
        say('');
        btn.textContent = 'Update';
        btn.disabled = false;
        btn.hidden = false;
      },
    };
  }

  const SDE = {
    HOST, MEMBERS, latestUrl,
    zipUrl, openZip, entryStream, eachLine, latest, build, derive,
    load, refresh, status, dropLocal, readLocal, writeLocal, mountStatus,
  };

  root.SDE = SDE;
  if (typeof module === 'object' && module.exports) module.exports = SDE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
