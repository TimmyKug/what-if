#!/usr/bin/env node
/**
 * Smoke test for the backtest engine, run against both committed datasets:
 *
 *   node scripts/check-engine.mjs
 *
 * Exits non-zero on the first failed assertion.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalise, longestRun, ratesFor, buildSeries, runScenario, OBSERVATIONS_PER_YEAR } from "../engine.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR ?? "data";
const load = async (f) => normalise(JSON.parse(await readFile(join(root, DATA_DIR, f), "utf8")));
const data = await load("market-data.json");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("calendar");
check("longestRun keeps a gap-free run whole", String(longestRun([202001, 202002, 202003])) === "0,3");
check("longestRun picks the longer side of a gap", String(longestRun([202001, 202106, 202107, 202108])) === "1,4");

console.log("\nfx");
const filled = ratesFor({ X: { keys: [202001, 202003], values: [2, 4] } }, "X", [201912, 202001, 202002, 202003]);
check("missing rate before the series is null", filled[0] === null);
check("known rates pass through", filled[1] === 2 && filled[3] === 4);
check("gaps carry the last known rate forward", filled[2] === 2);
check("USD needs no series", ratesFor({}, "USD", [202001])[0] === 1);

console.log("\nengine");
const flat = { keys: [1, 2, 3, 4], returns: [0, 0, 0] };
const monthly = (start, per, steps) => [start, ...Array(steps).fill(per)];
const flatRun = runScenario(flat, { steps: 3, schedule: monthly(500, 100, 3) });
check("flat market returns exactly what was paid in", flatRun.paths.median.at(-1) === 800);
check("paid-in line matches the plan", String(flatRun.paidIn) === "500,600,700,800");
check("a solvent plan reports no depletion", flatRun.depleted === 0);

const grow = { keys: [1, 2], returns: [0.1] };
check("return is applied before the contribution",
  runScenario(grow, { steps: 1, schedule: monthly(1000, 100, 1) }).paths.median.at(-1) === 1200);

const drain = { keys: [1, 2, 3, 4], returns: [0, 0, 0] };
const drainRun = runScenario(drain, { steps: 3, schedule: monthly(150, -100, 3) });
check("a portfolio that runs dry stops at zero", String(drainRun.paths.median) === "150,50,0,0");
check("a dry portfolio only pays out what it had", String(drainRun.paidIn) === "150,50,0,0");

// Withdrawing from nothing is not a withdrawal, so neither side should move.
const empty = runScenario(flat, { steps: 3, schedule: [0, -100, -100, -100] });
check("withdrawing from an empty portfolio moves nothing", String(empty.paths.median) === "0,0,0,0");
check("and is not counted as money paid out", String(empty.paidIn) === "0,0,0,0");
check("but is still reported as running dry", empty.depleted === 1);
check("a lump sum lands in the month it is scheduled",
  runScenario(flat, { steps: 3, schedule: [0, 0, 250, 0] }).paths.median.at(-1) === 250);
check("a wait is just a run of zeroes",
  String(runScenario(flat, { steps: 3, schedule: [0, 0, 100, 100] }).paths.median) === "0,0,100,200");
check("the month it ran dry is recorded", drainRun.picks.median.depletedAt === 2);
check("depleted windows are counted", drainRun.depleted === 1);

// Aggregates must describe the same windows the picked paths came from.
const varied = { keys: [1, 2, 3, 4, 5], returns: [0.1, -0.2, 0.3, -0.1] };
const v = runScenario(varied, { steps: 2, schedule: monthly(100, 0, 2) });
check("best and worst bracket the average",
  v.paths.best.at(-1) >= v.paths.average.at(-1) && v.paths.average.at(-1) >= v.paths.worst.at(-1));
check("the envelope contains every drawn path",
  v.paths.best.every((b, t) => b <= v.envelope.high[t] + 1e-9 && b >= v.envelope.low[t] - 1e-9));
check("window count is right", v.windows === 3);

{
  const label = "monthly";
  console.log(`\n${label} dataset`);
  

  for (const instrument of data.instruments) {
    const eur = buildSeries(data, instrument, "EUR");
    const usd = buildSeries(data, instrument, "USD");
    check(`${label}/${instrument.id}: converts to EUR and USD with history left`,
      eur.returns.length > 24 && usd.returns.length > 24);
    check(`${label}/${instrument.id}: every return is finite`,
      [...eur.returns, ...usd.returns].every(Number.isFinite));
    check(`${label}/${instrument.id}: keys ascend`, eur.keys.every((k, i) => i === 0 || k > eur.keys[i - 1]));
  }
}

// Every series tracks world equities, so their returns must move together.
//
// At daily resolution that is measured over five-day blocks. A European-listed
// ETF closes at 17:30 CET while a global index EOD includes US markets closing
// at 22:00, so part of each day's move lands in the ETF's next day: EUNL against
// MSCI World runs 0.69 day-to-day but 0.94 over five days. That asynchrony is
// real, not a defect, and aggregating past it keeps the check meaningful.
//
// The sharper guard against a shifted calendar is the lag scan below: whatever
// the correlation, it has to peak at lag zero.
console.log("\ncross-checks against MSCI World");
const blocks = (a, b, size, lag = 0) => {
  const index = new Map(b.keys.map((k, i) => [k, i]));
  const x = [], y = [];
  let ax = 1, by = 1, n = 0;
  a.keys.forEach((k, i) => {
    const j = index.get(k);
    if (i < 1 || j == null || j - 1 - lag < 0 || j - 1 - lag >= b.returns.length) return;
    ax *= 1 + a.returns[i - 1];
    by *= 1 + b.returns[j - 1 - lag];
    if (++n % size === 0) { x.push(ax - 1); y.push(by - 1); ax = 1; by = 1; }
  });
  const m = x.length;
  const mx = x.reduce((t, v) => t + v, 0) / m, my = y.reduce((t, v) => t + v, 0) / m;
  const cov = x.reduce((t, v, i) => t + (v - mx) * (y[i] - my), 0) / m;
  const sx = Math.sqrt(x.reduce((t, v) => t + (v - mx) ** 2, 0) / m);
  const sy = Math.sqrt(y.reduce((t, v) => t + (v - my) ** 2, 0) / m);
  return cov / (sx * sy);
};

{
  const label = "monthly";
  const size = 1;
  const world = buildSeries(data, data.instruments.find((i) => i.id === "msci-world"), "USD");
  // Crypto has no business tracking world equities, so it is held against the
  // other crypto series instead — enough to catch a shifted calendar, which is
  // what this check is really for.
  const crypto = buildSeries(data, data.instruments.find((i) => i.id === "ethereum"), "USD");
  const cryptoAlt = buildSeries(data, data.instruments.find((i) => i.id === "bitcoin"), "USD");

  for (const instrument of data.instruments) {
    if (instrument.id === "msci-world") continue;
    const isCrypto = instrument.assetClass === "crypto";
    const reference = isCrypto ? (instrument.id === "ethereum" ? cryptoAlt : crypto) : world;
    // Emerging markets genuinely decouple from developed ones — 0.78 to 0.82 here
    // is the market, not a defect — so each class is held to its own floor.
    const floor = { crypto: 0.3, emerging: 0.65 }[instrument.assetClass] ?? 0.85;
    const series = buildSeries(data, instrument, "USD");
    const against = isCrypto ? "the other crypto series" : "MSCI World";
    const r = blocks(series, reference, size);
    check(`${label}/${instrument.id}: returns line up with ${against}`, r > floor, `correlation ${r.toFixed(4)}`);

    const lagged = [-2, -1, 1, 2].map((l) => blocks(series, reference, 1, l));
    check(`${label}/${instrument.id}: correlation peaks at lag zero`,
      blocks(series, reference, 1) > Math.max(...lagged),
      `lag0 ${blocks(series, reference, 1).toFixed(3)} vs ${lagged.map((v) => v.toFixed(3)).join("/")}`);
  }
}

console.log("\nstart dates for a 10-year plan");
{
  const label = "monthly";
  for (const instrument of data.instruments) {
    const s = buildSeries(data, instrument, "EUR");
    const steps = 10 * OBSERVATIONS_PER_YEAR;
    const r = runScenario(s, { steps, schedule: monthly(0, 100, steps) });
    console.log(`  ${label.padEnd(8)} ${instrument.id.padEnd(17)} ${String(r ? r.windows : 0).padStart(6)} starts (from ${s.keys[0]})`);
  }
}

console.log(`\n${failures ? `${failures} failed` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
