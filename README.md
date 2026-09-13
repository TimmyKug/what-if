# What if?

What if? is a simple web calculator for comparing investment strategies against historical market data.

The core question is: “If I follow this exact sequence of waiting, investing, paying in, and taking money out, what could the result have looked like in the past?”

This is an educational backtesting tool, not financial advice. Results should be described as historical outcomes, not forecasts or guaranteed expected returns.

## First use case

The first scenario is a German `Bausparvertrag` versus investing the available money immediately.

Example defaults:

- Starting capital available now: €15,000
- Wait before the loan becomes available: 2 years 9 months / 33 months
- Capital available after the wait: €30,000 (€15,000 savings + €15,000 loan)
- Loan repayment: €110 per month for 5 years / 60 payments
- Total horizon: 7 years 9 months / 93 months
- Asset: a EUR-traded, accumulating MSCI World ETF proxy

The comparison should make the assumptions explicit:

### Wait and borrow

Wait 33 months, invest €30,000 when the loan becomes available, then withdraw €110 at the end of each of the next 60 months to make the loan payments.

### Invest now

Invest €15,000 immediately and hold it for the same 93-month horizon. This scenario intentionally ignores the later €15,000 loan opportunity, matching the requested comparison.

The first version compares the investment account balance at the horizon. A later version can add a household-net-worth view that includes loan principal, interest, taxes, fees, and the value of the Bauspar position separately.

## Running it

The app is a static page with no build step and no runtime API key — the market
history is committed in `data/market-data.json`.

```sh
python3 -m http.server 8000   # any static server; ES modules need http://, not file://
open http://localhost:8000
```

Checks and data refresh:

```sh
node scripts/check-engine.mjs       # smoke tests for the backtest engine
node scripts/fetch-market-data.mjs  # market history   → data/market-data.json
node scripts/verify-data.mjs <dir>  # integrity-check a fetched dataset
```

`DATA_DIR` redirects the fetchers and the checker, so a refresh can be staged
somewhere else and inspected before it replaces anything:

```sh
DATA_DIR=data-staging node scripts/fetch-market-data.mjs
node scripts/verify-data.mjs data-staging data
```

## Automated refresh and deployment

`.github/workflows/refresh-data.yml` runs weekly (Mondays 06:00 UTC) and on
demand. It never writes over the committed data directly:

1. fetch into `data-staging/`
2. `verify-data.mjs` checks it, and compares it against what is committed
3. `check-engine.mjs` runs against the staged copy
4. only then is it promoted, re-checked, committed, and deployed

If any step fails the job stops and the repository still holds the last good
dataset.

The comparison in step 2 is the part worth having. Structural checks catch a
malformed or truncated download; comparing against the previous vintage catches
the subtler failure, where a source still returns well-formed JSON but has
quietly changed what it means. Every return on a shared date must still agree:

| Check | Fails when |
|---|---|
| History length | a series came back shorter than before |
| Value sanity | a non-finite or non-positive price |
| Implausible move | a single period moves more than 60% |
| Revision drift | more than 5% of shared returns move by over 0.01pp |
| Series break | any single shared return moves by over 2pp |

The last one is the calendar guard: a one-period shift moves returns by whole
percentage points, so it cannot hide as a revision. Tolerances exist because
prices are stored to six significant figures and providers re-adjust history for
splits and dividends, so a re-fetch never reproduces the previous numbers
exactly.

`.github/workflows/deploy-pages.yml` publishes the static files and `data/` to
GitHub Pages on every push to `main`, and is called directly by the refresh
workflow — a commit pushed with `GITHUB_TOKEN` does not trigger `push` workflows,
so the refresh has to deploy itself.

To enable it: **Settings → Pages → Source: GitHub Actions**. The repository must
be public, or on a plan that allows Pages from private repositories.

Files:

| Path | What it is |
|---|---|
| `index.html`, `styles.css` | markup and the dark theme |
| `engine.js` | pure calendar, currency-conversion and backtest logic (no DOM) |
| `app.js` | data loading, the SVG chart, and the controls |
| `data/market-data.json` | committed monthly history |
| `scripts/` | fetch, verify and engine-check scripts |

