# EVE Helper

A collection of single-file, locally-run EVE Online tools with a shared top bar. No install,
no server, no ESI login — live data comes from ESI's public endpoints and nothing else ever
leaves your machine. Open any page in a browser or use the GitHub Pages deployment.

| Tool | Page | What it does |
| --- | --- | --- |
| **Sell** | `index.html` | Turns a hangar full of loot into ready-to-paste sell lists for any trade hub — valued against the real order book, ranked by net profit after fees, best plan per item (instant / order / split). |
| **Mine** | `mine.html` | Two modes over one page. **Plan production**: paste the materials you need → what to mine (rocks, moon ores, sov array deposits), how many m³ after refine losses, and which of your alliance moons cover it (accepts in-game survey scans and Alliance Auth moon/extraction pastes). **Profit mode**: paste a survey scan at the belt — or an Alliance Auth extraction copy, to plan a moon pop ahead — and rank the contents by refined vs compressed ISK/m³. Live Jita prices. |
| **Industry** | `industry.html` | Full-market build-vs-buy scan: every blueprint product (T1, T2 invention, reactions, capitals) priced against the live Jita book with your facilities, rigs, skills, owned blueprints and shipping — ranked by profit, ROI, ISK/h, with a per-item cost drilldown. |
| **Structures** | `structures.html` | The one place player structures are managed: one record per structure with its identity (auto-detected) plus the facts ESI never publishes — owner-set market broker %, facility job tax, installed Standup rigs (with the rig-inference wizard), reprocessing rig, industry activities and notes. Every other tool just *selects* a structure. |

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
page, because it is the pilot's, not the structure's. An **imported-skills panel** under the facility row lists
every reprocessing skill that was pulled, what it governs, and the resulting yield % at
the current facility. Everything stays client-side: it's the OAuth2 **PKCE** flow, so
there is no server, no database, and no secret — tokens live in your browser's
localStorage only.

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
**Connections** and **Diplomacy**, which only lift the agent/mission side. The formula is
verified against the live client at Jita 4-4: Broker Relations 5 with ~zero standings
gives 1.5%. On top of the percentage every order pays a flat **minimum broker fee of
100 ISK per order**, so a cheap stack pays an effective rate well above the nominal one
(100 ISK on a 4,500 ISK order is 2.2%); rows where that floor binds are flagged, and the
plan chooser prices it in, since it can flip a small stack from ORDER to INSTANT. Sales
tax is `7.5% × (1 − 11%×Accounting)` — that 7.5 base is **not yet verified** against the
live client.

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
   `esi-search.search_structures.v1` (player structure markets) and
   `esi-characters.read_blueprints.v1` (owned blueprints for the Industry tool);
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

## Workflow

1. **Paste your inventory** (select items in a hangar/container → Ctrl-C).
2. **Pick a market**: Jita 4-4, Amarr, Dodixie, Rens, Hek — or a saved player structure
   (see *Player structure markets* below).
3. **Fetch prices (ESI)** — pulls the live order book per item (optionally plus ~13 months
   of daily price history) for the chosen hub.
4. Check your **broker fee** and **sales tax** (defaults 2.1% / 7.5%) and choose how ORDER
   items get their list price `L`:
   - **current best sell** (optionally one tick under), or
   - **history statistic** — median / average / 10th / 90th percentile of the region's
     daily average price over the last N days. N and the statistic apply instantly, no refetch.
5. Every item is valued against the actual buy book and gets a plan:
   - **INSTANT** — dumping the stack into the buy book right now nets the most. Depth-aware:
     the walk respects each order's remaining volume and `min_volume` (margin-scam bait is
     ignored), so one 1-unit buy order at a silly price no longer values your whole stack.
   - **ORDER** — listing at `L` nets more: `qty × L × (1 − tax)` less the broker fee on
     that one order, `max(100 ISK, broker% × qty × L)`.
   - **SPLIT** — the best of both: when you import at `L`, the game automatically fills any
     buy orders priced ≥ `L` first (at *their* price, no broker fee) and lists the rest at
     `L`. SPLIT means that instant part is non-empty — no manual stack splitting needed.
   The split point is chosen by comparing the actual net of every cut of the buy book, so
   the 100 ISK per-order minimum is priced in: on a cheap stack it can tip the plan to
   INSTANT, and rows where it binds carry a `min fee 100 ISK → x.x%` flag.
