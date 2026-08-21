#!/usr/bin/env node
// verify-tracker.mjs
// A second, independent implementation of the Adam4EVE market-order-trades aggregate.
//
// It exists so the page's own parser has something to be checked AGAINST. Nothing the
// app reads is produced here: no artifact is written, nothing is committed, this file is
// never run by tests/run-all.js and never at deploy time. It is a hand-run harness.
//
// Usage:
//   node tools/verify-tracker.mjs <csv> [<csv> ...]   aggregate one or more dumps
//   node tools/verify-tracker.mjs --fixtures          aggregate tests/fixtures/
//   node tools/verify-tracker.mjs <csv> --json        machine-readable aggregate
//   node tools/verify-tracker.mjs <csv> --hub jita --type 34
//
// With a full weekly dump for ISO week 2026-33 it also re-checks the five published
// ground-truth numbers below. Those were measured from the real dump; if a future run
// disagrees, either Adam4EVE changed the format or the dump is not the one named.
//
// Column meanings, from https://static.adam4eve.eu/MarketOrdersTrades/MarketOrdersTrades.txt
//   is_buy_order = 0  someone BOUGHT FROM a sell order  -> fills a resting sell order
//   is_buy_order = 1  someone SOLD TO a buy order       -> does not
//   has_gone = 0      only orders whose volume changed
//   has_gone = 1      vanished orders counted as one completely-filled trade
// Every dump seen so far carries has_gone = 0 only; the two are kept apart here anyway,
// because merging them would double-count the day a has_gone=1 dump first appears.

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEADER = 'location_id;region_id;type_id;is_buy_order;has_gone;scanDate;'
  + 'amount;high;low;avg;orderNum;iskValue';

const HUBS = new Map([
  [60003760, 'jita'], [60008494, 'amarr'], [60011866, 'dodixie'],
  [60005686, 'hek'], [60004588, 'rens'],
]);
const HUB_BY_NAME = new Map([...HUBS].map(([id, n]) => [n, id]));

/* Measured from the real weekly dump for ISO week 2026-33 (2026-08-10 .. 2026-08-16).
   Any change to the parser that moves these is a change to the meaning of the data. */
const GROUND_TRUTH = {
  week: '2026-33',
  jita: {
    sellUnits: 36541011283,   // units bought FROM sell orders
    buyUnits: 11533523665,    // units sold TO buy orders
    share: 0.7601,            // sellUnits / (sellUnits + buyUnits), 4 dp
  },
  // share of Jita items (over 1000 units traded in the week) at each nearest-rank
  // percentile — the reason a single global capture constant cannot work
  jitaSharePercentiles: { n: 2325, p5: 0.000, p25: 0.250, p50: 0.645, p75: 0.852, p95: 0.992 },
  jitaShareMean: 0.558,
  // orderNum counts observed order-book changes, not transactions, so it is censored
  // near the number of 10-15 minute scans in a day
  maxOrderNum: 155,
  // the published avg column is below the day's low on most Jita rows, which is why the
  // volume-weighted price has to be recomputed from iskValue / amount
  jitaAvgBelowLowRows: 49562,
  jitaRows: 78977,
};

/* ---------- parsing ---------- */

/* One dump -> flat rows. Deliberately strict: a row that does not have twelve fields, or
   whose numeric fields do not parse, is DROPPED and counted, never coerced to zero. A
   silently-zeroed amount would look exactly like a real quiet day. */
function parseCsv(text, src) {
  const lines = text.split('\n');
  const head = (lines[0] || '').replace(/\r$/, '').trim();
  if (head !== HEADER) throw new Error(src + ': unexpected header\n  got      ' + head + '\n  expected ' + HEADER);
  const rows = [];
  const bad = { short: 0, nonNumeric: 0, blank: 0, emptyRegion: 0 };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) { bad.blank++; continue; }
    const f = line.split(';');
    if (f.length !== 12) { bad.short++; continue; }
    const num = j => { const v = Number(f[j]); return f[j].trim() !== '' && Number.isFinite(v) ? v : null; };
    const [locationId, typeId, isBuyOrder, hasGone] = [num(0), num(2), num(3), num(4)];
    // region_id is genuinely blank on some real rows (23 in week 2026-33, 9 in 2026-34,
    // all at three w-space stations, none at a hub). It is not a field anything here
    // keys on, so a blank one is recorded rather than used to throw the row away.
    const regionId = num(1);
    if (regionId == null) bad.emptyRegion++;
    const scanDate = f[5];
    const [amount, high, low, avg, orderNum, iskValue] = [num(6), num(7), num(8), num(9), num(10), num(11)];
    if ([locationId, typeId, isBuyOrder, hasGone, amount, high, low, avg, orderNum, iskValue]
        .some(v => v == null) || !/^\d{4}-\d{2}-\d{2}$/.test(scanDate)) { bad.nonNumeric++; continue; }
    rows.push({ locationId, regionId, typeId, isBuyOrder, hasGone, scanDate,
                amount, high, low, avg, orderNum, iskValue });
  }
  return { rows, bad };
}