## What the first screen does

One graph answers the question, with the plan editable beside it.

Defaults: **Developed Markets**, currency guessed from the visitor's time zone
(falling back to their locale), **0** starting amount, **+100 per month**, over
**10 years**.

The horizon is set as years and months rather than a whole number of years, so
18 months or 3 years 6 months are as easy to ask for as a decade. A horizon
longer than the available history is capped at it and the control says so.

## The plan

A scenario is a list of cash-flow events, and nothing else. There is no separate
starting amount, no waiting period and no withdrawal type, because a schedule
already expresses all three:

| Idea | How it is written |
|---|---|
| Starting capital | one payment, in month 0 |
| Saving monthly | a repeating payment, month 1 to the end |
| Waiting | months no event covers |
| A lump sum later | one payment, in that month |
| Drawing down | a repeating payment with a minus sign |

Each event becomes a number in a `schedule` array — `schedule[t]` is the net flow
in month `t`, and `schedule[0]` is the money present before the first month. The
engine reads that array and knows nothing about events, so the whole of the
scenario above costs it one line:

```js
balance = balance * (1 + returns[i]) + schedule[t];
```

Months are counted from the start rather than given as dates, which is how the
use case below states them ("33 months", "60 payments") and keeps each row to one
field per boundary instead of four.

### The first use case, expressed

`Invest now` is one event: **+15,000 in month 0**.

`Wait and borrow` is two: **+30,000 in month 33**, then **−110 a month from 34 to
93**. The wait needs no expressing — it is simply the months before the first
event, where the money earns nothing, which is what sitting in a Bausparvertrag
does.

Over Developed Markets in EUR, across all 340 overlapping 93-month windows:

| | Worst | Median | Best | Net paid in |
|---|---|---|---|---|
| Invest now | €8,872 | €29,608 | €69,040 | €15,000 |
| Wait and borrow | €14,073 | €40,690 | €85,298 | €23,400 |

Running the two side by side in one view is a separate piece of work; today they
are two runs of the same screen.

The engine replays that plan once for every historical start month the series is
long enough to cover, and the chart draws:

- **Best**, **Median** and **Worst** — three single, real timelines: the start
  months whose plan ended highest, in the middle, and lowest.
- **Average** — the mean across every timeline, month by month.
- **Paid in** — a dashed baseline of the money actually put in.
- A shaded envelope covering everywhere any timeline ever went.

Best, median and worst are deliberately actual historical sequences rather than
per-month percentiles, so each line is a path someone could really have lived
through. Overlapping windows are not independent samples, and the UI says so
whenever the series is short relative to the horizon.

Withdrawals that the portfolio cannot cover empty it instead of taking it
negative, and the number of timelines where that happened is reported.

## Instruments and currency

Each series carries its own currency and whether it is dividend-adjusted:

| Series | Returns | History from | 10-year windows (EUR) |
|---|---|---|---|
| **Developed Markets** (default) | total return, gross of tax | 1990-07 | **313** |
| US Market (1926) | total return, gross of tax | 1926-07 | 547 (1081 in USD) |
| MSCI World (net return) | net total return | 2000-12 | 189 |
| MSCI World (price only) | price return only | 1985-01 | 381 |
| S&P 500 Total Return | total return | 1988-01 | 345 |
| US Total Market (VTSMX) | total return | 1992-04 | 294 |
| MSCI ACWI (net return) | net total return | 2000-12 | 189 |
| FTSE Global All Cap | total return | 2008-06 | 100 |
| MSCI World ETF (EUNL) | total return | 2009-08 | 86 |
| Bitcoin | price (no dividends exist) | 2014-09 | 25 |
| Ethereum | price (no dividends exist) | 2017-11 | 0 |

Bitcoin and Ethereum are there because people do save into them, not because
they belong beside the rest. Two things are worth saying plainly: their record is
short enough that a ten-year plan has 25 overlapping windows for Bitcoin and none
at all for Ethereum, and they trade every day of the week, so a converted
currency uses the preceding Friday's rate at weekends. Both appear as warnings on
screen, along with the point that a "worst case" drawn from one bull market and
one crash is not the worst that can happen.

