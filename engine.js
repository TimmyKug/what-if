/**
 * The pure part of "What if?": calendar helpers, currency conversion, and the
 * backtest itself. No DOM, so it can be exercised from Node — see
 * `scripts/check-engine.mjs`.
 *
 * Both datasets are normalised to the same shape before anything else runs: a
 * series is an ascending array of integer `keys` (YYYYMM for monthly data,
 * YYYYMMDD for daily) alongside its values. Everything below is written against
 * that, so the engine never needs to know which file it was given.
 */

/* ------------------------------------------------------------------ shapes */

/** Folds either file layout into `{ keys, values }` form. */
function normalise(data) {
  const daily = data.resolution === "daily";
  const toKey = daily ? (d) => d : (m) => Number(m.replace("-", ""));

  const instruments = data.instruments.map((i) => ({
    ...i,
    keys: (daily ? i.dates : i.months).map(toKey),
  }));

  // Monthly stores its own dates per currency; daily shares one axis.
  const fx = {};
  if (daily) {
    for (const [code, values] of Object.entries(data.fx.rates)) {
      fx[code] = { keys: data.fx.dates, values };
    }
  } else {
    for (const [code, table] of Object.entries(data.fx)) {
      fx[code] = { keys: table.months.map(toKey), values: table.values };
    }
  }

  return { ...data, daily, instruments, fx };
}

const keyYear = (k, daily) => Math.floor(k / (daily ? 10000 : 100));
const keyMonth = (k, daily) => (daily ? Math.floor(k / 100) % 100 : k % 100);
const keyDay = (k) => k % 100;

function keyLabel(k, daily) {
  const y = keyYear(k, daily);
  const m = keyMonth(k, daily);
  const date = new Date(Date.UTC(y, m - 1, daily ? keyDay(k) : 1));
  return date.toLocaleDateString(undefined, daily
    ? { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }
    : { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Days since epoch, used for week boundaries and for measuring a span. */
function dayNumber(k) {
  return Math.floor(Date.UTC(keyYear(k, true), keyMonth(k, true) - 1, keyDay(k)) / 86400000);
}

/* ---------------------------------------------------------------- calendar */

/** Longest run of consecutive calendar months, as a `[start, end)` index pair. */
function longestRun(keys) {
  const step = (k) => keyYear(k, false) * 12 + keyMonth(k, false);
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

/**
 * Which observations a contribution lands on.
 *
 * Monthly data pays on every observation. Daily data pays on the first trading
 * day of each period, so a monthly plan buys on the first trading day of the
 * month rather than silently skipping a weekend.
 */
function contributionDays(keys, cadence, daily) {
  const flags = new Uint8Array(keys.length).fill(1);
  if (!daily || cadence === "daily") return flags;

  // Epoch day 0 was a Thursday, so +3 moves the week boundary onto Monday.
  const bucket = cadence === "weekly"
    ? (k) => Math.floor((dayNumber(k) + 3) / 7)
    : (k) => keyYear(k, true) * 12 + keyMonth(k, true);

  let seen = null;
  keys.forEach((k, i) => {
    const b = bucket(k);
    flags[i] = b === seen ? 0 : 1;
    seen = b;
  });
  return flags;
}

/** Observations per year, measured from the series itself. */
function observationsPerYear(keys, daily) {
  if (!daily) return 12;
  const years = (dayNumber(keys.at(-1)) - dayNumber(keys[0])) / 365.2425;
  return (keys.length - 1) / years;
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
    const [from, to] = data.daily ? [0, instrument.keys.length] : longestRun(instrument.keys);
    const keys = instrument.keys.slice(from, to);
    const prices = denominated.slice(from, to);
    return {
      keys, daily: data.daily,
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

  const [from, to] = data.daily ? [0, keys.length] : longestRun(keys);
  const kept = keys.slice(from, to);
  const keptPrices = prices.slice(from, to);

  return {
    keys: kept, daily: data.daily,
    returns: keptPrices.slice(1).map((p, i) => p / keptPrices[i] - 1),
    converted: instrument.currency !== currency,
    denominated: false,
  };
}

/* ------------------------------------------------------------------ engine */

/**
 * Replays the plan once per possible start date.
 *
 * Two passes, because at daily resolution there can be tens of thousands of
 * windows and keeping every balance path would run to hundreds of megabytes.
 * The first pass keeps only the final values and the running aggregates; the
 * second replays the three windows actually drawn.
 *
 * Within a step the return is applied first and the contribution second, so a
 * contribution never earns the return of the step it arrives in.
 */
function runScenario(series, { steps, initial, contribution, cadence = "monthly" }) {
  const { returns, keys } = series;
  const windows = returns.length - steps + 1;
  if (windows < 1 || steps < 1) return null;

  const pays = contributionDays(keys, cadence, series.daily);

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
      if (pays[i]) { balance += contribution; paid += contribution; }
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
      if (pays[i]) { balance += contribution; paid += contribution; }
      if (balance < 0) { balance = 0; depletedAt ??= t; }
      path[t] = balance; paidIn[t] = paid;
    }
    return { path, paidIn, depletedAt, startKey: keys[start], endKey: keys[start + steps] };
  };

  const picks = {
    best: replay(pick.best), median: replay(pick.median), worst: replay(pick.worst),
  };

  return {
    windows, steps, cadence,
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

export {
  normalise, keyLabel, keyYear, dayNumber, longestRun, contributionDays,
  observationsPerYear, ratesFor, buildSeries, runScenario,
};
