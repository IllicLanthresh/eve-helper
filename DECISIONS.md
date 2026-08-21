# Decisions

Answers from the owner, taken in interview. Anything here is settled and is not to be
re-litigated or quietly reinterpreted. Where a number used to be invented, the entry says what
replaces it. Where the answer was "your call", the choice taken is recorded with its reasoning
so it can be argued with later.

## Standing constraints

- **No invented constants.** Every number is measured, derived from a published rule, or set by
  the owner. Anything unmeasurable is labelled unmeasured in the UI, never given a plausible
  value.
- **No cache, for now.** Market data is fetched fresh on every calculation. Caching is only
  introduced if a concrete problem demands it — rate limits, or unusable slowness — and then
  deliberately, with the reason named. Stale cached market data produces wrong numbers that look
  like model bugs, and that class of problem is not worth inviting before we have to.
  The **SDE is not covered by this**: it is static data that changes on patch days, it is kept
  locally on purpose, it is stamped with the build it came from, and the app says when CCP has
  moved on. That is a copy you control, not a cache that expires behind your back.
- **Size is not a constraint.** Multi-MB downloads and a first run measured in minutes are
  normal for this class of tool. Do not trade model fidelity for payload size.

## The model

| # | Decision | Was |
|---|---|---|
| 1 | Patience is two fields, both typed: **days** and **fill floor %**. Presets 7 / 30 / 90, default **90** | fixed presets 7/14/30 with floors 75/55/35 |
| 2 | Under the floor a listing is **blocked, and the row says what that cost** — "blocked, listing was worth +350k" | blocked silently |
| 3 | Recency decay is **adaptive**, tied to how often the item actually trades | invented 45-day half-life |
| 4 | History depth is **whatever number the owner types**; that same number drives how much gets downloaded | 90d default, capped at 365 |
| 5 | Ranking objective stays **ISK per slot-day** | unchanged |
| 6 | Relist churn: how far off the top before repricing, and how many times, become **settings** | invented 2% and max 3 |
| 7 | Units per transaction: **no cap, believe the measurement** | capped at 1e6, which saturated and still called itself measured |
| 8 | The patient price anchors to **A4E sell-side trades at the hub**, ESI regional as fallback | ESI regional median, both sides pooled |
| 9 | **Mean reversion is a distinct case.** Falling into the bottom of its own range is not the same as falling from the top, and must not be discounted the same way | one ▼ for both |

## Pricing

| # | Decision | Was |
|---|---|---|
| 10 | New price source: **solve for the price with X% chance of selling in Y days**. Third option alongside current-sell and history; global target with a **per-row target chance** override | did not exist |
| 11 | Undercut step stays **one tick** | unchanged |
| 12 | Prices round **down when undercutting**, nearest otherwise | always nearest, which could land above the order being undercut |
| 13 | Absurd sell orders are **ignored silently** when reading the best sell | one unit at a silly price could set the plan |

Method for 13, taken as a delegated call: **modified z-score on log price, threshold 3.5**
(Iglewicz & Hoaglin, 1993), cross-checked against the price A4E says the item actually traded
at. MAD because a thin book can be half junk and MAD survives that; the traded-price check
because two independent signals mean far fewer false positives on items that are simply cheap.
Log price because order books are log-normal, not normal.

## Data

| # | Decision | Was |
|---|---|---|
| 14 | The A4E undercount is **corrected per item using the ESI ratio**, with the correction's size surfaced as a data-quality signal | uncorrected, biased low |
| 15 | Trade hubs only. Structures are marked, not solved | — |
| 20 | The **SDE is fetched by the client**, derived in the browser and kept locally; the app names the build and a button refreshes it | baked into the deploy, so refreshing game data meant pushing a commit |

A4E's bulk files carry only the `has_gone=0` reading, which treats a vanished order as
cancelled and so undercounts real sales. Measured against ESI regional totals, A4E sees a
median **54%** of regional volume (range 0.28–1.01 over 28 type-days). That gap mixes three
causes — vanished-orders-as-cancels, trades at other stations in the region, and 15-minute
sampling misses — and cannot separate them. It is still a per-item measurement rather than a
guess, which is why it is used.

