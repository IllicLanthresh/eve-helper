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

## Built

All twenty are in, with tests. Where a decision turned out to be already satisfied it was
pinned rather than rewritten, and where one killed an invented constant on the way past,
that is noted.

| # | Landed as |
|---|---|
| 1 | two typed fields, `patDays` / `patFloor`, presets 7/30/90, default 90/35 |
| 2 | the `floor 618k` chip: what the block cost, and the one control that changes it |
| 3 | `reachHalfLife` — as far back as it takes to find one window's worth of trading days |
| 4 | the typed history-days field is the ONLY window control: it drives the ESI statistic, the fill model, the recency half-life **and** how much traded volume gets downloaded. I recorded this as "already so" and it was not — a second 30/90/180/365 dropdown was still setting the download depth |
| 5 | unchanged |
| 6 | `relistTol` / `relistMax` fields |
| 7 | already done: the invented 1e6 was gone, the remaining bound is a rule and is named when it bites |
| 8 | the patient price reads A4E sell-side prints at the hub, ESI as fallback |
| 9 | `decayOf` bounds the carry by the range the market has traded in — **retired the 0.2 and 3 multipliers** |
| 10 | `priceForOdds`, with a per-row target in the Fill cell |
| 11 | unchanged |
| 12 | already done; pinned by a ten-thousand-price sweep |
| 13 | `cleanSellLevels` — modified z-score on log price plus the market's own floor |
| 14 | `trkCorrected` — the item's own ESI ratio, with `vol ×N` as the quality signal |
| 15 | unchanged |
| 16 | the Stalled column, filter, stripe, sort key and header count are gone |
| 17 | nine columns, two rows per item |
| 18 | hover to open, click to pin, and the plan's own price is a marker |
| 19 | both series, one scale, the hub line dashed |
| 20 | `sde.js` — CCP's SDE read in the browser, kept in IndexedDB, one button to refresh |

## Closed since

Four of the eight open items were the same problem in different places — a number bounding
an extrapolation with nothing behind it — and one rule closed all four:

**A price carried by the trend may not leave the range this market has traded in**, lowest
daily low to highest daily high. Beyond that it is being put at a price nobody has paid,
which is extrapolation rather than evidence. That retired the old-print inflation cap (4×),
the trend carry cap (±50%/week) and the give-up branch's 0.2 and 3 multipliers, and it is
what makes mean reversion a distinct case (decision 9) rather than a special case.

Units-per-trade also closed: the invented 1e6 was already gone, the bound that replaced it
is a rule (one trade cannot be larger than everything the window trades) and the row says
so when it binds.

## Still open

ESI history window · what counts as "flat" (`FLAT_PCT_PER_WEEK`) · exact-sum cutoff
(`EU_EXACT_MAX`) · the three measurement windows (`TREND_DAYS` / `RANK_DAYS` / `VEL_DAYS`)
· buy-order support.

