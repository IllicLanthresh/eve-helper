/* A miniature Static Data Export, in CCP's JSONL-in-a-zip shape.

   Small enough to read, complete enough that sde.js's real derivation runs over
   it end to end: a blueprint with skills, a reaction, an invention, a blueprint
   that references a type nobody has (so the pruning branch fires), an
   engineering rig and a reactor rig with their modifier records, a Thukker rig,
   the five structures the anchors name, and enough ore to exercise all three
   base-family rules plus the four reprocessing-skill anchors.

   The zip is assembled by hand — 30-byte local headers, deflate-raw members, a
   central directory, an EOCD — because that is exactly what the reader in
   sde.js has to cope with, and a library would hide it. */
'use strict';
const zlib = require('zlib');

/* ---------- zip writer ---------- */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text, 'utf8');
    const body = zlib.deflateRawSync(raw, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(raw) : crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // no extra field

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);

    parts.push(local, nameBuf, body);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/* zlib.crc32 landed in Node 20.15; this is the fallback for older runtimes */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- the data ---------- */
const jsonl = (rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

/* deterministic incompressible filler (a plain LCG, so the fixture is stable) */
function noise(seed, len) {
  let x = (seed * 2654435761) >>> 0;
  let s = '';
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += 'abcdefghijklmnopqrstuvwxyz0123456789'[(x >>> 16) % 36];
  }
  return s;
}
const nm = (en) => ({ de: en, en, fr: en });

const BUILD = 4000001;
const RELEASED = '2026-08-20T11:08:35Z';

/* group ids used below, named so the fixture reads */
const G = {
  mineral: 18, veldspar: 450, moonUbiq: 1884, ice: 465, mercoxit: 456,
  battleship: 27, skill: 255, blueprint: 105,
  rigEngShip: 1868, rigReactor: 1939, rigComponent: 1834,
  citadel: 1657, engComplex: 1404, refinery: 1406,
};
const CAT = { asteroid: 25, ship: 6, module: 7, structureModule: 66, structure: 65, charge: 8 };

