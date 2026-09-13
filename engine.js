/**
 * The pure part of "What if?": calendar helpers, currency conversion, and the
 * backtest itself. No DOM, so it can be exercised from Node — see
 * `scripts/check-engine.mjs`.
 */

const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

const monthLabel = (m) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1))
    .toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });

/** Longest run of consecutive calendar months, as a `[start, end)` index pair. */
function longestRun(months) {
  let bestStart = 0, bestLen = 0, runStart = 0;
  for (let i = 1; i <= months.length; i++) {
    const broken = i === months.length || monthIndex(months[i]) !== monthIndex(months[i - 1]) + 1;
    if (broken) {
      if (i - runStart > bestLen) { bestLen = i - runStart; bestStart = runStart; }
      runStart = i;
    }
  }
  return [bestStart, bestStart + bestLen];
}

/** USD per 1 unit of `code` for each of `months`, carrying the last known rate
 *  forward across the gaps Yahoo leaves in its FX history. */
function ratesFor(fx, code, months) {
  if (code === "USD") return months.map(() => 1);
  const table = fx[code];
  if (!table) return months.map(() => null);

  const known = new Map(table.months.map((m, i) => [m, table.values[i]]));
  let carried = null;
  let cursor = 0;
  return months.map((m) => {
    while (cursor < table.months.length && monthIndex(table.months[cursor]) <= monthIndex(m)) {
      carried = table.values[cursor++];
    }
    return known.get(m) ?? carried;
  });
}

/**
 * The instrument's price history expressed in `currency`, trimmed to the months
 * where every input actually exists and the calendar is unbroken.
 */
function buildSeries(data, instrument, currency) {
  // Some sources publish the index already computed in each currency. That is
  // strictly better than converting: no exchange-rate series in the middle, so
  // no conversion error and no history lost where the FX history starts later.
  const denominated = instrument.byCurrency?.[currency];
  if (denominated) {
    const [from, to] = longestRun(instrument.months);
    const months = instrument.months.slice(from, to);
    const prices = denominated.slice(from, to);
    return {
      months,
      returns: prices.slice(1).map((p, i) => p / prices[i] - 1),
      converted: false,
      denominated: true,
      droppedForFx: 0,
    };
  }

  const native = ratesFor(data.fx, instrument.currency, instrument.months);
  const display = ratesFor(data.fx, currency, instrument.months);

  const months = [];
  const prices = [];
  instrument.months.forEach((m, i) => {
    if (native[i] == null || display[i] == null) return;
    months.push(m);
    prices.push(instrument.values[i] * (native[i] / display[i]));
  });

  const [from, to] = longestRun(months);
  const kept = months.slice(from, to);
  const keptPrices = prices.slice(from, to);

  // returns[i] is the return earned during kept[i + 1].
  const returns = keptPrices.slice(1).map((p, i) => p / keptPrices[i] - 1);

  return {
    months: kept,
    returns,
    converted: instrument.currency !== currency,
    denominated: false,
    droppedForFx: instrument.months.length - months.length,
  };
}

/* ------------------------------------------------------------------ engine */

/**
 * Replays the plan once per historical start month.
 *
 * Cash-flow order within a month is return first, then the payment — so the
 * very first monthly payment does not earn that month's return.
 */
function runScenario(series, { horizonMonths, initial, monthly }) {
  const windows = [];
  for (let start = 0; start + horizonMonths <= series.returns.length; start++) {
    const path = new Float64Array(horizonMonths + 1);
    let balance = initial;
    let depletedAt = null;
    path[0] = balance;
    for (let t = 1; t <= horizonMonths; t++) {
      balance = balance * (1 + series.returns[start + t - 1]) + monthly;
      // A withdrawal the portfolio cannot cover empties it rather than taking it
      // negative; the window is flagged so the UI can say how often that happened.
      if (balance < 0) {
        balance = 0;
        depletedAt ??= t;
      }
      path[t] = balance;
    }
    windows.push({
      startMonth: series.months[start],
      endMonth: series.months[start + horizonMonths],
      path,
      final: path[horizonMonths],
      depletedAt,
    });
  }
  if (!windows.length) return null;

  const byFinal = [...windows].sort((a, b) => a.final - b.final);

  // Mean, and the envelope every timeline stayed inside, month by month.
  const average = new Array(horizonMonths + 1).fill(0);
  const low = new Array(horizonMonths + 1).fill(Infinity);
  const high = new Array(horizonMonths + 1).fill(-Infinity);
  for (const w of windows) {
    for (let t = 0; t <= horizonMonths; t++) {
      average[t] += w.path[t];
      if (w.path[t] < low[t]) low[t] = w.path[t];
      if (w.path[t] > high[t]) high[t] = w.path[t];
    }
  }
  for (let t = 0; t <= horizonMonths; t++) average[t] /= windows.length;

  const paidIn = Array.from({ length: horizonMonths + 1 }, (_, t) => initial + monthly * t);

  return {
    windows,
    paidIn,
    depleted: windows.filter((w) => w.depletedAt !== null).length,
    envelope: { low, high },
    paths: {
      best: Array.from(byFinal.at(-1).path),
      worst: Array.from(byFinal[0].path),
      median: Array.from(byFinal[(byFinal.length - 1) >> 1].path),
      average,
    },
    picks: {
      best: byFinal.at(-1),
      worst: byFinal[0],
      median: byFinal[(byFinal.length - 1) >> 1],
    },
  };
}

export { monthIndex, monthLabel, longestRun, ratesFor, buildSeries, runScenario };