They also need their own thresholds in the checks. `verify-data.mjs` treats a
60% move in a single period as a data error for equities, but Ether really has
moved 78% in a month and fallen 42% in a day, so crypto gets a 250% limit. The
cross-check that every series tracks MSCI World would be meaningless too, so
crypto is held against the other crypto series instead — enough to catch a
shifted calendar, which is what that check is for.

Usable history is the overlap of the equity series and the exchange-rate series,
so the exchange rate only binds where it starts later than the equity data. It
does for the US series (1926 equity, 1971 rates, so 1971 in EUR and 1926 in USD);
it does not for any of the others, which all start after 1971.

The dropdown groups the series by the universe they cover, and stamps each with
its start year, because within a group the *only* reason to prefer one over
another is where its history begins:

```
Developed world — the MSCI World universe
    MSCI World (net return) · from 2000
    Developed Markets · from 1990
    MSCI World ETF (EUNL) · from 2009
    MSCI World (price only) · from 1985
World including emerging markets
    MSCI ACWI (net return) · from 2000
    FTSE Global All Cap · from 2008
United States only
    S&P 500 · from 1988
    US Total Market · from 1992
    US Market (1926) · from 1926
```

**Developed Markets is the default**, because history matters more here than a
familiar name. The worst ten-year run of the same plan is **−30%** on Developed
Markets but **+2%** on MSCI World, entirely because MSCI's free data starts in
December 2000, after the dot-com peak — a calculator whose headline downside is
"roughly break-even" is not doing its job.

MSCI World is one click away for anyone who wants the index their tracker
actually follows, and whenever a longer comparable series exists the assumptions
panel names it and states its worst outcome, so the shorter history can never
quietly understate the downside.

The same reasoning rules out FTSE Global All Cap, which is just as widely held
but starts in 2008 and puts the worst ten-year run at **+42%**.

Each option in the dropdown carries the full span it covers (`1990–2026`), so the
trade-off between the series in a group is visible before you pick one.

**Developed Markets** is the Fama/French developed-market portfolio:
every listed company in the developed world weighted by market cap, built from the
underlying stocks rather than repackaged from an index product — which is why it
starts in 1990 rather than whenever a tracker launched. Its four regions are North
America, Europe, Japan, and Asia Pacific ex Japan, so in practice it is the MSCI
World universe arrived at independently: the two correlate at **0.9966** over 307
overlapping months, with a mean absolute monthly difference of 0.29pp.

It has the most history of any world-equity option here, and covers the dot-com crash and the financial
crisis, so the "worst" line is a genuinely bad decade rather than an artefact of
a data set that starts in a bull market. Its one cost is that it reinvests
dividends *gross* of withholding tax where an index like MSCI's `NETR` is net of
it — worth roughly 0.5–0.7pp/year, which the app states on screen.

Older instrument rows, for reference:

| Series | Currency | Returns | History from |
|---|---|---|---|
| MSCI World ETF (EUNL, Xetra) | EUR | total return | 2009 |
| MSCI World Index | USD | price return only | 1985 |
| S&P 500 Total Return | USD | total return | 1988 |
| US Total Market (VTSMX) | USD | total return | 1992 |

### Exchange rates

Monthly rates come from Eurostat's `ert_bil_eur_m` at `statinfo=END` — the
end-of-period rate, not the monthly average. The prices being converted are
month-end closes, so an average rate would pair a month-end price with a
mid-month exchange rate and inject timing noise into every converted return.
It is worth roughly 0.12 on the correlation between a converted series and a
natively denominated one.

The dataset publishes a continuous
euro/ECU series back to **1971-01** — the euro replaced the ECU 1:1 in 1999, so
the series bridges that boundary. Every currency the app offers reaches back past
1990 except SGD (1999). Eurostat quotes units per euro; the pipeline stores USD
per unit as `rate(USD) / rate(currency)`.

