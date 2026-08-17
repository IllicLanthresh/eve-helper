/* The Mine page against exact SDE ore data: the two page modes (plan production vs
   fleet mode) over one shared DOM, survey-scan parsing, refined vs compressed ISK/m³
   with real (mocked) skills and a picked facility, the 100:1 compression model, ISK/h
   math, the shopping-list planner (ranks + mining plan) on the same exact numbers,
   the data-derived skills panel, and persistence — all against a hand-written
   data/ores.json fixture.

   data/ores.json is gitignored and built from the SDE at deploy time, so it is normally
   absent from a checkout. The fetch is intercepted and served a fixture whose entries
   are copied VERBATIM from the real SDE 2025-07-07 build (Veldspar 400 Tritanium per
   100-unit portion, Dense 440, Scordite 99 Pyerite — not the 110 the old curated table
   claimed, Mordunium 88 — not 97, Brimful Zeolites 9200/460/75, Clear Icicle's four ice
   products, Banidine with no refine outputs and no compressed variant, per-type "s"
   reprocessing-skill tids incl. Kylixium=Variegated and Hezorime=Complex), so every
   expected number below is hand-computed from known-true data. */
'use strict';
const H = require('./helper');
const { check, eq, near, section } = H;

const CHAR = { id: 93813310, name: 'Miquel Dreamer' };

/* ---------- fixture: verbatim entries from the SDE-built data/ores.json ---------- */
const ORES_FIXTURE = {
  v: '2025-07-07',
  ores: {
    1230:  { n: 'Veldspar', v: 0.1, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 400]], c: 62516, cv: 0.001, ice: 0, s: 60377 },
    1228:  { n: 'Scordite', v: 0.15, p: 100, g: 'Scordite', b: 'Scordite', m: [[34, 150], [35, 99]], c: 62520, cv: 0.0015, ice: 0, s: 60377 },
    17470: { n: 'Concentrated Veldspar', v: 0.1, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 420]], c: 62517, cv: 0.001, ice: 0, s: 60377 },
    17471: { n: 'Dense Veldspar', v: 0.1, p: 100, g: 'Veldspar', b: 'Veldspar', m: [[34, 440]], c: 62518, cv: 0.001, ice: 0, s: 60377 },
    17453: { n: 'Fiery Kernite', v: 1.2, p: 100, g: 'Kernite', b: 'Kernite', m: [[36, 66], [37, 132]], c: 62538, cv: 0.012, ice: 0, s: 60378 },
    17449: { n: 'Pristine Jaspet', v: 2, p: 100, g: 'Jaspet', b: 'Jaspet', m: [[36, 165], [38, 55]], c: 62542, cv: 0.02, ice: 0, s: 60378 },
    17428: { n: 'Triclinic Bistot', v: 16, p: 100, g: 'Bistot', b: 'Bistot', m: [[35, 3360], [36, 1260], [39, 168]], c: 62565, cv: 0.16, ice: 0, s: 60380 },
    17869: { n: 'Magma Mercoxit', v: 40, p: 100, g: 'Mercoxit', b: 'Mercoxit', m: [[11399, 147]], c: 62587, cv: 0.4, ice: 0, s: 12189 },
    74521: { n: 'Mordunium', v: 0.1, p: 100, g: 'Mordunium', b: 'Mordunium', m: [[35, 88]], c: 75275, cv: 0.001, ice: 0, s: 60377 },
    81900: { n: 'Kylixium', v: 1.2, p: 100, g: 'Kylixium', b: 'Kylixium', m: [[34, 300], [35, 200], [36, 550]], c: 82300, cv: 0.012, ice: 0, s: 60379 },
    82163: { n: 'Hezorime', v: 5, p: 100, g: 'Hezorime', b: 'Hezorime', m: [[34, 2000], [37, 120], [39, 60]], c: 82312, cv: 0.05, ice: 0, s: 60380 },
    45490: { n: 'Zeolites', v: 10, p: 100, g: 'Ubiquitous Moon Asteroids', b: 'Zeolites', m: [[35, 8000], [36, 400], [16634, 65]], c: 62463, cv: 0.1, ice: 0, s: 46152 },
    46280: { n: 'Brimful Zeolites', v: 10, p: 100, g: 'Ubiquitous Moon Asteroids', b: 'Zeolites', m: [[35, 9200], [36, 460], [16634, 75]], c: 62464, cv: 0.1, ice: 0, s: 46152 },
    16262: { n: 'Clear Icicle', v: 1000, p: 1, g: 'Ice', b: 'Clear Icicle', m: [[16272, 69], [16273, 35], [16274, 414], [16275, 1]], c: 28434, cv: 100, ice: 1, s: 18025 },
    28617: { n: 'Banidine', v: 0.1, p: 1, g: 'Veldspar', b: 'Banidine', m: [], c: null, cv: null, ice: 0, s: 60377 },
    // the moon ores of the real 5-column survey scan (group headers + Est. Value column)
    45494: { n: 'Cobaltite', v: 10, p: 100, g: 'Common Moon Asteroids', b: 'Cobaltite', m: [[16640, 40]], c: 62474, cv: 0.1, ice: 0, s: 46153 },
    46288: { n: 'Copious Cobaltite', v: 10, p: 100, g: 'Common Moon Asteroids', b: 'Cobaltite', m: [[16640, 46]], c: 62475, cv: 0.1, ice: 0, s: 46153 },
    45501: { n: 'Chromite', v: 10, p: 100, g: 'Uncommon Moon Asteroids', b: 'Chromite', m: [[16633, 10], [16641, 40]], c: 62480, cv: 0.1, ice: 0, s: 46154 },
    45506: { n: 'Cinnabar', v: 10, p: 100, g: 'Rare Moon Asteroids', b: 'Cinnabar', m: [[16635, 15], [16637, 10], [16646, 50]], c: 62495, cv: 0.1, ice: 0, s: 46155 },
    46310: { n: 'Replete Cinnabar', v: 10, p: 100, g: 'Rare Moon Asteroids', b: 'Cinnabar', m: [[16635, 17], [16637, 12], [16646, 58]], c: 62496, cv: 0.1, ice: 0, s: 46155 },
  },
  names: {
    'veldspar': 1230, 'scordite': 1228, 'concentrated veldspar': 17470, 'dense veldspar': 17471,
    'fiery kernite': 17453, 'pristine jaspet': 17449, 'triclinic bistot': 17428,
    'magma mercoxit': 17869, 'mordunium': 74521, 'kylixium': 81900, 'hezorime': 82163,
    'zeolites': 45490, 'brimful zeolites': 46280, 'clear icicle': 16262,
    'banidine': 28617,
    'cobaltite': 45494, 'copious cobaltite': 46288, 'chromite': 45501,
    'cinnabar': 45506, 'replete cinnabar': 46310,
  },
  types: {
    34: 'Tritanium', 35: 'Pyerite', 36: 'Mexallon', 37: 'Isogen', 38: 'Nocxium',
    39: 'Zydrine', 11399: 'Morphite', 16634: 'Atmospheric Gases',
    16633: 'Hydrocarbons', 16635: 'Evaporite Deposits', 16637: 'Tungsten',
    16640: 'Cobalt', 16641: 'Chromium', 16646: 'Mercury',
    16272: 'Heavy Water', 16273: 'Liquid Ozone', 16274: 'Helium Isotopes', 16275: 'Strontium Clathrates',
    12189: 'Mercoxit Ore Processing', 18025: 'Ice Processing',
    46152: 'Ubiquitous Moon Ore Processing', 46153: 'Common Moon Ore Processing',
    46154: 'Uncommon Moon Ore Processing', 46155: 'Rare Moon Ore Processing',
    60377: 'Simple Ore Processing',
    60378: 'Coherent Ore Processing', 60379: 'Variegated Ore Processing',
    60380: 'Complex Ore Processing',
  },
};

/* names for the /universe/names lookup the fleet fetch does for unfamiliar type ids */
const TID_NAMES = {
  62516: 'Compressed Veldspar', 62517: 'Compressed Concentrated Veldspar',
  62518: 'Compressed Dense Veldspar', 62538: 'Compressed Fiery Kernite',
  62542: 'Compressed Pristine Jaspet', 62565: 'Compressed Triclinic Bistot',
  62587: 'Compressed Magma Mercoxit', 62464: 'Compressed Brimful Zeolites',
  28434: 'Compressed Clear Icicle',
  16272: 'Heavy Water', 16273: 'Liquid Ozone', 16274: 'Helium Isotopes',
  16275: 'Strontium Clathrates',
};

/* tids the mocked market-order route needs beyond helper.NAMED_IDS */
const MARKET_TIDS = {
  'Compressed Veldspar': 62516, 'Compressed Concentrated Veldspar': 62517,
  'Compressed Dense Veldspar': 62518, 'Compressed Fiery Kernite': 62538,
  'Compressed Pristine Jaspet': 62542, 'Compressed Triclinic Bistot': 62565,
  'Compressed Magma Mercoxit': 62587, 'Compressed Brimful Zeolites': 62464,
  'Compressed Clear Icicle': 28434,
  'Heavy Water': 16272, 'Liquid Ozone': 16273, 'Helium Isotopes': 16274,
  'Strontium Clathrates': 16275,
  'Fiery Kernite': 17453, 'Magma Mercoxit': 17869, 'Banidine': 28617,
  'Dense Veldspar': 17471,
};

/* Jita books for the compressed / extra types. Deliberate gaps:
   - Compressed Fiery Kernite has no book -> falls back to the RAW Fiery Kernite price
   - Banidine has no compressed variant  -> falls back to its own raw price
   - Compressed Magma Mercoxit AND raw Magma Mercoxit have no book -> comp is unpriced
   - Strontium Clathrates has no book    -> Clear Icicle refines "partial" */
const BOOKS = {
  'Compressed Veldspar': { buys: [], sells: [{ p: 2000, v: 1e6 }] },
  'Compressed Concentrated Veldspar': { buys: [], sells: [{ p: 1500, v: 1e6 }] },
  'Compressed Dense Veldspar': { buys: [], sells: [{ p: 900, v: 1e6 }] },
  'Compressed Pristine Jaspet': { buys: [], sells: [{ p: 5000, v: 1e6 }] },
  'Compressed Triclinic Bistot': { buys: [], sells: [{ p: 250000, v: 1e6 }] },
  'Compressed Brimful Zeolites': { buys: [], sells: [{ p: 120000, v: 1e6 }] },
  'Compressed Clear Icicle': { buys: [], sells: [{ p: 160000, v: 1e6 }] },
  'Fiery Kernite': { buys: [], sells: [{ p: 60, v: 1e6 }] },
  'Banidine': { buys: [], sells: [{ p: 40, v: 1e6 }] },
  'Heavy Water': { buys: [], sells: [{ p: 15, v: 1e6 }] },
  'Liquid Ozone': { buys: [], sells: [{ p: 90, v: 1e6 }] },
  'Helium Isotopes': { buys: [], sells: [{ p: 850, v: 1e6 }] },
};

/* seeded character: Reprocessing 5, Efficiency 4, per-group ore skills, Ice Processing 3,
   Accounting 5 (sales tax 7.5 × (1 − 0.11×5) = 3.375%) */
