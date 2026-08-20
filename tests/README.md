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
| `permissions.test.js` | the shared permissions layer: `EveAuth.permissions()`, the topbar indicator, the panel, and the inline notes on all three pages | yes |
| `structures.test.js` | the central structure store and the Structure Manager: the v2 schema bump, the one-time import of the tools' old per-structure facts (with the two-profile conflict note), the record editors, the moved rig-inference solver, and the Industry page reading rigs/tax from the record | yes |
| `industry-ui.test.js` | the Industry page end to end against a fixture `data/industry.json` | yes |
| `mine-fleet.test.js` | the Mine page: the two modes (plan production / fleet mode) over one shared DOM, survey-scan parsing, refined vs compressed ISK/m³ from skills + facility against a fixture `data/ores.json`, ISK/h math, persistence | yes |

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
it is usually absent. `industry-ui.test.js` and `structures.test.js` intercept the page's fetch of it with
`page.route` and serve a small hand-written fixture, so they never need the real file
and never write into `data/`. The engine suite builds its data inline — it needs no
fixture at all.

## Adding checks

Assertions are meant to be readable in the output, so name them as sentences
(`'Connections 5 leaves the broker fee unchanged'`). If a check fails, fix the code —
never loosen the assertion to make it green.

### Never wait on time — wait on a signal

**No `page.waitForTimeout`, no `setTimeout` inside `page.evaluate`, no
`waitForFunction(() => true)`.** Every wait must be `waitForFunction`/`waitForSelector`
on a condition that is actually true only once the work has finished. A sleep that is
long enough today is a flaky test tomorrow, and a flaky suite is worth less than no
suite.

This bit us once already: the Industry page re-plans a row's batch asynchronously after
its history arrives (`needHist` → `refineRow`), which with the test fixture's zero demand
collapses the batch from 20 runs to 1 and moves cost/item by ~10%. A cost captured before
that landed was compared against one captured after, and the assertion failed roughly one
run in four. The fix was to drive the refinement to its fixed point first —
`row.planDemand === histMem.get(tid).demand`, which is exactly `refineRow`'s own no-op
guard — so every capture is taken in the same state.

Two rules that follow:

- **Prefer the page's own end-state markers.** `#compStatus.className === 'ok'`, a row's
  recomputed value, a rendered badge. If a suitable signal genuinely does not exist, add
  one to the page rather than sleeping.
- **Negative assertions need a positive wait first.** "no warning is shown" passes
  trivially on a page that has not rendered yet. Wait for the render to have happened
  (`#authBox` has children, `#dataAges` is populated), *then* assert the absence.