/* ---------- aggregation ---------- */

/* Per (hub, type), the two sides kept apart. `share` is the fraction of traded units that
   hit a SELL order, which is the only fraction a resting sell order can be filled out of.
   has_gone is part of the key so a mixed dump cannot merge two different countings. */
function aggregate(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!HUBS.has(r.locationId)) continue;
    const key = r.locationId + '|' + r.typeId + '|' + r.hasGone;
    let a = out.get(key);
    if (!a) out.set(key, a = {
      hub: r.locationId, hubName: HUBS.get(r.locationId), typeId: r.typeId, hasGone: r.hasGone,
      sellUnits: 0, buyUnits: 0, sellTrades: 0, buyTrades: 0, sellIsk: 0, buyIsk: 0,
      sellDays: new Set(), buyDays: new Set(), days: new Set(),
      low: Infinity, high: -Infinity,
    });
    a.days.add(r.scanDate);
    if (r.isBuyOrder) {
      a.buyUnits += r.amount; a.buyTrades += r.orderNum; a.buyIsk += r.iskValue; a.buyDays.add(r.scanDate);
    } else {
      a.sellUnits += r.amount; a.sellTrades += r.orderNum; a.sellIsk += r.iskValue; a.sellDays.add(r.scanDate);
      a.low = Math.min(a.low, r.low); a.high = Math.max(a.high, r.high);
    }
  }
  return [...out.values()].map(a => {
    const total = a.sellUnits + a.buyUnits;
    return {
      hub: a.hub, hubName: a.hubName, typeId: a.typeId, hasGone: a.hasGone,
      sellUnits: a.sellUnits, buyUnits: a.buyUnits,
      sellTrades: a.sellTrades, buyTrades: a.buyTrades,
      sellIsk: a.sellIsk, buyIsk: a.buyIsk,
      // volume-weighted, from iskValue and amount — NOT the published avg column
      sellVwap: a.sellUnits > 0 ? a.sellIsk / a.sellUnits : null,
      buyVwap: a.buyUnits > 0 ? a.buyIsk / a.buyUnits : null,
      sellLow: a.low === Infinity ? null : a.low,
      sellHigh: a.high === -Infinity ? null : a.high,
      sellDays: a.sellDays.size, buyDays: a.buyDays.size, days: a.days.size,
      share: total > 0 ? a.sellUnits / total : null,
    };
  }).sort((x, y) => x.hub - y.hub || x.typeId - y.typeId || x.hasGone - y.hasGone);
}

/* Everything the ground truth is stated in terms of, in one pass over the raw rows. */
function diagnostics(rows) {
  const d = {
    rows: rows.length,
    hubRows: 0,
    days: new Set(),
    stations: new Set(),
    hasGone: {},
    maxOrderNum: 0,
    jita: { rows: 0, avgBelowLow: 0, avgAboveHigh: 0, vwapOutOfBand: 0, sellUnits: 0, buyUnits: 0 },
    all: { avgBelowLow: 0, vwapOutOfBand: 0 },
  };
  for (const r of rows) {
    d.days.add(r.scanDate);
    d.stations.add(r.locationId);
    d.hasGone[r.hasGone] = (d.hasGone[r.hasGone] || 0) + 1;
    if (r.orderNum > d.maxOrderNum) d.maxOrderNum = r.orderNum;
    if (!HUBS.has(r.locationId)) continue;
    d.hubRows++;
    const vwap = r.amount > 0 ? r.iskValue / r.amount : null;
    const out = vwap != null && (vwap < r.low - 1e-9 || vwap > r.high + 1e-9);
    if (r.avg < r.low) d.all.avgBelowLow++;
    if (out) d.all.vwapOutOfBand++;
    if (r.locationId !== 60003760) continue;
    d.jita.rows++;
    if (r.avg < r.low) d.jita.avgBelowLow++;
    if (r.avg > r.high) d.jita.avgAboveHigh++;
    if (out) d.jita.vwapOutOfBand++;
    if (r.isBuyOrder) d.jita.buyUnits += r.amount; else d.jita.sellUnits += r.amount;
  }
  d.days = [...d.days].sort();
  d.stations = d.stations.size;
  return d;
}

