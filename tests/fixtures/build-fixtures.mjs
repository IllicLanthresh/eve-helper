/* Distils the test fixtures out of a real Adam4EVE weekly dump.

   Nothing here is invented. Every row written to tests/fixtures/ is a verbatim line from
   the published file, picked so the suites exercise a market shape that actually occurs:
   a type traded almost entirely against sell orders, one traded almost entirely into buy
   orders, one that never touches a sell order at some hubs, and one that exists at Jita
   and nowhere else. The only edit made to any field is the scanDate shift used to build
   the year-boundary week (see YEAR_BOUNDARY below), and the two deliberately damaged
   files, which are labelled as such.

   Re-run it when Adam4EVE changes the format:
       node tests/fixtures/build-fixtures.mjs /path/to/marketOrderTrades_weekly_2026-33.csv

   The measured aggregates it prints are the same ones tools/verify-tracker.mjs asserts,
   computed here from the distilled slice rather than from the whole dump, so the fixture
   manifest and the harness can be compared against each other. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[3] || dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node build-fixtures.mjs <marketOrderTrades_weekly_YYYY-WW.csv> [outdir]');
  process.exit(2);
}

const HEADER = 'location_id;region_id;type_id;is_buy_order;has_gone;scanDate;amount;high;low;avg;orderNum;iskValue';

/* The tool's five hubs, in the order index.html lists them. */
const HUBS = {
  60003760: 'jita',
  60008494: 'amarr',
  60011866: 'dodixie',
  60005686: 'hek',
  60004588: 'rens',
};

/* Two real non-hub locations, kept so a parser that forgets to filter has something to
   trip over: one NPC station and one player structure (the id above 2^32 is the tell). */
const NON_HUBS = [60006658, 1044752365771];

/* Three real stations whose rows carry an EMPTY region_id. 23 such rows in week 2026-33
   and 9 in week 2026-34, never at a hub. They are kept whatever their type, because a
   parser that requires every numeric column to parse drops them — and a parser that
   drops a whole CHUNK on the first unparseable field drops the good rows around them
   too. region_id is not a field the tool needs; the station id is the key. */
const QUIRK_LOCS = [60015260, 60015261, 60015262];

/* Chosen off the real week-33 numbers — see the manifest for each one's measured share. */
const TYPES = {
  34:    'Tritanium',                      // both sides everywhere, sell-heavy
  62516: 'Compressed Veldspar',            // both sides everywhere, buy-heavy
  2272:  'Heavy Metals',                   // buy-heavy at Jita, ZERO sell units at two hubs
  24515: 'Inferno Precision Heavy Missile',// sell side only at three hubs
  77118: 'Amperum Mutanite',               // buy side only, and only at Jita
  11399: 'Morphite',                       // sell-heavy at all five hubs
  16273: 'Liquid Ozone',                   // middling share, all five hubs
};

/* ISO-8601 week of a 'YYYY-MM-DD' day: the Thursday of that week fixes both numbers. */
function isoWeek(day) {
  const t = new Date(day + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const jan1 = Date.UTC(y, 0, 1);
  return { y, w: Math.ceil(((t - jan1) / 86400e3 + 1) / 7) };
}

const lines = readFileSync(SRC, 'utf8').split('\n');
if (lines[0].trim() !== HEADER) {
  console.error('unexpected header:\n  got      ' + lines[0].trim() + '\n  expected ' + HEADER);
  process.exit(2);
}

const keepLoc = new Set([...Object.keys(HUBS).map(Number), ...NON_HUBS]);
const quirk = new Set(QUIRK_LOCS);
const kept = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const f = line.split(';');
  const isQuirk = quirk.has(Number(f[0]));
  if (!isQuirk && (!keepLoc.has(Number(f[0])) || !TYPES[Number(f[2])])) continue;
  kept.push({ line, loc: Number(f[0]), type: Number(f[2]), buy: Number(f[3]) === 1, day: f[5],
              amount: Number(f[6]), high: Number(f[7]), low: Number(f[8]), avg: Number(f[9]),
              orderNum: Number(f[10]), iskValue: Number(f[11]) });
}
kept.sort((a, b) => a.day.localeCompare(b.day) || a.loc - b.loc || a.type - b.type || a.buy - b.buy);

const days = [...new Set(kept.map(r => r.day))].sort();
const { y: wkYear, w: wkNum } = isoWeek(days[0]);

