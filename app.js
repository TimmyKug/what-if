/**
 * What if? — replays a saving plan over every historical window a market series
 * is long enough to cover, and draws the average, median, best and worst of them.
 *
 * Runs client-side against the committed datasets in `data/`; refresh them with
 * `node scripts/fetch-market-data.mjs`.
 */

import { normalise, keyLabel, buildSeries, runScenario, OBSERVATIONS_PER_YEAR } from "./engine.js";

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

async function loadData() {
  return normalise(await (await fetch("data/market-data.json")).json());
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

/** A horizon as a fraction of a year, which is what the step count is built on. */
const durationYears = ({ years, months }) => years + months / 12;

/** "10 years", "3 years 6 months", "2 months 10 days" — empty parts dropped. */
function durationLabel({ years, months }) {
  const parts = [[years, "year"], [months, "month"]]
    .filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" ") : "0 months";
}

/**
 * Grouped so the dropdown says which series are alternatives for each other.
 * Developed Markets and MSCI World cover the same companies — they correlate at
 * 0.9966 — and the only reason to pick one over the other is where its history
 * starts, which is why each option carries its start year.
 *
 * Headings stay short because a native select sizes its popup to the widest
 * option and clips anything longer; the hint under the select carries the detail.
 */
const GROUPS = [
  { label: "Developed world", ids: ["msci-world", "ff-developed", "msci-world-etf", "msci-world-index"] },
  { label: "World + emerging", ids: ["msci-acwi", "ftse-all-world"] },
  { label: "Emerging markets", ids: ["msci-em", "msci-em-ex-china"] },
  { label: "United States", ids: ["sp500", "us-total-market", "ff-us"] },
  { label: "Crypto", ids: ["bitcoin", "ethereum"] },
];

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
  // Below this width the right margin costs more than the labels are worth, so
  // the chart takes the full width and the legend carries the values instead.
  const narrow = width < 560;
  const pad = { top: 16, right: narrow ? 14 : 132, bottom: 30, left: narrow ? 46 : 62 };
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

  // Short horizons are ticked in months; a fractional last year gets no tick of
  // its own rather than a label that reads as a whole year it is not.
  svg.append(el("line", { class: "axis-line", x1: pad.left, x2: pad.left + plotW, y1: y(yLo), y2: y(yLo) }));
  const room = Math.max(2, Math.floor(plotW / 58));
  const inMonths = years < 2;
  const total = inMonths ? Math.round(years * 12) : Math.floor(years);
  const everyN = Math.max(1, Math.ceil(total / room));
  for (let t = 0; t <= total; t += everyN) {
    const fraction = (inMonths ? t / 12 : t) / years;
    if (fraction > 1) break;
    svg.append(el("text", { class: "axis-text", "text-anchor": "middle", x: x(fraction * steps), y: pad.top + plotH + 18 },
      t === 0 ? "start" : `${t}${inMonths ? "m" : "y"}`));
  }

  // Everywhere any historical timeline ever went, drawn thinned out on long
  // horizons where the extra points change nothing.
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

  if (!narrow) {
    // Each line is labelled with its name and where it ended, so the figures
    // live on the chart rather than in a row of tiles repeating it underneath.
    const labels = lines
      .map((line) => ({
        text: line.label, color: line.color,
        value: money.format(line.values.at(-1)),
        at: y(line.values.at(-1)),
      }))
      .sort((a, b) => a.at - b.at);
    // Each label is two lines (name over value), so they need the height of both
    // plus a gap before they stop colliding.
    for (let i = 1; i < labels.length; i++) labels[i].at = Math.max(labels[i].at, labels[i - 1].at + 38);
    const overflow = labels.at(-1).at - (pad.top + plotH);
    if (overflow > 0) for (const label of labels) label.at -= overflow;
    for (const label of labels) {
      svg.append(
        el("text", { class: "series-label", fill: label.color, x: pad.left + plotW + 10, y: label.at + 1 }, label.text),
        el("text", { class: "series-value", x: pad.left + plotW + 10, y: label.at + 17 }, label.value),
      );
    }
  }
  renderLegend(lines, narrow);

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
  plan: document.getElementById("plan"),
  addEvent: document.getElementById("add-event"),
  simplePlan: document.getElementById("simple-plan"),
  modeToggle: document.getElementById("mode-toggle"),
  planHint: document.getElementById("plan-hint"),
  initial: document.getElementById("initial"),
  initialSymbol: document.getElementById("initial-symbol"),
  monthly: document.getElementById("monthly"),
  monthlySymbol: document.getElementById("monthly-symbol"),
  years: document.getElementById("years"),
  months: document.getElementById("months"),
  horizonHint: document.getElementById("horizon-hint"),
  instrumentHint: document.getElementById("instrument-hint"),
  currencyHint: document.getElementById("currency-hint"),
  legend: document.getElementById("legend"),
  chartSub: document.getElementById("chart-sub"),
  chartCaption: document.getElementById("chart-caption"),
  chartDesc: document.getElementById("chart-desc"),
  windowsNote: document.getElementById("windows-note"),
  assumptions: document.getElementById("assumptions"),
  tableBody: document.querySelector("#windows-table tbody"),
};

