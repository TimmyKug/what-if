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
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Where to read and write data. Overridable so a refresh can be staged. */
const DATA_DIR = process.env.DATA_DIR ?? "data";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", DATA_DIR, "market-data.json");

/**
 * `adjusted: true` means the series is dividend-adjusted, i.e. a real
 * total-return series. `false` means price return only, which understates the
 * outcome, and the UI has to say so.
 */
const INSTRUMENTS = [
  {
    id: "msci-world-etf",
    symbol: "EUNL.DE",
    name: "MSCI World ETF (EUNL)",
    detail: "iShares Core MSCI World UCITS ETF from 2009 — a real tracker, not the index",
    currency: "EUR",
    adjusted: true,
  },
  {
    id: "msci-world-index",
    symbol: "^990100-USD-STRD",
    name: "MSCI World (price only)",
    detail: "MSCI World price index from 1985 — excludes dividends, so it understates returns by roughly 2%/year",
    currency: "USD",
    adjusted: false,
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
    // The FTSE-family counterpart to MSCI ACWI, and the index behind VWCE/VWRL.
    // Taken from the accumulating US listing: Yahoo's dividend adjustment on the
    // distributing European share class (VWRL.AS) is broken, trailing ACWI by
    // 1.9pp/year, while this one tracks it at 0.994 correlation.
    id: "ftse-all-world",
    symbol: "VT",
    name: "FTSE Global All Cap",
    detail: "Vanguard Total World Stock ETF from 2008 — the FTSE index family, incl. small caps",
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
  {
    id: "msci-em-ex-china",
    symbol: "EMXC",
    name: "MSCI EM ex China",
    detail: "iShares MSCI EM ex China ETF from 2017 — the only free record of this index, and a short one",
    currency: "USD",
    adjusted: true,
    assetClass: "emerging",
  },
  {
    // Crypto trades every day of the week, so these series carry roughly 365
    // observations a year where the equity ones carry about 261. Nothing needs
    // to special-case that: step counts are derived per series.
    id: "bitcoin",
    symbol: "BTC-USD",
    name: "Bitcoin",
    detail: "Bitcoin against the US dollar from 2014 — no dividends to reinvest, so the price is the whole return",
    currency: "USD",
    adjusted: true,
    assetClass: "crypto",
  },
  {
    id: "ethereum",
    symbol: "ETH-USD",
    name: "Ethereum",
    detail: "Ether against the US dollar from 2017 — no dividends to reinvest, so the price is the whole return",
    currency: "USD",
    adjusted: true,
    assetClass: "crypto",
  },
];

// USD per 1 unit of the currency. USD itself is the numeraire and needs no series.
const FX = ["EUR", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN"];

/**
 * The Fama/French research factors. These are monthly *returns*, not prices, so
 * they are accumulated into a synthetic index starting at 100 before the rest of
 * the pipeline sees them — `Mkt-RF + RF` is the value-weighted total return of
 * the market in USD.
 *
 * Note these are gross of dividend withholding tax, where an index like MSCI's
 * NETR is net of it. Over the 307-month overlap the two correlate at 0.9966, but
 * gross runs roughly 0.66pp/year hotter, so the UI has to say which it is.
 *
 * Daily files exist at the same URLs with `_daily` before `_CSV`, going back to
 * 1926-07-01 for the US series.
 */
const FRENCH = [
  {
    id: "ff-developed",
    file: "Developed_3_Factors_CSV.zip",
    name: "Developed Markets",
    detail: "Every listed company in the developed world, weighted by market cap — the MSCI World universe, built from the underlying stocks by Fama/French. Gross of dividend withholding tax.",
    grossOfTax: true,
  },
  {
    id: "ff-us",
    file: "F-F_Research_Data_Factors_CSV.zip",
    name: "US Market (1926)",
    detail: "Every listed company in the US, weighted by market cap, back to 1926 — built from the underlying stocks by Fama/French. Gross of dividend withholding tax.",
    grossOfTax: true,
  },
];

/** Reads the single deflated member out of a zip, without a zip dependency. */
function unzipSingle(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip file");
  const method = buffer.readUInt16LE(8);
  const start = 30 + buffer.readUInt16LE(26) + buffer.readUInt16LE(28);
  const size = buffer.readUInt32LE(18);
  const body = size ? buffer.subarray(start, start + size) : buffer.subarray(start);
  return (method === 0 ? body : inflateRawSync(body)).toString("latin1");
}

async function frenchFactors(file) {
  const res = await fetch(
    `https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/${file}`,
    { headers: { "User-Agent": "Mozilla/5.0" } },
  );
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const text = unzipSingle(Buffer.from(await res.arrayBuffer()));

  // Monthly rows are `YYYYMM, Mkt-RF, SMB, HML, RF`. The annual block further
  // down the same file uses four-digit dates, so it never matches.
  const months = [];
  const returns = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{4})(\d{2})\s*,\s*(-?[\d.]+)\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*(-?[\d.]+)/);
    if (!m) continue;
    const [mktRf, rf] = [Number(m[3]), Number(m[4])];
    if (mktRf <= -99.98 || rf <= -99.98) continue; // the file's missing-data marker
    months.push(`${m[1]}-${m[2]}`);
    returns.push((mktRf + rf) / 100);
  }
  if (!months.length) throw new Error(`${file}: no monthly rows parsed`);

  // Accumulate the returns into a price level so the rest of the pipeline, which
  // works in prices, needs no special case.
  let level = 100;
  const values = returns.map((r) => round((level *= 1 + r)));
  return { months, values };
}

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
    name: "MSCI World (net return)",
    detail: "MSCI World Net Total Return index from 2000, computed by MSCI in each currency",
  },
  {
    id: "msci-acwi",
    code: "892400",
    name: "MSCI ACWI (net return)",
    detail: "MSCI ACWI Net Total Return from 2000 — developed plus emerging markets",
  },
  {
    // Identified rather than assumed: this code's monthly returns correlate 0.974
    // with the iShares MSCI Emerging Markets ETF and only 0.910 with the ex-China
    // one, which is the wrong way round for anything else.
    id: "msci-em",
    code: "891800",
    name: "MSCI Emerging Markets",
    detail: "MSCI Emerging Markets Net Total Return from 2000, computed by MSCI in each currency",
    assetClass: "emerging",
  },
];

