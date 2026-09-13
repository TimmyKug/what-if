#!/usr/bin/env node
/**
 * Gate for a freshly fetched dataset, run before it replaces the committed one:
 *
 *   node scripts/verify-data.mjs <candidate-dir> [baseline-dir]
 *
 * Structural checks catch a malformed or truncated download. The comparison
 * against the baseline catches the subtler failure — a provider that still
 * returns well-formed JSON but has quietly changed what it means, renamed a
 * ticker onto different data, or shifted its calendar. Exits non-zero on any
 * failure, so a workflow can stop before overwriting anything.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [candidateDir, baselineDir = "data"] = process.argv.slice(2);
if (!candidateDir) {
  console.error("usage: node scripts/verify-data.mjs <candidate-dir> [baseline-dir]");
  process.exit(2);
}

const FILES = ["market-data.json", "market-data-daily.json"];
const REQUIRED = [
  "msci-world", "msci-acwi", "ff-developed", "ff-us",
  "sp500", "us-total-market", "ftse-all-world", "msci-world-etf", "msci-world-index",
  "bitcoin", "ethereum",
];

/**
 * A move this big is a data error rather than a market — except in crypto, where
 * it is a Tuesday. Ether really has moved 78% in a month and fallen 42% in a day.
 */
const IMPLAUSIBLE = { equity: 0.6, crypto: 2.5 };
const CURRENCIES = ["EUR", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "NZD", "SGD"];

/**
 * Prices are stored to six significant figures and providers re-adjust history
 * for splits and dividends, so a re-fetch never reproduces the previous returns
 * bit for bit. NOISE is the band where a difference means nothing; BREAK is the
 * size at which a single observation cannot be a revision — a one-period
 * calendar shift moves returns by whole percentage points.
 */
const NOISE = 1e-4;   // 0.01pp
const BREAK = 0.02;   // 2pp on any single observation

let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

// resolve, not join: a staging directory may be given as an absolute path.
const read = async (dir, file) => JSON.parse(await readFile(resolve(root, dir, file), "utf8"));
const keysOf = (i) => i.dates ?? i.months.map((m) => Number(m.replace("-", "")));

/** Returns keyed by the observation they end on, so two vintages can be compared. */
function returnsByKey(instrument) {
  const keys = keysOf(instrument);
  const out = new Map();
  for (let i = 1; i < keys.length; i++) {
    out.set(keys[i], instrument.values[i] / instrument.values[i - 1] - 1);
  }
  return out;
}

function structure(file, data) {
  console.log(`\n${file} — structure`);
  check(Array.isArray(data.instruments) && data.instruments.length > 0, "has instruments");
  check(typeof data.fetchedAt === "string" && !Number.isNaN(Date.parse(data.fetchedAt)), "has a valid fetchedAt");

  const ids = new Set(data.instruments.map((i) => i.id));
  const missing = REQUIRED.filter((id) => !ids.has(id));
  check(missing.length === 0, `every expected instrument present${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);

  for (const instrument of data.instruments) {
    const label = `${file}/${instrument.id}`;
    const keys = keysOf(instrument);

    if (keys.length !== instrument.values.length) { fail(`${label}: ${keys.length} keys vs ${instrument.values.length} values`); continue; }
    if (keys.length < 24) { fail(`${label}: only ${keys.length} observations`); continue; }

    const unsorted = keys.findIndex((k, i) => i > 0 && k <= keys[i - 1]);
    if (unsorted > 0) { fail(`${label}: keys not ascending at index ${unsorted} (${keys[unsorted - 1]} → ${keys[unsorted]})`); continue; }

    const bad = instrument.values.findIndex((v) => !Number.isFinite(v) || v <= 0);
    if (bad >= 0) { fail(`${label}: value ${instrument.values[bad]} at ${keys[bad]}`); continue; }

    const limit = IMPLAUSIBLE[instrument.assetClass === "crypto" ? "crypto" : "equity"];
    const jump = [...returnsByKey(instrument)].find(([, r]) => Math.abs(r) > limit);
    if (jump) { fail(`${label}: implausible ${(jump[1] * 100).toFixed(0)}% move at ${jump[0]}`); continue; }

    if (instrument.byCurrency) {
      const wrong = Object.entries(instrument.byCurrency).find(([, v]) => v.length !== keys.length);
      if (wrong) { fail(`${label}: byCurrency.${wrong[0]} has ${wrong[1].length} values, expected ${keys.length}`); continue; }
    }
    ok(`${label}: ${keys.length} observations, ${keys[0]}–${keys.at(-1)}`);
  }

  const fx = data.fx.rates ?? data.fx;
  const missingFx = CURRENCIES.filter((c) => !fx[c]);
  check(missingFx.length === 0, `every currency has rates${missingFx.length ? ` (missing ${missingFx.join(", ")})` : ""}`);
}

/**
 * The same observation must mean the same thing it did last time. Sources revise
 * occasionally, so a handful of tiny differences is fine; a wholesale change is
 * the signal that something upstream moved.
 */
function againstBaseline(file, candidate, baseline) {
  console.log(`\n${file} — against the committed data`);
  const previous = new Map(baseline.instruments.map((i) => [i.id, i]));

  for (const instrument of candidate.instruments) {
    const was = previous.get(instrument.id);
    if (!was) { ok(`${instrument.id}: new series, nothing to compare`); continue; }

    const before = keysOf(was).length;
    const now = keysOf(instrument).length;
    if (now < before) { fail(`${instrument.id}: lost history — ${before} observations became ${now}`); continue; }

    const oldReturns = returnsByKey(was);
    const newReturns = returnsByKey(instrument);
    let shared = 0, drifted = 0, worst = 0, worstKey = null;
    for (const [key, value] of oldReturns) {
      if (!newReturns.has(key)) continue;
      shared++;
      const delta = Math.abs(newReturns.get(key) - value);
      if (delta > NOISE) drifted++;
      if (delta > worst) { worst = delta; worstKey = key; }
    }

    if (shared < Math.min(24, oldReturns.size)) { fail(`${instrument.id}: only ${shared} observations overlap the previous data`); continue; }
    if (worst > BREAK) {
      fail(`${instrument.id}: ${(worst * 100).toFixed(2)}pp change at ${worstKey} — that is a different series, not a revision`);
      continue;
    }
    if (drifted / shared > 0.05) {
      fail(`${instrument.id}: ${drifted} of ${shared} shared returns moved more than ${(NOISE * 100).toFixed(2)}pp (worst ${(worst * 100).toFixed(3)}pp at ${worstKey})`);
      continue;
    }
    ok(`${instrument.id}: +${now - before} observations, ${shared} shared returns agree` +
       (worst ? ` (largest drift ${(worst * 100).toFixed(4)}pp)` : ""));
  }
}

for (const file of FILES) {
  const candidate = await read(candidateDir, file);
  structure(file, candidate);
  try {
    againstBaseline(file, candidate, await read(baselineDir, file));
  } catch {
    console.log(`\n${file} — no baseline at ${baselineDir}, skipping comparison`);
  }
}

console.log(`\n${failures ? `${failures} failed — refusing to promote` : "data verified"}`);
process.exit(failures ? 1 : 0);
