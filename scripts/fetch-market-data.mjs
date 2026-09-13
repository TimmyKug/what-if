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
    id: "msci-world-eur",
    symbol: "EUNL.DE",
    name: "MSCI World",
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
