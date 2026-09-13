/**
 * What if? — replays a saving plan over every historical window a market series
 * is long enough to cover, and draws the average, median, best and worst of them.
 *
 * Everything runs client-side against the committed `data/market-data.json`;
 * refresh that with `node scripts/fetch-market-data.mjs`.
 */

import { monthLabel, buildSeries, runScenario } from "./engine.js";

const SERIES = [
  { key: "best", label: "Best", color: "#00b070", desc: "the luckiest start month in the data" },
  { key: "average", label: "Average", color: "#c58203", desc: "the mean across every start month" },
  { key: "median", label: "Median", color: "#708ee1", desc: "the middle start month" },
  { key: "worst", label: "Worst", color: "#e86054", desc: "the unluckiest start month in the data" },
];

const PAID_IN = { key: "paidIn", label: "Paid in", color: "#7d8a8d" };

const CURRENCIES = {
  USD: "$", EUR: "€", GBP: "£", CHF: "CHF", JPY: "¥", CAD: "C$",
  AUD: "A$", SEK: "kr", NOK: "kr", DKK: "kr", PLN: "zł", NZD: "NZ$", SGD: "S$",
};

/** Time zones whose country does not use the currency its continent suggests. */
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

/** Round number-line steps, so the axis reads 0 / 25k / 50k rather than 0 / 23k. */
function niceTicks(min, max, count = 5) {
  const raw = (max - min) / count || 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  // Pick the round step whose tick count lands closest to `count`, rather than
  // the first step above `raw` — that one is often coarse enough to leave three.
  const step = [0.5, 1, 2, 2.5, 5, 10, 20]
    .map((m) => m * magnitude)
    .reduce((a, b) =>
      Math.abs((max - min) / b - count) < Math.abs((max - min) / a - count) ? b : a);
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(t);
  return ticks;
}

let chartState = null;

function drawChart(result, horizonMonths) {
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

  const x = (t) => pad.left + (t / horizonMonths) * plotW;
  const y = (v) => pad.top + plotH - ((v - yLo) / (yHi - yLo || 1)) * plotH;

  // Horizontal grid + value axis.
  for (const tick of ticks) {
    svg.append(
      el("line", { class: "grid-line", x1: pad.left, x2: pad.left + plotW, y1: y(tick), y2: y(tick) }),
      el("text", { class: "axis-text axis-text--y", x: pad.left - 10, y: y(tick) + 4 }, moneyCompact.format(tick)),
    );
  }

  // Year axis — thinned out so labels never collide on a narrow screen.
  const years = horizonMonths / 12;
  const everyN = Math.ceil(years / Math.max(2, Math.floor(plotW / 58)));
  svg.append(el("line", { class: "axis-line", x1: pad.left, x2: pad.left + plotW, y1: y(yLo), y2: y(yLo) }));
  for (let yr = 0; yr <= years; yr += everyN) {
    svg.append(el("text", { class: "axis-text", "text-anchor": "middle", x: x(yr * 12), y: pad.top + plotH + 18 },
      yr === 0 ? "start" : `${yr}y`));
  }

  // Everywhere any historical timeline ever went.
  const band = [];
  for (let t = 0; t <= horizonMonths; t++) band.push(`${t === 0 ? "M" : "L"}${x(t)},${y(result.envelope.high[t])}`);
  for (let t = horizonMonths; t >= 0; t--) band.push(`L${x(t)},${y(result.envelope.low[t])}`);
  svg.append(el("path", { class: "series-band", d: `${band.join("")}Z`, fill: "#7d8a8d" }));

  const pathFor = (values) =>
    Array.from(values, (v, t) => `${t === 0 ? "M" : "L"}${x(t).toFixed(2)},${y(v).toFixed(2)}`).join("");

  for (const line of [lines.at(-1), ...lines.slice(0, -1)]) {
    svg.append(el("path", {
      class: "series-line",
      d: pathFor(line.values),
      stroke: line.color,
      ...(line.dashed ? { "stroke-dasharray": "5 4", "stroke-width": 1.5 } : {}),
    }));
  }

  // Direct labels at the right edge, nudged apart so they stay readable.
  const labels = lines
    .map((line) => ({ text: line.label, color: line.color, at: y(line.values.at(-1)) }))
    .sort((a, b) => a.at - b.at);
  for (let i = 1; i < labels.length; i++) {
    labels[i].at = Math.max(labels[i].at, labels[i - 1].at + 13);
  }
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

  chartState = { result, horizonMonths, x, y, pad, plotW, plotH, lines, cursor, dots, width };
}

