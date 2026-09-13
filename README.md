# What if?

**A backtester for saving plans.**
You describe a plan — pay in this much, from then until then, take some out here — and it replays that exact plan against every stretch of real market history long enough to hold it.
Not one run.
Every run.

The question it answers is *"how differently could this have gone?"*, which a compound-interest calculator cannot answer at all.
Those ask you for an expected return and hand back one number.
Markets do not deliver an expected return; they deliver a sequence, and the sequence you happen to get decides the outcome.

€100 a month into developed-market equities for ten years, across all 313 ten-year stretches since 1990:

| | Result | vs the €12,000 paid in |
|---|---|---|
| Best ten years | €34,620 | +189% |
| Average | €18,621 | +55% |
| Worst ten years | €8,458 | **−30%** |

Same plan, same index, same decade-long horizon.
The gap between those rows is the thing worth knowing, and it is the only thing this tool is really for.

> Educational backtest of historical data.
> Not financial advice, not a forecast.
> Figures exclude tax and trading fees.

## Why it exists

Every savings calculator asks for an expected annual return.
That framing quietly assumes the answer: pick 7% and you will be told you end up with the 7% number.
But nobody gets the average.
They get 1990-2000, or 1999-2009, and those two decades produced results that differ by a factor of four for identical behaviour.

A backtest cannot predict which one you will get either.
What it can do is show you the full range that actually happened, so a plan can be judged on its worst case rather than its brochure case.
That is the whole argument for this existing.

The design follows from it: the worst line is never hidden, the number of historical windows behind every result is always on screen, and when a data series is too short to have seen a bad decade, the app says so rather than reporting a reassuring number.

## Using it

Pick what you would have invested in, a currency, and a horizon.
Then describe the plan.

**Simple mode** is a starting amount and a monthly figure, which covers almost every plan anyone actually has.

**Pro mode** replaces those two fields with a list of cash-flow events, which can express anything: waiting before you start, a lump sum partway through, drawing an income back out, or all three at once.

| Idea | How it is written |
|---|---|
| Starting capital | one payment, in month 0 |
| Saving monthly | a repeating payment, month 1 to the end |
| Waiting | months no event covers |
| A lump sum later | one payment, in that month |
| Drawing down | a repeating payment set to *Take out* |

A withdrawal larger than the balance takes only what is there.
Money that was never in the portfolio cannot leave it, so the shortfall is not counted as paid out, and the run is flagged as having run dry.

## Where the data comes from

Everything is committed to this repository, so the app makes **no network calls at runtime and needs no API key**.

| Series | Source | Returns | From | 10-year start dates |
|---|---|---|---|---|
| **Developed Markets** *(default)* | Fama/French | total, gross of tax | 1990-07 | **313** |
| US Market | Fama/French | total, gross of tax | 1926-07 | 505 in EUR, 1081 in USD |
| MSCI World (net return) | MSCI | net total return | 2000-12 | 189 |
| MSCI ACWI (net return) | MSCI | net total return | 2000-12 | 189 |
| MSCI Emerging Markets | MSCI | net total return | 2000-12 | 189 |
| MSCI World (price only) | market feed | **price only** | 1985-01 | 381 |
| MSCI World ETF (EUNL) | market feed | total return | 2009-09 | 85 |
| MSCI EM ex China | market feed | total return | 2017-07 | 0 |
| FTSE Global All Cap | market feed | total return | 2008-06 | 100 |
| S&P 500 | market feed | total return | 1988-01 | 345 |
| US Total Market | market feed | total return | 1992-04 | 294 |
| Bitcoin · Ethereum | market feed | price (none exist) | 2014-09 · 2017-11 | 25 · 0 |

Selecting a crypto series shortens the horizon to three years, because ten years of Bitcoin is 25 overlapping windows that all begin in its first two years and every one of them multiplied — a worst case of 9.7x.
That is a property of when the data starts, not of the asset.
Three years gives 109 windows and a worst case that loses money.

**Show in today's money** deflates every figure to the purchasing power of the month its own plan began, which is what makes windows comparable: a euro in 1998 and a euro in 2015 are not the same euro.
It is worth turning on.
The same €1,000-a-month decade that ends at €346,205 nominally ends at €216,810 in real terms — and the money paid in falls from €120,000 to €99,918, because a euro paid in year ten buys less than one paid in year one.

Price indices come from Eurostat's HICP, the US Bureau of Labor Statistics, and the UK Office for National Statistics.
Turning it on shortens the history, since price data starts later than the market data.

The currency list is limited to the eight with a usable monthly price index, so the toggle works everywhere rather than being unavailable in half the list.
JPY, CAD, AUD, NZD and SGD are absent for that reason: no free monthly index was reachable for them.

Exchange rates are Eurostat's `ert_bil_eur_m` at end-of-period, a continuous euro/ECU series back to **1971**.
The euro replaced the ECU 1:1 in 1999, so it spans that boundary; every currency offered reaches past 1990 except SGD.

### Why these, and what each one costs you

