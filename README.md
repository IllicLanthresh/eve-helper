# EVE Helper

A collection of single-file, locally-run EVE Online tools with a shared top bar. No install,
no server, no ESI login — live data comes from ESI's public endpoints and nothing else ever
leaves your machine. Open any page in a browser or use the GitHub Pages deployment.

| Tool | Page | What it does |
| --- | --- | --- |
| **Sell** | `index.html` | Turns a hangar full of loot into ready-to-paste sell lists for any trade hub — valued against the real order book, ranked by net profit after fees, best plan per item (instant / order / split). |
| **Mine** | `mine.html` | Paste the materials you need for production → what to mine (rocks, moon ores, sov array deposits), how many m³ after refine losses, and which of your alliance moons cover it (accepts in-game survey scans and Alliance Auth moon/extraction pastes). Live Jita prices. |
| **Industry** | `industry.html` | Full-market build-vs-buy scan: every blueprint product (T1, T2 invention, reactions, capitals) priced against the live Jita book with your facilities, rigs, skills, owned blueprints and shipping — ranked by profit, ROI, ISK/h, with a per-item cost drilldown. |

## EVE login (optional)

"Log in with EVE" in the top bar pulls your skill levels and standings to auto-fill what
you'd otherwise type by hand: **Accounting → sales tax**, **Broker Relations + standings →
broker fee** (Sell tool), **Reprocessing / Reprocessing Efficiency + the ore-group
processing skills → per-ore refine yields** (Mine tool; the flat refine % input is only
the logged-out fallback). The Mine tool's refining facility is either the NPC-station
default (flat 50% base — stations have no rigs, so no rig or security bonuses apply) or a
player structure found through the shared **structure picker**: its type (Athanor 52% /
Tatara 55% / anything else 50%) and its system's security band are **auto-detected**,
while the reprocessing **rig and implant stay manual** — ESI exposes neither structure
fittings nor clone implants. An **imported-skills panel** under the facility row lists
every reprocessing skill that was pulled, what it governs, and the resulting yield % at
the current facility. Everything stays client-side: it's the OAuth2 **PKCE** flow, so
there is no server, no database, and no secret — tokens live in your browser's
localStorage only.

**Multiple characters**: log more in with the **+ alt** link in the top bar (the SSO page
lets you pick a different character). A selector — in the top bar, and next to the values
it drives ("fees from" on Sell, "skills from" on Mine) — chooses the **active** character,
whose skills and standings both tools use; **log out** removes the active one. Handy when
one alt trades and another one mines.

**Broker fee with standings** (Sell tool): at an NPC station the broker fee is
`3% − 0.3%×Broker Relations − 0.03%×faction − 0.02%×corp` effective standing toward the
hub station's owner corporation and its faction (station owners come from public ESI and
are cached). Effective standing = `base + (10 − base) × 4% × skill`, where the skill is
**Connections** for positive base standings and **Diplomacy** for negative ones. The note
under the fee inputs shows exactly which character and standings produced the numbers.

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
so the login itself keeps working. Characters logged in before the standings feature carry
tokens without the standings scope — the Sell tool then computes with standings 0 and asks
you to log in again (the "+ alt" / login flow re-grants the character with both scopes);
if the standings scope itself is gone from the SSO, the tool says so instead and the
broker fee stays hand-editable.

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
   - **ORDER** — listing at `L` nets more: `L × (1 − tax − broker)` per unit.
   - **SPLIT** — the best of both: when you import at `L`, the game automatically fills any
     buy orders priced ≥ `L` first (at *their* price, no broker fee) and lists the rest at
     `L`. SPLIT means that instant part is non-empty — no manual stack splitting needed.
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
structures are listed in the same modal with a remove **×** each (the **manage
structures** link next to the selector opens it too; removing the currently selected
structure falls back to Jita), and the saved list is **shared with the Mine tool**. This
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
from the in-game sell window and type it into the broker % field — it is remembered per
structure and switching back to an NPC hub restores the skills/standings-derived rate.
Sales tax (Accounting) applies everywhere and keeps auto-filling.

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
  resting buy order's price and pay only sales tax; the listed remainder pays broker + tax.
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

