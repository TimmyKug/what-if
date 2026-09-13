#!/usr/bin/env node
/**
 * Fetches DAILY history into `data/market-data-daily.json`.
 *
 * This sits alongside the monthly file rather than replacing it. Daily
 * conversion needs daily exchange rates, and the ECB's reference rates only
 * start in 1999 — so a converted series reaches further back at monthly
 * resolution than at daily. The app keeps both and picks per scenario.
 *
 *   node scripts/fetch-daily-data.mjs
 */
import { writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Where to read and write data. Overridable so a refresh can be staged. */
const DATA_DIR = process.env.DATA_DIR ?? "data";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", DATA_DIR, "market-data-daily.json");
// Six significant figures is exact enough for an index level or a share price;
// the resulting return is accurate to about 1e-6, and it keeps the payload small.
const round = (v) => Number(v.toPrecision(6));
const ymd = (s) => Number(s.replace(/-/g, ""));

const YAHOO = [
  { id: "msci-world-etf", symbol: "EUNL.DE", name: "MSCI World ETF (EUNL)",
    detail: "iShares Core MSCI World UCITS ETF from 2009 — a real tracker, not the index",
    currency: "EUR", adjusted: true },
  { id: "msci-world-index", symbol: "^990100-USD-STRD", name: "MSCI World (price only)",
    detail: "MSCI World price index from 1985 — excludes dividends, so it understates returns by roughly 2%/year",
    currency: "USD", adjusted: false },
  { id: "ftse-all-world", symbol: "VT", name: "FTSE Global All Cap",
    detail: "Vanguard Total World Stock ETF from 2008 — the FTSE index family, incl. small caps",
    currency: "USD", adjusted: true },
  { id: "sp500", symbol: "^SP500TR", name: "S&P 500",
    detail: "S&P 500 Total Return index (US large caps)", currency: "USD", adjusted: true },
  { id: "us-total-market", symbol: "VTSMX", name: "US Total Market",
    detail: "Vanguard Total Stock Market Index Fund", currency: "USD", adjusted: true },
];

const MSCI = [
  { id: "msci-world", code: "990100", name: "MSCI World (net return)",
    detail: "MSCI World Net Total Return index from 2000, computed by MSCI in each currency" },
  { id: "msci-acwi", code: "892400", name: "MSCI ACWI (net return)",
    detail: "MSCI ACWI Net Total Return from 2000 — developed plus emerging markets" },
];
// Only the two currencies most likely to be asked for are carried natively here.
// Unlike the monthly file, that costs nothing in history: the ECB's daily rates
// start in 1999 and MSCI's daily series only starts in 2000-12, so a converted
// currency reaches just as far back. Twelve native currencies would quadruple
// the payload to buy nothing but a rounding difference.
const MSCI_CURRENCIES = ["USD", "EUR"];

const FRENCH = [
  { id: "ff-developed", file: "Developed_3_Factors_Daily_CSV.zip", name: "Developed Markets",
    detail: "Every listed company in the developed world, weighted by market cap — the MSCI World universe, built from the underlying stocks by Fama/French. Gross of dividend withholding tax.",
    grossOfTax: true },
  { id: "ff-us", file: "F-F_Research_Data_Factors_daily_CSV.zip", name: "US Market (1926)",
    detail: "Every listed company in the US, weighted by market cap, back to 1926 — built from the underlying stocks by Fama/French. Gross of dividend withholding tax.",
    grossOfTax: true },
];

const FX = ["EUR", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "NZD", "SGD"];

async function yahooDaily(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=0&period2=${Math.floor(Date.now() / 1000)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  const values = r.indicators?.adjclose?.[0]?.adjclose ?? r.indicators?.quote?.[0]?.close;
  const offset = r.meta.gmtoffset ?? 0; // see the monthly script — local time, not UTC

  const byDay = new Map();
  r.timestamp.forEach((ts, i) => {
    const v = values[i];
    if (v == null || !Number.isFinite(v) || v <= 0) return;
    byDay.set(Number(new Date((ts + offset) * 1000).toISOString().slice(0, 10).replace(/-/g, "")), v);
  });
  const dates = [...byDay.keys()].sort((a, b) => a - b);
  return { dates, values: dates.map((d) => round(byDay.get(d))) };
}

async function msciDaily(code, currency) {
  const url = "https://app2.msci.com/products/service/index/indexmaster/getLevelDataForGraph" +
    `?currency_symbol=${currency}&index_variant=NETR&start_date=19970101` +
    `&end_date=${new Date().toISOString().slice(0, 10).replace(/-/g, "")}` +
    `&data_frequency=DAILY&index_codes=${code}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.msci.com/" } });
  const body = await res.json();
  if (body.error_message) throw new Error(`MSCI ${code}/${currency}: ${body.error_message.trim()}`);
  const rows = body.indexes.INDEX_LEVELS;
  return { dates: rows.map((r) => r.calc_date), values: rows.map((r) => round(r.level_eod)) };
}

function unzipSingle(buf) {
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  const size = buf.readUInt32LE(18);
  const body = size ? buf.subarray(start, start + size) : buf.subarray(start);
  return inflateRawSync(body).toString("latin1");
}

async function frenchDaily(file) {
  const res = await fetch(`https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/${file}`,
    { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const text = unzipSingle(Buffer.from(await res.arrayBuffer()));

  const dates = [];
  let level = 100;
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{8})\s*,\s*(-?[\d.]+)\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*(-?[\d.]+)/);
    if (!m) continue;
    const mkt = Number(m[2]), rf = Number(m[3]);
    if (mkt <= -99.98 || rf <= -99.98) continue;
    dates.push(Number(m[1]));
    values.push(round((level *= 1 + (mkt + rf) / 100)));
  }
  return { dates, values };
}

/**
 * ECB daily reference rates, returned as USD per unit to match the monthly file.
 * Fetched one currency at a time: asking for all of them in a single SDMX key
 * silently truncates the response at about 4.4MB, which drops whichever
 * currencies sort last (USD among them).
 */
async function ecbDaily() {
  const perEuro = {};
  // USD is the numeraire and so absent from FX, but its own rate is still needed
  // to express everything else in USD per unit.
  for (const code of ["USD", ...FX.filter((c) => c !== "EUR")]) {
    const url = `https://data-api.ecb.europa.eu/service/data/EXR/D.${code}.EUR.SP00.A` +
      `?format=csvdata&detail=dataonly`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`ECB ${code}: HTTP ${res.status}`);
    const text = await res.text();
    const [header, ...lines] = text.trim().split(/\r?\n/);
    const cols = header.split(",");
    const iTime = cols.indexOf("TIME_PERIOD"), iVal = cols.indexOf("OBS_VALUE");
    const table = new Map();
    for (const line of lines) {
      const f = line.split(",");
      const v = Number(f[iVal]);
      if (Number.isFinite(v) && v > 0) table.set(ymd(f[iTime]), v);
    }
    if (!table.size) throw new Error(`ECB ${code}: no observations`);
    perEuro[code] = table;
  }

  // One shared date axis: the ECB publishes every currency on the same days, and
  // repeating the dates twelve times was a third of the whole file.
  const usd = perEuro.USD;
  const dates = [...usd.keys()].sort((a, b) => a - b);
  const rates = {};
  for (const code of FX) {
    const table = code === "EUR" ? usd : perEuro[code];
    rates[code] = dates.map((d) => {
      const r = table.get(d);
      return r ? round(code === "EUR" ? usd.get(d) : usd.get(d) / r) : null;
    });
  }
  return { dates, rates };
}