The **sell/buy split is a ratio**, so a roughly even undercount cancels out of it. The bias
lands on the absolute arrival rate, which is what the correction targets.

## Interface

| # | Decision | Was |
|---|---|---|
| 16 | **"Stalled" is deleted.** The verdict already says it; a stalled badge beside a HOLD is the tool contradicting itself | two overlapping verdict systems |
| 17 | The table is **redesigned to fit without horizontal scrolling** | flags column unreachable without scrolling, so never seen |

Target: a browser at **half the width of a second monitor, full height**. Width is the scarce
resource and height is not. Accepted, all four: short numbers with the exact value on hover and
on copy, two-line rows, smaller data text, and merged related columns. Free rein on which
columns survive.

Every column is read when it is visible — the owner wants detail, and objects to *scrolling*
for it, not to having it. Hiding columns is not the answer; fitting them is.

| # | Decision | Was |
|---|---|---|
| 18 | The chart **expands on hover**, not on click, and carries **the owner's own price** on it | click to expand, no own-price marker in Sell mode |
| 19 | The chart plots **both** lines: sell-side trades at the hub, and ESI regional | regional only, both sides pooled |

Where the two lines diverge, the hub is out of line with the region, and that is worth seeing
rather than averaging away.

Decision 20 in detail. CCP publishes the SDE at `developers.eveonline.com/static-data` with
`Access-Control-Allow-Origin: *` and working byte ranges, so `sde.js` reads the
end-of-central-directory record, then the central directory, then only the nine members it
wants — about 26 MB of a 99 MB archive — and inflates them with `DecompressionStream`. The
derivation runs in the tab; the result goes to IndexedDB. `data/*.json` remain as a seed for
a first visit, built by CI from the same module so the two cannot disagree.

Going first-party replaced several written-down guesses with CCP's own data, and three of
them were wrong: molecular-forged reactions **do** take reactor rig bonuses, sov structures
**do** take structure rig bonuses, boosters **do** take equipment rig bonuses, and capital
rigs do **not** reach titans or supercarriers. The packaged-volume table was wrong for 53
types. And the baked SDE was thirteen months stale, over which CCP renamed 215 ore variants —
the Mine tool would have failed to match a single pasted one.

## Order of work

Everything above is to be built. The sequence is chosen so each step unblocks the next:

1. ~~**Strip the cache.**~~ Done. A precondition — the rest edits the same code, and none of it
   should be built on machinery that is being deleted. Removed two invented constants on the
   way out.
2. ~~**Redesign the table.**~~ Done. What the owner hits every session, and what used to hide
   anything added to it.
3. ~~**Solve-for-odds pricing.**~~ Done. Needed the new table to land in.
4. ~~**The SDE, client-side.**~~ Done. Independent of the rest.

## Still to build

The interview settled these and they are not yet written:

adaptive half-life (3) · patience presets 7/30/90 with two typed fields (1) · the blocked-row
cost line (2) · relist churn as settings (6) · uncapped units per transaction (7) · the
A4E-sourced patient price (8) · mean reversion as its own case (9) · round down when
undercutting (12) · the MAD outlier filter (13) · the ESI-ratio correction with a
data-quality signal (14) · delete "stalled" from My orders (16) · the chart expanding on
hover with the owner's own price and both lines (18, 19).

## Still open

ESI history window · old-print inflation cap · trend carry cap · what counts as "flat" ·
exact-sum cutoff · which source for units-per-trade · the three measurement windows
(trend/percentile/undercut velocity) · buy-order support.

Several of these are pure internals the owner has already delegated ("you know what I want",
"this one is on you"). They are open because they are unmeasured, not because they are
undecided — each needs either a measurement or an honest label, not a preference.

Two of the original twenty-six died with the cache: the staleness threshold and the storage
guard.
