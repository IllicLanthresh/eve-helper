# data/

`industry.json` and `ores.json` are **generated at deploy time by CI** (see
`.github/workflows/pages.yml`) and are not committed. Both are built in one run
from CCP's Static Data Export (SDE) by `tools/build-industry-data.mjs` and
served alongside the site at `data/industry.json` and `data/ores.json`.

- `industry.json` (~2 MB) — types / groups / marketGroups / skills / blueprints
  with `man`/`rea`/`cop`/`inv`/`me`/`te` activities, plus the `rigs` catalog of
  real Standup engineering/reactor rigs and the `structures` size/slot map.
  Consumed by the Industry tool.
- `ores.json` (~80 KB) — every published Asteroid-category type (standard ores,
  moon ores, ice, every quality variant, compressed forms included) with exact
  per-variant reprocessing outputs (`typeMaterials`), portion size, unit volume,
  base family name, its `Compressed <name>` counterpart tid/volume, and a
  lowercased name → tid lookup. Consumed by the Mine tool.

Both schemas are documented at the top of `tools/build-industry-data.mjs`.

Build them locally:

```sh
cd tools && npm ci
curl -O https://eve-static-data-export.s3-eu-west-1.amazonaws.com/tranquility/sde.zip
unzip -q sde.zip 'fsd/blueprints.yaml' 'fsd/types.yaml' 'fsd/groups.yaml' 'fsd/marketGroups.yaml' \
  'fsd/typeDogma.yaml' 'fsd/dogmaAttributes.yaml' 'fsd/typeMaterials.yaml' 'fsd/categories.yaml' -d /tmp/sde
node --max-old-space-size=4096 build-industry-data.mjs --sde /tmp/sde --out ../data/industry.json
```

(`ores.json` is written next to `--out` by default; `--ores-out` overrides.)