/* Nearest-rank percentile — the definition the published figures were taken with. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}

/* ---------- reporting ---------- */

let failures = 0;
function assertNear(label, actual, expected, tol) {
  const ok = typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label.padEnd(46)
    + String(actual).padStart(16) + '   expected ' + expected + (tol ? ' ±' + tol : ''));
}

function main() {
  const argv = process.argv.slice(2);
  const flag = n => argv.includes(n);
  const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const paths = argv.filter((a, i) => !a.startsWith('--') && !['--hub', '--type'].includes(argv[i - 1]));

  let files = paths;
  if (flag('--fixtures')) {
    const dir = join(HERE, '..', 'tests', 'fixtures');
    files = readdirSync(dir).filter(f => /^marketOrderTrades_weekly_.*\.csv$/.test(f)).map(f => join(dir, f));
  }
  if (!files.length) {
    console.error('usage: node tools/verify-tracker.mjs <csv> [...] | --fixtures  [--json] [--hub jita] [--type 34]');
    process.exit(2);
  }

  let rows = [];
  const bad = { short: 0, nonNumeric: 0, blank: 0, emptyRegion: 0 };
  for (const f of files) {
    const r = parseCsv(readFileSync(f, 'utf8'), basename(f));
    // concat, not push(...r.rows) — a weekly dump is ~280k rows and spreading it into
    // an argument list blows the call stack
    rows = rows.length ? rows.concat(r.rows) : r.rows;
    for (const k of Object.keys(bad)) bad[k] += r.bad[k];
  }

  const agg = aggregate(rows);
  const d = diagnostics(rows);

  if (flag('--json')) {
    let rowsOut = agg;
    const hub = opt('--hub');
    const type = opt('--type');
    if (hub) rowsOut = rowsOut.filter(a => a.hubName === hub || a.hub === Number(hub));
    if (type) rowsOut = rowsOut.filter(a => a.typeId === Number(type));
    console.log(JSON.stringify({ files: files.map(f => basename(f)), diagnostics: d, dropped: bad, aggregate: rowsOut }, null, 2));
    return;
  }

  console.log('files      ' + files.map(f => basename(f)).join(', '));
  console.log('rows       ' + d.rows + ' parsed, ' + d.hubRows + ' at the five hubs'
    + '  (dropped: ' + bad.short + ' short, ' + bad.nonNumeric + ' unparseable, ' + bad.blank + ' blank'
    + '; kept with a blank region_id: ' + bad.emptyRegion + ')');
  console.log('days       ' + d.days[0] + ' .. ' + d.days[d.days.length - 1] + '  (' + d.days.length + ')');
  console.log('stations   ' + d.stations);
  console.log('has_gone   ' + Object.entries(d.hasGone).map(([k, v]) => k + ': ' + v).join(', '));
  console.log('orderNum   max ' + d.maxOrderNum
    + '   (a count of observed book changes, so a floor on trades — not a trade count)');
  console.log('avg column below the day\'s low: ' + d.all.avgBelowLow + ' of ' + d.hubRows + ' hub rows'
    + '  (' + (100 * d.all.avgBelowLow / d.hubRows).toFixed(1) + '%)');
  console.log('iskValue/amount outside [low,high]: ' + d.all.vwapOutOfBand + ' of ' + d.hubRows
    + '  (' + (100 * d.all.vwapOutOfBand / d.hubRows).toFixed(1) + '%)');

  const jita = agg.filter(a => a.hub === 60003760);
  const jitaSell = jita.reduce((s, a) => s + a.sellUnits, 0);
  const jitaBuy = jita.reduce((s, a) => s + a.buyUnits, 0);
  console.log('\njita       sell ' + jitaSell.toLocaleString('en-US')
    + '   buy ' + jitaBuy.toLocaleString('en-US')
    + '   share ' + (jitaSell / (jitaSell + jitaBuy)).toFixed(4));

  const shares = jita.filter(a => a.sellUnits + a.buyUnits > 1000).map(a => a.share).sort((x, y) => x - y);
  console.log('jita share percentiles over ' + shares.length + ' items above 1000 units traded:');
  console.log('  p5 ' + percentile(shares, 5).toFixed(3) + ' · p25 ' + percentile(shares, 25).toFixed(3)
    + ' · p50 ' + percentile(shares, 50).toFixed(3) + ' · p75 ' + percentile(shares, 75).toFixed(3)
    + ' · p95 ' + percentile(shares, 95).toFixed(3)
    + ' · mean ' + (shares.reduce((s, v) => s + v, 0) / shares.length).toFixed(3));

  const hub = opt('--hub');
  const type = opt('--type');
  if (hub || type) {
    const want = hub ? (HUB_BY_NAME.get(hub) || Number(hub)) : null;
    console.log('\n  hub        type   has_gone      sell units       buy units   share   sell u/trade');
    for (const a of agg) {
      if (want && a.hub !== want) continue;
      if (type && a.typeId !== Number(type)) continue;
      console.log('  ' + a.hubName.padEnd(9) + String(a.typeId).padStart(7) + String(a.hasGone).padStart(10)
        + String(a.sellUnits).padStart(16) + String(a.buyUnits).padStart(16)
        + (a.share == null ? '       —' : '  ' + a.share.toFixed(4))
        + (a.sellTrades > 0 ? String(Math.round(a.sellUnits / a.sellTrades)).padStart(15) : '              —'));
    }
  }

  /* Two different things can be checked, and only one of them applies to any given input.

     The published ground truth is a statement about the WHOLE week-33 dump, so it is
     only asserted when every station is present. Against the distilled fixture the
     equivalent check is the manifest: build-fixtures.mjs computed those aggregates with
     its own code, so agreeing with them here is two implementations agreeing, which is
     the entire reason this file exists. */
  const isWk33 = d.days[0] === '2026-08-10' && d.days[d.days.length - 1] === '2026-08-16' && d.days.length === 7;
  const full = d.stations > 100;

  if (isWk33 && full) {
    console.log('\nground truth, ISO week ' + GROUND_TRUTH.week + ' (full dump):');
    assertNear('jita units bought FROM sell orders', jitaSell, GROUND_TRUTH.jita.sellUnits, 0);
    assertNear('jita units sold TO buy orders', jitaBuy, GROUND_TRUTH.jita.buyUnits, 0);
    assertNear('jita sell-side share', Number((jitaSell / (jitaSell + jitaBuy)).toFixed(4)), GROUND_TRUTH.jita.share, 0);
    assertNear('jita rows', d.jita.rows, GROUND_TRUTH.jitaRows, 0);
    assertNear('jita rows whose avg is below the day low', d.jita.avgBelowLow, GROUND_TRUTH.jitaAvgBelowLowRows, 0);
    assertNear('max orderNum across every station', d.maxOrderNum, GROUND_TRUTH.maxOrderNum, 0);
    assertNear('items above 1000 units traded at jita', shares.length, GROUND_TRUTH.jitaSharePercentiles.n, 0);
    for (const p of [5, 25, 50, 75, 95])
      assertNear('jita share p' + p, Number(percentile(shares, p).toFixed(3)),
        GROUND_TRUTH.jitaSharePercentiles['p' + p], 0.0005);
    assertNear('jita share mean', Number((shares.reduce((s, v) => s + v, 0) / shares.length).toFixed(3)),
      GROUND_TRUTH.jitaShareMean, 0.0005);
  } else {
    console.log('\nground truth: not asserted — the published figures describe the complete'
      + ' week 2026-33 dump, and this input has ' + d.stations + ' station(s) over ' + d.days.length + ' day(s)');
  }

  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(HERE, '..', 'tests', 'fixtures', 'manifest.json'), 'utf8')); }
  catch (_e) { manifest = null; }
  const fromFixtures = files.every(f => f.includes(join('tests', 'fixtures')));
  if (manifest && fromFixtures && !full) {
    console.log('\nfixture manifest cross-check (independently recomputed here):');
    const mine = new Map(agg.filter(a => a.hasGone === 0).map(a => [a.hub + '|' + a.typeId, a]));
    assertNear('per (hub, type) pairs', mine.size, manifest.perHubType.length, 0);
    for (const m of manifest.perHubType) {
      const a = mine.get(m.hub + '|' + m.typeId);
      const tag = m.hubName + ' ' + m.typeId;
      assertNear(tag + ' sell units', a ? a.sellUnits : null, m.sellUnits, 0);
      assertNear(tag + ' buy units', a ? a.buyUnits : null, m.buyUnits, 0);
    }
  }

  if (failures) { console.log('\n' + failures + ' check(s) FAILED'); process.exitCode = 1; }
  else console.log('\nall checks passed');
}

main();