let data;
let seriesCache = null;

/**
 * The plan is a list of cash-flow events. Every scenario the README describes is
 * one of these lists: a wait is simply a stretch nobody pays into, and a
 * withdrawal is a payment with a minus sign, so neither needs its own concept.
 *
 * `from` and `to` are whole months from the start, which is how the README talks
 * about them ("33 months", "60 payments") and avoids four date fields per row.
 */
let plan = [{ id: 1, amount: 100, cadence: "monthly", from: 1, to: null }];
let nextEventId = 2;

/**
 * Simple mode is a view over the same event list, not a second model: it edits a
 * lump at month 0 and one repeating payment covering the whole horizon. The
 * engine sees a schedule either way, so the toggle changes what is editable
 * rather than what is computed.
 */
let proMode = false;

/** Rewrites the plan to the two events simple mode can express. */
function setSimplePlan() {
  const initial = Math.max(0, Number(ui.initial.value) || 0);
  const monthly = Number(ui.monthly.value) || 0;
  plan = [];
  if (initial) plan.push({ id: nextEventId++, amount: initial, cadence: "once", from: 0, to: null });
  plan.push({ id: nextEventId++, amount: monthly, cadence: "monthly", from: 1, to: null });
}

/** Fills the simple fields from the plan, for the trip back from pro mode. */
function readSimpleFromPlan() {
  const lump = plan.find((e) => e.cadence === "once" && e.from === 0);
  const repeating = plan.find((e) => e.cadence === "monthly");
  ui.initial.value = lump ? lump.amount : 0;
  ui.monthly.value = repeating ? repeating.amount : 0;
}

/** True when the plan is something the two simple fields could have produced. */
function isSimplePlan() {
  return plan.every((e) =>
    (e.cadence === "once" && e.from === 0) ||
    (e.cadence === "monthly" && e.from === 1 && (e.to === null || e.to === undefined)));
}

function setMode(pro) {
  proMode = pro;
  ui.modeToggle.setAttribute("aria-pressed", String(pro));
  ui.modeToggle.textContent = pro ? "Switch to simple mode" : "Switch to pro mode";
  ui.simplePlan.hidden = pro;
  ui.plan.hidden = !pro;
  ui.addEvent.hidden = !pro;
  if (!pro) { readSimpleFromPlan(); setSimplePlan(); }
  render();
}

