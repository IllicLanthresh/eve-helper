# EVE Helper

A collection of single-file, locally-run EVE Online tools with a shared top bar. No install,
no server, no ESI login — live data comes from ESI's public endpoints and nothing else ever
leaves your machine. Open any page in a browser or use the GitHub Pages deployment.

| Tool | Page | What it does |
| --- | --- | --- |
| **Sell** | `index.html` | Turns a hangar full of loot into ready-to-paste sell lists for any trade hub — valued against the real order book, ranked by net profit after fees, best plan per item (instant / order / split). |
| **Mine** | `mine.html` | Two modes over one page. **Plan production**: paste the materials you need → what to mine (rocks, moon ores, sov array deposits), how many m³ after refine losses, and which of your alliance moons cover it (accepts in-game survey scans and Alliance Auth moon/extraction pastes). **Profit mode**: paste a survey scan at the belt — or an Alliance Auth extraction copy, to plan a moon pop ahead — and rank the contents by refined vs compressed ISK/m³. Live Jita prices. |
| **Industry** | `industry.html` | Full-market build-vs-buy scan: every blueprint product (T1, T2 invention, reactions, capitals) priced against the live Jita book with your facilities, rigs, skills, owned blueprints and shipping — ranked by profit, ROI, ISK/h, with a per-item cost drilldown. |
| **Structures** | `structures.html` | The one place player structures are managed: one record per structure with its identity (auto-detected) plus the facts ESI never publishes — owner-set market broker %, facility job tax, installed Standup rigs (with the rig-inference wizard), reprocessing rig, hull role bonuses, industry activities and notes. Every other tool *selects* a structure and reads those facts — the one exception is Sell's broker box, which writes the rate it asks you to read off the market window straight onto the record. |

## On-screen text is terse by design

The pages state facts, not sentences. A cell carries a number and its unit; a reason is a
short chip (`minfee`, `dup×2`, `▼4.1%/wk`, `8%<55%`) with its arithmetic on the tooltip; a
status line is dot-separated (`Jita 4-4 · 250 items · 14:32`); the plan and verdict
tooltips are `key: value` lines rather than paragraphs. Every explanatory paragraph that
used to sit on screen now hides behind a small **?** that starts **closed**, and the
per-section *Notes & assumptions* lists stay collapsed.

**Nothing was deleted — it moved.** Every fact is still reachable: hover a chip, open a
**?**, expand a row's chart, or hit **Copy TSV** (both the Sell table and the My-orders
triage have one, and the TSV carries the working numbers the table compresses: queue,
days to fill, chance, trend, the three verdict values, the relist fee).

**This README is the long-form reference.** When the screen says `q52d>12d` and you want
the sentence, it is here. A test suite (`tests/density.test.js`) keeps the copy from
drifting back into prose.

## EVE login (optional)

"Log in with EVE" in the top bar pulls your skill levels and standings to auto-fill what
you'd otherwise type by hand: **Accounting → sales tax**, **Broker Relations + standings →
broker fee** (Sell tool), **Reprocessing / Reprocessing Efficiency + the ore-group
processing skills → per-ore refine yields** (Mine tool — for the page's chosen
**reprocessed by** character; the flat refine % input is only the logged-out fallback). The Mine tool's refining facility is either the NPC-station
default (flat 50% base — stations have no rigs, so no rig or security bonuses apply) or a
player structure found through the shared **structure picker**: its type (Athanor 52% /
Tatara 55% / anything else 50%) and its system's security band are **auto-detected**,
while the reprocessing **rig** is read from the structure's central record (managed on the
**Structures** page — ESI exposes no fittings) and the **implant stays manual** on the Mine
page, because it is the pilot's, not the structure's. The facility line shows the recorded
rig next to a **record ↗** link into that record; a structure with no reprocessing
rig recorded says *"no rig set"* (the tooltip names the record as the place to fix it) and
is computed with **no rig bonus** rather than a guessed one. An **imported-skills panel** under the facility row lists
every reprocessing skill that was pulled, what it governs, and the resulting yield % at
the current facility. Everything stays client-side: it's the OAuth2 **PKCE** flow, so
there is no server, no database, and no secret — tokens live in your browser's
localStorage only.

**Your own market orders** (Sell tool): `esi-markets.read_character_orders.v1` is what the
**My orders** mode reads. It is per character, so every logged-in character that carries it
is fetched and a character that does not is *listed* with the inline permissions note — a
missing scope shows up as a named gap, never as quietly missing orders and wrong totals.

**Multiple characters**: log more in with the **+ alt** link in the top bar (the SSO page
lets you pick a different character). A selector — in the top bar, and next to the values
it drives ("fees from" on Sell) — chooses the **active** character; **log out** removes
the active one. The Mine tool no longer moves that site-wide switch: like Industry's
buyer/seller/manufacturer roles it has two page-local, persisted **role selectors**
instead — **reprocessed by** in the shared refine section and **sold by** in profit mode —
so the topbar character stays untouched. Handy when one alt trades and another one mines;
a chosen role character that logs out falls back to a logged-in one with an inline
warning.

**Broker fee with standings** (Sell tool): at an NPC station the broker fee is
`3% − 0.3%×Broker Relations − 0.03%×faction − 0.02%×corp` standing toward the hub
station's owner corporation and its faction (station owners come from public ESI and are
cached). Those are the **unmodified** standings straight from ESI — market fees ignore
**Connections** and **Diplomacy**, which only lift the agent/mission side. Sales tax is
`7.5% × (1 − 11%×Accounting)`.

Both formulas are **measured against the live client**, not assumed. On one 6,108,000 ISK
sell order placed by a character with Broker Relations 5, Accounting 5 and Caldari State
0.15 unmodified, the client charged:

| | client charged | formula gives |
|---|---|---|
| sales tax | 206,145.00 | `7.5 × (1 − 0.11×5)` = **3.3750%** |
| broker | 91,345.14 | `3 − 0.3×5 − 0.03×0.15` = **1.4955%** |

Four further listings from 100k to 900k — spanning −55% to +304% of the item's regional
average — all paid the same 1.4955%, so **how far a listing sits from the market does not
enter its broker fee**. Standings cap at 10.00, so the rate bottoms out at
`3 − 0.3×5 − 0.03×10 − 0.02×10` = **1%**, and the page clamps there rather than at zero.

The fee boxes round to two decimals because they are the display *and* the override
surface, but the page does its arithmetic on the unrounded rate — 3.375% shows as 3.37 and
is spent as 3.375. Anything you type still wins.

On top of the percentage every order pays a flat **minimum broker fee of 100 ISK per
order**, so a cheap stack pays an effective rate well above the nominal one (100 ISK on a
4,500 ISK order is 2.2%); rows where that floor binds are flagged, and the plan chooser
prices it in, since it can flip a small stack from ORDER to INSTANT.

The note under the fee inputs shows which character, skills and standings produced the
numbers. Both fee inputs stay hand-editable — anything you type wins until the next
auto-fill. Player structures are different: their broker fee is owner-set, entered
directly and kept on the structure's own record (see *Player structure markets*).

The deployed site at `illiclanthresh.github.io` ships with its own registered app, so login
just works there. Running a fork on another domain needs a one-time app registration
(EVE SSO matches the callback URL exactly):
1. Go to <https://developers.eveonline.com> → *Create new application*.
2. Create the application (any kind — the login uses PKCE, so the app's secret key is
   never used or stored).
3. Scopes — tick everything the portal still offers of: `esi-skills.read_skills.v1`,
   `esi-characters.read_standings.v1` (standings-aware broker fee),
   `esi-markets.structure_markets.v1`, `esi-universe.read_structures.v1`,
   `esi-search.search_structures.v1` (player structure markets),
   `esi-characters.read_blueprints.v1` (owned blueprints for the Industry tool) and
   `esi-markets.read_character_orders.v1` (your open market orders and the stalled-order
   triage in the Sell tool's *My orders* mode) and `esi-ui.open_window.v1` (the ↗ button
   that opens an item's market window in your running client);
   callback URL —
   exactly your deployed index page, e.g.
   `https://your-name.github.io/eve-helper/index.html`. An app registered before these
   features must add the missing scopes in the portal (and characters must log in
   again to grant them).
4. Click *Log in with EVE* in the tool and paste the app's **Client ID** when prompted
   (stored locally; the secret key is never used).

The SSO rejects a login outright (`invalid_scope`) when the request names a scope the app
doesn't have — or one CCP has removed server-side (it happens: `esi-characterstats.read.v1`
went away in 2025 with exactly that rejection). Before redirecting to the SSO, the site
checks the SSO's published metadata and automatically drops scopes that no longer exist,
so the login itself keeps working.