function types() {
  const t = [];
  const push = (id, name, groupID, extra) => t.push(Object.assign(
    { _key: id, name: nm(name), groupID, published: true, volume: 1, portionSize: 1 }, extra || {}));

  // minerals and a product
  push(34, 'Tritanium', G.mineral, { volume: 0.01, packagedVolume: 0.01, marketGroupID: 1857 });
  push(35, 'Pyerite', G.mineral, { volume: 0.01, packagedVolume: 0.01, marketGroupID: 1857 });
  push(645, 'Dominix', G.battleship, { volume: 454500, packagedVolume: 50000, marketGroupID: 81, metaGroupID: 1 });
  push(999, 'Dominix Blueprint', G.blueprint, { volume: 0.01, marketGroupID: 2 });
  push(3380, 'Battleship Construction', G.skill, { volume: 0.01 });
  push(11399, 'Morphite', G.mineral, { volume: 0.01, marketGroupID: 1857 });

  // reaction chain
  push(16657, 'Hydrocarbons', G.mineral, { volume: 0.05, marketGroupID: 1857 });
  push(16672, 'Fullerides', G.mineral, { volume: 0.15, marketGroupID: 1857 });
  push(45732, 'Fullerides Reaction Formula', G.blueprint, { volume: 0.01, marketGroupID: 2 });
  push(45746, 'Reactions', G.skill, { volume: 0.01 });

  // invention chain
  push(1000, 'Dominix Navy Issue Blueprint', G.blueprint, { volume: 0.01, marketGroupID: 2 });
  push(20416, 'Datacore - Gallentean Starship Engineering', G.mineral, { volume: 0.1, marketGroupID: 1857 });
  push(11442, 'Gallente Starship Engineering', G.skill, { volume: 0.01 });

  // a blueprint whose material no longer exists -> the pruning branch
  push(1001, 'Ghost Blueprint', G.blueprint, { volume: 0.01, marketGroupID: 2 });

  // ores: three base-family rules and the four skill anchors
  push(1230, 'Veldspar', G.veldspar, { volume: 0.1, portionSize: 100, marketGroupID: 500 });
  push(1231, 'Veldspar II-Grade', G.veldspar, { volume: 0.1, portionSize: 100, marketGroupID: 500 });
  push(1232, 'Compressed Veldspar', G.veldspar, { volume: 0.01, portionSize: 100, marketGroupID: 500 });
  push(1233, 'Compressed Veldspar II-Grade', G.veldspar, { volume: 0.01, portionSize: 100, marketGroupID: 500 });
  push(1234, 'Zeolites', G.moonUbiq, { volume: 0.15, portionSize: 100, marketGroupID: 510 });
  push(1235, 'Brimful Zeolites', G.moonUbiq, { volume: 0.15, portionSize: 100, marketGroupID: 510 });
  push(1236, 'Compressed Brimful Zeolites', G.moonUbiq, { volume: 0.015, portionSize: 100, marketGroupID: 510 });
  push(1237, 'Mercoxit', G.mercoxit, { volume: 40, portionSize: 250, marketGroupID: 520 });
  push(1238, 'Clear Icicle', G.ice, { volume: 1000, portionSize: 1, marketGroupID: 530 });
  push(1239, 'Blue Ice', G.ice, { volume: 1000, portionSize: 1, marketGroupID: 530 });
  // the grade convention on an ice type whose market group is pluralised: only
  // the strip-the-grade rule can family this one
  push(1240, 'Blue Ice IV-Grade', G.ice, { volume: 1000, portionSize: 1, marketGroupID: 530 });
  push(1241, 'Compressed Blue Ice IV-Grade', G.ice, { volume: 100, portionSize: 1, marketGroupID: 530 });
  // the older adjective-in-front convention, and a one-off with no family
  push(1242, 'Thick Clear Icicle', G.ice, { volume: 1000, portionSize: 1, marketGroupID: 530 });
  push(1243, 'Banidine', G.veldspar, { volume: 0.1, portionSize: 100 });
  // an unpublished asteroid type, which must be skipped and counted
  t.push({ _key: 1244, name: nm('Test Asteroid'), groupID: G.veldspar, published: false, volume: 1, portionSize: 1 });

  // reprocessing skills
  push(3385, 'Simple Ore Processing', G.skill, { volume: 0.01 });
  push(3386, 'Ubiquitous Moon Ore Processing', G.skill, { volume: 0.01 });
  push(3387, 'Mercoxit Ore Processing', G.skill, { volume: 0.01 });
  push(3388, 'Ice Processing', G.skill, { volume: 0.01 });

  // rigs. A rig with no market group is the legacy outpost kind and must not
  // reach the catalog even though it has a modifier record.
  push(37180, 'Standup XL-Set Ship Manufacturing Efficiency I', G.rigEngShip, { marketGroupID: 2349 });
  push(46496, 'Standup L-Set Reactor Efficiency I', G.rigReactor, { marketGroupID: 2342 });
  push(45640, 'Standup M-Set Thukker Advanced Component Manufacturing Material Efficiency', G.rigComponent, { marketGroupID: 2350 });
  push(47883, 'Upwell A1F Outpost Rig', G.rigEngShip, {});

  // structures the anchors check
  push(35825, 'Raitaru', G.engComplex, { marketGroupID: 2200 });
  push(35835, 'Athanor', G.refinery, { marketGroupID: 2200 });
  push(35826, 'Azbel', G.engComplex, { marketGroupID: 2200 });
  push(35836, 'Tatara', G.refinery, { marketGroupID: 2200 });
  push(35827, 'Sotiyo', G.engComplex, { marketGroupID: 2200 });
  return t;
}

