# EVE Helper

A collection of single-file, locally-run EVE Online tools with a shared top bar. No install,
no server, no ESI login — live data comes from ESI's public endpoints and nothing else ever
leaves your machine. Open any page in a browser or use the GitHub Pages deployment.

| Tool | Page | What it does |
| --- | --- | --- |
| **Sell** | `index.html` | Turns a hangar full of loot into ready-to-paste sell lists for any trade hub — valued against the real order book, ranked by net profit after fees, best plan per item (instant / order / split). |
| **Mine** | `mine.html` | Paste the materials you need for production → what to mine (rocks, moon ores, sov array deposits), how many m³ after refine losses, and which of your alliance moons cover it (accepts in-game survey scans and Alliance Auth moon/extraction pastes). Live Jita prices. |

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
   `esi-markets.structure_markets.v1`, `esi-universe.read_structures.v1` and
   `esi-search.search_structures.v1` (player structure markets); callback URL —
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