/** Net cash flow per month, which is all the engine needs to know. */
function buildSchedule(events, steps) {
  const schedule = new Float64Array(steps + 1);
  for (const event of events) {
    const amount = Number(event.amount) || 0;
    if (!amount) continue;
    if (event.cadence === "once") {
      // Month zero is money already there before the first month's return.
      schedule[Math.min(Math.max(0, event.from), steps)] += amount;
    } else {
      const to = Math.min(event.to ?? steps, steps);
      for (let t = Math.max(1, event.from); t <= to; t++) schedule[t] += amount;
    }
  }
  return schedule;
}

const monthsLabel = (n) => {
  const y = Math.floor(n / 12), m = n % 12;
  return [y ? `${y}y` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "start";
};

function renderPlan(steps) {
  const symbol = CURRENCIES[ui.currency.value] ?? ui.currency.value;
  ui.plan.replaceChildren(...plan.map((event) => {
    const row = document.createElement("div");
    row.className = "plan-row";
    const once = event.cadence === "once";
    const to = Math.min(event.to ?? steps, steps);
    row.innerHTML =
      `<div class="plan-top">` +
        `<div class="money-input">` +
          `<span class="money-symbol${event.amount >= 0 ? " money-symbol--plus" : ""}">${event.amount < 0 ? "\u2212" : "+"}${symbol}</span>` +
          `<input type="number" step="10" value="${event.amount}" data-field="amount" inputmode="numeric" aria-label="Amount" />` +
        `</div>` +
        `<select data-field="cadence" aria-label="How often">` +
          `<option value="monthly"${once ? "" : " selected"}>each month</option>` +
          `<option value="once"${once ? " selected" : ""}>once</option>` +
        `</select>` +
      `</div>` +
      `<div class="plan-when">` +
        `<span>${once ? "in month" : "from month"}</span>` +
        `<input type="number" min="${once ? 0 : 1}" value="${event.from}" data-field="from" inputmode="numeric" aria-label="First month" />` +
        (once ? "" : `<span>to</span><input type="number" min="1" value="${event.to ?? steps}" data-field="to" inputmode="numeric" aria-label="Last month" />`) +
        `<span class="spacer"></span>` +
        `<button type="button" class="plan-remove" data-field="remove" aria-label="Remove">\u2715</button>` +
      `</div>` +
      `<div class="plan-note">${once
        ? (event.from === 0 ? "at the start" : `at ${monthsLabel(event.from)}`)
        : `${monthsLabel(event.from)} to ${monthsLabel(to)} \u00b7 ${Math.max(0, to - event.from + 1)} payments`}</div>`;

    row.addEventListener("input", (e) => {
      const field = e.target.dataset.field;
      if (field === "amount") event.amount = Number(e.target.value) || 0;
      else if (field === "cadence") event.cadence = e.target.value;
      else if (field === "from") event.from = Math.max(event.cadence === "once" ? 0 : 1, Math.trunc(Number(e.target.value) || 0));
      else if (field === "to") event.to = Math.max(1, Math.trunc(Number(e.target.value) || 1));
      render();
    });
    row.querySelector('[data-field="remove"]').addEventListener("click", () => {
      plan = plan.filter((x) => x !== event);
      if (!plan.length) plan = [{ id: nextEventId++, amount: 0, cadence: "monthly", from: 1, to: null }];
      render();
    });
    return row;
  }));
}

function readInputs() {
  return {
    instrumentId: ui.instrument.value,
    currency: ui.currency.value,
    years: Math.max(0, Math.trunc(Number(ui.years.value) || 0)),
    months: Math.max(0, Math.trunc(Number(ui.months.value) || 0)),
  };
}

const yearOf = (key) => String(key).slice(0, 4);
const span = (instrument) => `${yearOf(instrument.keys[0])}\u2013${yearOf(instrument.keys.at(-1))}`;

function renderInstrumentOptions(data) {
  const byId = new Map(data.instruments.map((i) => [i.id, i]));
  const selected = ui.instrument.value;
  const seen = new Set();
  const groups = GROUPS.map(({ label, ids }) => {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const id of ids) {
      const instrument = byId.get(id);
      if (!instrument) continue;
      seen.add(id);
      group.append(Object.assign(document.createElement("option"), {
        value: id, textContent: `${instrument.name} · ${span(instrument)}`,
      }));
    }
    return group;
  }).filter((g) => g.childElementCount);

  // Anything a group forgets still has to appear, rather than vanish silently.
  const rest = data.instruments.filter((i) => !seen.has(i.id));
  if (rest.length) {
    const group = document.createElement("optgroup");
    group.label = "Other";
    group.append(...rest.map((i) => Object.assign(document.createElement("option"), {
      value: i.id, textContent: `${i.name} · ${span(i)}`,
    })));
    groups.push(group);
  }

  ui.instrument.replaceChildren(...groups);
  if (selected) ui.instrument.value = selected;
}

