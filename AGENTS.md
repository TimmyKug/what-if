# AGENTS.md

## Project

- `what-if` is a web calculator for comparing investment plans against historical
  market data.
- Product behavior, market-data research, and modeling assumptions are documented
  in `README.md`.

## Layout

- `index.html`, `styles.css` — markup and the dark theme.
- `engine.js` — pure logic: calendar helpers, currency conversion, the backtest.
  No DOM, so it is importable from Node.
- `app.js` — data loading, the SVG chart, and the controls.
- `data/market-data.json` — committed monthly history. The app needs no API key
  and makes no network calls at runtime.
- `scripts/` — data fetch and engine smoke test.

## Commands

- Serve: `python3 -m http.server 8000` (ES modules need `http://`, not `file://`).
- Test: `node scripts/check-engine.mjs`.
- Refresh data: `node scripts/fetch-market-data.mjs`.

There is no install, lint, or build step — no dependencies, no bundler.

## Conventions

- Keep financial logic in `engine.js` and cover new behavior in
  `scripts/check-engine.mjs`.
- Every modeling shortcut must be visible in the "Data and assumptions" panel.
  Price-return series, currency conversion, proxy instruments, thin history, and
  depleted portfolios all warn there already.
- Chart series colors are validated against the dark surface for colorblind
  separation; re-validate before changing them, and keep each line direct-labeled
  as well as in the legend.
- Keep provider credentials server-side and out of committed files if a live data
  path is ever added.
- The default MSCI series comes from an undocumented MSCI endpoint and is
  licensed for neither redistribution nor public deployment. It is fine for
  personal use; see "On the MSCI source" in `README.md` before publishing.
- Prefer a natively denominated series over FX conversion when a source offers
  one — `buildSeries` already picks `byCurrency` ahead of the exchange-rate path.