const SKILLS = {
  reprocessing: 5, reprocessingEfficiency: 4, accounting: 5,
  'Simple Ore Processing': 5, 'Coherent Ore Processing': 3,
  'Complex Ore Processing': 4, 'Mercoxit Ore Processing': 2,
  'Ubiquitous Moon Ore Processing': 4,
};
const RAW_SKILLS = { 18025: 3 };   // Ice Processing (by type id — not an ore-group skill)

/* a second character with deliberately WORSE reprocessing and NO Accounting — the two
   role dropdowns must produce different numbers depending on who holds each role */
const CHAR2 = { id: 90000002, name: 'Nakiri Ayame' };
const SKILLS2 = { reprocessing: 4, reprocessingEfficiency: 3, 'Simple Ore Processing': 2 };

/* ---------- hand-computed expectations (same shapes as the page formulas) ----------
   yield% = base × (1+3%×Rep) × (1+2%×Eff) × (1+2%×group) × (1+implant)
   refined ISK/m³ = Σ(qtyPerPortion × price) × (yield%/100) / (portionSize × unitVol)
   compressed ISK/m³ = compressedPrice / (ratio × unitVol), ratio 100 ore / 1 ice */
const PCT = (base, rep, eff, grp, imp) =>
  base * (1 + 0.03 * rep) * (1 + 0.02 * eff) * (1 + 0.02 * grp) * (1 + imp / 100);
const REF = (mats, pct, p, v) => {
  let m = 0;
  for (const [q, price] of mats) m += q * price;
  return m * (pct / 100) / (p * v);
};

// NPC station, imp 0; material prices are the section-2 placeholders (no fetch here):
// Tritanium 5, Pyerite 14, Mexallon 80, Isogen 45, Nocxium 95, Zydrine 200,
// Morphite 190, Atmospheric Gases 900; ice products from BOOKS above.
const P_SIMPLE = PCT(50, 5, 4, 5, 0);       // 68.31
const P_COHER = PCT(50, 5, 4, 3, 0);        // 65.826
const P_COMPLEX = PCT(50, 5, 4, 4, 0);      // 67.068
const P_MERC = PCT(50, 5, 4, 2, 0);         // 64.584
const P_UBIQ = PCT(50, 5, 4, 4, 0);         // 67.068
const P_ICE = PCT(50, 5, 4, 3, 0);          // 65.826 (Ice Processing 3)

const EXP = {
  refVeld: REF([[400, 5]], P_SIMPLE, 100, 0.1),                          // 136.62
  refConc: REF([[420, 5]], P_SIMPLE, 100, 0.1),                          // 143.451
  refDense: REF([[440, 5]], P_SIMPLE, 100, 0.1),                         // 150.282
  refJasp: REF([[165, 80], [55, 95]], P_COHER, 100, 2),                  // ~60.64
  refFiery: REF([[66, 80], [132, 45]], P_COHER, 100, 1.2),               // ~61.55
  refTri: REF([[3360, 14], [1260, 80], [168, 200]], P_COMPLEX, 100, 16), // ~76.06
  refBrim: REF([[9200, 14], [460, 80], [75, 900]], P_UBIQ, 100, 10),     // ~156.34
  refMag: REF([[147, 190]], P_MERC, 100, 40),                            // ~4.51
  refIce: REF([[69, 15], [35, 90], [414, 850]], P_ICE, 1, 1000),         // ~234.38 (Strontium excluded)
  compVeld: 2000 / (100 * 0.1),      // 200 — the 100:1 ore compression ratio
  compConc: 1500 / (100 * 0.1),      // 150
  compDense: 900 / (100 * 0.1),      // 90
  compJasp: 5000 / (100 * 2),        // 25
  compTri: 250000 / (100 * 16),      // 156.25
  compBrim: 120000 / (100 * 10),     // 120
  compIce: 160000 / (1 * 1000),      // 160 — ice compresses 1:1 by units
  compFieryRaw: 60 / 1.2,            // 50 — raw-ore fallback (compressed has no book)
  compBanRaw: 40 / 0.1,              // 400 — raw-ore fallback (no compressed variant)
};

/* the 10-line scan pasted in the skills scenario — EU and US numbers, a header line */
const SCAN10 = [
  'Ore Type\tQuantity\tVolume\tDistance',
  'Veldspar\t100.000\t10.000 m3\t7.431 m',            // EU-grouped numbers
  'Concentrated Veldspar\t64,213\t6,421 m3\t12 km',   // US-grouped numbers
  'Dense Veldspar\t41,500\t4,150 m3\t9 km',
  'Pristine Jaspet\t3,205\t6,410 m3\t18 km',
  'Triclinic Bistot\t1,412\t22,592 m3\t31 km',
  'Magma Mercoxit\t402\t16,080 m3\t44 km',
  'Brimful Zeolites\t61,240\t612,400 m3\t3,105 m',
  'Clear Icicle\t1,204\t1,204,000 m3\t21 km',
  'Fiery Kernite\t8,014\t9,617 m3\t15 km',
  'Banidine\t5,000\t500 m3\t2,100 m',
].join('\n');
// per-row m³ as parsed (pasted volume kept when within 2% of qty × unit m³)
const M3 = { veld: 10000, conc: 6421, dense: 4150, jasp: 6410, tri: 22592,
  mag: 16080, brim: 612400, ice: 1204000, fiery: 9617, ban: 500 };
const TOT_M3 = 10000 + 6421 + 4150 + 6410 + 22592 + 16080 + 612400 + 1204000 + 9617 + 500;

/* a REAL full survey-scan copy (verbatim user paste, tabs between cells): five columns
   Name / Quantity / Volume / Est. Value / Distance, EU-grouped numbers, the client's
   per-ore-type GROUP HEADER rows as bare names, and "-" Est. Value cells */
const REAL_SCAN = [
  'Chromite\t30.927\t309.270 m3\t51.600.000,00 ISK\t3.324 m',
  'Chromite\t2.822\t28.220 m3\t4.710.000,00 ISK\t44 km',
  'Chromite\t23.202\t232.020 m3\t38.700.000,00 ISK\t175 km',
  'Replete Cinnabar\t8.187\t81.870 m3\t1.090.000,00 ISK\t94 km',
  'Cinnabar\t26.650\t266.500 m3\t7.830.000,00 ISK\t16 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t23 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t33 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t36 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t38 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t42 km',
  'Cinnabar\t39.974\t399.740 m3\t11.700.000,00 ISK\t46 km',
  'Cinnabar\t26.650\t266.500 m3\t7.830.000,00 ISK\t68 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t69 km',
  'Cinnabar\t39.974\t399.740 m3\t11.700.000,00 ISK\t111 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t113 km',
  'Cinnabar\t38.329\t383.290 m3\t11.300.000,00 ISK\t115 km',
  'Cinnabar\t6.203\t62.030 m3\t1.820.000,00 ISK\t122 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t126 km',
  'Cinnabar\t4.819\t48.190 m3\t1.420.000,00 ISK\t128 km',
  'Cinnabar\t13.325\t133.250 m3\t3.920.000,00 ISK\t135 km',
  'Cinnabar\t30.306\t303.060 m3\t8.910.000,00 ISK\t137 km',
  'Cinnabar\t7.950\t79.500 m3\t2.340.000,00 ISK\t138 km',
  'Cinnabar\t6.868\t68.680 m3\t2.020.000,00 ISK\t144 km',
  'Cinnabar\t26.650\t266.500 m3\t7.830.000,00 ISK\t153 km',
  'Cinnabar\t1.404\t14.040 m3\t413.000,00 ISK\t157 km',
  'Cinnabar\t39.974\t399.740 m3\t11.700.000,00 ISK\t169 km',
  'Copious Cobaltite',
  'Copious Cobaltite\t12.748\t127.480 m3\t-\t49 km',
  'Copious Cobaltite\t23.761\t237.610 m3\t-\t61 km',
  'Copious Cobaltite\t38.643\t386.430 m3\t-\t115 km',
  'Copious Cobaltite\t13.325\t133.250 m3\t-\t141 km',
  'Copious Cobaltite\t39.974\t399.740 m3\t-\t150 km',
  'Copious Cobaltite\t13.325\t133.250 m3\t-\t161 km',
  'Copious Cobaltite\t26.650\t266.500 m3\t-\t163 km',
  'Cobaltite',
  'Cobaltite\t13.313\t133.130 m3\t108.000.000,00 ISK\t12 km',
  'Cobaltite\t26.650\t266.500 m3\t216.000.000,00 ISK\t13 km',
  'Cobaltite\t3.998\t39.980 m3\t32.400.000,00 ISK\t66 km',
  'Cobaltite\t13.325\t133.250 m3\t108.000.000,00 ISK\t84 km',
  'Cobaltite\t26.650\t266.500 m3\t216.000.000,00 ISK\t88 km',
  'Cobaltite\t39.974\t399.740 m3\t324.000.000,00 ISK\t102 km',
  'Cobaltite\t39.974\t399.740 m3\t324.000.000,00 ISK\t105 km',
  'Cobaltite\t26.650\t266.500 m3\t216.000.000,00 ISK\t116 km',
  'Cobaltite\t13.325\t133.250 m3\t108.000.000,00 ISK\t144 km',
  'Cobaltite\t26.650\t266.500 m3\t216.000.000,00 ISK\t146 km',
  'Cobaltite\t26.650\t266.500 m3\t216.000.000,00 ISK\t153 km',
  'Cobaltite\t13.284\t132.840 m3\t108.000.000,00 ISK\t153 km',
  'Cobaltite\t39.974\t399.740 m3\t324.000.000,00 ISK\t174 km',
].join('\n');

/* role-character expectations: CHAR2's worse skills and the two Accounting levels */
const P_SIMPLE2 = PCT(50, 4, 3, 2, 0);                    // 61.7344 — Nakiri's Simple ores
const REF_VELD2 = REF([[400, 5]], P_SIMPLE2, 100, 0.1);   // 123.4688
const TAX1 = 3.375;   // Miquel, Accounting 5: 7.5 × (1 − 0.11×5), on the formula's 3-decimal grid
const TAX2 = 7.5;     // Nakiri, Accounting 0

/* ---------- shared plumbing ---------- */

/* mocked /characters/<id>/skills payload — helper.js's shape, but per character */
const SKILL_ID_MAP = { accounting: 16622, brokerRelations: 3446, reprocessing: 3385, reprocessingEfficiency: 3389 };
function skillList(skills, rawSkills) {
  const list = [];
  for (const [k, lvl] of Object.entries(skills || {})) {
    const id = SKILL_ID_MAP[k] != null ? SKILL_ID_MAP[k] : H.NAMED_IDS[k];
    if (id != null) list.push({ skill_id: id, active_skill_level: lvl, trained_skill_level: lvl });
  }
  for (const [id, lvl] of Object.entries(rawSkills || {}))
    list.push({ skill_id: Number(id), active_skill_level: lvl, trained_skill_level: lvl });
  return list;
}

/* Open mine.html with the ores.json fixture, mocked ESI and (optionally) a login.
   opts.chars: characters to log in (default [CHAR]); opts.skillsByChar: per-character
   skill payloads, e.g. { [CHAR2.id]: { skills: SKILLS2, rawSkills: {} } }. */
