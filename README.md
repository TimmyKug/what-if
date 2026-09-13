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

### Currency conversion

If the selected price series is not already in EUR, use an exchange-rate series and disclose that currency conversion is included. The ECB publishes historical daily reference exchange rates through its SDMX services; see the [ECB SDMX reference-rate documentation](https://www.ecb.europa.eu/stats/ecb_statistics/sdmx/html/index.fr.html).

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