6. **Filter and sort**: click headers to sort (▲/▼ indicator), search by name, filter by
   plan type. Filters are a viewing aid only — ticked rows hidden by a filter stay in the
   import list (the toolbar says so). Selection buttons (top N / all / none) act on the
   filtered rows and tick only ORDER/SPLIT items.
7. **Export — two artifacts**:
   - **Import list (orders & splits)**: every ticked row as `Item name ⇥ Price` for the
     game's multi-sell import. The tick column is labelled *Import* and only ORDER/SPLIT
     rows have a checkbox — INSTANT rows show ⚡ instead, since there is nothing to import.
   - **Instant checklist**: the INSTANT items as `Item name ⇥ Qty` (plus the instant legs
     of ticked SPLITs as partial stacks) — sell these directly in the hangar.
8. **Copy full table (TSV)** pastes the whole analysis into Excel / Google Sheets.

## Player structure markets

Sell where your alliance actually trades: the market selector's **+ add structure…**
option opens the structure picker — a modal with live search that runs **as your
logged-in character** (so it only finds structures that character has access to). Results
show name, system and structure type; pick with the mouse or ↑/↓ + Enter. Saved
structures are listed in the same modal with a remove **×** each (removing the currently
selected structure falls back to Jita); the **manage structures** link next to the selector
opens the [Structure Manager](#structure-manager-structureshtml) on that structure's record.
The saved list is **shared with every tool**. This
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

The **owner-set broker fee is not in ESI** (there is no endpoint for it): read it once
from the in-game sell window and type it into the broker % field — typing it here writes it
onto the **structure's central record** (it can equally be entered on the Structures page,
and a change there reaches an open Sell tab immediately), and switching back to an NPC hub
restores the skills/standings-derived rate. Sales tax (Accounting) applies everywhere and
keeps auto-filling.

## Flags

| Flag | Meaning |
| --- | --- |
| `suspect price` | Top buy above best sell — a thin or broken market. Check in game. |
| `sell ≫ / ≪ history` | Current best sell is far (±50%) from the chosen history statistic. |
| `depth x/y` | The buy book can only absorb x of your y units at any price. |
| `no history — using current sell` / `no sell orders — using history price` | The chosen list-price source wasn't available for this item; the other one was used. |
| `unsellable?` | Ice Storm / Expired filaments the market refuses. Auto-excluded from the export (re-tickable). |

Items with no orders and no history at the hub are listed separately and never pollute the ranking.

## Details & assumptions

- Instant valuation walks buy orders top-down, taking `volume_remain` per level and skipping
  orders whose `min_volume` can't be met — units the book can't absorb are valued at zero
  (and flagged).
- The ORDER/SPLIT plan models the real import mechanics: fills above `L` execute at the
  resting buy order's price and pay only sales tax; the listed remainder pays broker + tax,
  the broker never less than the flat 100 ISK per-order minimum.
  Order fills are not guaranteed, and relist fees from later repricing are not modelled.
- Price history is per **region** (ESI has no station-level history), using each day's
  average price.
- ESI usage: `POST /universe/ids`, `GET /markets/{region}/orders?type_id=…` (paginated,
  filtered to the hub station; buy orders count if their range covers it), and optionally
  `GET /markets/{region}/history?type_id=…`. Error-limit headers are honoured, transient
  errors retried; failed items are listed as unpriced.
- Prices respect EVE's 4-significant-digit rule; the one-tick undercut steps into the finer
  band below round numbers (1 000 000 → 999 900).
- Number parsing accepts both `1.234.567,89` (EVE client, EU locale) and `1234567.89`
  formats; the export decimal separator is switchable.
- Inputs, fees, market, pricing options, and row selections persist in `localStorage`.

## Development

