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
- `data/market-data.json` — committed monthly history.
- `data/market-data-daily.json` — committed daily history, lazy-loaded by the app
  only when a weekly or daily buying cadence is selected.
- `scripts/` — two fetch scripts and the engine smoke test.

The app needs no API key and makes no network calls at runtime.

## Commands

- Serve: `python3 -m http.server 8000` (ES modules need `http://`, not `file://`).
- Test: `node scripts/check-engine.mjs` (covers both datasets).
- Refresh data: `node scripts/fetch-market-data.mjs` and
  `node scripts/fetch-daily-data.mjs`.

There is no install, lint, or build step — no dependencies, no bundler.

## Conventions

- Keep financial logic in `engine.js` and cover new behavior in
  `scripts/check-engine.mjs`.
- Every modeling shortcut must be visible in the "Data and assumptions" panel.
  Price-return series, currency conversion, proxy instruments, thin history, and
  depleted portfolios all warn there already.
- Both datasets normalise to integer keys (YYYYMM or YYYYMMDD) via `normalise()`
  before the engine sees them, so engine code never branches on which file it got.
- `runScenario` is deliberately two-pass: daily resolution reaches tens of
  thousands of windows, and keeping every balance path would run to hundreds of
  megabytes. Pass one aggregates, pass two replays only the three drawn paths.
- Chart series colors are validated against the dark surface for colorblind
  separation with `--pairs all`, not the default adjacent-pairs mode: every line
  is on screen at once, so every pair has to separate, and adjacent-only checking
  once let an amber/red pair through at ΔE 4.5. Re-validate before changing them,
  and keep each line direct-labeled as well as in the legend.
- Keep provider credentials server-side and out of committed files if a live data
  path is ever added.
- The default MSCI series comes from an undocumented MSCI endpoint and is
  licensed for neither redistribution nor public deployment. It is fine for
  personal use; see "On the MSCI source" in `README.md` before publishing.
- Prefer a natively denominated series over FX conversion when a source offers
  one — `buildSeries` already picks `byCurrency` ahead of the exchange-rate path.