function members(overrides) {
  const o = overrides || {};
  const files = {
    '_sde.jsonl': jsonl([{ _key: 'sde', buildNumber: BUILD, releaseDate: RELEASED }]),

    'blueprints.jsonl': jsonl([
      { _key: 999, blueprintTypeID: 999, maxProductionLimit: 300, activities: {
        manufacturing: { time: 6000,
          materials: [{ typeID: 34, quantity: 24000 }, { typeID: 35, quantity: 4500 }],
          products: [{ typeID: 645, quantity: 1 }],
          skills: [{ typeID: 3380, level: 1 }] },
        copying: { time: 4800 },
        research_material: { time: 2100 },
        research_time: { time: 2100 } } },
      { _key: 1000, blueprintTypeID: 1000, maxProductionLimit: 1, activities: {
        invention: { time: 63900,
          materials: [{ typeID: 20416, quantity: 2 }],
          products: [{ typeID: 1000, quantity: 1, probability: 0.3 }],
          skills: [{ typeID: 11442, level: 1 }] } } },
      { _key: 45732, blueprintTypeID: 45732, maxProductionLimit: 1000000, activities: {
        reaction: { time: 360,
          materials: [{ typeID: 16657, quantity: 100 }],
          products: [{ typeID: 16672, quantity: 20 }],
          skills: [{ typeID: 45746, level: 1 }] } } },
      { _key: 1001, blueprintTypeID: 1001, maxProductionLimit: 1, activities: {
        manufacturing: { time: 100,
          materials: [{ typeID: 88888, quantity: 1 }],
          products: [{ typeID: 645, quantity: 1 }], skills: [] } } },
    ]),

    'categories.jsonl': jsonl([
      { _key: CAT.asteroid, name: nm('Asteroid'), published: true },
      { _key: CAT.ship, name: nm('Ship'), published: true },
      { _key: CAT.module, name: nm('Module'), published: true },
      { _key: CAT.charge, name: nm('Charge'), published: true },
      { _key: CAT.structure, name: nm('Structure'), published: true },
      { _key: CAT.structureModule, name: nm('Structure Module'), published: true },
      { _key: 16, name: nm('Skill'), published: true },
      { _key: 4, name: nm('Material'), published: true },
      { _key: 9, name: nm('Blueprint'), published: true },
    ]),

    'groups.jsonl': jsonl([
      { _key: G.mineral, name: nm('Mineral'), categoryID: 4, published: true },
      { _key: G.skill, name: nm('Science'), categoryID: 16, published: true },
      { _key: G.blueprint, name: nm('Ship Blueprint'), categoryID: 9, published: true },
      { _key: G.battleship, name: nm('Battleship'), categoryID: CAT.ship, published: true },
      { _key: G.veldspar, name: nm('Veldspar'), categoryID: CAT.asteroid, published: true },
      { _key: G.moonUbiq, name: nm('Ubiquitous Moon Asteroids'), categoryID: CAT.asteroid, published: true },
      { _key: G.ice, name: nm('Ice'), categoryID: CAT.asteroid, published: true },
      { _key: G.mercoxit, name: nm('Mercoxit'), categoryID: CAT.asteroid, published: true },
      { _key: G.rigEngShip, name: nm('Structure Engineering Rig XL - Ship Efficiency'), categoryID: CAT.structureModule, published: true },
      { _key: G.rigReactor, name: nm('Structure Reactor Rig L - Efficiency'), categoryID: CAT.structureModule, published: true },
      { _key: G.rigComponent, name: nm('Structure Engineering Rig M - Component'), categoryID: CAT.structureModule, published: true },
      { _key: G.citadel, name: nm('Citadel'), categoryID: CAT.structure, published: true },
      { _key: G.engComplex, name: nm('Engineering Complex'), categoryID: CAT.structure, published: true },
      { _key: G.refinery, name: nm('Refinery'), categoryID: CAT.structure, published: true },
    ]),

    'marketGroups.jsonl': jsonl([
      { _key: 2, nameID: nm('Blueprints'), parentGroupID: 0 },
      { _key: 81, nameID: nm('Battleships'), parentGroupID: 4 },
      { _key: 4, nameID: nm('Ships'), parentGroupID: 0 },
      { _key: 500, nameID: nm('Veldspar'), parentGroupID: 0 },
      { _key: 510, nameID: nm('Ubiquitous Moon Ores'), parentGroupID: 0 },
      { _key: 520, nameID: nm('Mercoxit'), parentGroupID: 0 },
      { _key: 530, nameID: nm('Ice Ores'), parentGroupID: 0 },
      { _key: 1857, nameID: nm('Minerals'), parentGroupID: 0 },
      { _key: 2200, nameID: nm('Citadels'), parentGroupID: 0 },
      { _key: 2342, nameID: nm('Reactor Rigs'), parentGroupID: 0 },
      { _key: 2349, nameID: nm('Engineering Rigs'), parentGroupID: 0 },
      { _key: 2350, nameID: nm('Component Rigs'), parentGroupID: 0 },
    ]),

    'industryTargetFilters.jsonl': jsonl([
      { _key: 3, categoryIDs: [CAT.ship], name: 'Ships' },
      { _key: 14, groupIDs: [332, 334], name: 'Components' },
      { _key: 15, groupIDs: [913], name: 'Advanced Capital Components' },
      { _key: 18, groupIDs: [G.mineral], name: 'Composite Reactions' },
    ]),

    'industryModifierSources.jsonl': jsonl([
      { _key: 35825, manufacturing: { cost: [{ dogmaAttributeID: 2601 }], material: [{ dogmaAttributeID: 2600 }], time: [{ dogmaAttributeID: 2602 }] } },
      { _key: 37180, manufacturing: { material: [{ dogmaAttributeID: 2592, filterID: 3 }], time: [{ dogmaAttributeID: 2591, filterID: 3 }] } },
      { _key: 46496, reaction: { material: [{ dogmaAttributeID: 2718, filterID: 18 }], time: [{ dogmaAttributeID: 2717, filterID: 18 }] } },
      { _key: 45640, manufacturing: { material: [{ dogmaAttributeID: 2557, filterID: 14 }, { dogmaAttributeID: 2658, filterID: 15 }] } },
      { _key: 47883, manufacturing: { material: [{ dogmaAttributeID: 2592, filterID: 3 }] } },
    ]),

    'compressibleTypes.jsonl': jsonl([
      { _key: 1230, compressedTypeID: 1232 },
      { _key: 1231, compressedTypeID: 1233 },
      { _key: 1235, compressedTypeID: 1236 },
      { _key: 1240, compressedTypeID: 1241 },
    ]),

    'typeMaterials.jsonl': jsonl([
      { _key: 1230, materials: [{ materialTypeID: 34, quantity: 400 }] },
      { _key: 1231, materials: [{ materialTypeID: 34, quantity: 440 }] },
      { _key: 1232, materials: [{ materialTypeID: 34, quantity: 400 }] },
      { _key: 1234, materials: [{ materialTypeID: 35, quantity: 50 }] },
      { _key: 1237, materials: [{ materialTypeID: 11399, quantity: 530 }] },
      { _key: 1238, materials: [{ materialTypeID: 34, quantity: 69 }] },
    ]),

    'dogmaAttributes.jsonl': jsonl([
      { _key: 790, name: 'reprocessingSkillType' },
      { _key: 1137, name: 'rigSlots' },
      { _key: 1298, name: 'canFitShipGroup01' },
      { _key: 1299, name: 'canFitShipGroup02' },
      { _key: 1300, name: 'canFitShipGroup03' },
      { _key: 1301, name: 'canFitShipGroup04' },
      { _key: 1547, name: 'rigSize' },
      { _key: 2355, name: 'hiSecModifier' },
      { _key: 2356, name: 'lowSecModifier' },
      { _key: 2357, name: 'nullSecModifier' },
      { _key: 2593, name: 'attributeEngRigTimeBonus' },
      { _key: 2594, name: 'attributeEngRigMatBonus' },
      { _key: 2595, name: 'attributeEngRigCostBonus' },
      { _key: 2653, name: 'attributeThukkerEngRigMatBonus' },
      { _key: 2713, name: 'RefRigTimeBonus' },
      { _key: 2714, name: 'RefRigMatBonus' },
      { _key: 9, name: 'mass' },
    ]),

    /* A big member the derivation never opens, filled with text that does not
       deflate away. The real archive is 99 MB of which we read 26; without
       something bulky here, "reads far less than the whole archive" would be a
       vacuous claim about a file smaller than the end-of-directory probe. */
    'missions.jsonl': jsonl(Array.from({ length: 3000 }, (_, i) => (
      { _key: 100000 + i, name: nm('Mission ' + i), briefing: noise(i, 120) }))),

    'types.jsonl': jsonl(types()),

    'typeDogma.jsonl': jsonl([
      { _key: 37180, dogmaAttributes: [
        { attributeID: 1547, value: 4 }, { attributeID: 1298, value: G.citadel },
        { attributeID: 1299, value: G.engComplex },
        { attributeID: 2355, value: 1 }, { attributeID: 2356, value: 1.9 }, { attributeID: 2357, value: 2.1 },
        { attributeID: 2593, value: -20 }, { attributeID: 2594, value: -2 }, { attributeID: 2595, value: 0 }] },
      { _key: 46496, dogmaAttributes: [
        { attributeID: 1547, value: 3 }, { attributeID: 1298, value: G.refinery },
        { attributeID: 2356, value: 1 }, { attributeID: 2357, value: 1.1 },
        { attributeID: 2713, value: -20 }, { attributeID: 2714, value: -2 }] },
      { _key: 45640, dogmaAttributes: [
        { attributeID: 1547, value: 2 }, { attributeID: 1298, value: G.engComplex },
        { attributeID: 2355, value: 0.1 }, { attributeID: 2356, value: 1.9 }, { attributeID: 2357, value: 0.1 },
        { attributeID: 2593, value: 0 }, { attributeID: 2594, value: -2 }, { attributeID: 2653, value: -3.7 }] },
      { _key: 47883, dogmaAttributes: [{ attributeID: 1547, value: 3 }, { attributeID: 1298, value: G.citadel }] },
      { _key: 35825, dogmaAttributes: [{ attributeID: 1547, value: 2 }, { attributeID: 1137, value: 3 }] },
      { _key: 35835, dogmaAttributes: [{ attributeID: 1547, value: 2 }, { attributeID: 1137, value: 3 }] },
      { _key: 35826, dogmaAttributes: [{ attributeID: 1547, value: 3 }, { attributeID: 1137, value: 3 }] },
      { _key: 35836, dogmaAttributes: [{ attributeID: 1547, value: 3 }, { attributeID: 1137, value: 3 }] },
      { _key: 35827, dogmaAttributes: [{ attributeID: 1547, value: 4 }, { attributeID: 1137, value: 3 }] },
      { _key: 1230, dogmaAttributes: [{ attributeID: 790, value: 3385 }] },
      { _key: 1231, dogmaAttributes: [{ attributeID: 790, value: 3385 }] },
      { _key: 1232, dogmaAttributes: [{ attributeID: 790, value: 3385 }] },
      { _key: 1233, dogmaAttributes: [{ attributeID: 790, value: 3385 }] },
      { _key: 1234, dogmaAttributes: [{ attributeID: 790, value: 3386 }] },
      { _key: 1235, dogmaAttributes: [{ attributeID: 790, value: 3386 }] },
      { _key: 1236, dogmaAttributes: [{ attributeID: 790, value: 3386 }] },
      { _key: 1237, dogmaAttributes: [{ attributeID: 790, value: 3387 }] },
      { _key: 1238, dogmaAttributes: [{ attributeID: 790, value: 3388 }] },
      { _key: 1239, dogmaAttributes: [{ attributeID: 790, value: 3388 }] },
      { _key: 1240, dogmaAttributes: [{ attributeID: 790, value: 3388 }] },
      { _key: 1241, dogmaAttributes: [{ attributeID: 790, value: 3388 }] },
      { _key: 1242, dogmaAttributes: [{ attributeID: 790, value: 3388 }] },
      { _key: 1243, dogmaAttributes: [{ attributeID: 790, value: 3385 }] },
    ]),
  };
  for (const [k, v] of Object.entries(o)) {
    if (v == null) delete files[k]; else files[k] = v;
  }
  return files;
}

/* The zip, ready to serve. `overrides` replaces (or with null, removes) members
   so a test can break one thing and watch the reader refuse it. */
function buildZip(overrides) {
  return zip(Object.entries(members(overrides)));
}

const latestJsonl = (build) =>
  JSON.stringify({ _key: 'sde', buildNumber: build == null ? BUILD : build, releaseDate: RELEASED }) + '\n';

module.exports = { buildZip, members, latestJsonl, jsonl, nm, BUILD, RELEASED, G, CAT, types };