mkdirSync(OUT, { recursive: true });
const write = (name, body) => { writeFileSync(join(OUT, name), body); return name; };
const csv = rows => HEADER + '\n' + rows.map(r => r.line).join('\n') + '\n';
const written = [];

/* --- the week, and each of its days on its own, under the real published filenames --- */
written.push(write(`marketOrderTrades_weekly_${wkYear}-${wkNum}.csv`, csv(kept)));
for (const d of days)
  written.push(write(`marketOrderTrades_daily_${d}.csv`, csv(kept.filter(r => r.day === d))));

/* --- the year-boundary week -------------------------------------------------------
   ISO week 1 of 2026 runs Mon 2025-12-29 to Sun 2026-01-04, so its file lives under
   /2026/ and is named weekly_2026-1 even though four of its seven days fall in 2025.
   No real dump for it was available offline, so this is the same real rows with only
   scanDate remapped day-for-day. Every other field is untouched. */
const YEAR_BOUNDARY = ['2025-12-29', '2025-12-30', '2025-12-31',
                       '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
const shifted = kept.map(r => {
  const to = YEAR_BOUNDARY[days.indexOf(r.day)];
  const f = r.line.split(';'); f[5] = to;
  return { ...r, day: to, line: f.join(';') };
});
written.push(write('marketOrderTrades_weekly_2026-1.csv', csv(shifted)));

/* --- a body that stops mid-row, the shape a dropped connection leaves behind ------- */
const whole = csv(kept.filter(r => r.day === days[0]));
written.push(write('truncated.csv', whole.slice(0, Math.floor(whole.length * 0.4)).replace(/\n[^\n]*$/, '\n') +
  kept[0].line.slice(0, 28)));

/* --- rows a strict parser must drop without throwing, around rows it must keep ----- */
const good = kept.filter(r => r.day === days[0] && HUBS[r.loc]).slice(0, 3);
written.push(write('malformed.csv', [
  HEADER,
  good[0].line,
  '60003760;10000002;34;0;0;2026-08-10;12345',                       // short row
  '',                                                                // blank line
  good[1].line,
  '60003760;10000002;34;0;0;2026-08-10;NaN;3.97;3.89;3.89;95;1000',  // amount not a number
  '60003760;10000002;;0;0;2026-08-10;10;1;1;1;1;10',                 // empty type_id
  'location_id;region_id;type_id;is_buy_order;has_gone;scanDate;amount;high;low;avg;orderNum;iskValue',
  good[2].line + '\r',                                               // stray CR
  '   ',
].join('\n') + '\n'));

/* --- the manifest: what the fixture actually measures, per hub and per type -------- */
const agg = new Map();
for (const r of kept) {
  if (!HUBS[r.loc]) continue;
  const k = r.loc + '|' + r.type;
  let a = agg.get(k);
  if (!a) agg.set(k, a = { hub: r.loc, hubName: HUBS[r.loc], typeId: r.type, name: TYPES[r.type],
                           sellUnits: 0, buyUnits: 0, sellDays: 0, buyDays: 0, sellTrades: 0, buyTrades: 0 });
  if (r.buy) { a.buyUnits += r.amount; a.buyDays++; a.buyTrades += r.orderNum; }
  else { a.sellUnits += r.amount; a.sellDays++; a.sellTrades += r.orderNum; }
}
const rows = [...agg.values()].map(a => ({
  ...a, capture: a.sellUnits + a.buyUnits > 0 ? a.sellUnits / (a.sellUnits + a.buyUnits) : null,
})).sort((x, y) => x.hub - y.hub || x.typeId - y.typeId);

const vw = r => r.amount > 0 ? r.iskValue / r.amount : 0;
const detail = r => ({ line: r.line, hub: r.loc, hubName: HUBS[r.loc], typeId: r.type, name: TYPES[r.type],
                       day: r.day, isBuyOrder: r.buy ? 1 : 0, amount: r.amount, high: r.high, low: r.low,
                       avg: r.avg, iskValue: r.iskValue, vwap: vw(r) });

/* The anchor rows are the WORST case of each defect, not the first one found, so a suite
   asserting on them fails loudly rather than by a rounding tick. */
const badAvg = kept.filter(r => HUBS[r.loc] && r.avg < r.low)
  .sort((a, b) => (b.low - b.avg) / b.low - (a.low - a.avg) / a.low);
const outOfBand = kept.filter(r => HUBS[r.loc] && r.amount > 0 && (vw(r) < r.low - 1e-9 || vw(r) > r.high + 1e-9))
  .sort((a, b) => Math.max(vw(b) / b.high, b.low / vw(b)) - Math.max(vw(a) / a.high, a.low / vw(a)));
/* the same defect where it does NOT bite: avg below low, yet the volume-weighted price
   still lands inside the day's band, which is the case the clamp must leave alone */
const inBandDespiteAvg = badAvg.filter(r => r.high > r.low && vw(r) > r.low && vw(r) < r.high);

const manifestHubRows = kept.filter(r => HUBS[r.loc]).length;
const manifest = {
  builtFrom: SRC.split('/').pop(),
  header: HEADER,
  week: `${wkYear}-${String(wkNum).padStart(2, '0')}`,
  days,
  hubs: HUBS,
  nonHubs: NON_HUBS,
  emptyRegionLocations: QUIRK_LOCS,
  types: TYPES,
  rowCount: kept.length,
  hubRowCount: manifestHubRows,
  perHubType: rows,
  anchors: {
    avgBelowLow: { count: badAvg.length, of: manifestHubRows, worst: detail(badAvg[0]),
                   inBandDespite: detail(inBandDespiteAvg[0]) },
    vwapOutOfBand: { count: outOfBand.length, of: manifestHubRows, worst: detail(outOfBand[0]) },
    maxOrderNum: Math.max(...kept.map(r => r.orderNum)),
    emptyRegionId: { count: kept.filter(r => r.line.split(';')[1] === '').length,
                     example: (kept.find(r => r.line.split(';')[1] === '') || {}).line },
  },
  files: written.concat(['manifest.json']).sort(),
  notes: {
    'marketOrderTrades_weekly_2026-33.csv': 'the whole distilled week, real rows, real dates',
    'marketOrderTrades_daily_2026-08-10.csv': 'one day of it — the other six days follow the same name',
    'marketOrderTrades_weekly_2026-1.csv': 'ISO week 1 of 2026 = Mon 2025-12-29 .. Sun 2026-01-04, '
      + 'so it is filed under /2026/ and named 2026-1, NOT 2026-01 and NOT /2025/. '
      + 'Same real rows with only scanDate remapped, since no real dump for that week was available offline.',
    'truncated.csv': 'a real daily body cut mid-row, the shape a dropped connection leaves',
    'malformed.csv': 'good rows around a short row, a blank line, an unparseable amount, an empty '
      + 'type_id, a repeated header and a stray CR — every one of them must be dropped, and every '
      + 'good row around them kept',
    hubs: 'the tool\u2019s five hubs; every other location in these files is there to be filtered out',
    emptyRegionId: 'real rows whose region_id is blank (23 in week 2026-33, 9 in 2026-34, never at a '
      + 'hub). region_id is not a key here — a parser that requires it drops real data.',
    avgColumn: 'the published avg column is below the day low on ' + badAvg.length + ' of '
      + manifestHubRows + ' hub rows in this slice, so the volume-weighted price has to come from '
      + 'iskValue / amount instead. anchors.avgBelowLow.inBandDespite is the row that shows the '
      + 'difference most plainly.',
    orderNum: 'a count of observed order-book changes, not transactions — a floor on trades, so '
      + 'amount / orderNum is a ceiling on units per trade',
  },
};
written.push(write('manifest.json', JSON.stringify(manifest, null, 2) + '\n'));

console.log('wrote ' + written.length + ' files to ' + OUT);
console.log('  rows kept: ' + kept.length + ' (' + manifest.hubRowCount + ' at the five hubs)');
console.log('  days: ' + days[0] + ' .. ' + days[days.length - 1] + '  week ' + manifest.week);
console.log('  avg < low: ' + badAvg.length + '   iskValue/amount out of band: ' + outOfBand.length);
console.log('  max orderNum: ' + manifest.anchors.maxOrderNum);
console.log('\n  hub        type   name                              sell units      buy units  share');
for (const r of rows) console.log('  ' + r.hubName.padEnd(9) + ' ' + String(r.typeId).padStart(6) + '  '
  + (r.name || '?').padEnd(32) + String(r.sellUnits).padStart(14) + String(r.buyUnits).padStart(15)
  + (r.capture == null ? '     —' : ('  ' + r.capture.toFixed(4))));
