/**
 * What if? — replays a saving plan over every historical window a market series
 * is long enough to cover, and draws the average, median, best and worst of them.
 *
 * Runs client-side against the committed datasets in `data/`; refresh them with
 * `node scripts/fetch-market-data.mjs` and `node scripts/fetch-daily-data.mjs`.
 */

import { normalise, keyLabel, buildSeries, runScenario, observationsPerYear } from "./engine.js";

/**
 * Three lines, validated against the dark surface across *all* pairs rather than
 * adjacent ones — every line is on screen at once, so every pair has to separate.
 * That rules out the obvious green/red for best/worst: they sit at ΔE 4.7 under
 * deuteranopia. Amber carries "worst" instead (it reads as caution anyway) and
 * violet the neutral middle; the worst pair is then amber↔green at ΔE 9.1.
 */
const SERIES = [
  { key: "best", label: "Best", color: "#00b070" },
  { key: "average", label: "Average", color: "#9085e9" },
  { key: "worst", label: "Worst", color: "#c58203" },
];

const PAID_IN = { key: "paidIn", label: "Paid in", color: "#7d8a8d" };

const CURRENCIES = {
  USD: "$", EUR: "€", GBP: "£", CHF: "CHF", JPY: "¥", CAD: "C$",
  AUD: "A$", SEK: "kr", NOK: "kr", DKK: "kr", PLN: "zł", NZD: "NZ$", SGD: "S$",
};

const ZONE_CURRENCY = {
  "Europe/London": "GBP", "Europe/Zurich": "CHF", "Europe/Busingen": "CHF",
  "Europe/Stockholm": "SEK", "Europe/Oslo": "NOK", "Europe/Copenhagen": "DKK",
  "Europe/Warsaw": "PLN", "Europe/Moscow": null, "Europe/Istanbul": null,
  "Europe/Kiev": null, "Europe/Kyiv": null, "Europe/Prague": null,
  "Europe/Budapest": null, "Europe/Bucharest": null, "Europe/Sofia": null,
  "Asia/Tokyo": "JPY", "Asia/Singapore": "SGD",
  "Pacific/Auckland": "NZD", "Pacific/Chatham": "NZD",
};
const CONTINENT_CURRENCY = { Europe: "EUR", America: "USD", Australia: "AUD" };
const REGION_CURRENCY = {
  US: "USD", GB: "GBP", CH: "CHF", JP: "JPY", CA: "CAD", AU: "AUD", NZ: "NZD",
  SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", SG: "SGD",
  DE: "EUR", AT: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", NL: "EUR", BE: "EUR",
  IE: "EUR", PT: "EUR", FI: "EUR", GR: "EUR", LU: "EUR", SK: "EUR", SI: "EUR",
  EE: "EUR", LV: "EUR", LT: "EUR", CY: "EUR", MT: "EUR", HR: "EUR",
};

/** Best guess at the visitor's home currency, from time zone first, then locale. */
function detectCurrency() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone in ZONE_CURRENCY && ZONE_CURRENCY[zone]) return ZONE_CURRENCY[zone];
    if (!(zone in ZONE_CURRENCY)) {
      const byContinent = CONTINENT_CURRENCY[zone?.split("/")[0]];
      if (byContinent) return byContinent;
    }
  } catch { /* fall through to the locale guess */ }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const region = new Intl.Locale(tag).maximize().region;
    if (REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  }
  return "USD";
}

/* ------------------------------------------------------------------- data */

/** Monthly loads with the page; daily is ~810KB gzipped, so it waits until asked. */
const datasets = { monthly: null, daily: null };
let dailyRequest = null;

async function dataset(resolution) {
  if (datasets[resolution]) return datasets[resolution];
  if (resolution === "monthly") {
    datasets.monthly = normalise(await (await fetch("data/market-data.json")).json());
    return datasets.monthly;
  }
  dailyRequest ??= fetch("data/market-data-daily.json")
    .then((r) => r.json())
    .then((j) => (datasets.daily = normalise(j)));
  return dailyRequest;
}

/* --------------------------------------------------------------- formatting */

let money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
let moneyCompact = money;

function setCurrencyFormat(currency) {
  money = new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 });
  moneyCompact = new Intl.NumberFormat(undefined, {
    style: "currency", currency, notation: "compact", maximumFractionDigits: 1,
  });
}

