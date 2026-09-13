#!/usr/bin/env node
/**
 * Smoke test for the backtest engine, run against the committed market data:
 *
 *   node scripts/check-engine.mjs
 *
 * Exits non-zero on the first failed assertion.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildSeries, longestRun, ratesFor, runScenario } from "../engine.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(await readFile(join(root, "data", "market-data.json"), "utf8"));

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

console.log("calendar");
check("longestRun keeps a gap-free run whole", String(longestRun(["2020-01", "2020-02", "2020-03"])) === "0,3");
check("longestRun picks the longer side of a gap", String(longestRun(["2020-01", "2021-06", "2021-07", "2021-08"])) === "1,4");
check("longestRun handles a single month", String(longestRun(["2020-01"])) === "0,1");

console.log("\nfx");
const filled = ratesFor({ X: { months: ["2020-01", "2020-03"], values: [2, 4] } }, "X", ["2019-12", "2020-01", "2020-02", "2020-03"]);
check("missing rate before the series is null", filled[0] === null);
check("known rates pass through", filled[1] === 2 && filled[3] === 4);
check("gaps carry the last known rate forward", filled[2] === 2, `got ${filled[2]}`);
check("USD needs no series", ratesFor({}, "USD", ["2020-01"])[0] === 1);

console.log("\nengine");
// A flat market: nothing compounds, so the balance is exactly what was paid in.
const flat = { months: ["a", "b", "c", "d"], returns: [0, 0, 0], converted: false };
const flatRun = runScenario(flat, { horizonMonths: 3, initial: 500, monthly: 100 });
check("flat market returns exactly what was paid in", flatRun.paths.median.at(-1) === 800);
check("paid-in line matches the plan", String(flatRun.paidIn) === "500,600,700,800");

// Return is applied before the month's payment, so month 1 pays in after growth.
const grow = { months: ["a", "b"], returns: [0.1], converted: false };
const growRun = runScenario(grow, { horizonMonths: 1, initial: 1000, monthly: 100 });
check("return is applied before the monthly payment", growRun.paths.median.at(-1) === 1200);

// Withdrawals bigger than the balance empty the portfolio rather than going negative.
const drain = { months: ["a", "b", "c", "d"], returns: [0, 0, 0], converted: false };
const drainRun = runScenario(drain, { horizonMonths: 3, initial: 150, monthly: -100 });
check("a portfolio that runs dry stops at zero", String(Array.from(drainRun.paths.median)) === "150,50,0,0");
check("the month it ran dry is recorded", drainRun.windows[0].depletedAt === 2);
check("depleted windows are counted", drainRun.depleted === 1);
check("a solvent plan reports no depletion", flatRun.depleted === 0);

console.log("\nseries");
for (const instrument of data.instruments) {
  const base = buildSeries(data, instrument, instrument.currency);
  check(`${instrument.id}: unconverted series is gap-free and complete`,
    !base.converted && base.returns.length === instrument.months.length - 1,
    `${base.returns.length} vs ${instrument.months.length - 1}`);

  const usd = buildSeries(data, instrument, "USD");
  const eur = buildSeries(data, instrument, "EUR");
  check(`${instrument.id}: converts to USD and EUR with history left`,
    usd.returns.length > 24 && eur.returns.length > 24,
    `usd ${usd.returns.length}, eur ${eur.returns.length}`);
  check(`${instrument.id}: every return is a finite number`,
    [...usd.returns, ...eur.returns].every(Number.isFinite));

  // Converting to the currency the series is already quoted in must be a no-op.
  const self = buildSeries(data, instrument, instrument.currency);
  check(`${instrument.id}: self-conversion changes nothing`,
    self.returns.every((r, i) => near(r, base.returns[i])));
}

// A EUR-quoted series viewed in USD should differ from the EUR view by roughly
// the exchange-rate move over the same window.
const eunl = data.instruments.find((i) => i.id === "msci-world-eur");
const inEur = buildSeries(data, eunl, "EUR");
const inUsd = buildSeries(data, eunl, "USD");
const growth = (s) => s.returns.reduce((acc, r) => acc * (1 + r), 1);
const fxMove = data.fx.EUR.values.at(-1) / data.fx.EUR.values[data.fx.EUR.months.indexOf(inEur.months[0])];
check("EUR→USD view differs from EUR view by the exchange-rate move",
  near(growth(inUsd) / growth(inEur), fxMove, 0.02),
  `ratio ${(growth(inUsd) / growth(inEur)).toFixed(4)} vs fx ${fxMove.toFixed(4)}`);

console.log(`\n${failures ? `${failures} failed` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