/**
 * On a narrow screen the legend carries each series' ending value, because the
 * chart gives up its right margin there and the direct labels with it.
 */
function renderLegend(lines, withValues) {
  ui.legend.classList.toggle("legend--values", withValues);
  ui.legend.replaceChildren(...lines.map((line) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.setAttribute("role", "listitem");
    item.innerHTML =
      `<span class="legend-swatch${line.dashed ? " legend-swatch--dashed" : ""}" style="color:${line.color}"></span>` +
      `<span class="legend-name">${line.label}</span>` +
      (withValues ? `<span class="legend-value">${money.format(line.values.at(-1))}</span>` : "");
    return item;
  }));
}

/**
 * There can be hundreds of start months, so the table shows the distribution
 * rather than every window, plus the three the chart names.
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
      `<td>${pick ? keyLabel(pick.startKey) : ""}</td>` +
      `<td class="num">${money.format(paidIn)}</td>` +
      `<td class="num">${money.format(value)}</td>` +
      `<td class="num ${gain >= 0 ? "gain-positive" : "gain-negative"}">${change(gain, paidIn)}</td>` +
      `<td>${pick?.depletedAt != null ? "ran out early" : ""}</td>`;
    return tr;
  }));
}

function renderAssumptions(series, result, { instrument, currency, horizon, longer }) {
  const warnings = [];
  if (longer) {
    warnings.push(
      `${longer.name} covers the same kind of portfolio from ${longer.from}, ${longer.extra.toLocaleString()} more start dates than this series. ` +
      `Its worst run over ${durationLabel(horizon)} ended at ${money.format(longer.worst)} against ${money.format(longer.paidIn)} paid in — ` +
      `${longer.delta} than the worst shown here. A shorter history does not just blur the range, it can miss the crash altogether.`,
    );
  }
  if (!instrument.adjusted) {
    warnings.push(`${instrument.name} is a price index: it excludes dividends, so every line here is lower than a real investor holding the index would have seen.`);
  }
  if (instrument.grossOfTax) {
    warnings.push(`${instrument.name} reinvests dividends before withholding tax. A fund actually receives them after it, which historically costs roughly 0.5–0.7 percentage points a year — so these lines sit a little above what a real tracker would have returned.`);
  }
  if (series.converted) {
    warnings.push(`Prices are converted from ${instrument.currency} to ${currency} at each period's exchange rate, so the result includes currency movement. History starts where the exchange-rate series does.`);
  }
  const spanYears = result.windows / 12;
  if (spanYears < 10) {
    warnings.push(`This series offers ${result.windows.toLocaleString()} start dates for a plan of ${durationLabel(horizon)}, spanning ${spanYears.toFixed(1)} years. Neighbouring windows share almost all of their history, so "best" and "worst" describe two particular start dates rather than the full range of what is possible.`);
  }
  if (result.depleted) {
    warnings.push(`The money ran out before the end in ${result.depleted.toLocaleString()} of ${result.windows.toLocaleString()} timelines. Those are shown flat at zero from the point the portfolio could no longer cover the withdrawal.`);
  }
  if (instrument.assetClass === "crypto") {
    warnings.push(
      `${instrument.name} is a single speculative asset, not a diversified portfolio, and its record is short: the whole history here is briefer than one of the drawdowns in the equity series. Every "worst case" below is the worst of a handful of overlapping windows drawn from one bull market and one crash, which is not the same as the worst that can happen.`,
    );
  } else if (!["msci-world", "msci-acwi", "msci-world-index", "sp500", "ff-developed", "ff-us"].includes(instrument.id)) {
    warnings.push(`${instrument.name} here is a tradable fund used as a proxy for the index, not the index itself.`);
  }

  ui.assumptions.innerHTML =
    `<dl class="kv">` +
    `<dt>Instrument</dt><dd>${instrument.detail}</dd>` +
    `<dt>Series currency</dt><dd>${
      series.denominated ? `${currency}, computed in that currency at source (no conversion)`
        : series.converted ? `${instrument.currency} → converted to ${currency} at historical rates`
        : `${instrument.currency} (no conversion)`}</dd>` +
    `<dt>Return type</dt><dd>${
      instrument.assetClass === "crypto" ? "Price only — there are no dividends to reinvest"
        : !instrument.adjusted ? "Price return (dividends excluded)"
        : instrument.grossOfTax ? "Total return, gross of dividend withholding tax"
        : "Total return, net of dividend withholding tax"}</dd>` +
    `<dt>History used</dt><dd>${keyLabel(series.keys[0])} – ${keyLabel(series.keys.at(-1))} · ${series.returns.length.toLocaleString()} observations</dd>` +
    `<dt>Start dates tested</dt><dd>${result.windows.toLocaleString()} overlapping periods of ${durationLabel(horizon)}, one per start date</dd>` +
    `<dt>Buying</dt><dd>Every month, at each month-end observation</dd>` +
    `<dt>Cash-flow order</dt><dd>The balance earns each period's return first, then the payment is added</dd>` +
    `<dt>Not included</dt><dd>Tax, trading fees, fund costs beyond those already in the price, and inflation</dd>` +
    `<dt>Source</dt><dd>${data.source}, fetched ${new Date(data.fetchedAt).toLocaleDateString()}</dd>` +
    `</dl>` +
    warnings.map((w) => `<p class="warn">${w}</p>`).join("");
}

/**
 * The longest comparable series, when the one on screen is materially shorter.
 *
 * Worth the extra run: the headline worst case is mostly a question of whether
 * the data reaches back past a crash. The same plan bottoms out at +42% on a
 * series starting in 2008 and −30% on one starting in 1990.
 */
