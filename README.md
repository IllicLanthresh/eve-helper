# EVE Jita Sell Helper

A single-file, locally-run webapp that turns a hangar full of loot into a ready-to-paste
sell list for Jita 4-4 — ranked by expected profit, with instant-sale vs sell-order
decisions made for you after fees.

## Run it

Open `index.html` in any modern browser. That's it — no install, no server, no ESI login.
Your data never leaves your machine (the only network call is the optional, public ESI
price fetch).

## Workflow

1. **Paste your inventory** (select items in a hangar/container → Ctrl-C) into the left box.
   Optional, but it supplies quantities/volumes and catches items your appraisal dropped.
2. **Paste a [Janice](https://janice.e-351.com/) appraisal** (the per-unit buy/sell columns)
   into the right box — **or** click **Fetch live Jita 4-4 prices (ESI)** to pull the
   current best buy/best sell straight from CCP's public API. If you do both, ESI wins.
3. Check your **broker fee** and **sales tax** percentages (defaults: 2.1% / 7.5%).
4. Every item is ranked by expected net ISK and tagged:
   - **INSTANT** — selling into buy orders nets more than a sell order once you account
     for the broker fee you'd pay to list (`buy × (1 − tax)` ≥ `sell × (1 − tax − broker)`).
   - **ORDER** — listing at the sell price nets more, even after the broker fee.
5. **Select top N** (or hand-pick rows), then **Copy import list** — the preview is
   `Item name ⇥ Quantity ⇥ Price`, ready for the game's multi-sell import. INSTANT items
   are priced at the current best buy so they fill the moment you import them; ORDER items
   are listed at the sell price, optionally undercut by one tick.
6. **Copy full table (TSV)** pastes the whole analysis into Excel / Google Sheets.

## Flags

| Flag | Meaning |
| --- | --- |
| `suspect price` | Buy > sell — a thin or broken market. These are the same items Janice marks as "missing or low quality price information". Check them in game before trusting the number. |
| `unsellable?` | Ice Storm / Expired filaments that the in-game market refuses to list. Auto-excluded from the export (you can re-tick them). |
| `Janice qty ≠ N` | The appraisal quantity disagrees with your inventory paste; the inventory wins. |
| `no buy orders` / `no sell orders` | Only one strategy is possible for this item. |

Items with no price at all (not in the appraisal, no Jita orders) are listed separately in
section 5 so they never pollute the ranking.

## Details & assumptions

- Broker fee applies only when listing a sell order (charged up front on order value);
  sales tax applies to every sale. Relist fees from later repricing are not modelled — if
  a market is a 0.01-ISK-undercut war, instant selling is relatively better than shown.
- The ESI fetch uses only public endpoints: `POST /universe/ids` to resolve names, then
  `GET /markets/10000002/orders?type_id=…` per item, keeping orders at Jita IV-4
  (station `60003760`) — including buy orders placed elsewhere whose range covers the
  station. It paginates, honours the ESI error-limit headers, and retries transient errors;
  items that fail keep their appraisal price and get flagged.
- Exported prices respect EVE's 4-significant-digit price rule (the one-tick undercut is
  one unit of the price's own magnitude, e.g. `544 800 → 544 700`).
- Number parsing accepts both `1.234.567,89` (EVE client, EU locale) and `1234567.89`
  (Janice) formats; the export decimal separator is switchable for comma-locale clients.
- Inputs, fees, and row selections persist in `localStorage`, so closing the tab loses nothing.

## Development

Plain HTML/CSS/JS in one file — no build step. `Load sample data` fills the inputs with a
real 250-item hangar + matching appraisal for instant experimentation.