async function openMine(browser, server, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  const seed = [];
  const chars = opts.login !== false ? (opts.chars || [CHAR]) : [];
  if (chars.length) seed.push(['eveHelper.auth.v1', H.authState(chars)]);
  if (opts.storage) seed.push(...opts.storage);
  if (seed.length) await H.seedStorage(context, server.url, seed);
  const counters = await H.mockEsi(context, {
    skills: opts.login !== false ? SKILLS : {},
    rawSkills: opts.login !== false ? RAW_SKILLS : {},
    standings: {},
    typeIds: MARKET_TIDS,
    books: opts.books || {},
  });
  // per-character skills override (registered after mockEsi, so it wins; unknown
  // characters fall back to the shared skills route above)
  if (opts.skillsByChar) {
    await context.route('**/characters/*/skills/**', route => {
      const m = /\/characters\/(\d+)\/skills\//.exec(route.request().url());
      const cfg = m && opts.skillsByChar[m[1]];
      if (!cfg) return route.fallback();
      route.fulfill(H.json({ skills: skillList(cfg.skills, cfg.rawSkills), total_sp: 1e8 }));
    });
  }
  // /universe/names resolves display names for the on-demand price fetch
  const state = { oresFetches: 0, namesCalls: 0, oresFail: false };
  await context.route('**/universe/names/**', route => {
    state.namesCalls++;
    let ids = [];
    try { ids = JSON.parse(route.request().postData() || '[]'); } catch (_e) {}
    route.fulfill(H.json(ids.map(id => ({ id, name: TID_NAMES[id] || ('type ' + id) }))));
  });
  // the fixture stands in for the CI-built static data
  await context.route('**/data/ores.json', route => {
    state.oresFetches++;
    if (state.oresFail) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    route.fulfill(H.json(ORES_FIXTURE));
  });
  const page = await context.newPage();
  H.watchPage(page, opts.label || 'mine');
  await page.goto(server.url + '/mine.html');
  return { context, page, counters, state, close: () => context.close() };
}

const waitSkillsNote = page => page.waitForFunction(
  () => /per-ore refine from Miquel Dreamer/.test(document.body.textContent),
  null, { timeout: 15000 });
const waitOreDB = page => page.waitForFunction(
  () => typeof oreDB !== 'undefined' && oreDB !== null, null, { timeout: 15000 });
// settled = every queued price fetched (possibly over several rounds) and re-rendered
const waitSettled = page => page.waitForFunction(() => {
  if (!state.fleet.fetchedAt) return false;
  const tbl = document.querySelector('#fleetTable table');
  if (!tbl) return false;
  return ![...tbl.querySelectorAll('td')].some(td => td.textContent.trim() === '…');
}, null, { timeout: 20000 });
const waitRendered = page => page.waitForFunction(
  () => !!document.querySelector('#fleetTable table'), null, { timeout: 15000 });

/* the whole rendered table, keyed by the sort keys of the current column set */
const tableData = page => page.evaluate(() => {
  const tbl = document.querySelector('#fleetTable table');
  if (!tbl) return null;
  const keys = [...tbl.querySelectorAll('thead th')].map(th => th.dataset.sort);
  const rows = [];
  for (const tr of tbl.querySelectorAll('tbody tr')) {
    const cells = [...tr.children];
    const row = {
      total: tr.classList.contains('total'), best: tr.classList.contains('best'),
      name: tr.classList.contains('total') ? cells[0].textContent
        : (cells[0].querySelector('.orename') || cells[0]).textContent,
      flags: [...tr.querySelectorAll('.flag')].map(f => f.textContent),
      copy: {}, text: {}, title: {},
    };
    keys.forEach((k, i) => {
      row.copy[k] = cells[i] ? (cells[i].dataset.copy != null ? cells[i].dataset.copy : null) : null;
      row.text[k] = cells[i] ? cells[i].textContent : null;
      row.title[k] = cells[i] ? cells[i].title : null;
    });
    rows.push(row);
  }
  return { keys, headers: [...tbl.querySelectorAll('thead th')].map(th => th.textContent), rows };
});

/* raw (unrounded) computed values straight out of the page's own value model */
const rawRows = page => page.evaluate(() => {
  const p = parseSurvey(document.getElementById('fleetScan').value);
  const { rows } = fleetCompute(p.rows);
  return rows.map(r => ({
    name: r.o.n, ref: r.ref, comp: r.comp, refState: r.refState, compState: r.compState,
    compTag: r.compTag, ice: r.ice, merc: r.merc, rocks: r.rocks, units: r.units,
    m3: r.m3, unpriced: r.unpriced, refPct: r.r.pct, detail: r.r.detail,
  }));
});

const cp = v => v == null ? null : parseFloat(v);   // data-copy attr -> number