const percent = (v) =>
  `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}%`;

/** Change against what was paid in, as a percentage where that reads sensibly. */
const change = (gain, paidIn) =>
  paidIn > 0 ? percent((gain / paidIn) * 100) : `${gain >= 0 ? "+" : "−"}${money.format(Math.abs(gain))}`;

const yearsLabel = (n) => `${n} year${n === 1 ? "" : "s"}`;
const yearsAdj = (n) => `${n}-year`;

const CADENCE_WORD = { monthly: "month", weekly: "week", daily: "trading day" };

/* -------------------------------------------------------------------- chart */

const svg = document.getElementById("chart");
const host = document.getElementById("chart-host");
const tooltip = document.getElementById("tooltip");
const NS = "http://www.w3.org/2000/svg";

const el = (name, attrs = {}, text) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
};

function niceTicks(min, max, count = 5) {
  const raw = (max - min) / count || 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [0.5, 1, 2, 2.5, 5, 10, 20]
    .map((m) => m * magnitude)
    .reduce((a, b) =>
      Math.abs((max - min) / b - count) < Math.abs((max - min) / a - count) ? b : a);
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(t);
  return ticks;
}

let chartState = null;

function drawChart(result, years) {
  const steps = result.steps;
  const width = host.clientWidth || 720;
  const height = svg.clientHeight || 380;
  const pad = { top: 16, right: 76, bottom: 30, left: 62 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = Math.max(10, height - pad.top - pad.bottom);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const desc = svg.querySelector("desc");
  svg.replaceChildren(desc);

  const lines = [
    ...SERIES.map((s) => ({ ...s, values: result.paths[s.key] })),
    { ...PAID_IN, values: result.paidIn, dashed: true },
  ];

  let lo = Infinity, hi = -Infinity;
  for (const values of [...lines.map((l) => l.values), result.envelope.low, result.envelope.high]) {
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  lo = Math.min(0, lo);
  const ticks = niceTicks(lo, hi);
  const yLo = Math.min(lo, ticks[0]);
  const yHi = Math.max(hi, ticks.at(-1));

  const x = (t) => pad.left + (t / steps) * plotW;
  const y = (v) => pad.top + plotH - ((v - yLo) / (yHi - yLo || 1)) * plotH;

  for (const tick of ticks) {
    svg.append(
      el("line", { class: "grid-line", x1: pad.left, x2: pad.left + plotW, y1: y(tick), y2: y(tick) }),
      el("text", { class: "axis-text axis-text--y", x: pad.left - 10, y: y(tick) + 4 }, moneyCompact.format(tick)),
    );
  }

  const everyN = Math.ceil(years / Math.max(2, Math.floor(plotW / 58)));
  svg.append(el("line", { class: "axis-line", x1: pad.left, x2: pad.left + plotW, y1: y(yLo), y2: y(yLo) }));
  for (let yr = 0; yr <= years; yr += everyN) {
    svg.append(el("text", { class: "axis-text", "text-anchor": "middle", x: x((yr / years) * steps), y: pad.top + plotH + 18 },
      yr === 0 ? "start" : `${yr}y`));
  }

  // Everywhere any historical timeline ever went. Drawn thinned out, because at
  // daily resolution there are thousands of points and the outline is identical.
  const stride = Math.max(1, Math.floor(steps / 600));
  const band = [];
  for (let t = 0; t <= steps; t += stride) band.push(`${t === 0 ? "M" : "L"}${x(t)},${y(result.envelope.high[t])}`);
  band.push(`L${x(steps)},${y(result.envelope.high[steps])}`);
  for (let t = steps; t >= 0; t -= stride) band.push(`L${x(t)},${y(result.envelope.low[t])}`);
  band.push(`L${x(0)},${y(result.envelope.low[0])}`);
  svg.append(el("path", { class: "series-band", d: `${band.join("")}Z`, fill: "#7d8a8d" }));

  const pathFor = (values) => {
    let d = "";
    for (let t = 0; t <= steps; t += stride) d += `${t === 0 ? "M" : "L"}${x(t).toFixed(2)},${y(values[t]).toFixed(2)}`;
    return `${d}L${x(steps).toFixed(2)},${y(values[steps]).toFixed(2)}`;
  };

  for (const line of [lines.at(-1), ...lines.slice(0, -1)]) {
    svg.append(el("path", {
      class: "series-line", d: pathFor(line.values), stroke: line.color,
      ...(line.dashed ? { "stroke-dasharray": "5 4", "stroke-width": 1.5 } : {}),
    }));
  }

  const labels = lines
    .map((line) => ({ text: line.label, color: line.color, at: y(line.values.at(-1)) }))
    .sort((a, b) => a.at - b.at);
  for (let i = 1; i < labels.length; i++) labels[i].at = Math.max(labels[i].at, labels[i - 1].at + 13);
  const overflow = labels.at(-1).at - (pad.top + plotH);
  if (overflow > 0) for (const label of labels) label.at -= overflow;
  for (const label of labels) {
    svg.append(el("text", { class: "series-label", fill: label.color, x: pad.left + plotW + 8, y: label.at + 4 }, label.text));
  }

  const cursor = el("g", { opacity: 0 });
  cursor.append(el("line", { class: "crosshair", y1: pad.top, y2: pad.top + plotH }));
  const dots = lines.map((line) => el("circle", { class: "cursor-dot", r: 4, fill: line.color }));
  cursor.append(...dots);
  svg.append(cursor);

  chartState = { result, years, steps, x, y, pad, plotW, plotH, lines, cursor, dots, width };
}

function moveCursor(event) {
  if (!chartState) return;
  const { x, y, pad, plotW, steps, years, lines, cursor, dots } = chartState;
  const box = svg.getBoundingClientRect();
  const px = ((event.clientX - box.left) / box.width) * chartState.width;
  const t = Math.round(Math.min(1, Math.max(0, (px - pad.left) / plotW)) * steps);

  cursor.setAttribute("opacity", 1);
  cursor.querySelector("line").setAttribute("x1", x(t));
  cursor.querySelector("line").setAttribute("x2", x(t));
  lines.forEach((line, i) => {
    dots[i].setAttribute("cx", x(t));
    dots[i].setAttribute("cy", y(line.values[t]));
  });

  const elapsedMonths = Math.round((t / steps) * years * 12);
  const label = t === 0 ? "At the start" :
    [Math.floor(elapsedMonths / 12) ? `${Math.floor(elapsedMonths / 12)}y` : "",
     elapsedMonths % 12 ? `${elapsedMonths % 12}m` : ""].filter(Boolean).join(" ") || "0m";
  // Ordered by value at the hovered point, highest first, so the rows match the
  // vertical order of the lines under the cursor rather than a fixed sequence.
  tooltip.innerHTML =
    `<div class="tooltip-head">${label}</div>` +
    [...lines].sort((a, b) => b.values[t] - a.values[t]).map((line) =>
      `<div class="tooltip-row"><span class="dot" style="background:${line.color}"></span>` +
      `<span class="name">${line.label}</span><span class="val">${money.format(line.values[t])}</span></div>`,
    ).join("");
  tooltip.hidden = false;

  const flip = x(t) > chartState.width * 0.6;
  tooltip.style.left = `${flip ? x(t) - tooltip.offsetWidth - 14 : x(t) + 14}px`;
  tooltip.style.top = `${pad.top}px`;
}

function hideCursor() {
  tooltip.hidden = true;
  chartState?.cursor.setAttribute("opacity", 0);
}

svg.addEventListener("pointermove", moveCursor);
svg.addEventListener("pointerleave", hideCursor);

/* ----------------------------------------------------------------------- ui */

const ui = {
  instrument: document.getElementById("instrument"),
  currency: document.getElementById("currency"),
  initial: document.getElementById("initial"),
  monthly: document.getElementById("monthly"),
  cadence: document.getElementById("cadence"),
  cadenceHint: document.getElementById("cadence-hint"),
  horizon: document.getElementById("horizon"),
  horizonValue: document.getElementById("horizon-value"),
  horizonScale: document.getElementById("horizon-scale"),
  instrumentHint: document.getElementById("instrument-hint"),
  currencyHint: document.getElementById("currency-hint"),
  initialSymbol: document.getElementById("initial-symbol"),
  monthlySymbol: document.getElementById("monthly-symbol"),
  dataStatus: document.getElementById("data-status"),
  legend: document.getElementById("legend"),
  cards: document.getElementById("cards"),
  chartSub: document.getElementById("chart-sub"),
  chartCaption: document.getElementById("chart-caption"),
  chartDesc: document.getElementById("chart-desc"),
  windowsNote: document.getElementById("windows-note"),
  assumptions: document.getElementById("assumptions"),
  tableBody: document.querySelector("#windows-table tbody"),
};

let data;
let seriesCache = null;

function readInputs() {
  return {
    instrumentId: ui.instrument.value,
    currency: ui.currency.value,
    initial: Math.max(0, Number(ui.initial.value) || 0),
    contribution: Number(ui.monthly.value) || 0,
    cadence: ui.cadence.value,
    years: Number(ui.horizon.value),
  };
}

function renderLegend() {
  ui.legend.replaceChildren(...[...SERIES, PAID_IN].map((s) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.setAttribute("role", "listitem");
    item.innerHTML =
      `<span class="legend-swatch${s === PAID_IN ? " legend-swatch--dashed" : ""}" style="color:${s.color}"></span>${s.label}`;
    return item;
  }));
}

function renderCards(result, { initial, contribution, cadence, years }) {
  const paidIn = result.paidIn.at(-1);
  const cards = SERIES.map((s) => {
    const final = result.paths[s.key].at(-1);
    const gain = final - paidIn;
    const pick = result.picks[s.key];
    return {
      tint: s.color, label: s.label, value: money.format(final),
      note: `<strong class="${gain >= 0 ? "gain-positive" : "gain-negative"}">${change(gain, paidIn)}</strong>` +
        ` vs paid in · ${pick ? `started ${keyLabel(pick.startKey, result.daily)}` : `mean of ${result.windows.toLocaleString()} starts`}`,
    };
  });

  cards.push({
    tint: PAID_IN.color, label: "Paid in", value: money.format(paidIn),
    note: `${money.format(initial)} at the start · ${money.format(contribution)} every ${CADENCE_WORD[cadence]} for ${yearsLabel(years)}`,
  });

  ui.cards.replaceChildren(...cards.map((card) => {
    const node = document.createElement("div");
    node.className = "card";
    node.style.setProperty("--tint", card.tint);
    node.innerHTML =
      `<div class="card-label">${card.label}</div>` +
      `<div class="card-value">${card.value}</div>` +
      `<div class="card-note">${card.note}</div>`;
    return node;
  }));
}

/**
 * At daily resolution there can be thousands of start dates, so the table shows
 * the distribution rather than every window, plus the three the chart names.
 */
function renderTable(result) {
  const paidIn = result.paidIn.at(-1);
  const sorted = Float64Array.from(result.finals).sort();
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  // Highest outcome first, so the column reads down from best to worst.
  const rows = [
    ["Best", at(1), "best"], ["90th percentile", at(0.9)], ["75th percentile", at(0.75)],
    ["Median", at(0.5), "median"], ["25th percentile", at(0.25)], ["10th percentile", at(0.1)],
    ["Worst", at(0), "worst"],
  ];

  ui.tableBody.replaceChildren(...rows.map(([label, value, markKey]) => {
    const meta = SERIES.find((s) => s.key === markKey);
    const pick = markKey ? result.picks[markKey] : null;
    const gain = value - paidIn;
    const tr = document.createElement("tr");
    if (markKey) tr.dataset.mark = markKey;
    tr.innerHTML =
      `<td>${label}${meta ? `<span class="mark-tag" style="background:${meta.color}">${meta.label}</span>` : ""}</td>` +
      `<td>${pick ? keyLabel(pick.startKey, result.daily) : ""}</td>` +
      `<td class="num">${money.format(paidIn)}</td>` +
      `<td class="num">${money.format(value)}</td>` +
      `<td class="num ${gain >= 0 ? "gain-positive" : "gain-negative"}">${change(gain, paidIn)}</td>` +
      `<td>${pick?.depletedAt != null ? "ran out early" : ""}</td>`;
    return tr;
  }));
}

function renderAssumptions(series, result, { instrument, currency, years, cadence }) {
  const warnings = [];
  if (!instrument.adjusted) {
    warnings.push(`${instrument.name} is a price index: it excludes dividends, so every line here is lower than a real investor holding the index would have seen.`);
  }
  if (instrument.grossOfTax) {
    warnings.push(`${instrument.name} reinvests dividends before withholding tax. A fund actually receives them after it, which historically costs roughly 0.5–0.7 percentage points a year — so these lines sit a little above what a real tracker would have returned.`);
  }
  if (series.converted) {
    warnings.push(`Prices are converted from ${instrument.currency} to ${currency} at each period's exchange rate, so the result includes currency movement. History starts where the exchange-rate series does.`);
  }
  const spanYears = result.windows / (series.daily ? observationsPerYear(series.keys, true) : 12);
  if (spanYears < 10) {
    warnings.push(`This series offers ${result.windows.toLocaleString()} start dates for a ${yearsAdj(years)} plan, spanning ${spanYears.toFixed(1)} years. Neighbouring windows share almost all of their history, so "best" and "worst" describe two particular start dates rather than the full range of what is possible.`);
  }
  if (result.depleted) {
    warnings.push(`The money ran out before the end in ${result.depleted.toLocaleString()} of ${result.windows.toLocaleString()} timelines. Those are shown flat at zero from the point the portfolio could no longer cover the withdrawal.`);
  }
  if (!["msci-world", "msci-acwi", "msci-world-index", "sp500", "ff-developed", "ff-us"].includes(instrument.id)) {
    warnings.push(`${instrument.name} here is a tradable fund used as a proxy for the index, not the index itself.`);
  }
  if (series.daily && instrument.currency !== currency) {
    warnings.push(`Daily currency conversion uses ECB reference rates, which start in 1999 — at monthly resolution this series reaches further back.`);
  }

  ui.assumptions.innerHTML =
    `<dl class="kv">` +
    `<dt>Instrument</dt><dd>${instrument.detail}</dd>` +
    `<dt>Resolution</dt><dd>${series.daily ? "Daily, one observation per trading day" : "Monthly, one observation per month-end"}</dd>` +
    `<dt>Series currency</dt><dd>${
      series.denominated ? `${currency}, computed in that currency at source (no conversion)`
        : series.converted ? `${instrument.currency} → converted to ${currency} at historical rates`
        : `${instrument.currency} (no conversion)`}</dd>` +
    `<dt>Return type</dt><dd>${!instrument.adjusted ? "Price return (dividends excluded)"
      : instrument.grossOfTax ? "Total return, gross of dividend withholding tax"
      : "Total return, net of dividend withholding tax"}</dd>` +
    `<dt>History used</dt><dd>${keyLabel(series.keys[0], series.daily)} – ${keyLabel(series.keys.at(-1), series.daily)} · ${series.returns.length.toLocaleString()} observations</dd>` +
    `<dt>Start dates tested</dt><dd>${result.windows.toLocaleString()} overlapping ${yearsAdj(years)} periods</dd>` +
    `<dt>Buying</dt><dd>Every ${CADENCE_WORD[cadence]}${series.daily && cadence !== "daily" ? `, on the first trading day of each ${CADENCE_WORD[cadence]}` : ""}</dd>` +
    `<dt>Cash-flow order</dt><dd>The balance earns each period's return first, then the payment is added</dd>` +
    `<dt>Not included</dt><dd>Tax, trading fees, fund costs beyond those already in the price, and inflation</dd>` +
    `<dt>Source</dt><dd>${data.source}, fetched ${new Date(data.fetchedAt).toLocaleDateString()}</dd>` +
    `</dl>` +
    warnings.map((w) => `<p class="warn">${w}</p>`).join("");
}

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const input = readInputs();
  setCurrencyFormat(input.currency);
  ui.initialSymbol.textContent = CURRENCIES[input.currency] ?? input.currency;
  ui.monthlySymbol.textContent = (input.contribution < 0 ? "−" : "+") + (CURRENCIES[input.currency] ?? input.currency);
  ui.monthlySymbol.classList.toggle("money-symbol--plus", input.contribution >= 0);

  // Weekly and daily buying need a daily series; monthly buying does not, and the
  // monthly dataset reaches further back, so it stays the default.
  const resolution = input.cadence === "monthly" ? "monthly" : "daily";
  if (!datasets[resolution]) host.dataset.loading = "true";
  data = await dataset(resolution);
  if (token !== renderToken) return;
  host.dataset.loading = "false";

  const instrument = data.instruments.find((i) => i.id === input.instrumentId) ?? data.instruments[0];
  ui.instrument.value = instrument.id;
  ui.instrumentHint.textContent = instrument.detail;

  const cacheKey = `${resolution}|${instrument.id}|${input.currency}`;
  if (seriesCache?.key !== cacheKey) {
    seriesCache = { key: cacheKey, series: buildSeries(data, instrument, input.currency) };
  }
  const series = seriesCache.series;

  ui.currencyHint.textContent = series.denominated
    ? `Computed in ${input.currency} at source, so no conversion is applied.`
    : series.converted
      ? `Converted from ${instrument.currency} at historical rates.`
      : `${instrument.name} is quoted in ${input.currency}, so no conversion is applied.`;

  const perYear = observationsPerYear(series.keys, series.daily);
  const maxYears = Math.max(1, Math.floor((series.returns.length / perYear) - 0.5));
  ui.horizon.max = Math.min(30, maxYears);
  if (Number(ui.horizon.value) > Number(ui.horizon.max)) ui.horizon.value = ui.horizon.max;
  const years = Number(ui.horizon.value);
  ui.horizonValue.textContent = yearsLabel(years);
  ui.horizonScale.replaceChildren(
    Object.assign(document.createElement("span"), { textContent: "1y" }),
    Object.assign(document.createElement("span"), { textContent: `${ui.horizon.max}y` }),
  );

  const steps = Math.round(years * perYear);
  const result = runScenario(series, {
    steps, initial: input.initial, contribution: input.contribution, cadence: input.cadence,
  });
  if (!result) {
    ui.chartSub.textContent = "Not enough history for this horizon.";
    return;
  }
  result.daily = series.daily;

  const tag = series.daily ? `<span class="resolution-tag">daily</span>` : "";
  ui.dataStatus.innerHTML =
    `${series.returns.length.toLocaleString()} observations · ` +
    `${keyLabel(series.keys[0], series.daily)}–${keyLabel(series.keys.at(-1), series.daily)}${tag}`;
  ui.chartSub.textContent =
    `${yearsLabel(years)} of ${instrument.name} in ${input.currency}, buying every ${CADENCE_WORD[input.cadence]}, ` +
    `replayed from all ${result.windows.toLocaleString()} start dates in the data.`;
  ui.chartCaption.textContent =
    `Best and worst are single real timelines — the start dates that ended highest and lowest. ` +
    `Average is the mean of all ${result.windows.toLocaleString()} timelines, and the shaded area covers every one of them.`;
  ui.chartDesc.textContent =
    `Line chart of portfolio value over ${yearsLabel(years)}. Best ends at ${money.format(result.paths.best.at(-1))}, ` +
    `average ${money.format(result.paths.average.at(-1))}, worst ${money.format(result.paths.worst.at(-1))}, ` +
    `against ${money.format(result.paidIn.at(-1))} paid in. The median outcome was ${money.format(result.paths.median.at(-1))}.`;
  ui.windowsNote.textContent =
    `Tested against ${result.windows.toLocaleString()} overlapping ${yearsAdj(years)} periods from ${keyLabel(series.keys[0], series.daily)}.`;
  // Buying daily at the same figure is ~21x the money, so state the equivalent
  // monthly rate: comparing cadences is only meaningful at the same total.
  if (input.cadence === "monthly") {
    ui.cadenceHint.textContent = "Negative values withdraw instead of paying in.";
  } else {
    const perMonth = input.contribution * (result.contributions / input.contribution) / (years * 12);
    ui.cadenceHint.textContent =
      `About ${money.format(Math.abs(perMonth))} a month at this rate. Weekly and daily buying use the ` +
      `daily dataset, which starts later for converted currencies.`;
  }

  drawChart(result, years);
  renderCards(result, { ...input, years });
  renderTable(result);
  renderAssumptions(series, result, { ...input, instrument, years });
}

async function init() {
  data = await dataset("monthly");

  ui.instrument.replaceChildren(...data.instruments.map((i) =>
    Object.assign(document.createElement("option"), { value: i.id, textContent: i.name })));
  ui.instrument.value = "ff-developed";

  ui.currency.replaceChildren(...Object.keys(CURRENCIES).map((code) =>
    Object.assign(document.createElement("option"), { value: code, textContent: `${code} — ${CURRENCIES[code]}` })));
  ui.currency.value = detectCurrency();

  renderLegend();
  for (const control of [ui.instrument, ui.currency, ui.initial, ui.monthly, ui.cadence, ui.horizon]) {
    control.addEventListener("input", render);
  }
  new ResizeObserver(() => chartState && drawChart(chartState.result, chartState.years)).observe(host);
  await render();
}

init();