# Industry Helper (`industry.html`)

Answers one question across the whole market at once: *of everything I could manufacture,
what is worth building right now* — with home facilities in null, Jita as the trade hub,
and shipping both ways priced in.

## Static data pipeline

Blueprint recipes, type volumes, market groups and skills come from CCP's **Static Data
Export**. CI downloads the SDE at deploy time and runs
`tools/build-industry-data.mjs`, which condenses the ~500 MB YAML into one
`data/industry.json` blob (~2 MB: every man/rea/inv/cop/me/te activity with materials,
products, probabilities and skills). The file is generated, not committed — for a local
checkout, build it once from an extracted SDE:
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
  BPO per type (a BPO always beats a BPC). Characters missing the scope are named in an
  inline note — add the scope to the app and log in again. An owned BPO feeds its real
  ME/TE into the calculation and removes the invention path for that product.

## Profiles

Named manufacturing profiles (create / rename / duplicate / delete; stored per browser).
Each holds:

- **Facilities** (ordered — a job runs at the first facility offering its activity whose
  product scope covers the end product): player structures via the shared picker (system,
  security and structure type auto-detected; Raitaru/Azbel/Sotiyo/Athanor/Tatara role
  bonuses pre-filled as editable presets marked *verify in game*) or NPC stations (type
  the system name for its cost index). Per facility: activity checkboxes, owner-set
  facility tax, optional cost-index override, and **rigs** as T1/T2 × ME/TE/Cost presets
  with the security-band multiplier applied automatically (HS ×1.0, LS ×1.9, NS/WH ×2.1)
  plus an optional market-group scope per rig.
- **Market settings**: buy inputs instantly vs at buy order; sell output via sell order
  vs instant; broker + sales tax auto-filled from the active character's skills and
  standings at Jita 4-4 (same formulas as the Sell tool) with a manual override.
- **Shipping**: `reward = round-up-to-million(base + ISK/m³ × volume + collateral% ×
  value)` — all four parameters editable, per-direction toggles (defaults 10 M + 653.4
  ISK/m³ + 1% collateral).
- **Assumptions**: ME/TE for unowned BPOs (10/20), decryptor policy (auto-cheapest /
  none / a specific one), SCC surcharge %.

## The table & drilldown

One button computes **every manufacturable product with a market group** (~4 300)
through the shared calc engine (`industry-engine.js`) in background chunks with progress
and cancel; profile/data changes flag the results *stale* instead of silently recomputing.
Sortable, filterable columns (name search, category and meta chips, numeric minimums,
owned-BP / skilled / priced toggles — filter state persists): cost, revenue, profit,
margin, ROI, ISK/h, shipping, sales tax, m³, ISK/m³, blueprint situation (owned research
/ invent / buy BPO) and build-vs-buy node counts. **Demand/Day and D.O.S.** (days of
stock = Jita sell depth ÷ demand) fetch region history lazily — only for rows actually
scrolled into view, cached a day. Clicking a row opens the **drilldown**: the full
build-vs-buy tree with both costs at every node, the chosen facility, job time, the fee
breakdown (system cost index gross, structure/rig bonus, SCC, facility tax), the
material-modifier breakdown, an invention subpanel with the per-decryptor comparison,
per-node **force buy/build** toggles (persisted in the profile, recomputing just that
product), and TSV export of the tree or the whole table.

## Honest simplifications (v1)

- Input-side broker fees (when placing buy orders) are not modelled.
- ISK/h divides profit by the **sum** of build-job times — no parallel slots, no critical
  path; invention/copy times excluded.
- Invention consumables are amortized into cost but not added to the inbound haul.
- Demand/history is regional (The Forge), both order sides combined.
- Facility product scopes and owned-BP ME/TE apply per end product; intermediates use the
  unowned-BPO defaults. Owned T2 BPCs are displayed but priced via invention.
- Everything is priced at 1 run; structure role/rig bonus presets are hardcoded — verify
  in game and override per facility if needed.
