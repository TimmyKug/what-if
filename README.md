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

Thirteen series to choose from, in eight currencies, going back as far as 1926.

The whole scenario lives in the URL, so a link is the unit of sharing, a bookmark the unit of saving, and a second tab the unit of comparison.
Scenarios can also be saved by name in the browser; nothing is stored until you press Save.

Two things it says on screen rather than hiding:

- A series that begins after a crash will flatter a plan, so wherever a longer comparable one exists, the app names it and states its worst outcome.
- Overlapping windows are not independent samples.
  313 ten-year windows drawn from 36 years are 313 views of the same 36 years.

## More

- [`docs/data.md`](docs/data.md) — every series, where it comes from, and what each one costs you.
- [`AGENTS.md`](AGENTS.md) — running it, conventions, and the data traps already paid for.

> Educational backtest of historical data.
> Not financial advice, not a forecast.
> Figures are before tax and trading fees.
