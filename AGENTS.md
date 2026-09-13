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
- `data/market-data.json` — committed month-end history.
- `scripts/` — fetch, verify and engine-check scripts.

The app needs no API key and makes no network calls at runtime.

## Commands

- Serve: `python3 -m http.server 8000` (ES modules need `http://`, not `file://`).
- Test: `node scripts/check-engine.mjs` (covers both datasets).
- Refresh data: `node scripts/fetch-market-data.mjs`. Set `DATA_DIR` to write
  elsewhere.
- Verify a fetched dataset: `node scripts/verify-data.mjs <dir> [baseline-dir]`.
- CI: `.github/workflows/refresh-data.yml` (weekly, staged + verified) and
  `.github/workflows/deploy-pages.yml` (Pages).

There is no install, lint, or build step — no dependencies, no bundler.

## Conventions

- Keep financial logic in `engine.js` and cover new behavior in
  `scripts/check-engine.mjs`.
- A scenario is a list of cash-flow events, flattened to a `schedule` array
  before it reaches the engine. Resist adding kinds to it: a starting balance is
  a flow at month 0, a wait is a run of zeroes, and a withdrawal is a negative
  payment, so new scenarios should need UI rather than engine changes.
- Never fetch straight over `data/`. Stage it, run `verify-data.mjs` against the
  committed copy, then promote — that comparison is what catches a source
  changing meaning while still returning valid JSON.
- Every modeling shortcut must be visible in the "Data and assumptions" panel.
  Price-return series, currency conversion, proxy instruments, thin history, and
  depleted portfolios all warn there already.
- Data normalises to integer keys (YYYYMM) via `normalise()` before the engine
  sees it.
- `runScenario` is two-pass: pass one aggregates, pass two replays only the three
  drawn paths, which keeps memory flat in the number of windows.
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
