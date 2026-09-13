#!/usr/bin/env node
/**
 * Fetches monthly history for the supported instruments and FX rates from the
 * Yahoo Finance chart endpoint and writes `data/market-data.json`.
 *
 * The output is committed so the app runs as a static site with no API key and
 * no network access at runtime. Re-run this to refresh the history:
 *
 *   node scripts/fetch-market-data.mjs
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "market-data.json");

/**
 * `adjusted: true` means the series is dividend-adjusted, i.e. a real
 * total-return series. `false` means price return only, which understates the
 * outcome, and the UI has to say so.
 */
const INSTRUMENTS = [
  {
    id: "msci-world-etf",
    symbol: "EUNL.DE",
    name: "MSCI World ETF",
    detail: "iShares Core MSCI World UCITS ETF (EUNL, Xetra, accumulating)",
    currency: "EUR",
    adjusted: true,
  },
  {
    id: "msci-world-index",
    symbol: "^990100-USD-STRD",
    name: "MSCI World Index",
    detail: "MSCI World price index, long history, excludes dividends",
    currency: "USD",
    adjusted: false,
  },
  {
    id: "msci-acwi",
    symbol: "ACWI",
    name: "MSCI ACWI",
    detail: "iShares MSCI ACWI ETF (world incl. emerging markets)",
    currency: "USD",
    adjusted: true,
  },
  {
    id: "sp500",
    symbol: "^SP500TR",
    name: "S&P 500",
    detail: "S&P 500 Total Return index (US large caps)",
    currency: "USD",
    adjusted: true,
  },
  {
    id: "us-total-market",
    symbol: "VTSMX",
    name: "US Total Market",
    detail: "Vanguard Total Stock Market Index Fund",
    currency: "USD",
    adjusted: true,
  },
];

// USD per 1 unit of the currency. USD itself is the numeraire and needs no series.
const FX = ["EUR", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "NZD", "SGD"];

/**
 * MSCI computes its indices separately in each currency, so these come back
 * already denominated — no exchange-rate series in the middle, and none of the
 * history lost to one. PLN is deliberately absent: MSCI only publishes it from
 * late 2025, so it falls back to converting the USD series.
 *
 * `NETR` is the net total return variant, i.e. dividends reinvested after
 * withholding tax, which is what a UCITS ETF actually tracks. The same endpoint
 * serves `DAILY` instead of `END_OF_MONTH` if per-day start dates are ever wanted.
 */
const MSCI_INDICES = [
  {
    id: "msci-world",
    code: "990100",
    name: "MSCI World",
    detail: "MSCI World Net Total Return index, computed by MSCI in each currency",
  },
];

const MSCI_CURRENCIES = ["USD", "EUR", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "NZD", "SGD"];

async function msciLevels(code, currency) {
  const url =
    "https://app2.msci.com/products/service/index/indexmaster/getLevelDataForGraph" +
    `?currency_symbol=${currency}&index_variant=NETR&start_date=19970101` +
    `&end_date=${new Date().toISOString().slice(0, 10).replace(/-/g, "")}` +
    `&data_frequency=END_OF_MONTH&index_codes=${code}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.msci.com/" },
  });
  if (!res.ok) throw new Error(`MSCI ${code}/${currency}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error_message) throw new Error(`MSCI ${code}/${currency}: ${body.error_message.trim()}`);

  const byMonth = new Map();
  for (const row of body.indexes.INDEX_LEVELS) {
    const d = String(row.calc_date);
    byMonth.set(`${d.slice(0, 4)}-${d.slice(4, 6)}`, row.level_eod);
  }
  const months = [...byMonth.keys()].sort();
  return { months, values: months.map((m) => round(byMonth.get(m))) };
}

async function chart(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1mo&period1=0&period2=${Math.floor(Date.now() / 1000)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const result = (await res.json())?.chart?.result?.[0];
  if (!result) throw new Error(`${symbol}: no result in response`);

  const adjclose = result.indicators?.adjclose?.[0]?.adjclose;
  const close = result.indicators?.quote?.[0]?.close;
  const values = adjclose ?? close;
  if (!values) throw new Error(`${symbol}: no price series`);

  // Yahoo dates the last bar "today" rather than the first of the month, so key
  // by month and keep the last observation seen for each one.
  const byMonth = new Map();
  result.timestamp.forEach((ts, i) => {
    const v = values[i];
    if (v == null || !Number.isFinite(v) || v <= 0) return;
    const d = new Date(ts * 1000);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    byMonth.set(month, v);
  });

  const months = [...byMonth.keys()].sort();
  return { months, values: months.map((m) => round(byMonth.get(m))) };
}

const round = (v) => Number(v.toPrecision(8));

async function main() {
  const instruments = [];
  for (const spec of INSTRUMENTS) {
    const { months, values } = await chart(spec.symbol);
    instruments.push({ ...spec, months, values });
    console.log(`${spec.symbol.padEnd(18)} ${months[0]} → ${months.at(-1)}  ${months.length} months`);
  }

  for (const index of MSCI_INDICES) {
    const byCurrency = {};
    let months;
    for (const currency of MSCI_CURRENCIES) {
      const series = await msciLevels(index.code, currency);
      months ??= series.months;
      if (series.months.length !== months.length) {
        throw new Error(`MSCI ${index.code}: ${currency} has ${series.months.length} months, expected ${months.length}`);
      }
      byCurrency[currency] = series.values;
    }
    instruments.unshift({
      id: index.id,
      symbol: index.code,
      name: index.name,
      detail: index.detail,
      currency: "EUR",
      adjusted: true,
      months,
      values: byCurrency.EUR,
      byCurrency,
    });
    console.log(`${index.name.padEnd(18)} ${months[0]} → ${months.at(-1)}  ${months.length} months × ${MSCI_CURRENCIES.length} currencies`);
  }

  const fx = {};
  for (const code of FX) {
    const { months, values } = await chart(`${code}USD=X`);
    fx[code] = { months, values };
    console.log(`${code}/USD${" ".repeat(12)} ${months[0]} → ${months.at(-1)}  ${months.length} months`);
  }

  await writeFile(
    OUT,
    JSON.stringify({ fetchedAt: new Date().toISOString(), source: "Yahoo Finance", instruments, fx }, null, 1),
  );
  console.log(`\nwrote ${OUT}`);
}

await main();
