/* Runs every *.test.js in this directory, sequentially, and exits non-zero if any
   suite failed. Sequential on purpose: the browser suites are the slow part and
   interleaving their output would make a failure hard to read. */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// deliberate order: cheapest and most fundamental first
const ORDER = ['industry.test.js', 'fees.test.js', 'sell.test.js', 'orders.test.js',
  'tracker-mock.test.js', 'tracker-model.test.js',
  'auth.test.js', 'structures.test.js', 'structures-manager.test.js', 'industry-ui.test.js',
  'density.test.js', 'sde.test.js', 'global-market.test.js'];

const found = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'));
const suites = ORDER.filter(f => found.includes(f)).concat(found.filter(f => !ORDER.includes(f)));

const results = [];
for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  results.push({ suite, code: r.status == null ? 1 : r.status });
  console.log('');
}

console.log('==================== summary ====================');
let bad = 0;
for (const r of results) {
  if (r.code !== 0) bad++;
  console.log((r.code === 0 ? 'ok   ' : 'FAIL ') + r.suite);
}
console.log(bad ? bad + ' of ' + results.length + ' suites FAILED' : 'all ' + results.length + ' suites passed');
process.exit(bad ? 1 : 0);
