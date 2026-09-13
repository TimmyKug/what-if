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
- Nothing may be written to `localStorage` before the user asks for it. That is
  what keeps the site outside ePrivacy Art. 5(3) consent and free of a banner —
  see "Why there is no consent banner" in `README.md`. Analytics of any kind
  would cross that line.
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

## Data traps already paid for

Three things worth recording, because each cost real time to find:

- **Prefer accumulating share classes.**
  Yahoo's dividend adjustment on the
distributing `VWRL.AS` trails MSCI ACWI by 1.92pp/year at 0.88 correlation, while the accumulating classes of the *same fund* track it at 0.983-0.994.
The FTSE row uses `VT` for this reason.
- **Monthly bars are stamped in exchange-local time.**
  Read as UTC, every
European listing was labelled one month early and paired with the wrong month's exchange rate.
- **Use end-of-period exchange rates, not monthly averages.**
  The prices being
converted are month-end closes; an average rate injects timing noise worth about 0.12 of correlation.

## On the MSCI series

`app2.msci.com` is the undocumented JSON backend of MSCI's public end-of-day index search.
It needs no key, and it is also MSCI's copyrighted index data.
That is fine for a personal tool; it is **not** a basis for a public product, and non-commercial use is not an exemption — in the EU the database right (Directive 96/9/EC, UrhG §§87a-87e) applies regardless of commercial intent.

The Fama/French and Eurostat series are the publishable foundation.
Eurostat is official EU statistics with clean reuse terms; the Fama/French library is copyright Eugene F.
Fama and Kenneth R.
French with no stated licence, so publishing this anywhere public should start with an email to Dartmouth.

**Compare with a fixed rate** draws the line a compound-interest calculator would have given you, dotted, alongside the historical ones.
At 3% a year the same decade ends at €139,448 against a historical median of €186,213 — and a worst case of €84,582, which is below the €120,000 paid in.
Seeing the guaranteed line cross through the historical range is the clearest statement of what the trade actually is.
In real terms the rate is read as a real rate, since a deterministic line has no window whose inflation it could be deflated by.

## Why there is no consent banner

Not because `localStorage` is not a cookie.
ePrivacy Art. 5(3) covers "storing of information, or gaining access to information already stored, in the terminal equipment of a user", which is technology-neutral and catches `localStorage` exactly as it catches cookies.

The exemption is what the storage is *for*: Art. 5(3) excludes storage strictly necessary to provide a service the user explicitly requested, and a button labelled "Save this one" storing the thing you asked to save is the textbook case.
WP29 Opinion 04/2012 lists user-input and interface-preference storage among its examples.

So the load-bearing design decision is that **nothing is written before the click**.
The whole footprint is two keys, `what-if:scenarios` and `what-if:told`, both written only then.
Storing anything on arrival — a visitor id, a session marker, an analytics call — would move this out of the exemption and require a banner.
Adding analytics of any kind is the line to watch.

Two tabs is a real comparison, with one caveat worth knowing: each chart scales its own axis, so the same line height means different money in each.
For the two legs of the use case below the axes differ by 1.21x.
The ending value is printed on every line, so read the numbers rather than the heights.