const MSCI_CURRENCIES = ["USD", "EUR", "GBP", "CHF", "SEK", "NOK", "DKK"];

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

  // Yahoo stamps each monthly bar at the first day of the month in *exchange-local*
  // time, which for a European listing is 22:00 or 23:00 UTC on the last day of the
  // month before. Reading it as UTC therefore labels every bar one month early, and
  // then pairs it with the wrong month's exchange rate. Shift by the exchange's own
  // offset before taking the month. (The last bar is stamped "today", so keeping the
  // last value seen per month still collapses it onto the right one.)
  const offset = result.meta.gmtoffset ?? 0;
  const byMonth = new Map();
  result.timestamp.forEach((ts, i) => {
    const v = values[i];
    if (v == null || !Number.isFinite(v) || v <= 0) return;
    const d = new Date((ts + offset) * 1000);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    byMonth.set(month, v);
  });

  const months = [...byMonth.keys()].sort();
  return { months, values: months.map((m) => round(byMonth.get(m))) };
}

const round = (v) => Number(v.toPrecision(8));

/**
 * Monthly exchange rates from Eurostat, which publishes a continuous euro/ECU
 * series back to 1971 — decades further than a market FX feed, and from an
 * official statistical source rather than a scraped endpoint.
 *
 * Eurostat quotes units of each currency per euro; the rest of this project
 * works in USD per unit, which is `rate(USD) / rate(currency)`.
 *
 * `statinfo=END` asks for the end-of-period rate rather than the monthly average.
 * That matters: the prices these convert are month-end closes, so an average rate
 * would pair a month-end price with a mid-month exchange rate and inject timing
 * noise into every converted return.
 */
