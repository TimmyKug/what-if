# Data

Start dates below are as the data stood in September 2026; they grow by one a month.

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
  Three hundred-odd ten-year windows drawn from 36 years are that many views of the same 36 years.

`AGENTS.md` has the engineering notes: the data traps already paid for, the MSCI licensing position, and why there is no consent banner.

## Terms, per source

The code in this repository is MIT licensed; the files in `data/` are not, because
they are not ours to relicense.
What is known about each, none of which is legal advice:

| Source | Position |
|---|---|
| **Eurostat** (rates, prices) | EU open data, reusable with attribution. |
| **US Bureau of Labor Statistics** (US prices) | US government work, public domain. |
| **UK Office for National Statistics** (UK prices) | Open Government Licence v3.0, attribution required. |
| **Fama/French** (Developed, US) | "Copyright Eugene F. Fama and Kenneth R. French", no stated licence. Universally used for research; publishing it should start with an email to Dartmouth. |
| **MSCI** (World, ACWI, EM) | MSCI's copyrighted index data, from an undocumented endpoint. Fine locally, not a basis for redistribution — see `AGENTS.md`. |
| **Market feeds** (ETFs, indices, crypto) | Terms generally prohibit redistribution. |

The two rows at the bottom are the reason this repository being public is a
question rather than a formality.
The free-and-clear foundation is Eurostat plus Fama/French with permission; the
rest are conveniences that could be dropped.