These are pure internals the owner has already delegated ("you know what I want", "this one
is on you"). They are open because they are unmeasured, not because they are undecided —
each needs either a measurement or an honest label, not a preference. Note that none of
them bounds an extrapolation: they choose a window or a rendering threshold, which is a
different kind of number.

Two of the original twenty-six died with the cache: the staleness threshold and the storage
guard.

## The row redesign (decided on the design canvas, 2026-08-26)

The owner's brief, verbatim: *"totals mixed with unitary prices · narrative tooltips with
a bunch of info that should just be represented at a glance · metrics are just bombarded
· I wanna understand, above everything else, the numbers involved in the decisionmaking
and the reason it got categorized as x or y or z · ultimately I wanna be able to
understand the process so I can catch possible bugs or mistakes when using it."*

Decided on the canvas (five artboards, three review rounds of owner comments), primary
direction approved:

- **The row carries the whole decision.** Verdict badge + a gate line
  (`floor → pass → rank → won by`) + all candidate plans as cards, each with price `/u`,
  net `Σ`, Δ vs the plan taken, and a labelled fill bar with the floor drawn as a tick.
  Card states: TAKEN / LOST (passed the floor, lost the rank) / BLOCKED (missed the
  floor; its odds stay visible) / SKIPPED (never built; the comparison that skipped it
  is on the card).
- **Unit discipline.** A bare number is banned. `/u` per unit (Book column only),
  `Σ` stack total (Outcome column only, own background + left rule), rates name the
  thing per the time (`u/d`, `%/wk`, `ISK/slot-d`), shares get a bar when a threshold
  exists, multipliers get context. Totals and unit prices never share a column.
- **One meaning per colour.** green = taken/passed · amber = a rule the owner set bit ·
  red = money leaving · cyan = measured this run / the sells branch · violet = the
  owner's own setting · slate = the modelled if-unsold branch.
- **Three tiers, hover is not one of them.** Tier 1 the row; tier 2 the expanded
  decision ledger (measured inputs with sources, the owner's settings, the candidate
  table, if-it-sells vs if-unsold branch bars, the formula evaluated with the real values, the
  gate step by step, the chart); tier 3 hover = the unrounded figure behind a rounded
  one and full names, nothing else. Narrative tooltips are dead.
- **No sentences.** Every string is `label + value + unit` or `a < b`.
- **Demand vs supply as one glance** (owner interview): sell and buy flow are a pair
  with a split bar whose divide IS the sell share; the tracker correction is a
  provenance line under the flow it corrects, amber only when big enough to distrust.
- The sparkline column STAYS on the collapsed row, deviating from the canvas: it is
  the ledger's entry point (hover to open, click to pin — decision 18) and the
  trend at a glance. The full chart and the ledger live in the expanded row.

## Ship-scan paste (owner request, 2026-08-26)

The scanner reads a structure's fit without ownership. The Structure Manager takes the
readout verbatim; only the Rig Slots section is applied (exact catalog names, replace
not append; reprocessing rigs become the tier by their trailing mark). Services are
reported, never applied — mapping services to activities would be an invented rule.

## The row shows real outcomes, not the blend (owner call, 2026-08-27)

The owner caught the label overstating: a listing plan's "net" is not realized money,
it is the odds-weighted score `p × if-it-sells + (1−p) × if-unsold − fees` that
the engine ranks by. An `E` prefix was tried and rejected the same day — his call:
"a single number … the non-reduced value + an 'at X% prob'". So the row now shows the
REAL if-it-sells total (net of fees) with its odds beside it — cards read `458kΣ at
74%`, the Outcome column reads `if sells 458kΣ at 74%` — and the number reconciles
with the price by arithmetic anyone can check. The blend never appears on the row:
it lives on hover (`if unsold · odds-weighted`) and in the ledger's candidate table
as `E net Σ`, still the sort key and the basis of every Δ, `won by`, and `vs instant`
margin, which the tooltips say. The instant plan's net stays plain — it is realized.

## Two follow-ups the owner's questions forced (2026-08-27)

**"Wtf is that give-up branch stuff?"** It was house jargon for the plain thing it
models: the units that do not sell get dumped into the buy book when the patience
window runs out. Every visible string now says `if unsold` against `if it sells`
(ledger sections 3 and 4, the bar legend, the My Orders verdict line); only code
comments keep the old shorthand.

**"The fill % doesn't change when I change the target."** True, and the row said
nothing about it. `priceForOdds` returns the HIGHEST price whose odds still clear the
target, so that one price answers every target at or below the odds it actually
delivers — on a liquid row the odds sit near 100% right up to the price ceiling and
cliff to zero above it, so the control is inert across its whole range. A price tick
coarser than the odds curve is steep does the same thing more locally. The row now
carries an amber `not binding` marker whenever the odds delivered beat the target by
more than 2 points, with the ceiling, what you asked, what you get, the threshold
where the price would start moving, and which of the two limits pinned it. A test
sweeps every row between a 40% and a 90% target: any row whose price does not move
must disclose why.

## The reprocessing rig is a rig (owner question, 2026-08-30)

It is not in the industry rig catalog and cannot be: that catalog is derived from CCP's
industry-modifier records, and these rigs carry none — what they change is refining
yield, which the Mine tool reads as a tier (T1 +1%, T2 +3%, times the system's security
multiplier). That is a fact about where the numbers come from, and it was leaking into
the interface as a separate widget below the rig controls, so a scan that filled it
looked like a scan that had missed it. It now sits in the same fitted-rig list as every
other rig, in the same shape — select, effect line, remove — and it **spends a rig slot**,
because it does in game. A ship scan carrying real section headers is the whole fitting,
so it now also clears a reprocessing tier its Rig Slots section does not show; a
headerless paste is a fragment and clears nothing.

Reprocessing is not in the industry activity checkboxes: those six are EVE's industry
*jobs* (no blueprint, no slot, no ME/TE for refining), and they feed the Industry tool's
job routing. The first version of this entry went further and said reprocessing "should
not be" industry-relevant at all — the owner refuted that the same day (see the next
section), and he was right: it is not a job, but it prices the inputs.


