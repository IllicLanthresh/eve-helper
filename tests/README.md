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
| `sell.test.js` | the Sell tool: paste parsing, price ticks, plan selection, the 100 ISK order floor, import list, filters — and the **decision layer**: the Theil–Sen trend, the percentile rank, the queue-based fill estimate, the trend-adjusted hit rate (including the `highest`-absent fallback), the two-branch expectation with the broker fee charged in both branches, the fill-probability guard, ISK per slot-day, the patience preset and its migration off the retired wait tag, and the regression the rework exists for — a recommendation flipping from LIST-PATIENT to INSTANT purely because the trend turned negative. Plus the graphs: sparkline marker geometry against a constructed history, the expanded chart's series/band/volume bars, lazy drawing across 250 rows, and rows with no history degrading | yes |
| `orders.test.js` | the Sell tool's **My orders** mode: the two-mode switcher over one shared DOM, the per-character order import (with a character whose login lacks `esi-markets.read_character_orders.v1` listed and noted, never silently dropped), type/station/structure name resolution down to an id ESI will not name, the table and the header totals, and then the triage — queue position with the user's OWN volume excluded (by order id, with the by-price fallback), days to fill, each of the three stalled reasons in isolation, all three verdicts against hand-computed arithmetic, the **sunk broker fee** that must never be charged against cancelling, the unverified relist fee (computed from Advanced Broker Relations, overridden by hand, persisted, and passing through the 100 ISK floor), the patience window, the buy-order toggle, the duplicate-order flag the Sell mode raises, and degradation when a book, a history or a structure scope is missing | yes |
| `auth.test.js` | `auth.js`: PKCE callback, multi-character login, v1→v2 migration, logout, scope dropping, degraded standings | yes |
| `permissions.test.js` | the shared permissions layer: `EveAuth.permissions()`, the topbar indicator, the panel, and the inline notes on the Sell, Industry and Structure Manager pages (including the picker's "structure search is unavailable" branch, logged out and with the search scopes missing) | yes |
| `structures.test.js` | the central structure store and the Structure Manager with **all three legacy sources present at once**: the v2 schema bump, the one-time import of the tools' old per-structure facts (with the two-profile conflict note), the record editors (rates, rigs, activities, hull role bonuses), the moved rig-inference solver and its deep link, and the Industry page reading every structure fact off the record — read-only, with the removed-record and renamed-facility cases | yes |
| `structures-manager.test.js` | the same feature from the complementary angles: migration from **each legacy source on its own** (including the pre-v1 list inside the Sell blob, the coercion rules, the rig de-duplication and slot cap, and idempotency across a real reload), adding a record through the picker, editing every managed fact back out of `localStorage`, removing one while all three tools point at it, re-resolving the identity from ESI, the rig wizard driven through **its own UI** to the point of writing central rigs, and the Sell / Mine / Industry pages computing off the record — with one number per tool checked against the closed form of the legacy facts. Section (g) pins one case per review finding: a removed record must not take a profile's last surviving copy of the facts with it (and adding the structure back reclaims them), identity flowing between import passes, a removed structure never resurrected by the Sell rate map, a legacy `tax: 0` never recorded, the Sell broker box clearing to *not known* instead of 0%, a cross-tab removal of the selected market, a corrupt legacy blob not aborting the other passes, re-runs not piling up conflict notes, a dead deep link that says so, and legacy preset rigs following the active-profile-wins rule. Section (h) does the same for the second review round: Mine's legacy rig imported from the retained snapshot rather than the selection, the rig wizard stripping the record's *corrected* role bonuses (a case where the hull preset detects nothing), the picker's empty and logged-out states, Sell refusing to carry one market's broker rate into a structure that has none, Mine's dropdown offering the shared saved list and falling back to the NPC station when a structure is removed, Mine re-reading a security band changed centrally, and a record with no system/security flagged on both the manager card and the Industry facility. Section (i) covers the leftover controls: *infer rigs…* offered only where the wizard can run, the record's activity list actually checked against what a profile routes, the read-only mirrors marked as mirrors, an unmapped legacy `{preset}` rig row surviving a failed SDE fetch (and mapped on the next load that has the catalog), and Mine stating the security band instead of a permanently disabled dropdown | yes |
| `industry-ui.test.js` | the Industry page end to end against a fixture `data/industry.json` | yes |
| `mine-fleet.test.js` | the Mine page: the two modes (plan production / fleet mode) over one shared DOM, survey-scan parsing, refined vs compressed ISK/m³ from skills + facility against a fixture `data/ores.json`, ISK/h math, persistence | yes |
| `density.test.js` | the copy rules, as a ratchet: every `?` disclosure ships closed and hangs off a one-liner, no always-visible copy carries a prose connective (*of which*, *because*, *so that*, *which means*), no rendered table cell runs past 24 characters, no flag/verdict chip past 12 — and every chip carries the detail it replaced on its tooltip, so a shortened chip is a fact **moved** rather than lost. Also pins the plan and verdict tooltips as key: value lines rather than paragraphs, and the My-orders TSV as the place the compressed diagnostics still live | yes |
| `equivalence.test.js` | value equivalence across the structure centralisation: the **pre-migration builds are checked out of git** and served next to the current one, all are handed the same legacy storage, and every Sell fee/plan, Mine yield/profit-mode column and Industry engine feed / table row / cost-and-time tree is compared exactly | yes |

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
it is usually absent. `industry-ui.test.js`, `structures.test.js`,
`structures-manager.test.js` and `permissions.test.js` intercept the page's fetch of it with
`page.route` and serve a small hand-written fixture, so they never need the real file
and never write into `data/`. `data/ores.json` is handled the same way by the Mine suites.
The engine suite builds its data inline — it needs no fixture at all.

`equivalence.test.js` needs one thing the others don't: **git history**. It materializes
each pre-migration build (`git show <commit>:index.html`, …) into a temp directory and
serves it on its own port, so the old and new builds can be driven side by side from the
same legacy storage. Two commits are used: the one before the central store landed (Sell
and Mine) and the one before Industry profiles became references (Industry). In a checkout
too shallow to contain them it reports a failed check rather than pretending to have
proved anything.

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