H.run('mine-fleet', async () => {
  const server = await H.startServer();
  const browser = await H.launch();
  try {
    /* ================= the mode switcher: two peer flows, one shared DOM ================= */
    section('mode switcher: production flow vs fleet flow');
    const sParse = await openMine(browser, server, { login: false, label: 'parse' });
    const visibleSections = page => page.evaluate(() =>
      [...document.querySelectorAll('main > section')]
        .filter(s => getComputedStyle(s).display !== 'none')
        .map(s => ({ id: s.id, h2: s.querySelector('h2').textContent.trim() })));
    const visibleIntro = page => page.evaluate(() =>
      [...document.querySelectorAll('header p')]
        .filter(p => getComputedStyle(p).display !== 'none').map(p => p.textContent).join(' | '));
    eq('first-time users land in production mode',
      await sParse.page.$eval('body', b => b.dataset.mode), 'prod');
    let secs = await visibleSections(sParse.page);
    check('...showing the classic flow: targets → prices → what to mine → your moons',
      JSON.stringify(secs.map(x => x.id)) === '["secTargets","secPrices","secMine","secMoons"]',
      JSON.stringify(secs));
    check('...numbered 1 / 2 / 3 / 4 — the moons are step 4 now, no gap where fleet sat',
      secs.every((x, i) => x.h2.startsWith(['1 ·', '2 ·', '3 ·', '4 ·'][i])),
      JSON.stringify(secs.map(x => x.h2)));
    check('...and no section is numbered 5 or named Fleet mode any more',
      secs.every(x => !/^5 ·/.test(x.h2) && !/Fleet mode/.test(x.h2)), JSON.stringify(secs));
    eq('the shared section reads "Prices & refine" in production',
      await sParse.page.$eval('#pricesTitle', el => el.textContent), 'Prices & refine');
    check('the production intro line is the shopping-list one',
      /production line needs/.test(await visibleIntro(sParse.page)), await visibleIntro(sParse.page));

    // switch: an instant view swap into the paste-first fleet flow
    await sParse.page.click('#modeFleet');
    await sParse.page.waitForFunction(() => document.body.dataset.mode === 'fleet');
    secs = await visibleSections(sParse.page);
    check('fleet mode is paste-first: survey scan → refine & prices → what to shoot',
      JSON.stringify(secs.map(x => x.id)) === '["secScan","secPrices","secShoot"]',
      JSON.stringify(secs));
    check('...numbered 1 / 2 / 3 for its own flow',
      secs.every((x, i) => x.h2.startsWith(['1 ·', '2 ·', '3 ·'][i])),
      JSON.stringify(secs.map(x => x.h2)));
    eq('...with the shared section retitled "Refine & prices"',
      await sParse.page.$eval('#pricesTitle', el => el.textContent), 'Refine & prices');
    check('...targets, plan, arrays and moons are all hidden',
      await sParse.page.evaluate(() => ['secTargets', 'secMine', 'secArrays', 'secMoons']
        .every(id => getComputedStyle(document.getElementById(id)).display === 'none')));
    check('the fleet intro line replaces the production one',
      /no shopping list/.test(await visibleIntro(sParse.page)), await visibleIntro(sParse.page));
    eq('the refine section is ONE shared DOM instance, not a copy: one #facStruct',
      await sParse.page.evaluate(() => document.querySelectorAll('#facStruct').length), 1);
    eq('...one #priceGrid', await sParse.page.evaluate(() => document.querySelectorAll('#priceGrid').length), 1);
    check('...visible inside the fleet flow',
      await sParse.page.$eval('#facStruct', el => getComputedStyle(el.closest('section')).display !== 'none'));

    /* ================= survey-scan parser ================= */
    section('survey-scan parser');
    // entering fleet mode is what loads ores.json; parseSurvey needs the name index
    await waitOreDB(sParse.page);

    const parse = text => sParse.page.evaluate(t => {
      const p = parseSurvey(t);
      return {
        rows: p.rows.map(r => ({ tid: r.tid, name: r.o.n, rocks: r.rocks, units: r.units, m3: r.m3 })),
        unknown: [...p.unknown.entries()], numberless: p.numberless, volFixed: p.volFixed,
        headers: p.headers,
      };
    }, text);

    let p = await parse('Veldspar\t1.234.567');
    eq('EU-grouped 1.234.567 parses to 1234567 units', p.rows[0] && p.rows[0].units, 1234567);
    near('...and the missing volume cell is derived as qty × unit m³',
      p.rows[0] && p.rows[0].m3, 1234567 * 0.1, 1e-6);
    p = await parse('Veldspar\t1,234,567');
    eq('US-grouped 1,234,567 parses to the same 1234567 units', p.rows[0] && p.rows[0].units, 1234567);
    p = await parse("Veldspar\t1'234");
    eq("apostrophe-grouped 1'234 parses to 1234", p.rows[0] && p.rows[0].units, 1234);

    p = await parse('Ore Type\tQuantity\tVolume\tDistance\nVeldspar\t100');
    eq('the scanner-window header line is skipped', p.rows.length, 1);
    p = await parse('Name\t123\nAsteroid\t55\nVeldspar\t100');
    eq('generic header cells (Name/Asteroid) are skipped too', p.rows.length, 1);
    eq('...without landing in the unrecognized list', p.unknown.length, 0);

    p = await parse('Veldspar\t1\u00a0000\r\n\r\nDense Veldspar\t2\u00a0000\r\n');
    eq('CRLF + blank lines + NBSP-grouped numbers: two rows', p.rows.length, 2);
    eq('...first with 1000 units', p.rows[0].units, 1000);
    eq('...second with 2000 units', p.rows[1].units, 2000);

    p = await parse('Quafe Zero\t5\nQuafe Zero\t7\nVeldspar\t100');
    eq('unknown names never make rows', p.rows.length, 1);
    check('...and are aggregated with a count', JSON.stringify(p.unknown) === '[["Quafe Zero",2]]',
      JSON.stringify(p.unknown));

    p = await parse('Veldspar\t100\t10 m3\nVeldspar\t50\t5 m3');
    eq('duplicate ore rows aggregate into one row', p.rows.length, 1);
    eq('...counting each rock', p.rows[0].rocks, 2);
    eq('...summing units', p.rows[0].units, 150);
    near('...and summing m³', p.rows[0].m3, 15, 1e-9);

    p = await parse('Veldspar\t1,000\t100 m3\t7,431 m');
    near('with a distance column the pasted volume is used', p.rows[0].m3, 100, 1e-9);
    eq('...and no cell is flagged as ignored', p.volFixed, 0);
    p = await parse('Veldspar\t1,000\t100 m3');
    near('without the distance column the row parses identically', p.rows[0].m3, 100, 1e-9);
    p = await parse('Veldspar\t1,000\t100 m³');
    near('the m³ (unicode) suffix is stripped like m3', p.rows[0].m3, 100, 1e-9);
    p = await parse('Veldspar\t1,000\t44 km');
    near('a km distance in the volume slot parses NaN and is ignored', p.rows[0].m3, 100, 1e-9);
    eq('...without counting as an ignored volume cell', p.volFixed, 0);
    p = await parse('Veldspar\t1,000\t7431');
    near('a bare-number distance deviating >2% from qty × unit m³ is overridden', p.rows[0].m3, 100, 1e-9);
    eq('...and counted as an ignored volume cell', p.volFixed, 1);
    p = await parse('Veldspar\tabc');
    eq('a row with no readable number makes no row', p.rows.length, 0);
    eq('...and is counted visibly instead of vanishing', p.numberless, 1);

    p = await parse('Concentrated Veldspar 64,213 6,421 m3 7,431 m');
    eq('single-space rows peel the trailing numbers off the name', p.rows[0] && p.rows[0].name,
      'Concentrated Veldspar');
    eq('...with the quantity', p.rows[0] && p.rows[0].units, 64213);
    near('...and the volume', p.rows[0] && p.rows[0].m3, 6421, 1e-9);
    p = await parse('Dense Veldspar   41,500   4,150 m3   9 km');
    eq('multi-space separated rows split on runs of spaces', p.rows[0] && p.rows[0].units, 41500);

    // an interior empty Quantity cell must not shift the volume into the quantity slot
    p = await parse('Veldspar\t\t10 m3');
    near('an empty Quantity cell keeps the volume in its own column: 10 m³', p.rows[0] && p.rows[0].m3, 10, 1e-9);
    eq('...deriving 100 units from it — not 10 units from the shifted cell', p.rows[0] && p.rows[0].units, 100);
    // a cell carrying the m³ suffix is a volume no matter which slot it landed in
    p = await parse('Veldspar\t6,421 m3');
    near('an m³-suffixed cell in the quantity slot is read as the volume', p.rows[0] && p.rows[0].m3, 6421, 1e-9);
    eq('...with the quantity derived from it', p.rows[0] && p.rows[0].units, 64210);
    p = await parse('Veldspar 6,421 m3');
    near('...also in a single-space hand-typed row', p.rows[0] && p.rows[0].m3, 6421, 1e-9);
    // FR-locale space grouping survives losing its tabs (Discord/chat relays)
    p = await parse('Concentrated Veldspar 64 213 6 421 m3 7 431 m');
    eq('space-grouped (FR) numbers in a single-space row: the full 64,213 quantity', p.rows[0] && p.rows[0].units, 64213);
    near('...and the full 6,421 m³ volume', p.rows[0] && p.rows[0].m3, 6421, 1e-9);
    eq('...with no volume cell flagged as ignored', p.volFixed, 0);
    p = await parse('Veldspar 64\u202f213');   // narrow NBSP grouping (FR locale)
    eq('narrow-NBSP grouped quantities parse whole', p.rows[0] && p.rows[0].units, 64213);

    /* ---------- the real 5-column scan: group headers + Est. Value column ---------- */
    section('real survey scan: group-header rows and the Est. Value column');
    // verbatim user scan (tabs between cells): the scanner window groups rocks by ore
    // type, and Ctrl+A/Ctrl+C copies the bare ore-name group-header rows too; the 4th
    // column is the client's Est. Value in ISK \u2014 sometimes just "-"
    p = await parse(REAL_SCAN);
    eq('5 ore types parse from the 48-line paste', p.rows.length, 5);
    eq('nothing lands in the unrecognized list', p.unknown.length, 0);
    eq('the two bare group-header rows are counted as headers', p.headers, 2);
    eq('...not as numberless rows', p.numberless, 0);
    eq('...and the ISK/distance columns never trip the volume sanity check', p.volFixed, 0);
    const PR = n => p.rows.find(r => r.name === n) || {};
    eq('Chromite: 3 rocks', PR('Chromite').rocks, 3);
    eq('...56,951 units (EU 30.927 + 2.822 + 23.202)', PR('Chromite').units, 56951);
    near('...569,510 m\u00b3', PR('Chromite').m3, 569510, 1e-9);
    eq('Replete Cinnabar: 1 rock', PR('Replete Cinnabar').rocks, 1);
    eq('Cinnabar: 22 rocks', PR('Cinnabar').rocks, 22);
    eq('Copious Cobaltite: all 7 data rows survive their "-" Est. Value cells', PR('Copious Cobaltite').rocks, 7);
    eq('...168,426 units', PR('Copious Cobaltite').units, 168426);
    eq('Cobaltite: all 13 data rows kept \u2014 nothing about the group is "unrecognized"', PR('Cobaltite').rocks, 13);
    eq('...310,417 units', PR('Cobaltite').units, 310417);
    // the header rule is name-resolution-based: a bare name the data does NOT resolve
    // stays visibly unrecognized instead of being eaten as a "header"
    p = await parse('Quafe Zero');
    eq('a bare unresolvable name is not a group header', p.headers, 0);
    check('...it stays in the unrecognized list', JSON.stringify([...p.unknown]) === '[["Quafe Zero",1]]',
      JSON.stringify([...p.unknown]));
    p = await parse('Cobaltite');
    eq('a bare resolvable name IS a group header', p.headers, 1);
    eq('...and makes no data row', p.rows.length, 0);
    // an ISK-suffixed cell is the Est. Value column even when tabs collapsed it into
    // the volume slot \u2014 a price must never be read as a volume
    p = await parse('Veldspar\t1.000\t51.600.000,00 ISK');
    near('an ISK cell in the volume slot is ignored \u2014 volume derives from qty \u00d7 unit m\u00b3',
      p.rows[0] && p.rows[0].m3, 100, 1e-9);
    eq('...without counting as an ignored volume cell', p.volFixed, 0);

    /* ---------- parser notes in the UI ---------- */
    section('parser notes in the UI');
    await sParse.page.fill('#fleetScan',
      'Veldspar\t1000\t7431\nVeldspar\tabc\nQuafe Zero\t5\nQuafe Zero\t7');
    await waitSettled(sParse.page);
    let note = await sParse.page.$eval('#fleetNote', el => el.textContent);
    check('the note reports the skipped numberless row', /1 row without readable numbers skipped/.test(note), note);
    check('...and the ignored volume cell', /1 volume cell ignored/.test(note), note);
    const unk = await sParse.page.$eval('#fleetUnknown', el => ({ hidden: el.hidden, text: el.textContent }));
    eq('the unrecognized note is visible', unk.hidden, false);
    check('...listing the name with its ×2 count', /Quafe Zero ×2/.test(unk.text), unk.text);
    check('...with the softened wording — no SDE assertion, just "unrecognized ore names"',
      /^unrecognized ore names \(rows kept out of the ranking\): /.test(unk.text)
      && !/SDE/.test(unk.text), unk.text);

    // recognized names whose rows all lack numbers must not read as "not recognized"
    await sParse.page.fill('#fleetScan', 'Veldspar\tabc\nDense Veldspar\txyz');
    await sParse.page.waitForFunction(
      () => /no usable rows/.test(document.getElementById('fleetTable').textContent));
    note = await sParse.page.$eval('#fleetTable', el => el.textContent);
    check('an all-numberless paste says what actually kept the table empty',
      /no usable rows — 2 recognized ore rows without a readable quantity or volume/.test(note), note);

    // ...and a paste of nothing but group headers says THAT, not "no usable rows"
    await sParse.page.fill('#fleetScan', 'Cobaltite\nChromite');
    await sParse.page.waitForFunction(
      () => /group header/.test(document.getElementById('fleetTable').textContent));
    note = await sParse.page.$eval('#fleetTable', el => el.textContent);
    check('a headers-only paste is called out as such',
      /no data rows — only 2 group headers \(bare ore-type names\)/.test(note), note);

    // the full real scan: headers surface in the parse-status note, nothing is dropped
    await sParse.page.fill('#fleetScan', REAL_SCAN);
    await waitSettled(sParse.page);
    note = await sParse.page.$eval('#fleetNote', el => el.textContent);
    check('the real scan summarizes 5 ore types · 46 rocks', /5 ore types · 46 rocks/.test(note), note);
    check('...and mentions the ignored group headers', /2 group headers ignored/.test(note), note);
    check('...with no numberless-row or ignored-volume complaint',
      !/without readable numbers|volume cell/.test(note), note);
    eq('...and the unrecognized note stays hidden',
      await sParse.page.$eval('#fleetUnknown', el => el.hidden), true);

    // the sample scan: 9 rows, 8 types, Concentrated Veldspar pasted twice
    await sParse.page.click('#btnFleetSample');
    await waitSettled(sParse.page);
    note = await sParse.page.$eval('#fleetNote', el => el.textContent);
    check('the sample scan parses to 8 ore types from 9 rocks', /8 ore types · 9 rocks/.test(note), note);
    eq('...with nothing unrecognized', await sParse.page.$eval('#fleetUnknown', el => el.hidden), true);
    check('logged out, a visible note declares the flat-refine basis of the whole column',
      /refined values use the flat 75% refine — log in with EVE/.test(note), note);
    let raw = await rawRows(sParse.page);
    const concS = raw.find(r => r.name === 'Concentrated Veldspar');
    eq('the two Concentrated Veldspar rows aggregate to 2 rocks', concS && concS.rocks, 2);
    eq('...86,321 units', concS && concS.units, 86321);
    near('...8,632 m³', concS && concS.m3, 8632, 1e-9);
    // not logged in: the flat refine input (75%) prices the refined column
    near('logged out, refined uses the flat 75% refine: Concentrated = 420×5 × 0.75 ÷ 10',
      concS && concS.ref, 2100 * (75 / 100) / (100 * 0.1), 1e-9);
    // no books in this context: ice products are unpriced -> flagged, never zeroed
    const iceS = raw.find(r => r.name === 'Clear Icicle');
    eq('an ore whose refine outputs all lack a book is unpriced', iceS && iceS.refState, 'unpriced');
    eq('...with ref null, NOT zero', iceS && iceS.ref, null);
    let tbl = await tableData(sParse.page);
    const iceRow = tbl.rows.find(r => r.name === 'Clear Icicle');
    check('...rendered as an em-dash with an "unpriced" flag',
      /—/.test(iceRow.text.ref) && iceRow.flags.some(f => f === 'unpriced'),
      JSON.stringify({ text: iceRow.text.ref, flags: iceRow.flags }));

    // the chosen mode persists (and the fleet paste survives a visit to production).
    // Wait for the STORED state, not the mere DOM state — reloading mid-persist races.
    await sParse.page.click('#modeProd');   // back to production
    await sParse.page.waitForFunction(() => {
      const st = JSON.parse(localStorage.getItem('eveHelper.mine.v1') || '{}');
      return document.body.dataset.mode === 'prod' && st.mode === 'prod';
    });
    const fetchesBeforeReload = sParse.state.oresFetches;
    await sParse.page.reload();
    await sParse.page.waitForFunction(() => document.querySelector('#rankList').children.length > 0);
    eq('production mode persists across reload',
      await sParse.page.$eval('body', b => b.dataset.mode), 'prod');
    eq('...the fleet sections stay hidden',
      await sParse.page.$eval('#secScan', el => getComputedStyle(el).display), 'none');
    eq('...and the production page (no targets, no moons) does not refetch ores.json',
      sParse.state.oresFetches, fetchesBeforeReload);
    eq('...while the fleet paste still restored underneath',
      await sParse.page.$eval('#fleetScan', el => el.value.split('\n')[1]),
      'Concentrated Veldspar\t64,213\t6,421 m3\t7,431 m');
    await sParse.close();

    /* ================= the shopping-list planner on exact SDE numbers ================= */
    section('mining plan from exact ores.json densities (no curated numbers)');
    const s = await openMine(browser, server, { books: BOOKS, label: 'skills' });
    await waitSkillsNote(s.page);
    await s.page.fill('#need', 'Pyerite\t1,000,000');
    await s.page.waitForFunction(() => !!document.querySelector('#planBox table'));
    // Pyerite carriers among the ranked base ores in the fixture, densities straight
    // from ores.json (qtyPerPortion ÷ (portionSize × unitVolume)):
    //   Mordunium  88 / (100 × 0.1)  = 8.8 u/m³  (the old curated table said 9.7)
    //   Zeolites 8000 / (100 × 10)   = 8.0 u/m³
    //   Scordite   99 / (100 × 0.15) = 6.6 u/m³  (the old curated table said 7.33)
    // effective m³ = qty ÷ (dens × yield); Simple 5 → 68.31 %, Ubiquitous Moon 4 → 67.068 %
    const M3_MORD = 1e6 / (8.8 * P_SIMPLE / 100);
    const M3_ZEO = 1e6 / (8.0 * P_UBIQ / 100);
    const M3_SCOR = 1e6 / (6.6 * P_SIMPLE / 100);
    const plan = await s.page.evaluate(() => {
      const tr = document.querySelector('#planBox tbody tr');
      return {
        best: tr.children[2].textContent.trim(),
        m3: tr.children[3].dataset.copy, m3Title: tr.children[3].title,
        hours: tr.children[4].textContent.trim(),
        alts: [...tr.children[5].querySelectorAll('.alt')].map(a => ({ t: a.textContent, copy: a.dataset.copy })),
      };
    });
    check('the best Pyerite source is Mordunium', /Mordunium/.test(plan.best), plan.best);
    near('its m³ to mine is hand-computed from exact SDE numbers: 1e6 ÷ (8.8 × 68.31%)',
      parseFloat(plan.m3), Math.round(M3_MORD), 0.5);
    check('...the breakdown names its exact SDE reprocessing skill',
      /Simple Ore Processing 5/.test(plan.m3Title), plan.m3Title);
    eq('...an asteroid source gets no drill hours', plan.hours, '—');
    check('the runner-ups are Zeolites then Scordite',
      plan.alts.length === 2 && /Zeolites/.test(plan.alts[0].t) && /Scordite/.test(plan.alts[1].t),
      JSON.stringify(plan.alts));
    near('...Zeolites at 1e6 ÷ (8.0 × 67.068%)', parseFloat(plan.alts[0].copy), Math.round(M3_ZEO), 0.5);
    near('...Scordite at the SDE 6.6 u/m³, not the curated 7.33',
      parseFloat(plan.alts[1].copy), Math.round(M3_SCOR), 0.5);
    const rankTxt = await s.page.$eval('#rankList', el => el.textContent);
    check('the source ranking shows the exact 8.8 Pye/m³ — the curated 9.7 is gone',
      /8\.8\/m³/.test(rankTxt) && !/9\.7\/m³/.test(rankTxt), rankTxt);
    check('...and Scordite at 6.6, not 7.33', /6\.6\/m³/.test(rankTxt) && !/7\.33/.test(rankTxt), rankTxt);

    section('imported-skills panel: the governs column derives from the data');
    const govern = await s.page.evaluate(() => {
      const rows = [...document.querySelectorAll('#skillsTblBody tr')].slice(1);
      return Object.fromEntries(rows.map(tr => [tr.children[0].textContent, tr.children[2].textContent]));
    });
    check('Variegated governs Kylixium — the SDE mapping (the old page guessed Simple)',
      /Kylixium/.test(govern['Variegated Ore Processing']), govern['Variegated Ore Processing']);
    check('Complex governs Hezorime — the SDE mapping (the old page guessed Variegated)',
      /Hezorime/.test(govern['Complex Ore Processing']), govern['Complex Ore Processing']);
    check('...and Hezorime is NOT under Variegated any more',
      !/Hezorime/.test(govern['Variegated Ore Processing']), govern['Variegated Ore Processing']);
    check('Simple governs Veldspar, Scordite and Mordunium',
      ['Veldspar', 'Scordite', 'Mordunium'].every(o => new RegExp('\\b' + o + '\\b').test(govern['Simple Ore Processing'])),
      govern['Simple Ore Processing']);
    check('the moon skill lists its tier and its actual ores',
      /R4 moon ores — .*Zeolites/.test(govern['Ubiquitous Moon Ore Processing']),
      govern['Ubiquitous Moon Ore Processing']);
    check('no visible text or tooltip reads "assumed" any more',
      await s.page.evaluate(() =>
        !/assumed/i.test(document.body.innerText)
        && ![...document.querySelectorAll('[title]')].some(e => /assumed/i.test(e.title))));

    /* ================= refined vs compressed with real skills ================= */
    section('refined ISK/m³ from seeded skills (NPC station)');
    await s.page.click('#modeFleet');
    await waitOreDB(s.page);
    // the same #facStruct/#skillsBox DOM that just drove the mining plan now sits in the
    // fleet flow — same skills, same facility, one instance
    check('the shared refine section is visible in fleet mode',
      await s.page.$eval('#secPrices', el => getComputedStyle(el).display !== 'none'));
    check('...with the imported-skills panel still in it',
      await s.page.$eval('#skillsBox', el => !el.hidden));
    await s.page.fill('#fleetScan', SCAN10);
    await waitSettled(s.page);

    raw = await rawRows(s.page);
    const R = n => raw.find(r => r.name === n) || {};
    eq('the 11-line paste (1 header) computes 10 ore rows', raw.length, 10);
    near('Veldspar: 400 Trit × 5 ISK × 68.31% ÷ (100 × 0.1 m³)', R('Veldspar').ref, EXP.refVeld, 1e-9);
    near('...where 68.31% = 50% × Rep 5 × Eff 4 × Simple 5', EXP.refVeld, 136.62, 1e-9);
    near('Concentrated Veldspar (420 Trit)', R('Concentrated Veldspar').ref, EXP.refConc, 1e-9);
    near('Dense Veldspar (440 Trit)', R('Dense Veldspar').ref, EXP.refDense, 1e-9);
    near('the +5% variant is exactly 1.05× plain — no approximation',
      R('Concentrated Veldspar').ref / R('Veldspar').ref, 1.05, 1e-12);
    near('the +10% variant is exactly 1.10× plain and beats it',
      R('Dense Veldspar').ref / R('Veldspar').ref, 1.10, 1e-12);
    check('...so Dense > Concentrated > plain',
      R('Dense Veldspar').ref > R('Concentrated Veldspar').ref
      && R('Concentrated Veldspar').ref > R('Veldspar').ref);
    near('Pristine Jaspet at Coherent 3 (Mexallon+Nocxium)', R('Pristine Jaspet').ref, EXP.refJasp, 1e-9);
    near('Fiery Kernite at Coherent 3 (Mexallon+Isogen)', R('Fiery Kernite').ref, EXP.refFiery, 1e-9);
    near('Triclinic Bistot at Complex 4', R('Triclinic Bistot').ref, EXP.refTri, 1e-9);
    near('Brimful Zeolites (moon ore) at Ubiquitous Moon 4', R('Brimful Zeolites').ref, EXP.refBrim, 1e-9);
    near('Magma Mercoxit at Mercoxit 2', R('Magma Mercoxit').ref, EXP.refMag, 1e-9);
    near('Clear Icicle at Ice Processing 3, Strontium excluded', R('Clear Icicle').ref, EXP.refIce, 1e-9);
    eq('...its state is partial, not ok', R('Clear Icicle').refState, 'partial');
    check('...naming exactly the unpriced output',
      JSON.stringify(R('Clear Icicle').unpriced) === '["Strontium Clathrates"]',
      JSON.stringify(R('Clear Icicle').unpriced));
    eq('Banidine (no refine outputs in the SDE) has state none', R('Banidine').refState, 'none');
    eq('...and ref null, not zero', R('Banidine').ref, null);

    section('compressed ISK/m³ and the 100:1 ratio');
    near('Compressed Veldspar 2,000 ISK ÷ (100 × 0.1 m³) = 200', R('Veldspar').comp, EXP.compVeld, 1e-9);
    near('Compressed Dense Veldspar 900 ÷ 10 = 90', R('Dense Veldspar').comp, EXP.compDense, 1e-9);
    near('Compressed Triclinic Bistot 250,000 ÷ (100 × 16)', R('Triclinic Bistot').comp, EXP.compTri, 1e-9);
    near('Compressed Brimful Zeolites 120,000 ÷ (100 × 10)', R('Brimful Zeolites').comp, EXP.compBrim, 1e-9);
    near('ice compresses 1:1 — Compressed Clear Icicle 160,000 ÷ (1 × 1,000 m³)',
      R('Clear Icicle').comp, EXP.compIce, 1e-9);
    check('Veldspar: compressed (200) beats refined (136.62)',
      R('Veldspar').comp > R('Veldspar').ref,
      R('Veldspar').comp + ' vs ' + R('Veldspar').ref);
    check('Dense Veldspar: refined (150.28) beats compressed (90)',
      R('Dense Veldspar').ref > R('Dense Veldspar').comp,
      R('Dense Veldspar').ref + ' vs ' + R('Dense Veldspar').comp);
    near('a compressed type with no book falls back to the RAW ore price: Fiery Kernite 60 ÷ 1.2',
      R('Fiery Kernite').comp, EXP.compFieryRaw, 1e-9);
    check('...and says so', /no Jita sell book — raw ore price/.test(R('Fiery Kernite').compTag),
      R('Fiery Kernite').compTag);
    near('an ore with no compressed variant prices raw too: Banidine 40 ÷ 0.1',
      R('Banidine').comp, EXP.compBanRaw, 1e-9);
    check('...tagged as such', /no compressed variant/.test(R('Banidine').compTag), R('Banidine').compTag);
    eq('Magma Mercoxit (neither compressed nor raw book) is unpriced', R('Magma Mercoxit').compState, 'unpriced');
    eq('...comp null, not zero', R('Magma Mercoxit').comp, null);

    section('the rendered table: flags, best rows, % of best');
    tbl = await tableData(s.page);
    const T = n => tbl.rows.find(r => r.name === n) || { copy: {}, text: {}, title: {}, flags: [] };
    eq('default sort is refined ISK/m³ descending — Clear Icicle first', tbl.rows[0].name, 'Clear Icicle');
    near('the Veldspar cell carries its raw value in data-copy', cp(T('Veldspar').copy.ref), EXP.refVeld, 0.006);
    check('...and its tooltip explains the compression divisor on the compressed side',
      /100 × unit m³/.test(T('Veldspar').title.comp), T('Veldspar').title.comp);
    check('Brimful Zeolites is the best ORE (ice excluded from that contest)', T('Brimful Zeolites').best);
    eq('...at 100% of best', T('Brimful Zeolites').copy.pct, '100');
    check('Clear Icicle out-refines every ore (234 > 156) yet only wins the ICE pool',
      EXP.refIce > EXP.refBrim && T('Clear Icicle').best);
    eq('...also shown as 100% — of the ice pool', T('Clear Icicle').copy.pct, '100');
    check('...and carries the ice flag', T('Clear Icicle').flags.some(f => /^ice — unit-based/.test(f)),
      JSON.stringify(T('Clear Icicle').flags));
    near('Dense Veldspar % of best = dense ÷ Brimful', cp(T('Dense Veldspar').copy.pct),
      EXP.refDense / EXP.refBrim * 100, 0.006);
    check('Magma Mercoxit carries the deep-core flag',
      T('Magma Mercoxit').flags.some(f => /deep-core/.test(f)), JSON.stringify(T('Magma Mercoxit').flags));
    check('...its compressed cell shows — with an unpriced flag, not 0',
      /—/.test(T('Magma Mercoxit').text.comp) && T('Magma Mercoxit').flags.includes('unpriced'),
      JSON.stringify({ text: T('Magma Mercoxit').text.comp, flags: T('Magma Mercoxit').flags }));
    near('...while its refined cell is still priced', cp(T('Magma Mercoxit').copy.ref), EXP.refMag, 0.006);
    check('Fiery Kernite compressed is flagged raw',
      T('Fiery Kernite').flags.includes('raw'), JSON.stringify(T('Fiery Kernite').flags));
    check('Banidine refined is flagged "no refine outputs"',
      T('Banidine').flags.includes('no refine outputs'), JSON.stringify(T('Banidine').flags));
    check('Clear Icicle refined is flagged with the excluded output',
      T('Clear Icicle').flags.some(f => f === 'excl. Strontium Clathrates'),
      JSON.stringify(T('Clear Icicle').flags));
    check('no compression-ratio warning fires on SDE-consistent volumes',
      tbl.rows.every(r => !r.flags.includes('ratio?')));
    note = await s.page.$eval('#fleetNote', el => el.textContent);
    check('the summary counts 10 ore types · 10 rocks', /10 ore types · 10 rocks/.test(note), note);
    check('...with no flat-refine disclaimer while logged in', !/flat \d+% refine/.test(note), note);
    // minerals have no mocked books here, so their placeholder fallback must be declared
    check('placeholder-priced refine outputs get a visible note, not just tooltips',
      /section-2 placeholders/.test(await s.page.$eval('#fleetPriceNote', el => el.textContent)),
      await s.page.$eval('#fleetPriceNote', el => el.textContent));

    // field totals: Σ value × m³ over priced rows only
    const totalRow = tbl.rows.find(r => r.total);
    const expRefIsk = EXP.refIce * M3.ice + EXP.refBrim * M3.brim + EXP.refDense * M3.dense
      + EXP.refConc * M3.conc + EXP.refVeld * M3.veld + EXP.refTri * M3.tri
      + EXP.refFiery * M3.fiery + EXP.refJasp * M3.jasp + EXP.refMag * M3.mag;
    const expCompIsk = EXP.compBanRaw * M3.ban + EXP.compVeld * M3.veld + EXP.compIce * M3.ice
      + EXP.compTri * M3.tri + EXP.compConc * M3.conc + EXP.compBrim * M3.brim
      + EXP.compDense * M3.dense + EXP.compFieryRaw * M3.fiery + EXP.compJasp * M3.jasp;
    check('a field-value totals row renders', !!totalRow);
    near('total m³ over the field', cp(totalRow.copy.m3), TOT_M3, 0.006);
    near('field refined ISK = Σ ref × m³, unpriced rows excluded (Banidine adds nothing)',
      cp(totalRow.copy.ref), expRefIsk, 0.02);
    near('field compressed ISK = Σ comp × m³, Magma Mercoxit excluded',
      cp(totalRow.copy.comp), expCompIsk, 0.02);

    /* ================= ISK/h toggle ================= */
    section('ISK/h toggle: m³/h, per-cycle, time-to-clear');
    eq('with ISK/h off the table has 6 columns', tbl.keys.length, 6);
    await s.page.click('#fleetHrOn');
    await s.page.waitForFunction(() => !document.getElementById('fleetYieldRow').hidden);
    tbl = await tableData(s.page);
    eq('turning it on adds refined ISK/h, compressed ISK/h and clear time', tbl.keys.length, 9);
    check('...with no yield entered, the per-hour cells show —',
      tbl.rows.filter(r => !r.total && r.copy.ref != null).every(r => r.text.refh === '—'));
    check("...and the row asks for the ship's yield",
      /enter your ship/.test(await s.page.$eval('#fleetRateNote', el => el.textContent)));

    await s.page.fill('#fleetRate', '60000');
    await s.page.waitForFunction(() => state.fleet.rate === 60000);
    tbl = await tableData(s.page);
    const T2 = n => tbl.rows.find(r => r.name === n);
    near('refined ISK/h = ISK/m³ × 60,000 m³/h (Veldspar)',
      cp(T2('Veldspar').copy.refh), EXP.refVeld * 60000, 0.006);
    near('compressed ISK/h likewise', cp(T2('Veldspar').copy.comph), EXP.compVeld * 60000, 0.006);
    near('clear time = m³ ÷ rate (Veldspar 10,000 ÷ 60,000 h)', cp(T2('Veldspar').copy.ttc), 10000 / 60000, 0.006);
    eq('...printed in minutes under an hour', T2('Veldspar').text.ttc, '10 min');
    eq('...and in hours above one (Brimful 612,400 m³)', T2('Brimful Zeolites').text.ttc, '10.2 h');

    // the entered rate is an ORE yield — it cannot mine ice (unit-based) or Mercoxit
    // (deep-core), so no hourly figure may be derived from it for those rows
    const MINE_M3 = TOT_M3 - M3.ice - M3.mag;
    eq('Mercoxit gets no ISK/h from the ore yield', T2('Magma Mercoxit').text.refh, '—');
    check('...its tooltip says why', /deep-core/.test(T2('Magma Mercoxit').title.refh),
      T2('Magma Mercoxit').title.refh);
    eq('...nor a clear time', T2('Magma Mercoxit').text.ttc, '—');
    eq('ice gets no ISK/h from the ore yield either', T2('Clear Icicle').text.comph, '—');
    eq('...nor a clear time', T2('Clear Icicle').text.ttc, '—');
    near('the totals clear time covers mineable rows only — ice and Mercoxit excluded',
      cp(tbl.rows.find(r => r.total).copy.ttc), MINE_M3 / 60000, 0.006);
    check('...and its tooltip declares the exclusion',
      /ice\/Mercoxit rows excluded/.test(tbl.rows.find(r => r.total).title.ttc),
      tbl.rows.find(r => r.total).title.ttc);
    const mineRefIsk = expRefIsk - EXP.refIce * M3.ice - EXP.refMag * M3.mag;
    near('the field-average refined ISK/h uses the same mineable subset on both sides of the ÷',
      cp(tbl.rows.find(r => r.total).copy.refh), mineRefIsk / (MINE_M3 / 60000), 0.02);

    await s.page.click('#fleetYCycle');
    await s.page.fill('#fleetCycM3', '750');
    await s.page.fill('#fleetCycSec', '60');
    await s.page.waitForFunction(() => state.fleet.cycM3 === 750 && state.fleet.cycSec === 60);
    const rateNote = await s.page.$eval('#fleetRateNote', el => el.textContent);
    check('per-cycle mode derives 750 m³ × 3600 ÷ 60 s = 45,000 m³/h', /45,000 m³\/h/.test(rateNote), rateNote);
    tbl = await tableData(s.page);
    near('...and the ISK/h column follows the derived rate',
      cp(tbl.rows.find(r => r.name === 'Veldspar').copy.refh), EXP.refVeld * (750 * 3600 / 60), 0.05);

    /* ================= sorting and the % of best baseline ================= */
    section('sorting and the % of best baseline');
    await s.page.click('#fleetTable th[data-sort="comp"]');
    await s.page.waitForFunction(() => state.fleet.sortKey === 'comp' && state.fleet.sortDir === -1);
    tbl = await tableData(s.page);
    eq('sorting by compressed puts raw-priced Banidine (400) first', tbl.rows[0].name, 'Banidine');
    check('...the % column baseline follows to compressed',
      tbl.headers.some(h => /% of best \(compressed\)/.test(h)), JSON.stringify(tbl.headers));
    check('...and Banidine is now the best ore row', tbl.rows[0].best);
    near('Veldspar sits at 200 ÷ 400 = 50% of best',
      cp(tbl.rows.find(r => r.name === 'Veldspar').copy.pct), EXP.compVeld / EXP.compBanRaw * 100, 0.006);
    eq('ice still only competes with ice',
      tbl.rows.find(r => r.name === 'Clear Icicle').copy.pct, '100');
    await s.page.click('#fleetTable th[data-sort="comp"]');
    await s.page.waitForFunction(() => state.fleet.sortDir === 1);
    tbl = await tableData(s.page);
    eq('a second click flips the direction — unpriced Magma Mercoxit first', tbl.rows[0].name, 'Magma Mercoxit');

    // hiding the hourly columns must never leave the sort on an invisible column
    await s.page.click('#fleetTable th[data-sort="comph"]');
    await s.page.waitForFunction(() => state.fleet.sortKey === 'comph' && state.fleet.sortDir === -1);
    await s.page.click('#fleetHrOff');
    await s.page.waitForFunction(() => !state.fleet.iskh && state.fleet.sortKey === 'comp');
    tbl = await tableData(s.page);
    check('a comph sort remaps to comp when the hourly columns hide — the arrow stays visible',
      tbl.headers.some(h => /compressed ISK\/m³[▲▼]/.test(h)), JSON.stringify(tbl.headers));
    eq('...with the identical ordering (Banidine still first)', tbl.rows[0].name, 'Banidine');
    // back to the state the persistence checks below expect: hourly on, comp ascending
    await s.page.click('#fleetHrOn');
    await s.page.click('#fleetTable th[data-sort="comp"]');
    await s.page.waitForFunction(() => state.fleet.iskh && state.fleet.sortDir === 1);

    /* ================= persistence across reload ================= */
    section('persistence across reload');
    const ordersBefore = s.counters.orders;
    const namesBefore = s.state.namesCalls;
    await s.page.reload();
    await waitSkillsNote(s.page);
    await waitSettled(s.page);   // table re-renders purely from the persisted caches
    eq('fleet mode persists across reload', await s.page.$eval('body', b => b.dataset.mode), 'fleet');
    eq('the paste survives the reload', await s.page.$eval('#fleetScan', el => el.value), SCAN10);
    const persisted = await s.page.evaluate(() => ({
      iskh: state.fleet.iskh, ymode: state.fleet.ymode, cycM3: state.fleet.cycM3,
      cycSec: state.fleet.cycSec, rate: state.fleet.rate,
      sortKey: state.fleet.sortKey, sortDir: state.fleet.sortDir, valueCol: state.fleet.valueCol,
    }));
    eq('ISK/h stays on', persisted.iskh, true);
    eq('...in per-cycle mode', persisted.ymode, 'cycle');
    eq('...with the cycle volume', persisted.cycM3, 750);
    eq('...and the cycle time', persisted.cycSec, 60);
    eq('...and the direct rate kept for switching back', persisted.rate, 60000);
    check('the sort key, direction and % baseline persist',
      persisted.sortKey === 'comp' && persisted.sortDir === 1 && persisted.valueCol === 'comp',
      JSON.stringify(persisted));
    tbl = await tableData(s.page);
    eq('...so the re-rendered table is still comp-ascending', tbl.rows[0].name, 'Magma Mercoxit');
    eq('the price cache persists: zero market refetches after reload', s.counters.orders, ordersBefore);
    eq('...and zero name refetches', s.state.namesCalls, namesBefore);
    near('...with the same exact refined value',
      cp(tbl.rows.find(r => r.name === 'Veldspar').copy.ref), EXP.refVeld, 0.006);
    await s.close();

    /* ================= role characters: reprocessor and seller ================= */
    section('reprocessor role: page-local skills, active character untouched');
    const sRole = await openMine(browser, server, {
      books: BOOKS, label: 'roles',
      chars: [CHAR, CHAR2],
      skillsByChar: {
        [CHAR.id]: { skills: SKILLS, rawSkills: RAW_SKILLS },
        [CHAR2.id]: { skills: SKILLS2 },
      },
    });
    await waitSkillsNote(sRole.page);   // the default reprocessor is the active character
    check('the "reprocessed by" select lives in the shared refine section',
      !!(await sRole.page.$('#secPrices select#reproChar')));
    check('the old "skills from" selector is gone', !(await sRole.page.$('#skillChar')));
    const reproOpts = await sRole.page.$eval('#reproChar', el => [...el.options].map(o => o.textContent));
    check('...listing both logged-in characters (EveAuth lists them in id order)',
      JSON.stringify(reproOpts) === JSON.stringify(['Nakiri Ayame', 'Miquel Dreamer']),
      JSON.stringify(reproOpts));
    eq('...defaulting to the character that was active',
      await sRole.page.$eval('#reproChar', el => el.value), String(CHAR.id));

    await sRole.page.click('#modeFleet');
    await waitOreDB(sRole.page);
    await sRole.page.fill('#fleetScan', 'Veldspar\t10,000\t1,000 m3');
    await waitSettled(sRole.page);
    raw = await rawRows(sRole.page);
    near('with Miquel reprocessing, Veldspar refines at his Simple 5 yield (68.31%)',
      raw[0].ref, EXP.refVeld, 1e-9);

    await sRole.page.selectOption('#reproChar', String(CHAR2.id));
    await sRole.page.waitForFunction(
      () => /per-ore refine from Nakiri Ayame/.test(document.body.textContent));
    raw = await rawRows(sRole.page);
    near('switching the reprocessor to Nakiri gives HER yield: 400×5 × 61.7344% ÷ 10',
      raw[0].ref, REF_VELD2, 1e-9);
    check('...a genuinely different number than Miquel’s',
      Math.abs(REF_VELD2 - EXP.refVeld) > 1, REF_VELD2 + ' vs ' + EXP.refVeld);
    eq('...WITHOUT touching the site-wide active character',
      await sRole.page.evaluate(() => EveAuth.active()), CHAR.id);
    const skillsSum = await sRole.page.$eval('#skillsSummary', el => el.textContent);
    check('the imported-skills panel names the reprocessor',
      /skills imported from Nakiri Ayame \(reprocessor\)/.test(skillsSum), skillsSum);
    check('...with her levels', /Reprocessing 4 · Efficiency 3/.test(skillsSum), skillsSum);

    // the role lives in the SHARED section — production planning uses the same skills
    await sRole.page.click('#modeProd');
    await sRole.page.fill('#need', 'Tritanium\t1,000,000');
    await sRole.page.waitForFunction(() => !!document.querySelector('#planBox table'));
    const planTitle = await sRole.page.$eval('#planBox tbody tr td:nth-child(4)', el => el.title);
    check('the production mining plan refines with the reprocessor’s skills too',
      /Simple Ore Processing 2/.test(planTitle), planTitle);

    section('seller role: sales tax nets the fleet values');
    await sRole.page.click('#modeFleet');
    eq('the "sold by" select defaults to gross',
      await sRole.page.$eval('#sellChar', el => el.value), '');
    eq('...and the table area says so',
      await sRole.page.$eval('#fleetSellNote', el => el.textContent), 'gross — no seller selected');
    const sellOpts = await sRole.page.$eval('#sellChar', el => [...el.options].map(o => o.textContent));
    check('...its options are gross + both characters',
      JSON.stringify(sellOpts) === JSON.stringify(['gross (no seller)', 'Nakiri Ayame', 'Miquel Dreamer']),
      JSON.stringify(sellOpts));
    check('...and its tooltip states the no-broker assumption',
      /instant-style disposal/.test(await sRole.page.$eval('#sellChar', el => el.title)),
      await sRole.page.$eval('#sellChar', el => el.title));

    await sRole.page.selectOption('#sellChar', String(CHAR.id));
    await sRole.page.waitForFunction(() =>
      /net of Miquel Dreamer’s 3\.38% sales tax/.test(document.getElementById('fleetSellNote').textContent));
    raw = await rawRows(sRole.page);
    near('refined ISK/m³ scales by exactly (1 − 3.375%) — Accounting 5',
      raw[0].ref, REF_VELD2 * (1 - TAX1 / 100), 1e-9);
    near('...and compressed ISK/m³ likewise', raw[0].comp, EXP.compVeld * (1 - TAX1 / 100), 1e-9);
    tbl = await tableData(sRole.page);
    near('the rendered refined cell is net', cp(tbl.rows[0].copy.ref), REF_VELD2 * (1 - TAX1 / 100), 0.006);
    const totNet = tbl.rows.find(r => r.total);
    near('the field totals are net too: net ref × 1,000 m³',
      cp(totNet.copy.ref), REF_VELD2 * (1 - TAX1 / 100) * 1000, 0.02);
    near('...compressed total likewise', cp(totNet.copy.comp), EXP.compVeld * (1 - TAX1 / 100) * 1000, 0.02);
    check('...and the totals tooltip declares the netting',
      /net of Miquel Dreamer’s 3\.38% sales tax/.test(totNet.title.ref), totNet.title.ref);

    await sRole.page.click('#fleetHrOn');
    await sRole.page.fill('#fleetRate', '60000');
    await sRole.page.waitForFunction(() => state.fleet.rate === 60000);
    tbl = await tableData(sRole.page);
    near('ISK/h derives from the NET value',
      cp(tbl.rows[0].copy.refh), REF_VELD2 * (1 - TAX1 / 100) * 60000, 0.02);
    await sRole.page.click('#fleetHrOff');

    await sRole.page.selectOption('#sellChar', String(CHAR2.id));
    await sRole.page.waitForFunction(() =>
      /net of Nakiri Ayame’s 7\.50% sales tax/.test(document.getElementById('fleetSellNote').textContent));
    raw = await rawRows(sRole.page);
    near('an Accounting-0 seller nets the full 7.5%', raw[0].ref, REF_VELD2 * (1 - TAX2 / 100), 1e-9);
    await sRole.page.selectOption('#sellChar', '');
    await sRole.page.waitForFunction(() =>
      document.getElementById('fleetSellNote').textContent === 'gross — no seller selected');
    raw = await rawRows(sRole.page);
    near('back to gross restores the un-netted value', raw[0].ref, REF_VELD2, 1e-9);

    section('role persistence across reload');
    await sRole.page.selectOption('#sellChar', String(CHAR.id));
    await sRole.page.waitForFunction(() =>
      /net of Miquel Dreamer/.test(document.getElementById('fleetSellNote').textContent));
    const storedRoles = await sRole.page.evaluate(
      () => JSON.parse(localStorage.getItem('eveHelper.mine.v1')).roles);
    check('both roles persist in the stored state',
      storedRoles && storedRoles.repro === CHAR2.id && storedRoles.seller === CHAR.id,
      JSON.stringify(storedRoles));
    await sRole.page.reload();
    await sRole.page.waitForFunction(
      () => /per-ore refine from Nakiri Ayame/.test(document.body.textContent));
    await sRole.page.waitForFunction(() =>
      /net of Miquel Dreamer’s 3\.38% sales tax/.test(document.getElementById('fleetSellNote').textContent));
    eq('the reprocessor select restores', await sRole.page.$eval('#reproChar', el => el.value), String(CHAR2.id));
    eq('the seller select restores', await sRole.page.$eval('#sellChar', el => el.value), String(CHAR.id));
    await waitSettled(sRole.page);
    raw = await rawRows(sRole.page);
    near('...and the values re-render net of the persisted seller over the persisted reprocessor',
      raw[0].ref, REF_VELD2 * (1 - TAX1 / 100), 1e-9);
    eq('the active character is still untouched after all of it',
      await sRole.page.evaluate(() => EveAuth.active()), CHAR.id);
    await sRole.close();

    /* ================= role fallbacks when characters log out ================= */
    section('role fallbacks: the chosen characters logged out');
    const sFall = await openMine(browser, server, {
      books: BOOKS, label: 'fallback',
      storage: [['eveHelper.mine.v1', {
        mode: 'fleet',
        fleetText: 'Veldspar\t10,000\t1,000 m3',
        roles: { repro: CHAR2.id, seller: CHAR2.id },
      }]],
    });
    await waitSkillsNote(sFall.page);   // Nakiri is gone — Miquel is the only login
    await waitSettled(sFall.page);
    const reproWarn = await sFall.page.$eval('#reproWarn', el => ({ hidden: el.hidden, text: el.textContent }));
    eq('the reprocessor warning is visible', reproWarn.hidden, false);
    eq('...naming the fallback (industry.html precedent)',
      reproWarn.text, 'reprocessor character logged out — using Miquel Dreamer');
    eq('...and the select shows the fallback',
      await sFall.page.$eval('#reproChar', el => el.value), String(CHAR.id));
    const sellWarn = await sFall.page.$eval('#sellWarn', el => ({ hidden: el.hidden, text: el.textContent }));
    eq('the seller warning is visible too', sellWarn.hidden, false);
    eq('...naming its fallback', sellWarn.text, 'seller character logged out — using Miquel Dreamer');
    await sFall.page.waitForFunction(() =>
      /net of Miquel Dreamer’s 3\.38% sales tax/.test(document.getElementById('fleetSellNote').textContent));
    check('...with the note carrying the fallback seller’s tax', true);
    raw = await rawRows(sFall.page);
    near('values use the fallback character on both roles: Miquel’s refine net of Miquel’s tax',
      raw[0].ref, EXP.refVeld * (1 - TAX1 / 100), 1e-9);
    await sFall.close();

    section('fully logged out: flat refine, gross values, disabled role selects');
    const sOut = await openMine(browser, server, {
      login: false, books: BOOKS, label: 'roles-out',
      storage: [['eveHelper.mine.v1', {
        mode: 'fleet',
        fleetText: 'Veldspar\t10,000\t1,000 m3',
        roles: { repro: CHAR2.id, seller: CHAR2.id },
      }]],
    });
    await waitSettled(sOut.page);
    eq('the reprocessor select is a disabled "log in…"',
      await sOut.page.$eval('#reproChar', el => el.disabled ? el.options[0].textContent : 'enabled'), 'log in…');
    eq('the seller select is disabled at gross',
      await sOut.page.$eval('#sellChar', el => el.disabled && el.value === ''), true);
    eq('...the note says gross', await sOut.page.$eval('#fleetSellNote', el => el.textContent),
      'gross — no seller selected');
    check('no stale logged-out warnings with nobody to fall back to',
      await sOut.page.evaluate(() =>
        document.getElementById('reproWarn').hidden && document.getElementById('sellWarn').hidden));
    raw = await rawRows(sOut.page);
    near('values are the flat-refine gross ones: 400×5 × 75% ÷ 10',
      raw[0].ref, 2000 * 0.75 / 10, 1e-9);
    await sOut.close();

    /* ================= transient price-fetch failures ================= */
    section('failed price fetches: flagged honestly, never persisted, retried on reload');
    // Compressed Veldspar and Helium Isotopes fail while this set is populated; a 400
    // makes esiFetch throw immediately (no 5xx retry loop), a clean transient error
    const failIds = new Set([62516, 16274]);
    const sErr = await openMine(browser, server, { login: false, books: BOOKS, label: 'fail' });
    await sErr.context.route('**/markets/*/orders/**', route => {
      const tid = Number(new URL(route.request().url()).searchParams.get('type_id'));
      if (failIds.has(tid)) return route.fulfill({ status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' }, body: 'boom' });
      route.fallback();
    });
    await sErr.page.click('#modeFleet');
    await waitOreDB(sErr.page);
    await sErr.page.fill('#fleetScan', 'Veldspar\t10,000\t1,000 m3\nClear Icicle\t10\t10,000 m3');
    await waitSettled(sErr.page);

    raw = await rawRows(sErr.page);
    const veldE = raw.find(r => r.name === 'Veldspar') || {};
    const iceE = raw.find(r => r.name === 'Clear Icicle') || {};
    eq('a failed compressed fetch (raw ore bookless) is state failed — NOT unpriced', veldE.compState, 'failed');
    eq('...comp null, not zero', veldE.comp, null);
    eq('a failed refine-output fetch leaves the ice row partial', iceE.refState, 'partial');
    near('...priced from the outputs that did fetch (Heavy Water + Liquid Ozone, 75% flat)',
      iceE.ref, (69 * 15 + 35 * 90) * 0.75 / 1000, 1e-9);
    tbl = await tableData(sErr.page);
    const veldRow = tbl.rows.find(r => r.name === 'Veldspar');
    const iceRow2 = tbl.rows.find(r => r.name === 'Clear Icicle');
    check('the compressed cell is flagged "fetch failed" — no false "no Jita book" claim',
      veldRow.flags.includes('fetch failed'), JSON.stringify(veldRow.flags));
    const failTitle = await sErr.page.evaluate(() => {
      const f = [...document.querySelectorAll('#fleetTable .flag')].find(x => x.textContent === 'fetch failed');
      return f ? f.title : null;
    });
    check('...whose tooltip names the error and the retry path',
      /network\/ESI error/.test(failTitle || '') && /refresh fleet prices/.test(failTitle || ''), failTitle);
    check('the ice refined cell names exactly the failed output',
      iceRow2.flags.some(f => f === 'fetch failed: Helium Isotopes'), JSON.stringify(iceRow2.flags));
    check('...separately from the bookless one', iceRow2.flags.some(f => f === 'excl. Strontium Clathrates'),
      JSON.stringify(iceRow2.flags));
    note = await sErr.page.$eval('#fleetPriceNote', el => el.textContent);
    check('the completion note carries the failure count instead of reading as success',
      /2 price fetches failed/.test(note), note);

    const stored = await sErr.page.evaluate(
      () => JSON.parse(localStorage.getItem('eveHelper.mine.v1')).fleet.prices);
    eq('failed entries are NOT persisted: Compressed Veldspar', stored['62516'], undefined);
    eq('...nor Helium Isotopes', stored['16274'], undefined);
    check('...while successful fetches are (Compressed Clear Icicle)', !!stored['28434'],
      JSON.stringify(Object.keys(stored)));

    failIds.clear();   // the transient error clears — a plain reload must recover on its own
    await sErr.page.reload();
    await waitSettled(sErr.page);
    raw = await rawRows(sErr.page);
    near('after a reload the failed types refetch automatically: Compressed Veldspar prices',
      (raw.find(r => r.name === 'Veldspar') || {}).comp, EXP.compVeld, 1e-9);
    near('...and the ice row refines in full (bookless Strontium stays excluded)',
      (raw.find(r => r.name === 'Clear Icicle') || {}).ref,
      (69 * 15 + 35 * 90 + 414 * 850) * 0.75 / 1000, 1e-9);
    note = await sErr.page.$eval('#fleetPriceNote', el => el.textContent);
    check('...and the failure note is gone', !/failed/.test(note), note);
    await sErr.close();

    /* ================= a picked facility drives the yield ================= */
    section('a picked refining facility drives the refined value');
    const TATARA = {
      id: 9000001, name: 'Test Tatara', typeId: 35836, typeName: 'Tatara', refinery: 'tatara',
      systemId: 30000999, systemName: 'TEST-1', security: -0.42, regionId: 10000999,
    };
    const sFac = await openMine(browser, server, {
      label: 'facility',
      storage: [
        ['eveHelper.mine.v1', {
          fac: { struct: 's:9000001', rig: 't2', sec: 'ns', imp: 4, structInfo: TATARA },
          fleetText: 'Dense Veldspar\t10,000\t1,000 m3',
          fleet: { open: true },   // pre-mode storage: the fleet SECTION's open flag
        }],
        ['eveHelper.structInfo.v1', { 9000001: TATARA }],
      ],
    });
    await waitSkillsNote(sFac.page);
    eq('legacy storage with the old fleet section open migrates to fleet mode',
      await sFac.page.$eval('body', b => b.dataset.mode), 'fleet');
    await waitSettled(sFac.page);
    const facNote = await sFac.page.$eval('#facNote', el => el.textContent);
    eq('the facility row shows the structure, its detected band and rig multiplier',
      facNote, 'Tatara · TEST-1 (nullsec) — rig ×1.12');
    // base = 55% Tatara × (1 + 3% T2 rig × 1.12 nullsec) = 56.848%, then skills + implant
    const pTatara = PCT(55 * (1 + 0.03 * 1.12), 5, 4, 5, 4);
    const expDenseTatara = 2200 * (pTatara / 100) / (100 * 0.1);
    raw = await rawRows(sFac.page);
    near('Dense Veldspar at Tatara + T2 rig (nullsec) + 4% implant',
      raw[0].ref, expDenseTatara, 1e-9);
    check('...which beats the NPC-station value', raw[0].ref > EXP.refDense,
      raw[0].ref + ' vs ' + EXP.refDense);
    check('the yield breakdown names the 56.85% facility base',
      /base 56\.85%/.test(raw[0].detail), raw[0].detail);
    check('...and the +4% implant', /implant \+4%/.test(raw[0].detail), raw[0].detail);
    tbl = await tableData(sFac.page);
    near('...and the rendered cell agrees', cp(tbl.rows[0].copy.ref), expDenseTatara, 0.006);
    await sFac.close();

    /* ================= lazy load, missing data, retry ================= */
    section('lazy data load, missing ores.json, retry');
    const sLazy = await openMine(browser, server, { login: false, label: 'lazy' });
    await sLazy.page.waitForFunction(() => document.querySelector('#rankList').children.length > 0);
    eq('the page starts in production mode', await sLazy.page.$eval('body', b => b.dataset.mode), 'prod');
    eq('...which, with no targets or moons, fetches no ore data at all', sLazy.state.oresFetches, 0);
    await sLazy.page.reload();
    await sLazy.page.waitForFunction(() => document.querySelector('#rankList').children.length > 0);
    eq('...even across a reload', sLazy.state.oresFetches, 0);

    sLazy.state.oresFail = true;   // deploy-time file absent: the fetch 404s
    await sLazy.page.click('#modeFleet');
    await sLazy.page.waitForFunction(() => typeof oreDBErr !== 'undefined' && oreDBErr !== null,
      null, { timeout: 15000 });
    eq('entering fleet mode is what triggers the load', sLazy.state.oresFetches, 1);
    await sLazy.page.fill('#fleetScan', 'Veldspar 1000');
    const dn = await sLazy.page.$eval('#fleetDataNote', el => ({ hidden: el.hidden, cls: el.className, text: el.textContent }));
    eq('with a paste and no data, the inline error shows', dn.hidden, false);
    check('...as a warning', /warn/.test(dn.cls), dn.cls);
    check('...naming the builder', /tools\/build-industry-data\.mjs/.test(dn.text), dn.text);
    check('...and the data README', /data\/README\.md/.test(dn.text), dn.text);

    sLazy.state.oresFail = false;  // the file gets built — retry must recover in place
    await sLazy.page.click('#fleetDataNote button');
    await waitSettled(sLazy.page);
    eq('retry refetches the data', sLazy.state.oresFetches, 2);
    tbl = await tableData(sLazy.page);
    eq('...and the table renders from the same paste', tbl.rows.filter(r => !r.total).length, 1);
    near('...at the flat logged-out refine: 400×5 × 0.75 ÷ 10 = 150',
      cp(tbl.rows[0].copy.ref), 2000 * (75 / 100) / (100 * 0.1), 0.006);
    await sLazy.close();

    /* ================= the planner needs the data too ================= */
    section('planner data-unavailable state: inline error + retry, never approximations');
    const sPlan = await openMine(browser, server, { login: false, label: 'plan-data' });
    sPlan.state.oresFail = true;
    await sPlan.page.fill('#need', 'Pyerite\t1000');
    await sPlan.page.waitForFunction(
      () => /exact ore data unavailable/.test(document.getElementById('rankList').textContent));
    check('the source ranking shows the unavailable state naming the builder',
      /tools\/build-industry-data\.mjs/.test(await sPlan.page.$eval('#rankList', el => el.textContent)),
      await sPlan.page.$eval('#rankList', el => el.textContent));
    check('...and so does the mining plan',
      /exact ore data unavailable/.test(await sPlan.page.$eval('#planBox', el => el.textContent)),
      await sPlan.page.$eval('#planBox', el => el.textContent));
    await sPlan.page.fill('#moons', 'GMLH-K VIII - 4\nZeolites\t32%');
    await sPlan.page.waitForFunction(
      () => /exact ore data unavailable/.test(document.getElementById('moonList').textContent));
    check('...and the moons section once it has a paste', true);
    check('no plan table was rendered from approximate numbers',
      !(await sPlan.page.$('#planBox table')));
    sPlan.state.oresFail = false;   // the file gets built — retry must recover in place
    await sPlan.page.click('#planBox button');
    await sPlan.page.waitForFunction(() => !!document.querySelector('#planBox table'));
    const planFlat = await sPlan.page.evaluate(() => {
      const tr = document.querySelector('#planBox tbody tr');
      return { best: tr.children[2].textContent.trim(), m3: tr.children[3].dataset.copy };
    });
    check('retry recovers the plan in place: best Pyerite source Mordunium',
      /Mordunium/.test(planFlat.best), planFlat.best);
    near('...at the flat 75% refine: 1000 ÷ (8.8 × 0.75)',
      parseFloat(planFlat.m3), Math.round(1000 / (8.8 * 0.75)), 0.5);
    check('...and the moons section recovered too',
      !/exact ore data unavailable/.test(await sPlan.page.$eval('#moonList', el => el.textContent)),
      await sPlan.page.$eval('#moonList', el => el.textContent));
    await sPlan.close();
  } finally {
    await browser.close();
    await server.close();
  }
});
