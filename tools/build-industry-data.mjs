#!/usr/bin/env node
/* build-industry-data.mjs — write the seed copies of data/industry.json and
   data/ores.json that the site ships.

   This used to be the only way the tools ever saw the SDE: CI downloaded CCP's
   112 MB YAML archive, a thousand lines here turned it into two JSON blobs, and
   the site served whatever the last deploy happened to bake. Game data was
   therefore only as fresh as the last commit.

   The derivation now lives in ../sde.js, which the browser runs itself against
   CCP's own JSONL archive, so anyone can refresh their local copy whenever CCP
   ships a patch without waiting for a deploy. This file is what remains: the
   same module, run once in CI, so a first visit has data to work with before
   the visitor has downloaded anything. One implementation, so the seed and the
   copy your browser derives cannot disagree.

   Usage:
     node tools/build-industry-data.mjs [--out data/industry.json]
                                        [--ores-out data/ores.json]
                                        [--build <sde build number>]

   Needs Node 18+ for fetch and DecompressionStream. No dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const SDE = require(path.join(here, '..', 'sde.js'));

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const outFile = arg('--out', 'data/industry.json');
const oresOutFile = arg('--ores-out', path.join(path.dirname(outFile), 'ores.json'));
const wantBuild = arg('--build', null);

const t0 = Date.now();
const log = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

let phase = '';
const out = await SDE.build({
  build: wantBuild ? Number(wantBuild) : undefined,
  onWarn: (m) => console.error('WARNING: ' + m),
  onProgress: (p) => {
    if (p.phase === phase) return;
    phase = p.phase;
    log('reading ' + p.phase + (p.total ? ` (${(p.total / 1e6).toFixed(1)} MB)` : ''));
  },
});

log(`SDE build ${out.build}, released ${out.released}`);
for (const [file, blob] of [[outFile, out.industry], [oresOutFile, out.ores]]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(blob));
  log(`wrote ${file}: ${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`);
}
log('counts: ' + Object.entries(out.stats).map(([k, v]) => `${k}=${v}`).join(', '));