**Developed Markets is the default** because history matters more here than a familiar name.
It is the Fama/French developed-market portfolio — every listed company in the developed world weighted by market cap, built from the underlying stocks rather than repackaged from an index product, which is why it starts in 1990 instead of whenever a tracker launched.
In practice it *is* the MSCI World universe: the two correlate at **0.9966** over 307 overlapping months.

The price of that choice is that Fama/French reinvest dividends *gross* of withholding tax where MSCI's `NETR` is net, worth roughly 0.5-0.7pp a year.
The app says so on screen.

The price of the alternative is worse.
The same plan's worst ten years is **−30%** on Developed Markets but **+2%** on MSCI World, entirely because MSCI's free data begins in December 2000, after the dot-com peak.
A calculator whose headline downside is "roughly break-even" is not doing its job.
Whenever a longer comparable series exists, the assumptions panel names it and states its worst outcome, so a short history can never quietly flatter a plan.

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

### On the MSCI series

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

## Sharing and comparing

The whole scenario lives in the query string, so a link is the unit of sharing, a bookmark is the unit of saving, and a second tab is the unit of comparison.

```
?i=msci-world&c=GBP&y=7&m=9&r=1&f=2.5&pro=1&p=o:30000:33,m:-110:34:93
```

Events encode as `cadence:amount:from[:to]` — `m:1000:1` is a thousand a month from month one, `o:30000:33` a lump at month 33.

**Saved scenarios** keep named plans in `localStorage`, as the same query strings the URL uses — saving is just remembering a link.
Naming happens in an inline field rather than `prompt()`, which arrives wearing the browser's chrome and announcing the hostname.
Enter saves, Escape cancels.

Nothing is written until you press Save, which is why there is no notice on arrival: a visitor who never saves leaves no trace.
The notice appears the first time something is actually stored, and every saved scenario has a delete button next to it.
Storage that fails, as in a private window, says so and points at the address bar instead.

### Why there is no consent banner

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

## How it works

Monthly observations.
For every start month the series is long enough to cover, the plan is replayed:

```js
balance = balance * (1 + returns[i]) + schedule[t];
```

The return is applied first and the cash flow second, so money never earns the return of the month it arrives in.
`schedule[t]` is the net flow in month `t` and `schedule[0]` is the money present before the first month — every event in a plan collapses into that one array, which is why waits, lump sums and withdrawals cost the engine nothing.

The runs are then summarised as the best, the average and the worst, plus the band covering every run.
**Best and worst are real single timelines** — the start months whose plan ended highest and lowest — not per-month percentiles, so each line is a path somebody could actually have lived through.

One honest caveat the app repeats where it matters: overlapping windows are not independent samples.
313 ten-year windows drawn from 36 years of history are 313 views of the same 36 years.
More windows make the extremes less of a calendar accident; they do not make them more certain.

## Running it

A static page.
No build step, no dependencies, no bundler.

```sh
python3 -m http.server 8000   # ES modules need http://, not file://
open http://localhost:8000
```

```sh
node scripts/check-engine.mjs       # engine + data cross-checks
node scripts/fetch-market-data.mjs  # refresh history → data/market-data.json
node scripts/verify-data.mjs <dir>  # integrity-check a fetched dataset
```

| Path | What it is |
|---|---|
| `index.html`, `styles.css` | markup and the dark theme |
| `engine.js` | calendar, currency conversion and the backtest — no DOM |
| `app.js` | data loading, the SVG chart, the controls |
| `data/market-data.json` | committed history, ~350 KB |
| `scripts/` | fetch, verify, engine checks |
| `.github/workflows/` | weekly data refresh, Pages deploy |

Everything in `styles.css` is in `rem`, so `html { font-size }` scales the whole interface from one value.

### Keeping the data honest

`refresh-data.yml` runs weekly.
It fetches into `data-staging/`, verifies, runs the engine checks against the staged copy, and only then promotes, commits and deploys.
A failure at any step leaves the last good dataset in place.

The gate that earns its keep is the comparison against the previous vintage.
Structural checks catch a truncated download; comparing to what is already committed catches a source that still returns valid JSON but has quietly changed what it means:

| Check | Fails when |
|---|---|
| History length | a series came back shorter |
| Value sanity | a non-finite or non-positive price |
| Implausible move | one period moves >60% (>250% for crypto) |
| Revision drift | >5% of shared returns move >0.01pp |
| **Series break** | any shared return moves **>2pp** |

That last row is the calendar guard: a one-month shift moves returns by whole percentage points, so it cannot hide as a revision.
Between them these checks have caught four real bugs — the timezone shift, the averaged exchange rates, a broken dividend adjustment, and an off-by-one in the window count.

To deploy: **Settings → Pages → Source: GitHub Actions**.
Note the MSCI caveat above before making the repository public.

## Support

If this was useful to you:

<!-- TODO: replace with the real Buy Me a Coffee link -->
[☕ Buy me a coffee](https://www.buymeacoffee.com/YOUR_USERNAME)