**Permissions panel** (every page): nothing about a missing permission is left to guess.
When anything the site asks for is unavailable, the top bar shows a `⚠ N permissions`
link; clicking it opens a panel listing, per logged-in character, which scopes are granted
and which are not — each missing one with the plain-language consequence ("disables: your
real researched ME/TE and which BPOs you own…") and, crucially, **which of three problems
it is**:

- **not granted** — the character's token predates the scope. A *re-login to grant* button
  sits right there; a token only carries the scopes that existed when it was issued.
- **your SSO application is missing it** — the SSO rejected the scope at the authorize
  step, so it is not ticked on the app in the developer portal. Logging in again changes
  nothing until that is fixed, and the panel says so in its own section.
- **CCP retired it** — the scope is gone from the SSO metadata. Not your fault and not
  fixable by you; the panel says that plainly.

The panel always shows the concrete fix: the exact scope list (with a copy button), the
exact callback URL to paste, a link to the developer portal, and the reminder that each
character must log in again afterwards. Everywhere a feature actually degrades — the Sell
fee note, the structure picker, the Industry owned-blueprints area and its "only owned
BPs" filter, the Mine skills panel — a short `⚠` line names what is unavailable and opens
the same panel. Nothing ever blocks: every tool keeps working in its degraded mode, and
when all permissions are granted the site says nothing at all.

---

# Sell Helper (`index.html`)

Two modes over one page, switched in the header the same way the Mine tool switches its
own: **Sell loot** — everything below, from a hangar paste to a ranked plan — and
**My orders**, which triages the orders that are already on the market. The switch is a
pure view swap: same state, same fees, same patience, same machinery, and it is
remembered.

## Workflow

1. **Paste your inventory** (select items in a hangar/container → Ctrl-C).
2. **Pick a market**: Jita 4-4, Amarr, Dodixie, Rens, Hek — or a saved player structure
   (see *Player structure markets* below).
3. **Fetch prices** — pulls the live order book per item (optionally plus ~13 months
   of daily price history) for the chosen hub.
4. Check your **broker fee** and **sales tax** (defaults 2.1% / 7.5%), set your **patience**
   (*in a rush* / *balanced* / *patient*), and choose where the competitive list price `L`
   comes from:
   - **current best sell** (optionally one tick under), or
   - **history statistic** — median / average / 10th / 90th percentile of the region's
     daily average price over the last N days. N and the statistic apply instantly, no refetch.
     This statistic is also the **patient price** the tool values as its own option.
5. Every item is valued against the actual buy book *and* against the two ways of listing
   it, and gets a plan — see [The decision layer](#the-decision-layer) for the model:
   - **INSTANT** — dumping the stack into the buy book right now is the best of the three.
     Depth-aware: the walk respects each order's remaining volume and `min_volume`
     (margin-scam bait is ignored), so one 1-unit buy order at a silly price no longer
     values your whole stack. Certain, and it uses no market slot.
   - **LIST** — listing at the competitive price `L`.
   - **LIST-PATIENT** — listing at the history reference price, when the odds say that is
     worth the wait and the fee.
   - **SPLIT** — a listing whose instant leg is non-empty: when you import at a price, the
     game automatically fills any buy orders above it first (at *their* price, no broker
     fee) and lists the rest. No manual stack splitting needed, whichever list price the
     recommendation picked.
   The split point is chosen by comparing the actual net of every cut of the buy book, so
   the 100 ISK per-order minimum is priced in: on a cheap stack it can tip the plan to
   INSTANT, and rows where it binds carry a `minfee` chip whose tooltip gives the floor,
   the effective rate and the nominal one.
6. **Filter and sort**: click headers to sort (▲/▼ indicator), search by name, filter by
   plan. Every row carries the item's icon (CCP's public image CDN — no login, no scope),
   so a row can be matched against the stack in your hangar by eye; types the CDN has no
   icon for — many SKINs — leave the box blank rather than showing a broken image. The table opens sorted by **ISK/slot-day**, descending.

   **The screen is the order.** The `#` column is the row's position *in the view you are
   looking at* — it renumbers every time you sort or filter, and it is the only ordering
   the tool has. `Tick top N` works down that order from the top, the import list and both
   TSVs come out in it, and there is no second ranking hiding behind any of them. (Until this was fixed,
   `#` was a fixed position by expected net ISK, assigned when the plan was built and
   never moved by sorting — so `Tick top N` ticked rows that were nowhere near the top of
   the screen, and nothing on the page said which order was in charge.)

   `Tick top N` passes over rows it cannot tick — INSTANT ones (a ⚡ where the checkbox
   would be), unsellable ones (they carry a flag), and rows the filters are hiding — so
   "top 2" can land on `#1` and `#3`. Both reasons are visible on the row itself.

   **The three selection buttons obey one rule: a bulk button *sets* the import list, it
   never adds to it.** Whatever it does not tick, it unticks — everywhere, including rows a
   filter is hiding and stale ticks left behind on rows that have since become INSTANT.
   Only the per-row checkbox is additive. That is what makes "top 20" mean twenty: after
   any of the three, every ticked row is on screen, so the count in the echo is checkable
   by eye. It also means a bulk press discards a deliberate hand-tick on an unsellable row
   — the buttons say so, and `Tick top N` / `All` never tick one themselves.

   One exception, and it exists to stop the rule turning into a delete: if the current
   filter leaves **nothing tickable** — `show = INSTANT only`, or a name filter matching
   only INSTANT and unsellable rows, or one matching nothing at all — then `Tick top N`
   and `All` **leave the import list alone** and say so next to the button. Setting the
   list from an empty candidate set would wipe it entirely off screen, on a table showing
   one ⚡ row or none, with the `⚠N hidden` warning vanishing as though it had been
   resolved. `None` still empties the list on purpose; its tooltip already says it ignores
   the filters.

   Filters remain a viewing aid: a row you tick *by hand* and then filter away stays in
   the import list, and the toolbar says so (`⚠N hidden`). After a bulk button there is
   nothing for that warning to report.

   Ticks are remembered between visits, and **removing one sticks**: the saved list is
   narrowed whenever the list is saved, so a tick you cleared does not come back the next
   time its row goes away and returns (clear the box and paste the same export, change
   hub, refetch). Clearing the inventory box alone is not read as unticking anything — a
   plain clear-and-paste still brings your picks back.
7. **Export — two artifacts**:
   - **Import list (orders & splits)**: every ticked row as `Item name ⇥ Price` for the
     game's multi-sell import. The tick column is labelled *Import* and only ORDER/SPLIT
     rows have a checkbox — INSTANT rows show ⚡ instead, since there is nothing to import.
   - **Instant checklist**: the INSTANT items as `Item name ⇥ Qty` (plus the instant legs
     of ticked SPLITs as partial stacks) — sell these directly in the hangar.

   **Use them in that order: orders first, instants second.** Listing a stack moves it out
   of the hangar and into the order, so once the import list is in, whatever is *left* in
   the hangar is the instant pile — select all, right-click, Sell, one action. The other
   way round means picking a few hundred stacks out of a hangar by hand, one at a time,
   and being careful not to dump something that should have been listed. The only
   stragglers after the orders go up are items the tool could not price; section 2 names
   them.
8. **Copy TSV** pastes the whole analysis into Excel / Google Sheets, including
   the working numbers the table keeps in tooltips (trend %/week, percentile rank, undercut
   velocity, the broker fee at risk). *My orders* has its own **Copy TSV** with the triage
   diagnostics: queue ahead, days to fill, chance, trend, the hold / reprice / dump values
   and the relist fee. Each states its scope on its button, because the two differ on
   purpose: the Sell one is the whole analysis, filters ignored (it carries an *In import
   list* column and the rows that could not be priced), while *My orders* copies the orders
   its table is showing — a filtered table there no longer copies a second, larger set
   while the status line claims it copied what you were looking at. Both come out in the
   order their table is in.

## The decision layer

The scarce resource is not ISK, it is a **market slot-day**: you can only have so many
orders up, so the question per item is not "could this be worth more?" but "is this the
best thing to spend a slot on, and will it actually sell before I give up on it?".

Three disposals are valued per item, all net of the real fee model:

| Disposal | What it means | Slot | Certainty |
| --- | --- | --- | --- |
| **INSTANT** | dump the stack into the buy book now | none | certain |
| **LIST** | one order at the competitive price `L` | one | probabilistic |
| **LIST-PATIENT** | one order at the history reference price | one | probabilistic |

**The broker fee is charged when the order goes up, not when it fills.** Cancel or endlessly
modify the order and the fee is simply gone. So a listing is worth

```
net = legNet − broker − churn + p × (it fills) + (1 − p) × (you give up and dump it then)
```

with the broker fee subtracted in **both** branches, `legNet` the part of the stack that
fills instantly against buy orders above the list price, and the give-up branch valued at
today's buy-book price **carried forward by the trend** over the patience window
(`today × (1 + weekly%/100) ^ (window/7)`), which is what makes a decaying item punish
itself. `churn` prices the relisting a sliding market forces on you: each modification pays
the broker fee again.

The metrics behind it, all computed from data already fetched (the daily history and the
live book — no extra ESI endpoint), all recomputed locally when you change a control:

- **Trend** — Theil–Sen slope (the median of every pairwise slope) on the **log** of the
  last 30 daily averages, in %/week. Median-of-slopes because EVE history is full of
  single-day spikes that would drag a least-squares line; log because it makes the slope a
  growth rate, comparable across a 4 ISK mineral and a 400M ship. |trend| under 1.5%/week
  is called *flat*. It is in the row's tooltip and drawn by the sparkline, not given a
  column of its own.
- **Percentile rank** — where the live best sell sits in the last 60 days of daily averages.
  "The 12th percentile" means the market has been cheaper than this on only 12% of them.
- **Fill est. (days)** — units already listed at or below the recommended price ÷ Vol/day.
- **Chance %** — the empirical fill probability: over the last ~12 months, the share of
  rolling 7 / 14 / 30-day windows (per your patience) whose **daily high** reached the
  price, then tempered by the queue above. Each past day is first **carried to today's
  price level at the item's own trend**, because otherwise the metric has the same disease
  it is curing: on an item that has slid all year, every window from eight months ago
  cleared today's asking price, and a flat count would report a comfortable probability for
  a price nobody has paid since spring. The row's tooltip quotes both numbers when they
  disagree — *that gap is the difference between a dip and a decay*.
- **ISK/slot-day** — expected net ÷ expected days on the market, and the column the table
  opens sorted by: market slots, not ISK, are what you run out of. INSTANT rows have no
  value here (they use no slot) and sort to the bottom of it. Without history there is no
  fill estimate and therefore no rate at all, so the column is empty and the sort falls
  through to expected net — the header tooltip counts the rows that have no rate yet
  rather than letting the ▼ imply a ranking that is not happening.

**The fee guard.** A listing whose fill chance is under the patience mode's floor is never
recommended, whatever it would be worth if it filled:

| Patience | Window | Fill-chance floor |
| --- | --- | --- |
| in a rush | 7 days | 75% |
| balanced (default) | 14 days | 55% |
| patient | 30 days | 35% |

Below the floor the tool recommends the competitive listing or INSTANT instead and says so
in the row's tooltip, naming the fee that would have been spent for nothing. The patience
control re-ranks the whole table instantly — it changes no request, only the arithmetic.

Every recommendation carries a plain-language **why** on hover, e.g. *"best sell sits at the
12th percentile of the last 60 days, trend −4.1%/week (falling), the patient price 1,150,000
was reached in 8% of past 14-day windows once those days are carried to today's price level
(74% at the prices of the day — that gap is the decay)"*.

### What this replaced, and why

The old build tagged a row **⏳ wait** when an order at the **p90** of the history window
would net at least X% more than the current plan. p90 is a *level* statistic: in a declining
market it is a high-water mark, so the tag fired permanently on exactly the items that were
decaying, and "hide ⏳" deferred them forever. It also had no notion of probability, of the
fee spent to put the order up, or of the slot the order occupies. The tag, its threshold
input and its three-way filter are gone; a **LIST-PATIENT** recommendation — one that has to
survive the fee guard — replaces it. Old saved settings load cleanly; the dead keys are
ignored and dropped on the next save.

### The graphs

Every priced row carries an inline **sparkline** — the last 120 days of daily average
price, drawn in the trend's own colour (green rising, red falling, grey flat), with
horizontal markers for the three prices the row turns on: the current best sell (cyan),
the competitive list price (amber, drawn only when it differs from the best sell) and the
patient price (violet). The vertical scale spans the series *and* the markers, so a marker
is never off-canvas and "the patient price is above everything this market has done lately"
becomes a picture rather than a percentage.

**Click a sparkline** (or focus it and press Enter) to expand the row into a full chart:
the same series at ~12 months, a shaded band between the daily high and low where ESI
provides them, the price markers repeated and labelled, daily traded volume as bars
beneath, and the row's decision numbers — plan, expected net, fill estimate, chance,
ISK/slot-day — restated under it next to the plain-language *why*. One chart is open at a
time, and it stays open across a re-sort or a patience flip.

It is all inline SVG: no chart library, no external request, no canvas. Sparklines are
drawn **lazily**, only for cells actually scrolled into the table's viewport, so a 250-row
hangar does not pay for 250 charts nobody looks at. Rows with no history at this market say
so instead of drawing an empty box.

### Honest caveats

- **Fill est. is an approximation, and an optimistic one.** ESI publishes regional traded
  volume with no per-side split, so Vol/day mixes buys and sells and every station in the
  region, while the queue is counted at the hub only — and your own stack is not counted in
  the queue ahead of you.
- **Chance % is past behaviour, not a promise.** It says how often this market *did* pay
  that price, adjusted for where the market trades now. It cannot know about the patch notes
  that halve the item next week.
- The trend is a fit to 30 noisy days; on a thin item it is a guess with an error bar the
  page does not draw. That is why the flat band exists and why the carry factor is capped.
- Relist churn is modelled as a capped number of repricings, not simulated. Nothing models
  someone undercutting you by 0.01 ISK five minutes after you list.
- Price history is per **region**; ESI has none per station or per structure.

## Player structure markets

Sell where your alliance actually trades: the market selector's **+ add structure…**
option opens the structure picker — a modal with live search that runs **as your
logged-in character** (so it only finds structures that character has access to). Results
show name, system and structure type; pick with the mouse or ↑/↓ + Enter. With nothing
saved yet the modal says so and still links to the manager, and logged out it offers the
**log in with EVE** action itself (it covers the topbar's own button). Saved
structures are listed in the same modal to pick from — the modal is a **selector only**:
renaming, editing and removing happen in the
[Structure Manager](#structure-manager-structureshtml), which the modal's footer link and
the **structures ↗** link next to the market selector both open (deep-linked to the
selected structure's record). Removing a structure there drops it from the market list and
falls back to Jita — including live in an already-open Sell tab, which restores the NPC
hub's own broker fee, clears the structure's order book and says why. Typing in the broker
box records the structure's owner-set rate; **emptying** it records *not known* rather than
0%. Selecting a structure with **no rate recorded** never inherits the rate of the market
you came from: the box goes back to the NPC-hub rate from your skills and the fee line
names it as a stand-in until the real one is typed in. The saved list is **shared with
every tool**. This
needs the `esi-markets.structure_markets.v1`, `esi-universe.read_structures.v1` and
`esi-search.search_structures.v1` scopes — if your character logged in before these were
requested, log in again ("+ alt" on the same character works).

With a structure selected, a price run fetches:
- the structure's **real order book** (the ESI structure-market endpoint has no per-item
  filter, so the whole paginated book is pulled once and indexed — sell prices, undercuts
  and sell depth come exclusively from it);
- **regional buy orders that reach the structure** (range `region`, or same-system jump
  ranges; `station`-range buys elsewhere never do), merged with the structure book's buys
  and de-duplicated by order id — a public structure's orders appear in both feeds;
- **regional history** (ESI has no per-structure history — the Hist column, flags and
  fallbacks are region-wide, and the status line says so).

The **owner-set broker fee is not in ESI** (there is no endpoint for it). With a structure
selected, the fee line says so — *"⚑ broker 4.5% — ‹structure›: owner-set"*, or
*"⚑ owner broker % — ‹structure›: none recorded yet · pricing with 1.50% (stand-in)"* —
and links straight to that **record**. Read the rate once from the
in-game sell window and type it into the broker % field: typing it here writes it onto the
**structure's central record**, exactly as if it had been entered on the Structures page
(and a change made there reaches an open Sell tab immediately). Switching back to an NPC hub
restores the skills/standings-derived rate. Sales tax (Accounting) applies everywhere and
keeps auto-filling.

## My orders — the stalled-order triage

*"I have a bunch of orders I placed a while ago based on the tool's pricing. They seem to
be stalled, I've been overbid and the price has come down, and I don't think waiting three
months would move them."*

That is what this mode is for. It reads the orders you already have and answers, per order,
whether it is ever going to sell — and if not, what to do about it.

**What it fetches.** `GET /characters/{id}/orders/` for **every logged-in character** that
carries `esi-markets.read_character_orders.v1` (a character without it is listed with the
permissions link instead of being skipped). Type names come from `POST /universe/names`
(chunked, and retried one id at a time so a single unknown id can't lose a whole chunk),
NPC station names from `GET /universe/stations/{id}` (cached — stations do not move), and
player structures from your structure records or `GET /universe/structures/{id}`. Anything
that cannot be resolved is shown as its **raw id**, not as a guess.

Then, per order, the book at **its** location and that type's history: NPC stations through
the same region fetch the Sell mode uses, filtered to the station; player structures through
the structure-market path. Orders are grouped by location first, so a structure's whole book
is pulled **once** however many orders sit in it, and history the price fetch already pulled
for the same region is reused. The error-limit handling, the retries and the progress bar are
the price fetch's own.

**Sell orders are the default view.** Buy orders arrive behind a toggle, in their own group,
labelled as what they are: the economics run the other way round (you are waiting for someone
to sell *to* you, and the ISK is in escrow), so none of the sell-side triage is applied to them.

### The numbers, per order

| Column | What it is |
| --- | --- |
| **Queue ahead** | Units listed at or below your price at that location, **with your own units taken back out**. Your order is a public sell order like any other and *is* in the book that was just fetched; counting it inflates every wait, and when you happen to be cheapest it tells you that you are undercutting yourself. Own orders are matched by **order id** (exact), falling back to price only for an order the book does not carry. |
| **vs best %** | How far your price sits above the best **competing** sell — again, your own orders excluded. |
| **Fill est. (d)** | Queue ahead ÷ daily traded volume, the same `daysToFillAt` the Sell table uses, with the same caveat: regional volume mixes buy and sell sides and every station in the region, so it is an optimistic order of magnitude. |
| **Trend %/wk** | The same Theil–Sen slope over 30 days of daily average price the Sell mode ranks with. |
| **Chance %** | The same **trend-adjusted hit rate**: the share of past windows whose daily high reached your price, every past day first carried to today's price level at the item's own trend, then tempered by the queue already ahead of you. The window is whichever runs out first — your patience setting, or the days left on the order. |
| **History** | The Sell table's sparkline, with a marker at **your** asking price and at the best competing sell. A price the market has left behind is a picture, not a number. |

### Stalled, and why

An order is **stalled** when any of these is true. The Stalled cell shows one chip per
reason; the chip's tooltip carries the numbers:

| Chip | Reason |
| --- | --- |
| `8%<55%` | The **chance** of filling at your price is under your patience mode's floor (75 / 55 / 35%). |
| `q52d>12d` | The **queue** at your price cannot clear before the order expires (fill est. > days left). |
| `+4.1%▼` | You sit **above the best sell on a falling market**, where the gap only widens. This one needs the chance under 90% as well — an order that is going to fill anyway is not stalled whatever the trend does. |

The header states the totals as facts — *stalled: N orders · X ISK frozen* and
*recoverable: Y ISK by dumping* — with the exact figures on hover, and the table sorts by
the ISK frozen in stalled orders, worst first.

### The verdict

Three futures over the days that are actually left, all net of sales tax:

| Verdict | Arithmetic (one `key: value` line each, on hover) |
| --- | --- |
| **HOLD** | `chance × units × your price × (1 − tax) + (1 − chance) × (dumping at the end of the window, carried by the trend)` |
| **REPRICE → X** | the same at the competitive price X (the best competing sell, one tick under if you have that ticked), **minus the relist fee** |
| **CANCEL & DUMP** | what the buy book pays for the remaining units **right now**, walked depth-first with `min_volume` respected, minus tax |

The badge's tooltip prints all three values plus a `sunk:` line and, when the order is
stalled, a `stalled:` line listing the chips. **Copy TSV** above the table hands the same
numbers to a spreadsheet, one row per order.

The highest number wins; a tie goes to the option that **frees the market slot**, exactly as
the Sell mode refuses to list unless a listing strictly beats selling now. Slots, not ISK,
are the thing that runs out.

**The broker fee you already paid is sunk.** It left your wallet when the order went up and
is never refunded, so it is charged against **none** of the three — and least of all against
cancelling. Charging it there is the classic error that keeps dead orders alive ("I already
paid for this listing"); a sunk cost cannot be recovered by waiting. The only fee anywhere
in the comparison is the **relist fee**, because that one is a payment you have not made yet.

### How many slots you actually have

Every character has 5 open-order slots and four skills that add to them:

```
cap = 5 + 4×Trade + 8×Retail + 16×Wholesale + 32×Tycoon        (5 to 305)
```

The character list above the table shows `used/cap slots` per character, with the
derivation on hover, so it can be checked against the client's own market window. The four
skills are resolved **by name** through the same `/universe/ids` lookup the rest of the
site uses — no hardcoded type ids. Slots, not ISK, are the thing that runs out, which is
why both modes rank by ISK per slot-**day**.

### The relist fee, and the half of it that is easy to miss

Changing an open order's price is charged in **two** parts:

```
discount   = 50% + 6% × Advanced Broker Relations        (80% at level V)
relist fee = broker % × (1 − discount) × units × the NEW price
           + broker % ×                  units × (the new price − the old one, if it rose)
```

The first term is the ordinary broker fee on the whole re-listed order, discounted by the
skill. The second charges the **undiscounted** broker fee on however much the order grew —
raising a price brokers value that was never brokered, so the discount does not reach it.
**Lowering** a price makes that term zero, which is every reprice this page recommends.

Measured on the live client at Advanced Broker Relations 4 (discount 74%, so 26% of a
1.4955% broker = **0.38883%**), moving a stack of 10 whose old price was 2,166,000:

| new price | client charged | = first term | + growth term |
|---|---|---|---|
| 500,000 | 19,441.50 | 19,441.50 | — |
| 1,000,000 | 38,883.00 | 38,883.00 | — |
| 2,166,000 *(unchanged)* | 84,220.58 | 84,220.58 | — |
| **4,000,000** *(a raise)* | **429,806.70** | 155,532.00 | **274,274.70** |

All four to the ISK. The raise is the reading that proves the second term exists at all:
the discounted rate alone would have said 155,532, a **third** of what the client charged.

The skill is resolved **by name** through the same `/universe/ids` lookup the rest of the
site uses (no hardcoded type id), and the discount comes off *your* level — nothing about
it is a fixed number. The resulting % is shown in a box above the table
(*0.39% — 1.50% broker − 74% Advanced Broker Relations (level 4)*), is **hand-editable**,
and your correction is **saved** and used everywhere.

The same flat 100 ISK per-order floor applies, and it is measured too: one Nova Rocket
moved from 10.00 to 9.83 ISK computes to **0.04 ISK** of broker fee, and the client
charged the full **100**. So on anything under about 25,700 ISK of order value the floor,
not the rate, is what a reprice costs — which is why the tool prices it in rather than
quoting a percentage.

> An earlier version of this page charged a flat 1.20% per reprice against a real 0.38883%
> — **3.1× too much** — which pushed verdicts away from REPRICE and toward HOLD and
> CANCEL & DUMP.

### Honest caveats

- No diagnosis without a book: where the book cannot be fetched — no market scope at a
  structure, no docking access, a failed request — the row says so and gets **no verdict**,
  rather than a verdict built on nothing. Same for an item with no price history.
- The fill estimate and the chance carry exactly the caveats they carry in the Sell mode.
  Past behaviour is not a promise, and a 14-day window is not a forecast.
- Nothing here cancels, reprices or places anything. EVE has no write API for market orders,
  and this tool would not use one: it tells you what to do in the client.
- The diagnosis needs a fetch each session. The orders themselves are remembered between
  visits (that is what the duplicate-order flag reads), but books and odds are not — stale
  odds are worse than none.

### Acting on a verdict

The triage table has a **↗** column. On a **REPRICE** row one click does both halves of
the job: the new price goes on your clipboard *and* the item's market window opens in the
client that owns the order — so the in-game work is right-click → *Modify Order* → Ctrl-V.
On any other row it just opens the window. The clipboard half never depends on ESI: if the
scope is missing or no client is running you still get the price, and the status line says
what did not happen.

This is the *only* thing ESI can do to your client. There is no endpoint that moves an
item, places an order or changes a price — the entire ESI write surface is contacts, mail,
fittings, fleets, calendar RSVPs, an autopilot waypoint and four "open window" calls. So
the most any third-party tool can do is save you retyping the name into the market search.

Needs `esi-ui.open_window.v1` on the app *and* on the character's login. The token used is
always the one for the character that **owns** the order — opening the window on the wrong
alt is worse than not opening it.

The **verdict filter** next to the search box narrows the table to *stalled only*, or to a
single verdict. A buy order is never triaged, so any verdict filter hides buy orders rather
than pretending they passed. The reprice price is click-to-copy on its own, separately from
the cell around it, which copies the verdict.

### Prevention, back in Sell loot mode

The other half of the problem is not creating stalled orders in the first place. When you are
about to list something you **already have an order for at that market**, the row is flagged
`dup×N` (the price it is already up at is on the chip's tooltip). A second order competes
with your own, in the same queue,
for a second broker fee.

## Flags

| Flag | Meaning |
| --- | --- |
Every chip is at most ten-odd characters and carries its numbers on hover.

| Chip | Meaning (the tooltip carries the numbers) |
| --- | --- |
| `suspect` | Top buy above best sell — a thin or broken market. Check in game. |
| `≫hist` / `≪hist` | Current best sell is far (±50%) from the chosen history statistic; the tooltip gives both prices and the ratio. |
| `depth x/y` | The buy book can only absorb x of your y units at any price. |
| `▼x.x%/wk` | The daily average has been falling at that rate for the last 30 days — a decaying market, not a dip. |
| `minfee` | The flat 100 ISK per-order broker fee beats the percentage; the tooltip gives the effective and nominal rates. |
| `L=sell` / `L=hist` | The chosen list-price source wasn't available for this item; the other one was used. |
| `>best` | The list price `L` sits above the current best sell. |
| `no buy` / `no sell` | That side of the book is empty at this hub. |
| `dup×N` | You already have N open sell orders for this item at this market (from *My orders*' last pull). A second order competes with your own; the tooltip gives the price. |
| `unsellable` | Ice Storm / Expired filaments the market refuses. Auto-excluded from the export (re-tickable). |

Items with no orders and no history at the hub are listed separately and never pollute the ranking.

## Details & assumptions

- Instant valuation walks buy orders top-down, taking `volume_remain` per level and skipping
  orders whose `min_volume` can't be met — units the book can't absorb are valued at zero
  (and flagged).
- The listing plans model the real import mechanics: fills above the list price execute at
  the resting buy order's price and pay only sales tax; the listed remainder pays broker +
  tax, the broker never less than the flat 100 ISK per-order minimum — and that broker fee
  is spent when the order goes up, which is why it is charged in both branches of the
  expectation and why the fee guard exists.
- Price history is per **region** (ESI has no station-level history), using each day's
  average, high and low.
- ESI usage: `POST /universe/ids`, `GET /markets/{region}/orders?type_id=…` (paginated,
  filtered to the hub station; buy orders count if their range covers it), and optionally
  `GET /markets/{region}/history?type_id=…`. *My orders* adds `GET /characters/{id}/orders/`,
  `POST /universe/names`, `GET /universe/stations/{id}` and, for structures,
  `GET /markets/structures/{id}/`. Error-limit headers are honoured, transient
  errors retried; failed items are listed as unpriced.
- Prices respect EVE's 4-significant-digit rule; the one-tick undercut steps into the finer
  band below round numbers (1 000 000 → 999 900).
- Number parsing accepts both `1.234.567,89` (EVE client, EU locale) and `1234567.89`
  formats; the export decimal separator is switchable.
- Inputs, fees, market, pricing options, row selections, the page mode, the buy-order
  toggle and the relist-fee override persist in `localStorage`; the last order pull is kept
  under its own key, so *My orders* is not empty on a reload and the duplicate-order flag
  keeps working.

## Development

Plain HTML/CSS/JS in one file — no build step. `Sample` fills the input with a
real 250-item hangar for instant experimentation (fetch prices to value it).

---

# Mine Helper (`mine.html`)

One page, two peer modes, switched by a segmented control under the page title (the choice
persists; production planning is the default). **Plan production** is the shopping-list
workflow described above under *EVE login*: paste the materials a production line needs
(1), set prices & refine (2), see what to mine — ranking, mining plan and sov-array
deposits (3), and check which of your alliance moons cover the list (4). **Profit mode** is
a different entry point, not a step of that flow — no shopping list, you're sitting in a
belt with a survey scanner: paste the scan (1), the same refine-&-prices section production
uses (2 — one shared section, not a copy), and see what to shoot (3). Switching is an
instant view swap over shared state: prices, skills, facility and pastes all carry across.

## Refining facility (a selector, not an editor)

The refine section's facility row is either the **NPC station** (50% base) or one player
structure. The dropdown lists **every structure on the shared saved list** (exactly what
the Sell page's market selector offers), and *structure…* opens the shared
**structure picker** to add one. What the row does with that choice:

- the **refinery base** (Athanor 52% / Tatara 55%) comes from the structure's hull and the
  **security band** from its system — both read off the record, neither hand-picked, and
  both re-read when the record changes (re-resolving an identity that had no security
  moves the band, and the rig multiplier with it, without a reload);
- the **reprocessing rig** is *displayed*, never edited here. It is a fact about the
  structure, so it lives on the record: the row shows the recorded tier next to a **manage
  structure** link that deep-links to that record in the
  [Structure Manager](#structure-manager-structureshtml). With nothing recorded the row says
  *"no rig set"* — the tooltip names the record as the place to fix it — and the yield is
  computed with **no rig bonus** rather than an invented one;
- the **implant** stays a control on this page — it is the pilot's, not the structure's.

Editing that record (here or in another tab) re-prices the page immediately: the store
notifies every open tool. Structures picked here are saved centrally, so the same structure
is one click away in the Sell market list and as an Industry facility. A structure
**removed** in the manager stops being an option here and the facility falls back to the
NPC station, with a line naming which structure went — the fallback the manager's remove
confirm promises, rather than a selection pointing at nothing.

## Exact SDE data

Every per-ore number on the page comes straight from CCP's Static Data Export via
`data/ores.json` (the same CI build as `industry.json`): unit volumes, portion sizes,
per-variant reprocessing outputs, and — per type — the **exact reprocessing skill** from
the SDE's own `reprocessingSkillType` dogma attribute. The former hand-curated density
table and the name-based skill grouping are gone, including the assumed mapping for the
nine Equinox-era ores — and the SDE disagreed with two of those guesses: **Kylixium**
refines with *Variegated* (not Simple) and **Hezorime** with *Complex* (not Variegated)
Ore Processing; the other seven were right. The imported-skills panel's "applies to"
column is likewise derived from the data (each skill lists the ores that actually carry
it). The **only** curated data left is which ores spawn in which sov-array anomaly type —
game-world spawn info that no CCP export provides (EVE University Wiki). Without
`data/ores.json` the affected sections show an explicit "exact ore data unavailable"
state with a retry; nothing ever falls back to approximations.

## Profit mode (survey scan or Auth extraction)

Mining in an alliance fleet with no shopping list — just a belt or a moon chunk and the
question *what should I shoot for max value*? Profit mode's paste-first section takes the
in-game **survey scanner** output pasted as-is: `Ore  Quantity  Volume  [Est. Value]
Distance` rows, tab or multi-space separated, EU (`1.234.567`) and US (`1,234,567`)
number formats both fine; header lines, the client's Est. Value column (ISK or `-`) and
the distance are ignored, the scanner's per-ore-type **group-header rows** (a full
Ctrl+A copy includes those bare ore names) are recognized and counted in the
parse-status note instead of being flagged, and unrecognized names are listed visibly
instead of silently dropped. Rocks aggregate per ore type and every type gets two value
densities, side by side:

- **refined ISK/m³** — the variant's exact per-type reprocessing outputs (from the SDE via
  `data/ores.json`, generated by the same CI build as `industry.json`), priced with the
  section-2 material prices and multiplied by the **reprocessed by** character's refine
  rate: the same skills and the same facility row (structure, rig, security band, implant)
  the mining plan uses. Ice products (isotopes, heavy water…) aren't in the section-2
  grid, so their prices fetch on demand by type id.
- **compressed ISK/m³** — the matching "Compressed …" type's live Jita price (fetched on
  demand, honoring the sell/buy basis selector) per m³ of raw rock. Compression is **1:1
  by units** — one compressed unit per ore unit, only the *volume* shrinks (~100× for
  ore, ~10× for ice) — and the per-type unit ratio is derived from the SDE's own
  reprocessing outputs rather than assumed (CCP changed this mechanic in 2023; the
  pre-2023 100:1 unit ratio would price compressed rock ~100× too low). No compressed
  variant or no order book shows the honest unpriced flag — the raw column beside it is
  the fallback story now.
- **raw ISK/m³** — the untouched ore itself at its **own** Jita book (each variant
  prices from its own type id, not the base family's) divided by its unit volume. No
  ratio, no refining — selling the rocks exactly as they came out of the belt.

A **compressed m³** column shows the haul volume after compression — units ÷ the derived
unit ratio × the compressed type's own m³ (ores shrink ~100×, ice ~10×); a type with no
compressed variant hauls at raw volume and is excluded from the totals-row figure, the
haul-planning number for the whole field or chunk. Every value cell carries a small
muted percentage: that row's share of the **best row on that same basis**, so all three
rankings read at a glance (the old single "% of best" column is gone). Toggling
**ISK/h** swaps the three per-m³ columns for hourly ones — the same ranking scaled by
your yield, percentages riding along; ice/Mercoxit rows keep their greyed per-m³ value
there, since an ore-yield hourly figure would be wrong for them.

The same paste box also plans **ahead of a moon pop**: paste your alliance's Auth
**"Extraction details"** copy (the upcoming extraction's m³ per ore) and it is
auto-detected — reusing the exact parsers of production mode's *Your moons* section, no
second dialect. The aa-moonmining **ore-table modal** (icon / Ore Type / Rarity /
Est. Unit Price / Volume / Est. Total Price + a Total footer) is understood too: the
header row **anchors the column indices** so the Volume cell is read by position — never
"the first number after the name", which once misread the unit-price column as the m³ —
with headerless copies identified by the R-tier tag after the ore name, `?` unit prices
inert, EU and US number locales both fine, the Total row used as a checksum (a
disagreement with the summed ore rows earns a status note, never an error), and Auth's
rarity tags cross-checked against the SDE tier (the data wins, mismatches noted). Either
way it flows through the very same pipeline: quantity = m³ ÷ unit volume,
refined vs compressed vs raw ISK/m³, seller netting, ISK/h and time-to-clear (which at your
fleet's yield is precisely *how long the chunk takes to chew*). The rocks column shows
`—` (it's a chunk forecast, not scanned rocks), the status names what was detected
("Auth extraction paste — expected chunk contents (3 ores, 25.2M m³ total)"), and a
paste holding several moons' extractions ranks them combined, the status saying so. An
Auth **"Moon details"** copy (percentages only) is detected and honestly declined —
percentages carry no quantities — with a pointer at the Extraction copy and at the
production-mode moons section. Ambiguous pastes pick the format that parses more data
rows, ties keeping the survey interpretation.

The table sorts by any column, the best rock on the sorted basis is highlighted, and a
totals row values the whole field on all three bases (plus a muted field-average ISK/h
per basis when the hourly view is on). Ice is
ranked only against other ice (unit-based harvesting), Mercoxit is flagged deep-core
(own crystals, own yield), and unpriced types show a flag — never a fake zero. A **sold
by** selector next to the ISK/h toggle picks whose **sales tax** nets the displayed
values: with a seller chosen, both value columns and everything derived from them (ISK/h,
field totals) are net of that character's `7.5% × (1 − 0.11 × Accounting)` tax — tax
only, no broker fee, since the loot valuation assumes instant-style disposal — and a
note says exactly which basis is showing ("⚡ net · tax 3.38% — X" / "gross · no seller",
the logged-out default). Netting is a uniform scale, so the ranking
order never changes — only the ISK becomes honest for a separate market alt. Toggle
**ISK/h** to enter your ship's yield (m³/h directly, or m³ per cycle + cycle seconds,
converted live) and the table adds ISK/h on both bases plus time-to-clear per ore and for
the whole field. Paste, toggles, yield inputs, the role characters and the chosen mode
persist; a **Sample scan** button ships a realistic mixed scan (ore variants, a moon
ore, Mercoxit, ice) to try it dry.

---

# Industry Helper (`industry.html`)

Answers one question across the whole market at once: *of everything I could manufacture,
what is worth building right now* — with home facilities in null, Jita as the trade hub,
and shipping both ways priced in.

## Static data pipeline

Blueprint recipes, type volumes, market groups and skills come from CCP's **Static Data
Export**. CI downloads the SDE at deploy time and runs
`tools/build-industry-data.mjs`, which condenses the ~500 MB YAML into
`data/industry.json` (~2 MB: every man/rea/inv/cop/me/te activity with materials,
products, probabilities and skills) plus `data/ores.json` (~80 KB: every ore/moon
ore/ice variant with exact reprocessing outputs, for the Mine tool). The files are
generated, not committed — for a local checkout, build them once from an extracted SDE:
`node tools/build-industry-data.mjs --sde <dir> --out data/industry.json`. The page's
status line shows the SDE version and blueprint count it loaded.

## Live data — one "Update ESI" button

All of it public ESI, all cached in **IndexedDB** (the order book is far too big for
localStorage), each dataset with its own age label:

- **The Forge order book** — the full regional book, `~350 paginated requests`
  (progress-barred, error-limit aware). It is condensed on arrival: per type, the sell
  levels at Jita 4-4 (ascending) and the buy levels whose range actually covers Jita
  (station / same-system / region — the same rule the Sell tool uses), capped at 40
  price levels per side. That's what "cost at sell / revenue at buy" are computed from.
- **Adjusted prices** (`/markets/prices/`) — the EIV basis for job fees.
- **Cost indices** (`/industry/systems/`) — per-system, per-activity; facilities show
  their system's indices and refresh with this dataset.
- **Owned blueprints** — for every logged-in character whose token carries
  `esi-characters.read_blueprints.v1`: all blueprints, merged to the best-researched
  BPO per type (a BPO always beats a BPC), with each character's own best copy kept so
  the profile's **manufacturer** wins merge ties. Characters missing the scope are named
  in an inline note — add the scope to the app and log in again. An owned BPO feeds its
  real ME/TE into the calculation and removes the invention path for that product.

## Profiles

Named manufacturing profiles (create / rename / duplicate / delete; stored per browser).
Each holds:

- **Facilities** (ordered — a job runs at the first facility offering its activity whose
  product scope covers the end product): player structures via the shared picker, or NPC
  stations (type the system name for its cost index). A structure facility is a **pure
  reference**: all it stores is *which* structure, which activities **this** profile routes
  there, the product scope, the ordering and its own cost-index override — the last one
  deliberately per profile, because it is an estimate rather than a fact about the
  building. Everything intrinsic to the structure — name, hull, system, security, installed
  **rigs**, the hull's **role bonuses** and the **owner-set facility tax** — is read from
  the one record in the [Structure Manager](#structure-manager-structureshtml) and shown
  here read-only: those chips carry a **from Structures** marker and a dashed outline, so a
  mirror is not mistaken for the NPC card's editable fields, and each has an *edit* link
  into the record (plus an *infer rigs…* link straight into the wizard, offered only where
  the catalog actually knows which rigs fit the hull). If a profile routes an activity the
  record says the structure cannot run, the card says so rather than computing on in
  silence. Two profiles can therefore never disagree about the same
  building, and an edit there re-renders the facility list and marks the computed table
  stale. A facility whose record was removed says so and refuses to compute rather than
  quietly using a structure with no hull, no rigs and no tax. NPC stations have no record,
  so they keep carrying their own system, tax and bonuses. Rigs come from the **real
  Standup catalog** (extracted from the SDE at build time): the manager lists exactly the
  rigs the hull accepts (M/L/XL-Set by structure size, up to its 3 rig slots), grouped by
  domain and showing the effective bonus at the structure's security band (engineering
  rigs HS ×1.0, LS ×1.9, NS/WH ×2.1; reactor rigs LS ×1.0, NS/WH ×1.1). A single L/XL
  *Manufacturing Efficiency* rig grants **both** ME and TE (e.g. XL T1 in null: 4.2% /
  42%); M-size structures use separate ME and TE rigs, exactly as in game. Each rig
  applies only to its real product scope (ship classes, equipment, ammo, drones,
  components, structures, reaction families) and its own activity (Thukker rigs keep their
  lowsec-only enhanced capital-component ME). Old profiles with the former generic T1/T2
  presets are migrated best-effort — unmappable rows are dropped with a one-time inline
  notice — and whatever survives is handed to the structure's record.
- **Market settings**: buy inputs instantly vs at buy order; sell output via sell order
  vs instant — and **three market roles**, each a dropdown of your logged-in characters
  (defaulting to whoever was active when the profile was created, persisted per profile;
  a logged-out pick falls back to a logged-in character with an inline warning):
  - **Buyer** — their broker % is added on top of input buy-order quotes;
  - **Seller** — their sales tax + sell-order broker hit the revenue side;
  - **Manufacturer** — their full skill list drives job times, invention, the
    "only if skilled" filter and the job-slot derivation, and their owned blueprints win
    merge ties.
  Fees auto-fill from each role's skills and standings at Jita 4-4 (same formulas as the
  Sell tool), with manual overrides when auto is off.
- **Shipping**: `reward = round-up-to-million(base + ISK/m³ × volume + collateral% ×
  value)` — all four parameters editable, per-direction toggles (defaults 10 M + 653.4
  ISK/m³ + 1% collateral). Cargo above **max haul m³** splits into multiple courier
  contracts, each paying the base and its own round-up.
- **Assumptions**: ME/TE for unowned BPOs (10/20), decryptor policy (auto-cheapest /
  none / a specific one), SCC surcharge %.
- **Planning**: available **capital** (blank = unlimited — caps how much working ISK a
  batch may tie up), **job slots** for manufacturing / science / reactions (auto-derived
  from the manufacturer's skills — 1 + Mass Production + Advanced Mass Production and
  friends — shown and editable), **demand cap %** and **max haul m³**.

## Batch planning & depth-aware pricing

Everything is priced at **batch scale**, not one lonely run. The engine plans
`R runs/job × J parallel jobs` per product: R from the invented BPC's run count (T2) or
`min(blueprint run limit, ~24 h of job time)` (owned BPO / T1), J from the activity's
job slots — then scales the plan down to respect the **demand cap** (daily output ≤
demand/day × cap%) and your **capital** (depth-walked input cost + job fees + inbound
hauls must fit). Input costs **walk the condensed Jita book level by level** for the
real batch quantity; instant selling walks the buy book respecting min-volume. A book
shallower than the batch prices the remainder at the worst listed level and flags the
row/node with ⚠ ("book depth filled/needed") instead of poisoning the number.

**ISK/h and Profit/Day are steady-state pipeline numbers**: profit/unit × the slowest
stage rate among manufacturing/reaction, copying and invention (science slots pooled
proportionally between copying and invention; parallel T1 BPO jobs are fed by copies).
The bottleneck stage — including `demand` or `capital` when those bind — is shown in the
drilldown's **batch panel** along with R×J, units, cycle time, capital used and the
haul counts with per-haul cost.

The full-market scan plans with demand unknown (ranking can't wait for thousands of
history fetches); once a visible row's history arrives, its batch is **re-planned
against real demand** and marked with a subtle ↺.

## The table & drilldown

One button computes **every manufacturable product with a market group** (~4 300)
through the shared calc engine (`industry-engine.js`) in background chunks with progress
and cancel; profile/data changes flag the results *stale* instead of silently recomputing.
Sortable, filterable columns (name search, category and meta chips, numeric minimums,
owned-BP / skilled / priced toggles — filter state persists): cost, revenue, profit,
margin, ROI, pipeline ISK/h, **Batch (R×J)**, **Profit/Day**, **Capital Used**, shipping,
sales tax, m³, ISK/m³, blueprint situation (owned research / invent / buy BPO) and
build-vs-buy node counts. Thin-book rows keep their ⚠ marker even with "hide unpriced"
on. **Demand/Day and D.O.S.** (days of stock = Jita sell depth ÷ demand) fetch region
history lazily — only for rows actually scrolled into view, cached a day. Clicking a row
opens the **drilldown**: the batch panel, the full build-vs-buy tree with both costs at
every node, the chosen facility, job time, the fee breakdown (system cost index gross,
structure/rig bonus, SCC, facility tax), the material-modifier breakdown, per-node book
depth flags, an invention subpanel with the per-decryptor comparison, per-node
**force buy/build** toggles (persisted in the profile, recomputing just that product),
and TSV export of the tree or the whole table.

## Honest simplifications (v1)

- The batch prices as **one aggregate job** of R×J runs: job fees are linear so they match
  exactly, but per-job material ceilings can differ by up to J−1 units per material.
- Intermediate build nodes don't consume top-level job slots — only the final product's
  stages bound throughput; sub-node fees/times still scale with batch quantity. Reaction
  formulas are assumed available for every parallel job.
- Buy-order inputs pay the buyer's broker on the scalar top quote — no depth walk on the
  buy side of inputs; invention consumables also stay at the scalar top quote. Each
  material buy order and the batch's own sell order pay at least the game's flat 100 ISK
  per-order broker minimum, which only bites on cheap materials and tiny batches.
- Shipping hauls split cargo and collateral evenly across contracts.
- Invention consumables are amortized into cost but not added to the inbound haul.
- Demand/history is regional (The Forge), both order sides combined.
- Facility product scopes and owned-BP ME/TE apply per end product; intermediates use the
  unowned-BPO defaults. Owned T2 BPCs are displayed but priced via invention.
- Structure ROLE bonus presets (ME 1% / TE 15-30% / cost) are hardcoded per hull — verify
  in game and correct them on the structure's record if needed (every profile then follows).
  Rig bonuses are real SDE dogma values, applied to each rig's real product scope and
  activity.

# Structure Manager (`structures.html`)

Every tool needs the same handful of facts about a player structure, and none of them are
in ESI. They used to be smeared across three tools — the Sell page kept a broker rate per
structure id, the Mine page kept a refinery snapshot with its rig, and every Industry
profile kept its own copy of the same structure's hull, rigs, tax and role bonuses. Now
there is **one record per structure**, edited in one place; the tools *select* a structure
and read its facts. One write-through is sanctioned, and it is the only one: the **Sell
page's broker box**, because that rate is read off the in-game market window while you are
selling — typing it there records it on the structure. Mine's rig and Industry's tax, rigs
and role bonuses are read-only mirrors with an *edit* link into the record.

| Lives on the record (about the STRUCTURE) | Stays in the tool (about YOU) |
| --- | --- |
| identity: name, hull type, system, security, region, rig size/slots (auto-detected) | which market/facility a page currently points at |
| owner-set **market broker %** | the NPC-hub broker rate from your skills and standings |
| owner-set **facility tax %** | per-profile cost-index override (an estimate, not a fact) |
| installed **Standup rigs** (catalog type ids) | which activities a profile routes here, product scopes |
| **reprocessing rig** tier | your reprocessing implant |
| the hull's **role bonuses** (preset until corrected) | profile-level ordering and preferences |
| **industry activities** the structure can run | which of them a given profile actually uses |
| free-text **notes**, migration conflict notes | — |

## The manager

The saved list is one card per structure: name, system, security band, hull and rig size,
plus tags summarizing what is recorded (broker, tax, rigs, repro rig, activities, open
conflicts). Clicking a card opens its editor:

- **Identity** is read-only — it comes from ESI — with a **re-resolve** button that
  re-reads it (bypassing the identity cache).
- **Owner-set rates**: market broker % and facility tax %. Blank means *not known*, and
  the tools fall back to their own defaults rather than to an invented 0%.
- **Rigs**: one dropdown per fitted rig, listing exactly the catalog rigs the hull accepts
  (size + fitting group), grouped by domain, each showing its **security-adjusted**
  effective %s. `+ rig` offers the first rig that is not already fitted and stops at the
  hull's rig slot count. A separate selector holds the **reprocessing rig** tier the Mine
  tool's refine yield uses (the Standup reprocessing rigs are not part of the industry
  catalog, so they are a tier rather than a type id).
- **Industry activities**: what the structure is *capable* of, defaulted from the hull
  kind (engineering complexes manufacture/invent/copy/research, refineries react, citadels
  neither) and overridable, with a reset to the default. It seeds what a newly added
  Industry facility routes here **and** is checked against every existing one: a profile
  routing an activity this record says the structure cannot run is flagged on its facility
  card, with a link back here.
- **Structure role bonuses**: the hull's own ME / TE / job-cost bonuses, pre-filled from
  the per-hull preset (Raitaru/Azbel/Sotiyo/Athanor/Tatara — *verify in game*). Correcting
  one records an override on that structure; *reset to hull preset* clears it again. Every
  Industry profile routing work here computes with these.
- **Notes**, and a **used by** line naming the tools and profiles currently pointing at
  the structure. Removing a structure asks for confirmation, names exactly that, and is
  honest about the cost — naming the fallback each tool really performs: **Sell reverts to
  Jita**, **Mine to the NPC station**, while an Industry facility routing work there
  **stops computing** until the structure is added back (the pre-refactor facts a profile
  still carries from before the import are kept for exactly that case, and go back onto
  the record when it returns).

A record whose ESI identity is incomplete — no system, no security, because the blob it
was built from never carried them — is flagged on the card and on any Industry facility
using it: a missing system makes the job cost index count as **0** and a missing security
bands the structure as **highsec** (which makes reactor rigs inert). *Re-resolve* fixes it.

A deep link to a record that is not in the list any more (a tool still pointing at a
removed structure) says so at the top of the page instead of doing nothing, and the
Industry facility card offers to **add this structure back** rather than to "edit" a
record that is not there.

Everything saves the moment it changes. `structures.html#s<id>` opens straight to one
record — that is what the *manage* links on the Sell, Mine and Industry pages use — and
`structures.html#s<id>/rigs` opens it with the rig-inference wizard already running, which
is the Industry page's *infer rigs…* link.

## Inferring rigs you can't see

ESI never exposes a structure's fitting, and most industrialists are not the owner — but
the in-game industry window shows anyone who can use the facility the bonused material
quantities and the job duration. The **"infer rigs…" wizard** (it used to live on the
Industry page; it now edits the central record) picks a probe blueprint per rig domain —
blueprints the Industry tool knows you own come first, since their ME/TE are known, with
an unresearched-BPC toggle otherwise — tells you what to look up in game, then strips
blueprint ME/TE, the structure's role bonuses **as the record has them** (a hand-corrected
set, not the hull preset — the same numbers the Industry engine computes with, or the
residual would carry the difference and match the wrong rig) and the chosen character's
Industry / Advanced Industry / Reactions skills from the numbers you enter. The residual is matched against
the rig catalog for that hull size and security band using the exact in-game rounding
(quantities are rounded to 2 decimals then ceiled, so each shown integer pins an ME
interval — a second material or the job time disambiguates T1 vs T2). Verdicts are exact /
ambiguous (pick one) / no rig / conflict, ME and TE tiers are cross-checked (one
Efficiency rig carries both), and one click writes the detected rigs onto the record,
merging with rigs inferred for other domains. Everything runs client-side on data already
loaded; nothing is stored until that click.

## Storage, schema and the one-time import

The store is `localStorage["eveHelper.structures.v1"]`, bumped to **schema v2**:
`{ v: 2, structures: [record, …] }`. A v1 store (a bare array of identities) is read,
normalized — every managed fact gets its default — and rewritten in the v2 shape on first
load. `structures.js` exposes the record API (`get`, `facts`, `update`, `addConflict`,
`dismissConflict`, `refresh`, `roleBonuses`, `defaultActivities`) next to
`pick` / `info` / `saved` / `remember` / `remove` — `pick({title, list})` is now a pure
**selector** (it lists the saved structures and links to the manager — including when the
list is empty, which is exactly when that link matters most; it no longer removes
anything) — plus **`subscribe(fn)`**: it fires on
every mutation made through the API on this page *and* on a `storage` event from another
tab, which is how an edit in the manager re-prices an open Mine or Industry tab live.

Rig size and slot count come from `data/industry.json`'s structure map; the pages that
load that file (Industry, the manager) hand it to the store with `useTypeMap()`, which
caches a compact copy so the Sell and Mine pages get sizes without fetching 2 MB.

On any page, `structures.js` imports the old per-tool copies **once** (a marker key makes
it idempotent, so later hand edits are never clobbered) and logs a summary to the console.
The passes run Mine → Industry → Sell, because the first two carry the structure's identity
and the Sell one carries none; each pass is guarded on its own and **writes the marker as
soon as it finishes**, so a pass that throws (a hand-edited profile blob, a full origin)
never makes the passes that already succeeded run a second time over your edits.

- Mine's facility snapshot rig → `reproRig`. The rig was a *page*-level field there, so it
  survived switching the facility back to "NPC station": the structure it belongs to is
  taken from the retained snapshot when the selection is not one, and not from the
  selection alone (which would drop the rig, and a few percent of yield, for anyone not
  sitting on their refinery). The refinery itself gets a record either way —
  built from the snapshot when it was never in the saved list, and created even when no rig
  was ever recorded, so the Mine page's *"configure it in the structure manager"* note
  always has a record to point at;
- every Industry profile's per-facility rigs and tax → `rigs` / `facilityTax`. A legacy
  `tax: 0` is **not** imported: 0 was the value a structure facility was created with, i.e.
  the "never entered" placeholder, so importing it would both defeat the record's own
  *"— (not recorded)"* prompt and let a placeholder overwrite a real rate;
- every Industry profile's hand-corrected role bonuses → `roleBonus` (bonuses left at the
  hull preset carry no information and are not imported), after which the facility keeps
  only its reference to the structure and its own routing;
- Sell's `structBroker` map → `marketBroker` (a blank entry is *not known*, never 0%), and
  **only onto a structure that still has a record**. The old Sell page rewrote that map on
  every market switch and nothing ever pruned it, so it also names structures that were
  merely selected once or deliberately deleted since; importing those would resurrect them
  in every picker and dropdown.

A record another pass created from a thinner source keeps its facts but takes the identity a
later pass can supply — the Sell pass has none of its own, and the ESI identity cache it
would fall back to is wiped by the topbar's *↻ refresh ESI data*, so whichever pass runs
first must not pin a nameless record forever.

When two profiles disagree about the same structure, the **most recently saved** wins —
read as: the active profile last, the rest in store order — and a **conflict note** naming
both profiles and what was kept is stored on the record (identical notes are never stored
twice). The manager shows it on the card with a **dismiss** button. Nothing is ever dropped
silently. The Industry page applies the same rule when it hands legacy `{preset}` rig rows
over, and it never deletes a profile's copy of a structure's facts unless a record is there
to take them — nor a `{preset}` row the rig catalog was not loaded to map, which would
otherwise be lost for good on one failed `data/industry.json` fetch.

---

# Tests

```sh
cd tests && npm install && npm test
```

Plain Node scripts — no framework — driving the real pages in a headless browser with every
ESI/SSO call intercepted; each prints one `PASS`/`FAIL` line per check. See
[`tests/README.md`](tests/README.md) for the per-suite breakdown and the house rules (chief
among them: **never wait on time, wait on a signal**).

`density.test.js` is the copy ratchet: it opens every page and asserts the rules this
README's *On-screen text is terse by design* section describes — `?` disclosures closed,
no prose connectives in always-visible copy, table cells under 24 characters, chips under
12 **and carrying the tooltip that holds what the chip replaced**.

Three suites cover the structure centralisation from different angles, and all three have to
stay green for it to count as working:

| Suite | Angle |
| --- | --- |
| `structures.test.js` | the store and the manager with all three legacy sources present at once |
| `structures-manager.test.js` | each legacy source **on its own**, adding/editing/removing a record, re-resolving its identity, the rig wizard through its own UI, and the Sell / Mine / Industry pages reading the record |
| `equivalence.test.js` | the **pre-migration builds checked out of git** and run side by side with the current one on the same legacy storage, comparing every computed number exactly |
