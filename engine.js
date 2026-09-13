/**
 * The pure part of "What if?": calendar helpers, currency conversion, and the
 * backtest itself. No DOM, so it can be exercised from Node — see
 * `scripts/check-engine.mjs`.
 *
 * A series is an ascending array of integer `keys` (YYYYMM) alongside its
 * values, and everything below is written against that shape.
 */

/* ------------------------------------------------------------------ shapes */

/** Folds the file into `{ keys, values }` form, keys being YYYYMM integers. */
function normalise(data) {
  const toKey = (m) => Number(m.replace("-", ""));
  const instruments = data.instruments.map((i) => ({ ...i, keys: i.months.map(toKey) }));
  const fx = {};
  for (const [code, table] of Object.entries(data.fx)) {
    fx[code] = { keys: table.months.map(toKey), values: table.values };
  }
  return { ...data, instruments, fx };
}

const keyYear = (k) => Math.floor(k / 100);
const keyMonth = (k) => k % 100;

function keyLabel(k) {
  return new Date(Date.UTC(keyYear(k), keyMonth(k) - 1, 1))
    .toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

/* ---------------------------------------------------------------- calendar */

/** Longest run of consecutive calendar months, as a `[start, end)` index pair. */
function longestRun(keys) {
  const step = (k) => keyYear(k) * 12 + keyMonth(k);
  let bestStart = 0, bestLen = 0, runStart = 0;
  for (let i = 1; i <= keys.length; i++) {
    const broken = i === keys.length || step(keys[i]) !== step(keys[i - 1]) + 1;
    if (broken) {
      if (i - runStart > bestLen) { bestLen = i - runStart; bestStart = runStart; }
      runStart = i;
    }
  }
  return [bestStart, bestStart + bestLen];
}


/* ------------------------------------------------------- currency handling */

/** Values of `code` per key, carrying the last known rate across gaps. */
function ratesFor(fx, code, keys) {
  if (code === "USD") return keys.map(() => 1);
  const table = fx[code];
  if (!table) return keys.map(() => null);

  let carried = null;
  let cursor = 0;
  return keys.map((k) => {
    while (cursor < table.keys.length && table.keys[cursor] <= k) {
      const v = table.values[cursor++];
      if (v != null) carried = v;
    }
    return carried;
  });
}

/**
 * The instrument's price history expressed in `currency`, trimmed to where
 * every input exists.
 */
function buildSeries(data, instrument, currency) {
  const denominated = instrument.byCurrency?.[currency];
  if (denominated) {
    const [from, to] = longestRun(instrument.keys);
    const keys = instrument.keys.slice(from, to);
    const prices = denominated.slice(from, to);
    return {
      keys,
      returns: prices.slice(1).map((p, i) => p / prices[i] - 1),
      converted: false, denominated: true,
    };
  }

  const native = ratesFor(data.fx, instrument.currency, instrument.keys);
  const display = ratesFor(data.fx, currency, instrument.keys);

  const keys = [];
  const prices = [];
  instrument.keys.forEach((k, i) => {
    if (native[i] == null || display[i] == null) return;
    keys.push(k);
    prices.push(instrument.values[i] * (native[i] / display[i]));
  });

  const [from, to] = longestRun(keys);
  const kept = keys.slice(from, to);
  const keptPrices = prices.slice(from, to);

  return {
    keys: kept,
    returns: keptPrices.slice(1).map((p, i) => p / keptPrices[i] - 1),
    converted: instrument.currency !== currency,
    denominated: false,
  };
}

/* ------------------------------------------------------------------ engine */

/**
 * Replays the plan once per possible start month.
 *
 * Two passes: the first keeps only the final values and the running aggregates,
 * the second replays the three windows actually drawn. Cheap here, and it keeps
 * memory flat in the number of windows rather than growing with it.
 *
 * Within a month the return is applied first and the contribution second, so a
 * contribution never earns the return of the month it arrives in.
 */
function runScenario(series, { steps, initial, contribution }) {
  const { returns, keys } = series;
  const windows = returns.length - steps + 1;
  if (windows < 1 || steps < 1) return null;

  const finals = new Float64Array(windows);
  const depletedIn = new Uint8Array(windows);
  const sum = new Float64Array(steps + 1);
  const paidSum = new Float64Array(steps + 1);
  const low = new Float64Array(steps + 1).fill(Infinity);
  const high = new Float64Array(steps + 1).fill(-Infinity);

  for (let s = 0; s < windows; s++) {
    let balance = initial;
    let paid = initial;
    let depleted = 0;
    sum[0] += balance; paidSum[0] += paid;
    if (balance < low[0]) low[0] = balance;
    if (balance > high[0]) high[0] = balance;

    for (let t = 1; t <= steps; t++) {
      const i = s + t - 1;
      balance *= 1 + returns[i];
      balance += contribution;
      paid += contribution;
      if (balance < 0) { balance = 0; depleted = 1; }
      sum[t] += balance; paidSum[t] += paid;
      if (balance < low[t]) low[t] = balance;
      if (balance > high[t]) high[t] = balance;
    }
    finals[s] = balance;
    depletedIn[s] = depleted;
  }

  const order = Array.from(finals.keys()).sort((a, b) => finals[a] - finals[b]);
  const pick = { worst: order[0], median: order[(order.length - 1) >> 1], best: order.at(-1) };

  const replay = (start) => {
    const path = new Array(steps + 1);
    const paidIn = new Array(steps + 1);
    let balance = initial, paid = initial, depletedAt = null;
    path[0] = balance; paidIn[0] = paid;
    for (let t = 1; t <= steps; t++) {
      const i = start + t - 1;
      balance *= 1 + returns[i];
      balance += contribution;
      paid += contribution;
      if (balance < 0) { balance = 0; depletedAt ??= t; }
      path[t] = balance; paidIn[t] = paid;
    }
    return { path, paidIn, depletedAt, startKey: keys[start], endKey: keys[start + steps] };
  };

  const picks = {
    best: replay(pick.best), median: replay(pick.median), worst: replay(pick.worst),
  };

  return {
    windows, steps,
    paths: {
      best: picks.best.path, median: picks.median.path, worst: picks.worst.path,
      average: Array.from(sum, (v) => v / windows),
    },
    paidIn: Array.from(paidSum, (v) => v / windows),
    envelope: { low: Array.from(low), high: Array.from(high) },
    picks,
    finals,
    depleted: depletedIn.reduce((t, v) => t + v, 0),
    contributions: picks.median.paidIn.at(-1),
  };
}

/** Monthly data, so this is a constant — kept as a name rather than a literal 12. */
const OBSERVATIONS_PER_YEAR = 12;

export { normalise, keyLabel, keyYear, longestRun, ratesFor, buildSeries, runScenario, OBSERVATIONS_PER_YEAR };