const REFERENCE = "ff-developed";

function longerHistory(instrument, input, steps, result) {
  if (instrument.id === REFERENCE) return null;
  if (instrument.assetClass === "crypto") return null; // not the same kind of thing
  const reference = data.instruments.find((i) => i.id === REFERENCE);
  if (!reference) return null;

  const series = buildSeries(data, reference, input.currency);
  const run = runScenario(series, {
    steps, schedule: buildSchedule(plan, steps),
  });
  if (!run || run.windows <= result.windows) return null;

  const worst = run.paths.worst.at(-1);
  const paidIn = run.paidIn.at(-1);
  const here = result.paths.worst.at(-1);
  return {
    name: reference.name,
    from: keyLabel(series.keys[0]),
    extra: run.windows - result.windows,
    worst, paidIn,
    delta: worst < here
      ? `${money.format(here - worst)} worse`
      : `${money.format(worst - here)} better`,
  };
}

function render() {
  const input = readInputs();
  setCurrencyFormat(input.currency);

  const instrument = data.instruments.find((i) => i.id === input.instrumentId) ?? data.instruments[0];
  ui.instrument.value = instrument.id;
  ui.instrumentHint.textContent = instrument.detail;

  const symbol = CURRENCIES[input.currency] ?? input.currency;
  const monthlyAmount = Number(ui.monthly.value) || 0;
  ui.initialSymbol.textContent = symbol;
  ui.monthlySymbol.textContent = (monthlyAmount < 0 ? "−" : "+") + symbol;
  ui.monthlySymbol.classList.toggle("money-symbol--plus", monthlyAmount >= 0);

  const cacheKey = `${instrument.id}|${input.currency}`;
  if (seriesCache?.key !== cacheKey) {
    seriesCache = { key: cacheKey, series: buildSeries(data, instrument, input.currency) };
  }
  const series = seriesCache.series;

  ui.currencyHint.textContent = series.denominated
    ? `Computed in ${input.currency} at source, so no conversion is applied.`
    : series.converted
      ? `Converted from ${instrument.currency} at historical rates.`
      : `${instrument.name} is quoted in ${input.currency}, so no conversion is applied.`;

  const perYear = OBSERVATIONS_PER_YEAR;
  const requested = Math.max(1, Math.round(durationYears(input) * perYear));
  const available = series.returns.length;
  const steps = Math.min(requested, available);
  const horizon = steps === requested
    ? input
    : { years: Math.floor(steps / perYear), months: steps % perYear };

  ui.horizonHint.textContent = steps < requested
    ? `Only ${durationLabel(horizon)} of history is available, so that is what is shown.`
    : "";
  const years = steps / perYear;
  if (proMode) renderPlan(steps);
  ui.planHint.textContent = !proMode
    ? "Negative amounts withdraw instead of paying in."
    : isSimplePlan()
      ? "Negative amounts withdraw. Months count from the start."
      : "Negative amounts withdraw. Switching back to simple replaces this plan with a single monthly amount.";
  const result = runScenario(series, { steps, schedule: buildSchedule(plan, steps) });
  if (!result) {
    ui.chartSub.textContent = "Not enough history for this horizon.";
    return;
  }

  ui.chartSub.textContent =
    `${durationLabel(horizon)} of ${instrument.name} in ${input.currency}, ` +
    `replayed from all ${result.windows.toLocaleString()} start dates in the data.`;
  ui.chartDesc.textContent =
    `Line chart of portfolio value over ${durationLabel(horizon)}. Best ends at ${money.format(result.paths.best.at(-1))}, ` +
    `average ${money.format(result.paths.average.at(-1))}, worst ${money.format(result.paths.worst.at(-1))}, ` +
    `against ${money.format(result.paidIn.at(-1))} paid in. The median outcome was ${money.format(result.paths.median.at(-1))}.`;
  ui.windowsNote.textContent =
    `Tested against ${result.windows.toLocaleString()} overlapping periods of ${durationLabel(horizon)} from ${keyLabel(series.keys[0])}.`;

  drawChart(result, years);
  renderTable(result);
  renderAssumptions(series, result, { ...input, instrument, horizon, longer: longerHistory(instrument, input, steps, result) });
}

async function init() {
  data = await loadData();

  renderInstrumentOptions(data);
  ui.instrument.value = "ff-developed";

  ui.currency.replaceChildren(...Object.keys(CURRENCIES).map((code) =>
    Object.assign(document.createElement("option"), { value: code, textContent: `${code} — ${CURRENCIES[code]}` })));
  ui.currency.value = detectCurrency();

  for (const control of [ui.initial, ui.monthly]) {
    control.addEventListener("input", () => { setSimplePlan(); render(); });
  }
  ui.modeToggle.addEventListener("click", () => setMode(!proMode));
  ui.addEvent.addEventListener("click", () => {
    plan.push({ id: nextEventId++, amount: 0, cadence: "once", from: 0, to: null });
    render();
  });
  for (const control of [ui.instrument, ui.currency, ui.years, ui.months]) {
    control.addEventListener("input", render);
  }
  new ResizeObserver(() => chartState && drawChart(chartState.result, chartState.years)).observe(host);
  // Sync the DOM with the starting mode rather than trusting the markup to match.
  setMode(proMode);
}

init();
