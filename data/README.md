# data/

`industry.json` is **generated at deploy time by CI** (see `.github/workflows/pages.yml`)
and is not committed. It is built from CCP's Static Data Export (SDE) by
`tools/build-industry-data.mjs` and served alongside the site at
`data/industry.json`.

Build it locally:

```sh
cd tools && npm ci
curl -O https://eve-static-data-export.s3-eu-west-1.amazonaws.com/tranquility/sde.zip
unzip -q sde.zip 'fsd/blueprints.yaml' 'fsd/types.yaml' 'fsd/groups.yaml' 'fsd/marketGroups.yaml' -d /tmp/sde
node --max-old-space-size=4096 build-industry-data.mjs --sde /tmp/sde --out ../data/industry.json
```

The output schema (types / groups / marketGroups / skills / blueprints with
`man`/`rea`/`cop`/`inv`/`me`/`te` activities) is documented at the top of
`tools/build-industry-data.mjs`.