This matters more than it sounds: the previous market FX feed only went back to
2003, which silently truncated *every* non-native series at 2003 when displayed
in EUR. Switching sources restored the full history of all of them.

Both MSCI rows are the `NETR` net total return variant. MSCI's own endpoint
carries ACWI further back than the ETF proxy it replaced (2000-12 rather than
2008-03), so the Yahoo `ACWI` row is gone.

MSCI computes its indices separately in each currency, so its series is
already denominated in USD, EUR, GBP, CHF, JPY, CAD, AUD, SEK, NOK, DKK, NZD and
SGD — no exchange-rate series in the middle, no conversion error, and no history
lost to one. `NETR` is the net total return variant, dividends reinvested after
withholding tax, which is what a UCITS ETF actually tracks.

For any other series, or for a currency MSCI does not publish (PLN starts only in
late 2025), the display currency is applied by converting month by month at the
historical rate. Usable history is then the overlap of the price series and the
exchange-rate series, and gaps in the monthly FX data carry the last known rate
forward.

MSCI's public endpoint serves its price index only from 1997-01 and its total
return variants only from 2000-12; there is no earlier date it will accept. The
index itself is based at 100 on 1969-12-31, but that history is in MSCI's
licensed products, not the public endpoint. The `MSCI World (price only)` row
reaches back to 1985 because it comes from a market data feed rather than from
MSCI directly — it excludes dividends, so it is a poor choice for a savings
backtest even though it is the longest MSCI series here.

### A trap worth recording: distributing ETFs on Yahoo

The FTSE row is taken from `VT`, the accumulating US listing, not from the
European `VWRL.AS` that tracks the same index and has a longer European history.
Yahoo's dividend adjustment on that distributing share class is wrong — it
trails MSCI ACWI by 1.92pp/year at a correlation of 0.88, where the accumulating
share classes of the very same fund track it at 0.983–0.994 with no meaningful
gap:

| Ticker | vs ACWI | Gap/yr | From |
|---|---|---|---|
| VWRL.AS (distributing) | 0.8800 | −1.92 pp | 2012-05 |
| VWCE.DE (accumulating) | 0.9831 | −0.15 pp | 2019-07 |
| VWRA.L (accumulating) | 0.9868 | +0.00 pp | 2019-07 |
| VT (accumulating) | 0.9938 | +0.22 pp | 2008-06 |

Prefer an accumulating listing whenever a choice exists: dividends are reinvested
inside the fund, so its price is already a total return and no adjustment has to
be trusted. The cross-check in `scripts/check-engine.mjs` catches this class of
problem, which is why it is there.

### On the MSCI source

`app2.msci.com` is the undocumented JSON backend of MSCI's public end-of-day
index search. It needs no key, and the same endpoint serves `DAILY` instead of
`END_OF_MONTH` if per-day start dates are ever wanted.

It is also MSCI's copyrighted index data, and index licensing is their business.
That is fine for a personal tool; it is **not** a basis for a public product, and
non-commercial use is not an exemption — in the EU the database right
(Directive 96/9/EC, UrhG §§87a–87e) applies regardless of commercial intent.

If this ever needs a publishable footing, the closest free substitute is the
Fama/French **Developed** series (monthly and daily from 1990-07, USD). Measured
over the 307-month overlap it correlates with MSCI World at **0.9966**, with a
mean absolute monthly difference of 0.29pp; it runs about 0.66pp/year hotter only
because it is gross rather than net of dividend withholding tax. It has *more*
history than MSCI (312 ten-year windows vs 188), but it is USD-only, so
converting to EUR via ECB rates from 1999 gives back most of that advantage
(210 windows). Its terms are unclear too — the page says only "Copyright Eugene
F. Fama and Kenneth R. French" — so that route starts with an email to Dartmouth.

## Historical calculation model

Use monthly observations for the first version. A monthly model is easier to explain, matches the €110 repayment cadence, and avoids false precision from daily noise.

