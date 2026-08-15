# Tests

```sh
cd tests && npm install && npm test
```

`npm test` runs every `*.test.js` in this directory in sequence and exits non-zero if
any suite fails. A single suite is just a Node script — `node fees.test.js` — and each
one prints one `PASS`/`FAIL` line per check plus a count at the end.

**These suites must live in the repository, in this directory, and be committed.** An
earlier generation of them was written into a scratch directory outside the repo; the
container was reprovisioned, the scratch directory was wiped, and roughly 400 checks
were lost permanently because they had never been committed. Do not write test files
anywhere but here.

## Layout

| file | what it covers | browser? |
| --- | --- | --- |
| `helper.js` | shared plumbing: `check()/eq()/near()` reporting, static server, chromium launcher, SSO/ESI mocks | — |
| `run-all.js` | the `npm test` runner | — |
| `industry.test.js` | `industry-engine.js` as a pure module: ME rounding, job cost, depth walking, invention, the batch planner, shipping | no |
| `fees.test.js` | the fee model through the real Sell page: tax and broker from skills/standings, unmodified-standings proof, per-market observed-rate overrides | yes |
| `sell.test.js` | the Sell tool: paste parsing, price ticks, plan selection, the 100 ISK order floor, import list, filters | yes |
| `auth.test.js` | `auth.js`: PKCE callback, multi-character login, v1→v2 migration, logout, scope dropping, degraded standings | yes |
| `industry-ui.test.js` | the Industry page end to end against a fixture `data/industry.json` | yes |

## Environment

- **No `playwright install`.** The browser is pre-installed; `helper.js` launches
  `/opt/pw-browsers/chromium`. Override with `PW_CHROMIUM=/path/to/chrome` if your box
  keeps it elsewhere. Only `playwright-core` is a dependency — no browser download.
- The pages are served by a throwaway static server on `127.0.0.1` rather than opened
  over `file://`, because the Industry page fetches `data/industry.json`.
- All ESI/SSO traffic is intercepted with `page.route`. Mocked ESI responses must send
  `Access-Control-Expose-Headers: x-pages` or the paging logic cannot read the header —
  `helper.json()` does this for you.
- No test touches the network.

## Fixtures

`data/industry.json` is generated from the EVE SDE at deploy time and is gitignored, so
it is usually absent. `industry-ui.test.js` writes its own small fixture to a temp
directory and serves the repo from there, so it never needs the real file and never
writes into `data/`. The engine suite builds its data inline — it needs no fixture at
all.

## Adding checks

Assertions are meant to be readable in the output, so name them as sentences
(`'Connections 5 leaves the broker fee unchanged'`). If a check fails, fix the code —
never loosen the assertion to make it green.