async function eurostatRates() {
  const url =
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/ert_bil_eur_m" +
    "?format=JSON&statinfo=END&lang=en";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Eurostat: HTTP ${res.status}`);
  const body = await res.json();

  const currencies = body.dimension.currency.category.index;
  const times = body.dimension.time.category.index;
  const currencyAt = Object.fromEntries(Object.entries(currencies).map(([k, v]) => [v, k]));
  const timeAt = Object.fromEntries(Object.entries(times).map(([k, v]) => [v, k]));
  const axis = body.id.indexOf("currency");
  const timeAxis = body.id.indexOf("time");

  // JSON-stat flattens the dimensions into one index; unpick it back to coordinates.
  const perEuro = {};
  for (const [key, value] of Object.entries(body.value)) {
    let rest = Number(key);
    const coords = [];
    for (let i = body.size.length - 1; i >= 0; i--) { coords[i] = rest % body.size[i]; rest = Math.floor(rest / body.size[i]); }
    const code = currencyAt[coords[axis]];
    (perEuro[code] ??= new Map()).set(timeAt[coords[timeAxis]], value);
  }

  const usd = perEuro.USD;
  if (!usd) throw new Error("Eurostat: no USD series");

  const fx = {};
  for (const code of FX) {
    const table = code === "EUR" ? null : perEuro[code];
    if (code !== "EUR" && !table) throw new Error(`Eurostat: no ${code} series`);
    const months = [...(table ?? usd).keys()]
      .filter((m) => usd.has(m) && (table ? table.get(m) : 1))
      .sort();
    fx[code] = {
      months,
      // EUR is quoted against itself at 1, so its USD rate is just the USD row.
      values: months.map((m) => round(code === "EUR" ? usd.get(m) : usd.get(m) / table.get(m))),
    };
  }
  return fx;
}

/**
 * Consumer price indices, so results can be shown in the purchasing power of the
 * month a plan started rather than in nominal money.
 *
 * Eurostat's HICP is the only free source reachable without a key that covers
 * several currencies on one calendar; the OECD's is behind a bot check. It costs
 * two things, both of which the app states rather than hides: it begins in 1996,
 * and it has no series for JPY, CAD, AUD, NZD or SGD.
 */
const CPI_GEO = { EUR: "EA", CHF: "CH", SEK: "SE", NOK: "NO", DKK: "DK", PLN: "PL" };

/** US CPI-U from the BLS, which unlike Eurostat's US series is kept current. */
async function blsPrices() {
  const out = new Map();
  for (const [from, to] of [[1996, 2005], [2006, 2015], [2016, 2026]]) {
    const url = `https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0?startyear=${from}&endyear=${to}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`BLS ${from}-${to}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.status !== "REQUEST_SUCCEEDED") throw new Error(`BLS ${from}-${to}: ${body.message}`);
    for (const row of body.Results.series[0].data) {
      if (!/^M\d\d$/.test(row.period)) continue; // M13 is the annual average
      out.set(`${row.year}-${row.period.slice(1)}`, Number(row.value));
    }
  }
  const months = [...out.keys()].sort();
  return { months, values: months.map((m) => round(out.get(m))) };
}

/** UK CPI from the ONS, since Eurostat's UK series stops in 2020. */
async function onsPrices() {
  const url = "https://www.ons.gov.uk/generator?format=csv&uri=/economy/inflationandpriceindices/timeseries/d7bt/mm23";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`ONS: HTTP ${res.status}`);
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const out = new Map();
  for (const line of (await res.text()).split(/\r?\n/)) {
    const m = line.match(/^"(\d{4}) ([A-Z]{3})","([\d.]+)"/);
    if (!m) continue;
    const month = MONTHS.indexOf(m[2]);
    if (month < 0) continue;
    out.set(`${m[1]}-${String(month + 1).padStart(2, "0")}`, Number(m[3]));
  }
  const months = [...out.keys()].sort();
  if (!months.length) throw new Error("ONS: no monthly rows parsed");
  return { months, values: months.map((m) => round(out.get(m))) };
}

async function eurostatPrices() {
  const url =
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_midx" +
    "?format=JSON&unit=I15&coicop=CP00&lang=en" +
    Object.values(CPI_GEO).map((g) => `&geo=${g}`).join("");
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Eurostat HICP: HTTP ${res.status}`);
  const body = await res.json();

  const geoIndex = body.dimension.geo.category.index;
  const timeIndex = body.dimension.time.category.index;
  const geoAt = Object.fromEntries(Object.entries(geoIndex).map(([k, v]) => [v, k]));
  const timeAt = Object.fromEntries(Object.entries(timeIndex).map(([k, v]) => [v, k]));
  const geoAxis = body.id.indexOf("geo");
  const timeAxis = body.id.indexOf("time");

  const byGeo = {};
  for (const [key, value] of Object.entries(body.value)) {
    let rest = Number(key);
    const coords = [];
    for (let i = body.size.length - 1; i >= 0; i--) { coords[i] = rest % body.size[i]; rest = Math.floor(rest / body.size[i]); }
    (byGeo[geoAt[coords[geoAxis]]] ??= new Map()).set(timeAt[coords[timeAxis]], value);
  }

  const cpi = {};
  for (const [currency, geo] of Object.entries(CPI_GEO)) {
    const table = byGeo[geo];
    if (!table) throw new Error(`Eurostat HICP: no series for ${geo}`);
    const months = [...table.keys()].filter((m) => table.get(m) != null).sort();
    cpi[currency] = { months, values: months.map((m) => round(table.get(m))) };
  }
  return cpi;
}