1. Normalize the selected data series to EUR and use a total-return-capable price series. For an accumulating ETF this means using a dividend-adjusted series; for a distributing ETF it means reinvesting distributions or modeling them as cash.
2. Calculate monthly returns from adjacent adjusted prices.
3. For every historical start month with enough data to cover the complete horizon, replay the scenario’s cash-flow schedule.
4. Record the ending balance for that historical window.
5. Summarize the distribution with median, mean, P10, P25, P75, P90, minimum, and maximum. Call these “historical outcomes” or “historical average,” never a guaranteed expected amount.

For a window with monthly return `r` and balance `B`, use an explicit cash-flow order. The proposed default is:

```text
balance_after_return = balance_before_return × (1 + r)
balance_after_cashflow = balance_after_return + payins - withdrawals
```

The UI should show this convention and allow the timing to be changed later. If the balance cannot cover a withdrawal, record a failed window and show how often that happened instead of silently allowing a negative portfolio.

The example above maps to 93 months: 33 months with no market investment, followed by 60 months invested with 60 scheduled withdrawals. The exact month in which the €30,000 purchase and first €110 withdrawal happen must be visible in the timeline so that off-by-one choices are not hidden.

## Data-source research

### Recommended MVP provider: Twelve Data

Twelve Data has a single time-series endpoint with monthly data, date boundaries, exchange selection, and an `adjust` mode. Its documented modes include `all`, `splits`, `dividends`, and `none`; use `adjust=all` when the chosen instrument supports it. Its dividend endpoint can be used to audit the series. A request shape for the Xetra listing is:

```text
GET https://api.twelvedata.com/time_series
  ?symbol=EUNL
  &exchange=XETR
  &interval=1month
  &start_date=2009-10-01
  &end_date=2026-09-13
  &adjust=all
  &apikey=YOUR_API_KEY
```

For dividend auditing:

```text
GET https://api.twelvedata.com/dividends
  ?symbol=EUNL
  &exchange=XETR
  &range=full
  &apikey=YOUR_API_KEY
```