function moveCursor(event) {
  if (!chartState) return;
  const { x, y, pad, plotW, horizonMonths, lines, cursor, dots } = chartState;
  const box = svg.getBoundingClientRect();
  const px = ((event.clientX - box.left) / box.width) * chartState.width;
  const t = Math.round(Math.min(1, Math.max(0, (px - pad.left) / plotW)) * horizonMonths);

  cursor.setAttribute("opacity", 1);
  cursor.querySelector("line").setAttribute("x1", x(t));
  cursor.querySelector("line").setAttribute("x2", x(t));
  lines.forEach((line, i) => {
    dots[i].setAttribute("cx", x(t));
    dots[i].setAttribute("cy", y(line.values[t]));
  });

  const months = t % 12;
  const label = t === 0 ? "At the start" :
    [Math.floor(t / 12) ? `${Math.floor(t / 12)}y` : "", months ? `${months}m` : ""].filter(Boolean).join(" ");
  tooltip.innerHTML =
    `<div class="tooltip-head">${label}</div>` +
    [...lines].reverse().map((line) =>
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

const yearsLabel = (n) => `${n} year${n === 1 ? "" : "s"}`;
/** Adjectival form, for "a 10-year plan" rather than "a 10 years plan". */
const yearsAdj = (n) => `${n}-year`;

function readInputs() {
  return {
    instrument: data.instruments.find((i) => i.id === ui.instrument.value),
    currency: ui.currency.value,
    initial: Math.max(0, Number(ui.initial.value) || 0),
    monthly: Number(ui.monthly.value) || 0,
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

function renderCards(result, { initial, monthly, years }) {
  const paidIn = result.paidIn.at(-1);
  const cards = SERIES.map((s) => {
    const final = result.paths[s.key].at(-1);
    const gain = final - paidIn;
    const pick = result.picks[s.key];
    return {
      tint: s.color,
      label: s.label,
      value: money.format(final),
      note:
        `<strong class="${gain >= 0 ? "gain-positive" : "gain-negative"}">${change(gain, paidIn)}</strong>` +
        ` vs paid in · ${pick ? `started ${monthLabel(pick.startMonth)}` : `mean of ${result.windows.length} start months`}`,
    };
  });

  cards.push({
    tint: PAID_IN.color,
    label: "Paid in",
    value: money.format(paidIn),
    note: `${money.format(initial)} at the start · ${money.format(monthly)}/month for ${yearsLabel(years)}`,
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

function renderTable(result) {
  const paidIn = result.paidIn.at(-1);
  const marks = new Map();
  for (const key of ["best", "median", "worst"]) marks.set(result.picks[key], key);

  const rows = [...result.windows].reverse().map((w) => {
    const mark = marks.get(w);
    const meta = SERIES.find((s) => s.key === mark);
    const tr = document.createElement("tr");
    if (mark) tr.dataset.mark = mark;
    const gain = w.final - paidIn;
    tr.innerHTML =
      `<td>${monthLabel(w.startMonth)}${meta ? `<span class="mark-tag" style="background:${meta.color}">${meta.label}</span>` : ""}</td>` +
      `<td>${monthLabel(w.endMonth)}</td>` +
      `<td class="num">${money.format(paidIn)}</td>` +
      `<td class="num">${money.format(w.final)}</td>` +
      `<td class="num ${gain >= 0 ? "gain-positive" : "gain-negative"}">${change(gain, paidIn)}</td>` +
      `<td>${w.depletedAt === null ? "" : `ran out after ${Math.floor(w.depletedAt / 12)}y ${w.depletedAt % 12}m`}</td>`;
    return tr;
  });
  ui.tableBody.replaceChildren(...rows);
}

function renderAssumptions(series, result, { instrument, currency, years }) {
  const warnings = [];
  if (!instrument.adjusted) {
    warnings.push(
      `${instrument.name} is a price index: it excludes dividends, so every line here is lower than a real investor holding the index would have seen.`,
    );
  }
  if (series.converted) {
    warnings.push(
      `Prices are converted from ${instrument.currency} to ${currency} at each month's exchange rate, so the result includes currency movement. History starts where the exchange-rate series does.`,
    );
  }
  // Overlapping windows are not independent samples: what matters is how many
  // distinct start months the series actually offers beyond the horizon.
  const spread = series.returns.length - years * 12;
  if (spread < 120) {
    warnings.push(
      `This series only offers ${result.windows.length} start months for a ${yearsAdj(years)} plan, spanning ${(spread / 12).toFixed(1)} years. Neighbouring windows share almost all of their history, so "best" and "worst" describe two specific start months rather than the full range of what is possible.`,
    );
  }
  if (instrument.grossOfTax) {
    warnings.push(
      `${instrument.name} reinvests dividends before withholding tax. A fund actually receives them after it, which historically costs roughly 0.5–0.7 percentage points a year — so these lines sit a little above what a real tracker would have returned.`,
    );
  }
  if (result.depleted) {
    warnings.push(
      `The money ran out before the end in ${result.depleted} of ${result.windows.length} timelines. Those are shown flat at zero from the month the portfolio could no longer cover the withdrawal.`,
    );
  }
  if (!["msci-world", "msci-world-index", "sp500", "ff-developed", "ff-us"].includes(instrument.id)) {
    warnings.push(`${instrument.name} here is a tradable fund used as a proxy for the index, not the index itself.`);
  }

  ui.assumptions.innerHTML =
    `<dl class="kv">` +
    `<dt>Instrument</dt><dd>${instrument.detail}</dd>` +
    `<dt>Series currency</dt><dd>${
      series.denominated
        ? `${currency}, computed in that currency at source (no conversion)`
        : series.converted
          ? `${instrument.currency} → converted to ${currency} at historical rates`
          : `${instrument.currency} (no conversion)`
    }</dd>` +
    `<dt>Return type</dt><dd>${
      !instrument.adjusted
        ? "Price return (dividends excluded)"
        : instrument.grossOfTax
          ? "Total return, gross of dividend withholding tax"
          : "Total return, net of dividend withholding tax"
    }</dd>` +
    `<dt>History used</dt><dd>${monthLabel(series.months[0])} – ${monthLabel(series.months.at(-1))} · ${series.returns.length} monthly returns</dd>` +
    `<dt>Windows tested</dt><dd>${result.windows.length} overlapping ${yearsAdj(years)} periods, one per start month</dd>` +
    `<dt>Cash-flow order</dt><dd>Each month the balance earns that month's return first, then the payment is added</dd>` +
    `<dt>Not included</dt><dd>Tax, trading fees, fund costs beyond those already in the price, and inflation</dd>` +
    `<dt>Source</dt><dd>${data.source}, fetched ${new Date(data.fetchedAt).toLocaleDateString()}</dd>` +
    `</dl>` +
    warnings.map((w) => `<p class="warn">${w}</p>`).join("");
}

function render() {
  const input = readInputs();
  setCurrencyFormat(input.currency);
  ui.initialSymbol.textContent = CURRENCIES[input.currency] ?? input.currency;
  ui.monthlySymbol.textContent = (input.monthly < 0 ? "−" : "+") + (CURRENCIES[input.currency] ?? input.currency);
  ui.monthlySymbol.classList.toggle("money-symbol--plus", input.monthly >= 0);
  ui.instrumentHint.textContent = input.instrument.detail;

  const cacheKey = `${input.instrument.id}|${input.currency}`;
  if (seriesCache?.key !== cacheKey) {
    seriesCache = { key: cacheKey, series: buildSeries(data, input.instrument, input.currency) };
  }
  const series = seriesCache.series;

  ui.currencyHint.textContent = series.denominated
    ? `MSCI computes this index in ${input.currency} directly, so no conversion is applied.`
    : series.converted
      ? `Converted from ${input.instrument.currency} at historical rates.`
      : `${input.instrument.name} is quoted in ${input.currency}, so no conversion is applied.`;

  // The horizon can never exceed the history the current series actually has.
  const maxYears = Math.max(1, Math.floor(series.returns.length / 12));
  ui.horizon.max = Math.min(30, maxYears);
  if (Number(ui.horizon.value) > Number(ui.horizon.max)) ui.horizon.value = ui.horizon.max;
  const years = Number(ui.horizon.value);
  const horizonMonths = years * 12;
  ui.horizonValue.textContent = yearsLabel(years);
  ui.horizonScale.replaceChildren();
  ui.horizonScale.append(
    Object.assign(document.createElement("span"), { textContent: "1y" }),
    Object.assign(document.createElement("span"), { textContent: `${ui.horizon.max}y` }),
  );

  const result = runScenario(series, { horizonMonths, initial: input.initial, monthly: input.monthly });
  if (!result) {
    ui.chartSub.textContent = "Not enough history for this horizon.";
    return;
  }

  ui.dataStatus.textContent =
    `${series.returns.length} months of history · ${monthLabel(series.months[0])}–${monthLabel(series.months.at(-1))}`;
  ui.chartSub.textContent =
    `${yearsLabel(years)} of ${input.instrument.name} in ${input.currency}, replayed from all ${result.windows.length} start months in the data.`;
  ui.chartCaption.textContent =
    `Best, median and worst are single real timelines — the start months that ended highest, in the middle and lowest. ` +
    `Average is the mean of all ${result.windows.length} timelines month by month, and the shaded area covers every one of them.`;
  ui.chartDesc.textContent =
    `Line chart of portfolio value over ${yearsLabel(years)}. Best ends at ${money.format(result.paths.best.at(-1))}, ` +
    `average ${money.format(result.paths.average.at(-1))}, median ${money.format(result.paths.median.at(-1))}, ` +
    `worst ${money.format(result.paths.worst.at(-1))}, against ${money.format(result.paidIn.at(-1))} paid in.`;
  ui.windowsNote.textContent =
    `Tested against ${result.windows.length} overlapping ${yearsAdj(years)} periods between ${monthLabel(series.months[0])} and today.`;

  drawChart(result, horizonMonths);
  renderCards(result, { ...input, years });
  renderTable(result);
  renderAssumptions(series, result, { ...input, years });
}

async function init() {
  const res = await fetch("data/market-data.json");
  data = await res.json();

  ui.instrument.replaceChildren(...data.instruments.map((i) =>
    Object.assign(document.createElement("option"), { value: i.id, textContent: i.name })));
  ui.instrument.value = "ff-developed";

  ui.currency.replaceChildren(...Object.keys(CURRENCIES).map((code) =>
    Object.assign(document.createElement("option"), {
      value: code,
      textContent: `${code} — ${CURRENCIES[code]}`,
    })));
  ui.currency.value = detectCurrency();

  renderLegend();
  for (const control of [ui.instrument, ui.currency, ui.initial, ui.monthly, ui.horizon]) {
    control.addEventListener("input", render);
  }
  new ResizeObserver(() => chartState && drawChart(chartState.result, chartState.horizonMonths)).observe(host);
  render();
}

init();
