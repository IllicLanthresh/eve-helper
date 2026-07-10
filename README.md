# EVE Helper

A collection of single-file, locally-run EVE Online tools with a shared top bar. No install,
no server, no ESI login — live data comes from ESI's public endpoints and nothing else ever
leaves your machine. Open any page in a browser or use the GitHub Pages deployment.

| Tool | Page | What it does |
| --- | --- | --- |
| **Sell** | `index.html` | Turns a hangar full of loot into ready-to-paste sell lists for any trade hub — valued against the real order book, ranked by net profit after fees, best plan per item (instant / order / split). |
| **Mine** | `mine.html` | Paste the materials you need for production → what to mine (rocks, moon ores, sov array deposits), how many m³ after refine losses, and which of your alliance moons cover it (accepts in-game survey scans and Alliance Auth moon/extraction pastes). Live Jita prices. |

## EVE login (optional)

"Log in with EVE" in the top bar pulls your skill levels to auto-fill what you'd otherwise
type by hand: **Accounting → sales tax**, **Broker Relations → broker fee** (Sell tool),
**Reprocessing / Reprocessing Efficiency → refine %** (Mine tool; ore-specific skill assumed
IV, NPC-station base — edit for structures). Everything stays client-side: it's the OAuth2
**PKCE** flow, so there is no server, no database, and no secret — tokens live in your
browser's localStorage only.

One-time setup (needed because EVE SSO requires a registered app):
1. Go to <https://developers.eveonline.com> → *Create new application*.
2. Connection type: **Authentication & API Access**; scope: `esi-skills.read_skills.v1`.
3. Callback URL — exactly your deployed index page, e.g.
   `https://illiclanthresh.github.io/eve-helper/index.html`.
4. Click *Log in with EVE* in the tool and paste the app's **Client ID** when prompted
   (stored locally; the secret key is never used).

---

# Sell Helper (`index.html`)

## Workflow

1. **Paste your inventory** (select items in a hangar/container → Ctrl-C).
2. **Pick a market**: Jita 4-4, Amarr, Dodixie, Rens, or Hek.
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