The exact symbol/exchange coverage should be checked before production use. Twelve Data documents monthly history, date-range queries, a 5,000-point per-request limit, and its adjustment modes in the [historical data guide](https://support.twelvedata.com/en/articles/5214728-getting-historical-data), [price-history guide](https://support.twelvedata.com/en/articles/5656039-how-to-get-historical-prices), and [API documentation](https://twelvedata.com/docs).

### Strong alternative: EODHD

EODHD’s end-of-day endpoint directly returns daily, weekly, or monthly OHLCV data plus `adjusted_close`, which it documents as adjusted for splits and dividends. It also supports date ranges and exchange-qualified symbols:

```text
GET https://eodhd.com/api/eod/EUNL.XETRA
  ?api_token=YOUR_TOKEN
  &from=2009-10-01
  &to=2026-09-13
  &period=m
  &order=a
  &fmt=json
```

Confirm the provider’s current exchange code and the exact EUNL listing before wiring it in. EODHD documents the [historical EOD endpoint](https://eodhd.com/financial-apis/api-for-historical-data-and-volumes), adjusted-close behavior, and its free-plan history limits.

### Useful fallback: Alpha Vantage

Alpha Vantage provides a monthly adjusted endpoint that returns monthly OHLC, adjusted close, volume, and dividend data:

```text
GET https://www.alphavantage.co/query
  ?function=TIME_SERIES_MONTHLY_ADJUSTED
  &symbol=EUNL.DE
  &apikey=YOUR_API_KEY
```

It is a reasonable adapter target, but plan limits and European ETF coverage need to be verified during implementation. See the [Alpha Vantage API documentation](https://www.alphavantage.co/documentation/).

### Licensed index source: MSCI Index API

If the product needs the actual MSCI World index rather than an ETF proxy, MSCI’s own Index API is the cleanest authoritative option. It exposes historical index levels and performance across index variants and currencies, but access is entitlement-based. See the [MSCI Index API](https://developer.msci.com/apis/index-api).

### Currency conversion (superseded)

The app now uses Eurostat; this note is kept for background. If the selected price series is not already in EUR, use an exchange-rate series and disclose that currency conversion is included. The ECB publishes historical daily reference exchange rates through its SDMX services; see the [ECB SDMX reference-rate documentation](https://www.ecb.europa.eu/stats/ecb_statistics/sdmx/html/index.fr.html).

### Instrument default

The initial UI can offer `iShares Core MSCI World UCITS ETF`, Xetra ticker `EUNL`, as a concrete proxy. iShares lists EUNL on Deutsche Börse Xetra in EUR, with ISIN `IE00B4L5Y983`, accumulating income, and the MSCI World Index (Net) as its benchmark. It is a tradable proxy, not identical to the index. See the [official iShares product page](https://www.ishares.com/de/privatanleger/de/produkte/251882/ishares-msci-world-ucits-etf-acc-fund).

## Product layout

The UI should feel like a calm financial instrument rather than a spreadsheet. Use a near-black canvas, graphite panels, warm off-white text, thin hairline dividers, and one acid-green accent for positive change. Keep copy plain and make every assumption editable.

### 1. Scenario builder

The home screen is one guided builder with a sticky result preview. It should read top-to-bottom on mobile and become a two-column workspace on larger screens.

Left/main column:

- `Starting position`: currency, current amount, and date.
- `Wait`: a duration field with years and months.
- `Pay in / invest`: one-time amount or recurring amount.
- `Take out`: one-time or recurring withdrawal, amount, start, end, and cadence.
- `Market data`: instrument, currency, source, history range, and adjusted/total-return mode.
- A compact timeline showing every event as a draggable row.

Right/sticky column:

- Horizon and data status at the top.
- Large “At the end” amount for the selected summary statistic.
- Difference between scenarios in euros and percentage points.
- A small “assumptions” disclosure that expands the cash-flow order, fees, taxes, and inflation settings.

Use one reusable `CashFlowEvent` editor for one-time payins, recurring payins, one-time withdrawals, recurring withdrawals, and waiting periods. Adding a new event type should extend the event schema, not require a new calculator screen.

### 2. Results

Results should answer the user’s question before showing detail:

- `Historical average` and `Median` cards for both strategies.
- A range card showing `P10–P90`, plus min/max on demand.
- An overlay fan chart with the outcome distribution over time; use a solid median line and translucent percentile bands.
- A small table of historical windows: start month, end balance, total invested, total withdrawn, and whether the portfolio covered every withdrawal.
- A warning when the result uses an ETF proxy, a short history, nominal euros, or a series without distributions.

The default comparison should be side-by-side, with a toggle for “show only the difference” so the page stays quiet when the user is exploring.

### 3. Data and assumptions

Keep source and modeling details one click away, not in the primary flow. Show:

- Provider, instrument, exchange, currency, and last successful fetch.
- Number of observations and oldest/latest observation.
- Total-return / adjustment mode.
- Cash-flow timing convention.
- Fees, taxes, inflation, and currency-conversion toggles.

## Suggested domain model

Keep strategy definition separate from market data and result summaries:

```ts
type Strategy = {
  id: string;
  name: string;
  initialBalance: Money;
  events: CashFlowEvent[];
  horizonMonths: number;
};

type CashFlowEvent = {
  kind: "wait" | "invest" | "payin" | "withdrawal";
  startMonth: number;
  endMonth?: number;
  amount?: Money;
  cadence?: "once" | "monthly";
};

type MarketSeries = {
  instrumentId: string;
  currency: string;
  adjusted: boolean;
  observations: { month: string; value: number }[];
};
```

The calculation engine should accept a `Strategy` and `MarketSeries` and return raw window results plus summarized statistics. This keeps the UI free to add payins, withdrawals, or recurring investments without duplicating financial logic.

## MVP build order

1. Implement the monthly cash-flow engine with deterministic fixtures and the 93-month example.
2. Add a provider adapter for Twelve Data and cache normalized monthly series server-side.
3. Build the single-screen scenario builder with the reusable `CashFlowEvent` editor.
4. Add side-by-side result cards, percentile chart, and historical-window table.
5. Add source disclosures, error states, missing-data handling, and a second provider adapter.

There are no verified local install, test, lint, or build commands yet because the repository has no application scaffold.