Plain HTML/CSS/JS in one file — no build step. `Load sample data` fills the input with a
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
note says exactly which basis is showing ("net of X's 3.38% sales tax" / "gross — no
seller selected", the logged-out default). Netting is a uniform scale, so the ranking
order never changes — only the ISK becomes honest for a separate market alt. Toggle
**ISK/h** to enter your ship's yield (m³/h directly, or m³ per cycle + cycle seconds,
converted live) and the table adds ISK/h on both bases plus time-to-clear per ore and for
the whole field. Paste, toggles, yield inputs, the role characters and the chosen mode
persist; a **Load sample scan** button ships a realistic mixed scan (ore variants, a moon
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

## Live data — one "Update ESI data" button

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
  product scope covers the end product): player structures via the shared picker (system,
  security and structure type auto-detected; Raitaru/Azbel/Sotiyo/Athanor/Tatara role
  bonuses pre-filled as editable presets marked *verify in game*) or NPC stations (type
  the system name for its cost index). Per facility this profile keeps its **preferences**:
  activity checkboxes, product scope, optional cost-index override and the role-bonus
  overrides. What belongs to the *structure* — its **rigs** and the **owner-set facility
  tax** — lives on the structure's record instead and is shown here read-only with a link
  into the [Structure Manager](#structure-manager-structureshtml); every profile pointing
  at the same structure therefore computes with the same fitting, and an edit there
  re-renders the facility list and marks the table stale. Rigs come from the **real
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
- Structure ROLE bonus presets (ME 1% / TE 15-30% / cost) are hardcoded — verify in game
  and override per facility if needed. Rig bonuses are real SDE dogma values, applied to
  each rig's real product scope and activity.

# Structure Manager (`structures.html`)

Every tool needs the same handful of facts about a player structure, and none of them are
in ESI. They used to be smeared across three tools — the Sell page kept a broker rate per
structure id, the Mine page kept a refinery snapshot with its rig, and every Industry
profile kept its own copy of the same structure's rigs and tax. Now there is **one record
per structure**, edited in one place; the tools only *select* a structure.

| Lives on the record (about the STRUCTURE) | Stays in the tool (about YOU) |
| --- | --- |
| identity: name, hull type, system, security, region, rig size/slots (auto-detected) | which market/facility a page currently points at |
| owner-set **market broker %** | the NPC-hub broker rate from your skills and standings |
| owner-set **facility tax %** | per-profile cost-index override, role-bonus overrides |
| installed **Standup rigs** (catalog type ids) | which activities a profile routes here, product scopes |
| **reprocessing rig** tier | your reprocessing implant |
| **industry activities** the structure can run | profile-level ordering and preferences |
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
  neither) and overridable, with a reset to the default.
- **Notes**, and a **used by** line naming the tools and profiles currently pointing at
  the structure. Removing a structure asks for confirmation and names exactly that.

Everything saves the moment it changes. `structures.html#s<id>` opens straight to one
record — that is what the *manage* links on the Sell, Mine and Industry pages use.

## Inferring rigs you can't see

ESI never exposes a structure's fitting, and most industrialists are not the owner — but
the in-game industry window shows anyone who can use the facility the bonused material
quantities and the job duration. The **"infer rigs…" wizard** (it used to live on the
Industry page; it now edits the central record) picks a probe blueprint per rig domain —
blueprints the Industry tool knows you own come first, since their ME/TE are known, with
an unresearched-BPC toggle otherwise — tells you what to look up in game, then strips
blueprint ME/TE, the hull's role bonuses and the chosen character's Industry / Advanced
Industry / Reactions skills from the numbers you enter. The residual is matched against
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
`dismissConflict`, `refresh`, `roleBonuses`, `defaultActivities`) next to the unchanged
`pick` / `info` / `saved` / `remember` / `remove`, plus **`subscribe(fn)`**: it fires on
every mutation made through the API on this page *and* on a `storage` event from another
tab, which is how an edit in the manager re-prices an open Mine or Industry tab live.

Rig size and slot count come from `data/industry.json`'s structure map; the pages that
load that file (Industry, the manager) hand it to the store with `useTypeMap()`, which
caches a compact copy so the Sell and Mine pages get sizes without fetching 2 MB.

On any page, `structures.js` imports the old per-tool copies **once** (a marker key makes
it idempotent, so later hand edits are never clobbered) and logs a summary to the console:

- Sell's `structBroker` map → `marketBroker`;
- Mine's facility snapshot rig → `reproRig` (the structure is created from the snapshot if
  it was never in the saved list);
- every Industry profile's per-facility rigs and tax → `rigs` / `facilityTax`.

When two profiles disagree about the same structure, the **most recently saved** wins —
read as: the active profile last, the rest in store order — and a **conflict note** naming
both profiles and what was kept is stored on the record. The manager shows it on the card
with a **dismiss** button. Nothing is ever dropped silently.