async function main() {
  const instruments = [];
  for (const spec of INSTRUMENTS) {
    const { months, values } = await chart(spec.symbol);
    const { symbol, ...rest } = spec;
    instruments.push({ ...rest, months, values });
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
      name: index.name,
      detail: index.detail,
      assetClass: index.assetClass,
      currency: "EUR",
      adjusted: true,
      months,
      values: byCurrency.EUR,
      byCurrency,
    });
    console.log(`${index.name.padEnd(18)} ${months[0]} → ${months.at(-1)}  ${months.length} months × ${MSCI_CURRENCIES.length} currencies`);
  }

  for (const spec of FRENCH) {
    const { months, values } = await frenchFactors(spec.file);
    instruments.push({
      id: spec.id,
      name: spec.name,
      detail: spec.detail,
      currency: "USD",
      adjusted: true,
      grossOfTax: spec.grossOfTax,
      months,
      values,
    });
    console.log(`${spec.name.padEnd(18)} ${months[0]} → ${months.at(-1)}  ${months.length} months`);
  }

  const fx = await eurostatRates();
  for (const [code, series] of Object.entries(fx)) {
    console.log(`${`${code}/USD`.padEnd(18)} ${series.months[0]} → ${series.months.at(-1)}  ${series.months.length} months`);
  }

  const cpi = await eurostatPrices();
  cpi.USD = await blsPrices();
  cpi.GBP = await onsPrices();
  for (const [code, series] of Object.entries(cpi)) {
    console.log(`${`CPI ${code}`.padEnd(18)} ${series.months[0]} → ${series.months.at(-1)}  ${series.months.length} months`);
  }

  await writeFile(
    OUT,
    JSON.stringify({ fetchedAt: new Date().toISOString(), source: "Yahoo Finance", instruments, fx, cpi }),
  );
  console.log(`\nwrote ${OUT}`);
}

await main();