## Minerals via compressed ore (owner correction, 2026-08-30)

"Reprocessing is important when calculating industry because it can be cheaper to
reprocess ore/compressed ore rather than buying minerals directly." Correct, and the
Industry tool priced inputs only off the mineral book — its costs were wrong for anyone
who refines. Now a plan's reprocessable buy leaves can be priced as ONE joint purchase
of compressed ore, refined at the owner's structure. The decisions:

- **Buy/build decisions stay book-priced; the basket is priced after the plan is
  chosen.** Under joint production a per-mineral ore price is ill-defined — an ore
  yields several minerals at once — so the honest object is the whole basket, and the
  tree's decisions are never steered by it.
- **The LP only searches; buyQuote prices.** The mix is found by a linear program over
  the live book's levels (reprocessing tax folded into the ore columns), then
  integerized to whole portions and priced through the engine's one buying model —
  walks, broker floors, thin-book flags. Round-up is floor-vs-ceil per ore, priced
  exactly, cheaper kept: deterministic and constant-free. The adopted cost is the exact
  price of a concrete shopping list, optimal only in the continuous relaxation — and
  the drilldown says so.
- **Adoption is strict and conservative.** 'Direct' means the engine's own per-leaf
  charged sum (walks that restart at the top of the book); the ore route's legs are
  aggregated walks, which can only price >= that. The route can only ever reveal
  savings, never invent them; a losing route is still shown with its deficit.
- **The excess is listed and valued (buy-book walk, seller tax off) but NEVER
  credited.** Both readings are printed.
- **Refusal over guessing, three ways**: reprocessing tax unset on the structure record
  → feature off (0 is never assumed); reprocessor skills absent and no flat % typed →
  feature off (no default yield); an ore whose exact processing skill is untrained or
  unreadable is not a candidate (the game will not reprocess it). Flat mode is the
  owner asserting one yield by hand and is labelled "per-ore skills UNCHECKED".
- **One yield model** (refine.js / EveRefine, extracted from mine.html), **one buying
  model** (buyQuote), **one data path** (SDE.load serves ores and blueprints from the
  same local record — decision 20 holds). The per-material output floor is marked
  NEEDS-VERIFICATION in-client; the Mine tool deliberately keeps its continuous per-m³
  rate reading — a rate and a batch are different questions.
- **Candidates are derived, not curated**: an ore qualifies for a basket only when
  every output it yields is something that basket needs. LP duals are neither shown nor
  used; if ever displayed they are per-basket shadow prices, never decision inputs.
- The capital-shrink loop sizes against market-direct costs — conservative (savings
  only shrink spend) and zero LP solves inside the loop.
