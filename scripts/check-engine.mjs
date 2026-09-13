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
import {
  normalise, longestRun, ratesFor, buildSeries, runScenario,
  contributionDays, observationsPerYear, dayNumber,
} from "../engine.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR ?? "data";
const load = async (f) => normalise(JSON.parse(await readFile(join(root, DATA_DIR, f), "utf8")));
const monthly = await load("market-data.json");
const daily = await load("market-data-daily.json");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("calendar");
check("longestRun keeps a gap-free run whole", String(longestRun([202001, 202002, 202003])) === "0,3");
check("longestRun picks the longer side of a gap", String(longestRun([202001, 202106, 202107, 202108])) === "1,4");
check("dayNumber advances by one per calendar day", dayNumber(20200302) - dayNumber(20200301) === 1);
check("dayNumber crosses a leap day", dayNumber(20200301) - dayNumber(20200228) === 2);

console.log("\ncontribution schedule");
// Mon 6 Jan 2020 through Fri 17 Jan, weekends absent, plus the 3rd of February.
const tradingDays = [20200106, 20200107, 20200108, 20200109, 20200110,
                     20200113, 20200114, 20200115, 20200116, 20200117, 20200203];
const flags = (c) => Array.from(contributionDays(tradingDays, c, true)).join("");
check("daily cadence buys every trading day", flags("daily") === "1".repeat(11));
check("weekly cadence buys once per week", flags("weekly") === "10000100001", flags("weekly"));
check("monthly cadence buys once per month", flags("monthly") === "10000000001", flags("monthly"));
check("monthly data always contributes", Array.from(contributionDays([202001, 202002], "monthly", false)).join("") === "11");
check("a weekly buy lands on the first trading day of the week",
  Array.from(contributionDays(tradingDays, "weekly", true))[5] === 1);

console.log("\nfx");
const filled = ratesFor({ X: { keys: [202001, 202003], values: [2, 4] } }, "X", [201912, 202001, 202002, 202003]);
check("missing rate before the series is null", filled[0] === null);
check("known rates pass through", filled[1] === 2 && filled[3] === 4);
check("gaps carry the last known rate forward", filled[2] === 2);
check("USD needs no series", ratesFor({}, "USD", [202001])[0] === 1);

console.log("\nengine");
const flat = { keys: [1, 2, 3, 4], returns: [0, 0, 0], daily: false };
const flatRun = runScenario(flat, { steps: 3, initial: 500, contribution: 100 });
check("flat market returns exactly what was paid in", flatRun.paths.median.at(-1) === 800);
check("paid-in line matches the plan", String(flatRun.paidIn) === "500,600,700,800");
check("a solvent plan reports no depletion", flatRun.depleted === 0);

const grow = { keys: [1, 2], returns: [0.1], daily: false };
check("return is applied before the contribution",
  runScenario(grow, { steps: 1, initial: 1000, contribution: 100 }).paths.median.at(-1) === 1200);

const drain = { keys: [1, 2, 3, 4], returns: [0, 0, 0], daily: false };
const drainRun = runScenario(drain, { steps: 3, initial: 150, contribution: -100 });
check("a portfolio that runs dry stops at zero", String(drainRun.paths.median) === "150,50,0,0");
check("the month it ran dry is recorded", drainRun.picks.median.depletedAt === 2);
check("depleted windows are counted", drainRun.depleted === 1);

// Aggregates must describe the same windows the picked paths came from.
const varied = { keys: [1, 2, 3, 4, 5], returns: [0.1, -0.2, 0.3, -0.1], daily: false };
const v = runScenario(varied, { steps: 2, initial: 100, contribution: 0 });
check("best and worst bracket the average",
  v.paths.best.at(-1) >= v.paths.average.at(-1) && v.paths.average.at(-1) >= v.paths.worst.at(-1));
check("the envelope contains every drawn path",
  v.paths.best.every((b, t) => b <= v.envelope.high[t] + 1e-9 && b >= v.envelope.low[t] - 1e-9));
check("window count is right", v.windows === 3);

for (const [label, data] of [["monthly", monthly], ["daily", daily]]) {
  console.log(`\n${label} dataset`);
  const perYear = observationsPerYear(data.instruments[0].keys, data.daily);
  check(`${label}: observations per year look right`,
    data.daily ? perYear > 240 && perYear < 262 : perYear === 12, perYear.toFixed(1));

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

for (const [label, data] of [["monthly", monthly], ["daily", daily]]) {
  const size = data.daily ? 5 : 1;
  const world = buildSeries(data, data.instruments.find((i) => i.id === "msci-world"), "USD");
  for (const instrument of data.instruments) {
    if (instrument.id === "msci-world") continue;
    const series = buildSeries(data, instrument, "USD");
    const r = blocks(series, world, size);
    check(`${label}/${instrument.id}: returns line up with MSCI World`, r > 0.85, `correlation ${r.toFixed(4)}`);

    const lagged = [-2, -1, 1, 2].map((l) => blocks(series, world, 1, l));
    check(`${label}/${instrument.id}: correlation peaks at lag zero`,
      blocks(series, world, 1) > Math.max(...lagged),
      `lag0 ${blocks(series, world, 1).toFixed(3)} vs ${lagged.map((v) => v.toFixed(3)).join("/")}`);
  }
}

console.log("\nstart dates for a 10-year plan");
for (const [label, data] of [["monthly", monthly], ["daily", daily]]) {
  for (const instrument of data.instruments) {
    const s = buildSeries(data, instrument, "EUR");
    const steps = Math.round(10 * observationsPerYear(s.keys, s.daily));
    const r = runScenario(s, { steps, initial: 0, contribution: 100, cadence: "monthly" });
    console.log(`  ${label.padEnd(8)} ${instrument.id.padEnd(17)} ${String(r ? r.windows : 0).padStart(6)} starts (from ${s.keys[0]})`);
  }
}

console.log(`\n${failures ? `${failures} failed` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
