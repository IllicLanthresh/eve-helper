# data/

`industry.json` and `ores.json` are the **seed copies** the site ships. They are
generated at deploy time by CI (see `.github/workflows/pages.yml`) and are not
committed.

They are **not** where the tools get their game data from any more. Each page
reads its data through `../sde.js`, which fetches CCP's Static Data Export
directly in the browser, derives these same two shapes from it, and keeps the
result in IndexedDB. The SDE line on every page names the build you are on, says
when CCP has published a newer one, and has the button that replaces your copy.
These files exist so that a first visit has something to work with before
anything has been downloaded.

Both are produced by `tools/build-industry-data.mjs`, which is a thin CLI over
`sde.js` — the same derivation the browser runs, so the seed and a locally
derived copy cannot disagree.

- `industry.json` (~1.9 MB) — types / groups / marketGroups / skills / blueprints
  with `man`/`rea`/`cop`/`inv`/`me`/`te` activities, plus the `rigs` catalog of
  Standup engineering/reactor rigs and the `structures` size/slot map.
  Consumed by the Industry and Structures tools.
- `ores.json` (~87 KB) — every published Asteroid-category type (standard ores,
  moon ores, ice, every quality variant, compressed forms included) with exact
  per-variant reprocessing outputs, portion size, unit volume, base family name,
  its compressed counterpart from CCP's own `compressibleTypes` mapping, the
  exact reprocessing skill per type (dogma `reprocessingSkillType`), a
  lowercased name → tid lookup, and a tid → name map covering every referenced
  material and skill. Consumed by the Mine tool.

Both schemas are documented at the top of `../sde.js`.

Build them locally — no download, no unzip, no dependencies:

```sh
node tools/build-industry-data.mjs --out data/industry.json
```

(`ores.json` is written next to `--out` by default; `--ores-out` overrides, and
`--build <number>` pins a specific SDE build instead of the current one.)
