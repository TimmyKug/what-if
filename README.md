# What if?

**A backtester for saving plans.**
You describe a plan — pay in this much, from then until then, take some out here — and it replays that plan against every stretch of real market history long enough to hold it.
Not one run.
Every run.

€1,000 a month into developed-market equities for ten years, across all 313 ten-year stretches since 1990:

| | Result | vs the €120,000 paid in |
|---|---|---|
| Best ten years | €346,205 | +189% |
| Average | €186,213 | +55% |
| Worst ten years | €84,582 | **−30%** |

Same plan, same index, same decade.
The gap between those rows is the only thing this tool is really for.

## Why it exists

I kept ending up in conversations where I wanted to show someone that you can decide about investing from actual numbers rather than vibes.
Every time, I went looking for a tool that would show it the way I meant, and every time the tool was nearly right and not quite.
They all ask you for an expected annual return, which quietly assumes the answer: pick 7% and you get told the 7% number.
But nobody gets the average.
You get 1990–2000, or 1999–2009, and those two decades produced results four times apart for identical behaviour.

So I built the thing I kept wishing I had.
It cannot tell you which decade you will get either — it just shows you the whole range that actually happened, so a plan can be judged on its worst case rather than its brochure case.

## Support

If it was useful to you:

<!-- TODO: replace with the real Buy Me a Coffee link -->
**[☕ Buy me a coffee](https://www.buymeacoffee.com/YOUR_USERNAME)**

## What it does

Pick what you would have invested in, a currency, and a horizon.
Then describe the plan.

- **Simple mode** — a starting amount and a monthly figure.
- **Pro mode** — a list of cash-flow events, which can express waiting before you start, a lump sum partway through, drawing an income back out, or all three.
- **Show in today's money** — deflates every figure to the purchasing power of the month its own window began.
  The same decade that ends at €346,205 nominally ends at €216,810 in real terms.
- **Compare with a fixed rate** — draws the line a compound-interest calculator would have given you, through the historical range.

The whole scenario lives in the URL, so a link is the unit of sharing, a bookmark the unit of saving, and a second tab the unit of comparison.
Scenarios can also be saved by name in the browser; nothing is stored until you press Save.

## Where the data comes from

Everything is committed to this repository, so the app makes **no network calls at runtime and needs no API key**.

| Series | Source | From | 10-year start dates |
|---|---|---|---|
| **Developed Markets** *(default)* | Fama/French | 1990-07 | **313** |
| US Market | Fama/French | 1926-07 | 505 in EUR, 1081 in USD |
| MSCI World · ACWI · Emerging Markets | MSCI | 2000-12 | 189 |
| MSCI World (price only) | market feed | 1985-01 | 381 |
| S&P 500 · US Total Market | market feed | 1988 · 1992 | 345 · 294 |
| FTSE Global All Cap · MSCI EM ex China | market feed | 2008 · 2017 | 100 · 0 |
| MSCI World ETF (EUNL) | market feed | 2009-09 | 85 |
| Bitcoin · Ethereum | market feed | 2014 · 2017 | 25 · 0 |

Exchange rates are Eurostat's euro/ECU series back to **1971**; price indices come from Eurostat, the US Bureau of Labor Statistics and the UK Office for National Statistics.
Currencies are limited to the eight with a usable monthly price index, so "today's money" works everywhere rather than in half the list.

Two things the app says on screen rather than hiding:

- **Developed Markets is the default because history matters more than a familiar name.**
  The same plan's worst decade is −30% on it but **+2%** on MSCI World, purely because MSCI's free data begins after the dot-com peak.
  Whenever a longer comparable series exists, the assumptions panel names it and states its worst outcome.
- **Overlapping windows are not independent samples.**
  313 ten-year windows drawn from 36 years are 313 views of the same 36 years.

`AGENTS.md` has the engineering notes: the data traps already paid for, the MSCI licensing position, and why there is no consent banner.

## Running it

A static page.
No build step, no dependencies, no bundler.

```sh
python3 -m http.server 8000   # ES modules need http://, not file://
node scripts/check-engine.mjs # 89 assertions over the engine and the data
```

| Path | What it is |
|---|---|
| `engine.js` | calendar, currency conversion and the backtest — no DOM |
| `app.js` | data loading, the SVG chart, the controls |
| `data/market-data.json` | committed history, ~350 KB |
| `scripts/` | fetch, verify, engine checks |
| `.github/workflows/` | weekly data refresh, Pages deploy |

The refresh workflow stages a fetch, verifies it against the committed copy, and only promotes if it passes — a gate that has caught five real bugs, all of which produced plausible-looking wrong numbers.

> Educational backtest of historical data.
> Not financial advice, not a forecast.
> Figures are before tax and trading fees.