const span = (s) => `${s.dates[0]} → ${s.dates.at(-1)}  ${s.dates.length} days`;

async function main() {
  const instruments = [];

  for (const spec of MSCI) {
    const byCurrency = {};
    let dates;
    for (const currency of MSCI_CURRENCIES) {
      const s = await msciDaily(spec.code, currency);
      dates ??= s.dates;
      if (s.dates.length !== dates.length) throw new Error(`MSCI ${spec.code}: ${currency} length mismatch`);
      byCurrency[currency] = s.values;
    }
    instruments.push({ id: spec.id, name: spec.name, detail: spec.detail, currency: "EUR",
      adjusted: true, dates, values: byCurrency.EUR, byCurrency });
    console.log(`${spec.name.padEnd(24)} ${dates[0]} → ${dates.at(-1)}  ${dates.length} days × ${MSCI_CURRENCIES.length} ccy`);
  }

  for (const spec of FRENCH) {
    const s = await frenchDaily(spec.file);
    instruments.push({ id: spec.id, name: spec.name, detail: spec.detail, currency: "USD",
      adjusted: true, grossOfTax: spec.grossOfTax, ...s });
    console.log(`${spec.name.padEnd(24)} ${span(s)}`);
  }

  for (const spec of YAHOO) {
    const s = await yahooDaily(spec.symbol);
    instruments.push({ id: spec.id, name: spec.name, detail: spec.detail,
      currency: spec.currency, adjusted: spec.adjusted, ...s });
    console.log(`${spec.name.padEnd(24)} ${span(s)}`);
  }

  const fx = await ecbDaily();
  console.log(`${"ECB daily rates".padEnd(24)} ${span(fx)} × ${FX.length} ccy`);

  await writeFile(OUT, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    resolution: "daily",
    source: "MSCI, Ken French Data Library, Yahoo Finance; exchange rates from the ECB",
    instruments, fx,
  }));
  console.log(`\nwrote ${OUT}`);
}

await main();
