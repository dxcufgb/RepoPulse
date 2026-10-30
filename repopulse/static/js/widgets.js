// Widget catalogue: each type knows its defaults, its settings form and how
// to draw itself from the Model.

import { api } from "./api.js";
import { bucket, pctChange, rangeLabel } from "./data.js";
import { esc, fmt, fmt1, fmtCompact, fmtDay, markup, icon, parseDate, raw, setHTML, timeAgo } from "./util.js";

/* ------------------------------------------------------------- theme */
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export function palette() {
  return {
    ink: cssVar("--ink"), ink2: cssVar("--ink-2"), muted: cssVar("--muted"), grid: cssVar("--grid"),
    line: cssVar("--line-strong"), panel: cssVar("--panel"), paper: cssVar("--paper"), accent: cssVar("--accent"),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--s${i}`)), other: cssVar("--s-other"),
    onAccent: cssVar("--on-accent") || "#ffffff", font: cssVar("--font-ui"),
  };
}
const reducedMotion = () => document.documentElement.dataset.motion === "off" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const anim = (ms) => (reducedMotion() ? false : { duration: ms });
/** The headline band is filled with the accent colour (Admin, Appearance): its chart is drawn in the text colour. */
const bandFilled = () => ["accent", "gradient"].includes(document.documentElement.dataset.headline);

/** Colour per repo: a custom colour, else its own palette slot. Two repos in
 * the same chart never share a colour (only possible with more than 8 repos). */
export function colorsFor(repos, pal) {
  const map = new Map(), used = new Set();
  repos.forEach((r) => { if (r.color) { map.set(r.id, r.color); used.add(r.color.toLowerCase()); } });
  repos.forEach((r) => {
    if (r.color) return;
    let c = pal.series[r.slot % 8];
    if (used.has(c.toLowerCase())) c = pal.series.find((x) => !used.has(x.toLowerCase())) || c;
    used.add(c.toLowerCase());
    map.set(r.id, c);
  });
  return map;
}

/** Which items get a series (bar, slice) of their own. cfg.top: "auto" (all up
 * to 8, else the 7 largest), a number, or "all"; the rest is folded into one
 * "Other" item, or left out when cfg.rest is "hide". */
function foldItems(items, score, cfg, auto = 8) {
  const top = cfg.top === "all" ? Infinity : Number(cfg.top) || 0;
  if (items.length <= (top || auto)) return { shown: items, rest: [] };
  const keep = top || auto - 1;
  const sorted = items.slice().sort((a, b) => score(b) - score(a));
  const shown = sorted.slice(0, keep), rest = sorted.slice(keep);
  return cfg.rest === "hide" ? { shown, rest: [] } : { shown, rest };
}

function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function alpha(hex, a) {
  const c = rgb(hex);
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})` : hex;
}
/** a mixed with b; t is the share of b. */
export function mixHex(a, b, t) {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return a;
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
/** n shades of one colour, from full strength towards the background. */
function shades(base, n, bg) {
  return Array.from({ length: n }, (_, i) => (n < 2 ? base : mixHex(base, bg, (i / (n - 1)) * 0.68)));
}
/** Recolours the items (not "Other") after the widget's Colours setting. */
function applyColors(cfg, items, pal) {
  const own = items.filter((it) => !it.other);
  if (cfg.colors === "palette") own.forEach((it, i) => { it.color = pal.series[i % 8]; });
  else if (cfg.colors === "mono") { const s = shades(pal.accent, own.length, pal.panel); own.forEach((it, i) => { it.color = s[i]; }); }
  return items;
}
/** Each point averaged with the w - 1 before it. */
function rolling(values, w) {
  if (!(w > 1)) return values;
  return values.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - w + 1); j <= i; j++) if (values[j] != null) { s += values[j]; n++; }
    return n ? s / n : null;
  });
}

/* -------------------------------------------------------- repo scope */
/** The repositories a widget looks at: on a repository page always that one. */
function scope(cfg, ctx) {
  return ctx.repo ? [ctx.repo] : ctx.model.pick(cfg.repos);
}
/** The single repository a releases/files widget is about. */
function targetRepo(cfg, ctx) {
  return ctx.repo || ctx.model.byId.get(Number(cfg.repo)) || null;
}
export function repoHref(ctx, repo) {
  return `${ctx.base || ""}/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
function openRepo(ctx, repo) {
  if (repo && ctx.links) window.dispatchEvent(new CustomEvent("repopulse:navigate", { detail: repoHref(ctx, repo) }));
}
/** Click on a bar/slice opens that repository's page; the pointer shows it is clickable. */
function clickThrough(ctx, reposByIndex) {
  if (!ctx.links) return {};
  return {
    onClick: (_e, els) => { if (els.length) openRepo(ctx, reposByIndex[els[0].index]); },
    onHover: (e, els) => { e.native.target.style.cursor = els.length && reposByIndex[els[0].index] ? "pointer" : "default"; },
  };
}
/** Release list, per-release history and layout of one repository (cached). */
export function loadPage(ctx, repoId) {
  if (ctx.pageData && ctx.repo && ctx.repo.id === repoId) return Promise.resolve(ctx.pageData);
  ctx.pageCache = ctx.pageCache || new Map();
  if (!ctx.pageCache.has(repoId)) ctx.pageCache.set(repoId, api(`/api/repos/${repoId}/page`));
  return ctx.pageCache.get(repoId);
}

/* --------------------------------------------------------- chart setup */
function tooltip(pal, titleFn, labelFn) {
  return {
    backgroundColor: pal.ink, titleColor: pal.paper, bodyColor: pal.paper, footerColor: pal.paper,
    borderWidth: 0, cornerRadius: 8, padding: 10, boxPadding: 5, usePointStyle: true,
    titleFont: { family: pal.font, weight: "600", size: 13 }, bodyFont: { family: pal.font, size: 13 },
    callbacks: {
      title: titleFn || ((items) => items[0]?.label),
      label: labelFn || ((c) => ` ${c.dataset.label}: ${fmt(c.parsed.y ?? c.parsed)}`),
    },
  };
}

/** grid: "show", "hide" (no grid lines) or "none" (no grid and no axes). */
function axisOptions(pal, { stacked = false, horizontal = false, xTick, grid = "show", log = false, percent = false } = {}) {
  const valueTick = percent ? (v) => `${v}%` : (v) => fmtCompact(v);
  const valueAxis = {
    type: log ? "logarithmic" : "linear", display: grid !== "none",
    beginAtZero: !log, stacked, grid: { color: pal.grid, drawTicks: false, display: grid === "show" }, border: { display: false },
    ticks: { color: pal.muted, padding: 8, maxTicksLimit: 6, callback: valueTick, font: { family: pal.font, size: 12 } },
  };
  if (percent) valueAxis.max = 100;
  const catTicks = { color: pal.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 14, font: { family: pal.font, size: 12 } };
  if (xTick && !horizontal) catTicks.callback = xTick;
  // "none" keeps the category names on horizontal bars, or the bars would have no names
  const catAxis = { stacked, display: grid !== "none" || horizontal, grid: { display: false }, border: { color: pal.line, display: grid !== "none" }, ticks: catTicks };
  if (horizontal) {
    catAxis.ticks = { ...catTicks, color: pal.ink2, autoSkip: false,
      callback: function (v) { const l = String(this.getLabelForValue(v)); return l.length > 26 ? l.slice(0, 25) + "…" : l; } };
    return { x: valueAxis, y: catAxis };
  }
  return { x: catAxis, y: valueAxis };
}

/** Chart.js plugin that writes the values on the chart: at the end of each
 * bar, on top of each stack, at the last point of each line, or the share on
 * each slice. Built per chart so format() is not mistaken for an option. */
function valueLabels(on, pal, format = fmtCompact) {
  return {
    id: "rpValues",
    afterDatasetsDraw(c) {
      if (!on) return;
      const g = c.ctx, type = c.config.type;
      g.save();
      g.font = `600 12px ${pal.font}`;
      if (["doughnut", "pie", "polarArea"].includes(type)) {
        const data = c.data.datasets[0].data, total = data.reduce((a, v) => a + (v || 0), 0);
        g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#fff";
        g.shadowColor = "rgba(0, 0, 0, .55)"; g.shadowBlur = 3;
        c.getDatasetMeta(0).data.forEach((el, i) => {
          if (!total || !data[i] || data[i] / total < 0.04 || !c.getDataVisibility(i)) return;
          const p = el.tooltipPosition();
          g.fillText(type === "polarArea" ? format(data[i]) : `${fmt1((data[i] / total) * 100)}%`, p.x, p.y);
        });
        g.restore();
        return;
      }
      g.fillStyle = pal.ink2;
      const horizontal = c.options.indexAxis === "y";
      const sets = c.data.datasets.map((d, i) => [d, c.getDatasetMeta(i)]).filter(([, m]) => !m.hidden);
      const isLine = (d) => (d.type || type) === "line";
      if (type === "bar" && c.options.scales?.y?.stacked) {
        const bars = sets.filter(([d]) => !isLine(d));
        const n = c.data.labels.length;
        if (n <= 40) for (let i = 0; i < n; i++) {
          const sum = bars.reduce((a, [d]) => a + (d.data[i] || 0), 0);
          const els = bars.map(([, m]) => m.data[i]).filter(Boolean);
          if (!els.length || !sum) continue;
          g.textAlign = "center"; g.textBaseline = "bottom";
          g.fillText(format(sum), els[0].x, Math.min(...els.map((e) => e.y)) - 4);
        }
        g.restore();
        return;
      }
      for (const [d, m] of sets) {
        if (isLine(d)) {
          let j = d.data.length - 1;
          while (j >= 0 && d.data[j] == null) j--;
          if (j < 0 || !m.data[j]) continue;
          g.textAlign = "left"; g.textBaseline = "middle";
          g.fillText(format(d.data[j]), m.data[j].x + 7, m.data[j].y);
          continue;
        }
        if (m.data.length > 40) continue;
        m.data.forEach((el, i) => {
          const v = d.data[i];
          if (v == null) return;
          if (horizontal) { g.textAlign = "left"; g.textBaseline = "middle"; g.fillText(format(v), el.x + 6, el.y); }
          else { g.textAlign = "center"; g.textBaseline = "bottom"; g.fillText(format(v), el.x, el.y - 4); }
        });
      }
      g.restore();
    },
  };
}
const labelPadding = (on, right = 48) => (on ? { top: 20, right, left: 0, bottom: 0 } : undefined);

const HEIGHTS = { s: 200, m: 280, l: 380, xl: 480 };
/** The legend (placed after cfg.legend) and the box the canvas goes in. */
function chartFrame(cfg, ctx, legendItems, { height, round = false, label = "" } = {}) {
  const pos = cfg.legend || "auto";
  const h = HEIGHTS[cfg.height] || height;
  return markup`<div class="chart-wrap legend-${pos}">${pos === "none" ? "" : legendHTML(legendItems, ctx)}
    <div class="chart-box ${round ? "round" : ""}" style="${h ? `height:${h}px` : ""}"><canvas role="img" aria-label="${label}"></canvas></div></div>`;
}

function chart(ctx, canvas, config) {
  if (!window.Chart) { canvas.replaceWith(Object.assign(document.createElement("p"), { className: "empty", textContent: "Charts could not load." })); return null; }
  const c = new window.Chart(canvas, config);
  ctx.charts.push(c);
  return c;
}

function dateFormatter(by) {
  if (by === "month") return {
    tick: (iso) => parseDate(iso).toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
    title: (iso) => parseDate(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
  if (by === "week") return {
    tick: (iso) => fmtDay(iso),
    title: (iso) => `Week of ${fmtDay(iso, { day: "numeric", month: "long", year: "numeric" })}`,
  };
  return { tick: (iso) => fmtDay(iso), title: (iso) => fmtDay(iso, { weekday: "short", day: "numeric", month: "long", year: "numeric" }) };
}

function autoBucket(days, n) {
  if (days === 0 && n > 400) return "month";
  if (days >= 180 || (days === 0 && n > 120)) return "week";
  return "day";
}

function legendHTML(items, ctx) {
  if (items.length < 2) return raw("");
  const linked = ctx && ctx.links && items.some((it) => it.repo);
  return markup`<div class="legend" ${linked ? "" : raw('aria-hidden="true"')}>${items.map((it) => linked && it.repo
    ? markup`<a href="${repoHref(ctx, it.repo)}" title="Open ${it.label}"><i style="background:${it.color}"></i>${it.label}</a>`
    : markup`<span><i style="background:${it.color}"></i>${it.label}</span>`)}</div>`;
}

function tableHTML(columns, rows) {
  return markup`<div class="table-wrap"><table class="data"><thead><tr>${columns.map((c, i) =>
    markup`<th class="${i ? "r" : ""}" scope="col">${c}</th>`)}</tr></thead><tbody>${rows.map((r) =>
    markup`<tr>${r.map((v, i) => i ? markup`<td class="r">${typeof v === "number" ? fmt(v) : v ?? "–"}</td>` : markup`<td>${v}</td>`)}</tr>`)}</tbody></table></div>`;
}

/* ------------------------------------------------------------ settings */
export const RANGE_OPTIONS = [
  ["global", "Follow the dashboard range"], [7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"],
  [180, "Last 6 months"], [365, "Last 12 months"], [0, "All time"],
];
const SIZE_LABELS = { quarter: "Quarter width", third: "One third", half: "Half width", "two-thirds": "Two thirds", "three-quarters": "Three quarters", full: "Full width" };
const sizes = (...k) => k.map((x) => [x, SIZE_LABELS[x]]);

export function widgetDays(cfg, ctx) {
  return cfg.range === "global" || cfg.range == null ? ctx.globalDays : Number(cfg.range);
}

/* Fields shared by several widget types. The first option of a select is its
 * default, so layouts saved before an option existed look the same as before. */
const ARC_STYLES = ["doughnut", "pie", "polar"];
const f = {
  title: { key: "title", type: "text", label: "Title", hint: "Leave empty for an automatic title" },
  repos: { key: "repos", type: "repos", label: "Repositories", hint: "None selected means all repositories", overviewOnly: true },
  range: { key: "range", type: "select", label: "Time range", options: RANGE_OPTIONS },
  bucket: { key: "bucket", type: "select", label: "Group by", options: [["auto", "Automatic"], ["day", "Day"], ["week", "Week"], ["month", "Month"]] },
  look: { type: "heading", label: "Look" },
  card: { key: "card", type: "select", label: "Card", options: [["default", "Like the rest of the page"], ["accent", "Highlighted with the accent colour"], ["tint", "Tinted"], ["plain", "No border"], ["clear", "No card, straight on the page"]] },
  height: { key: "height", type: "select", label: "Chart height", options: [["auto", "Automatic"], ["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Extra large"]] },
  legend: { key: "legend", type: "select", label: "Legend", options: [["auto", "Above the chart"], ["bottom", "Below the chart"], ["right", "Beside the chart"], ["none", "Hidden"]] },
  grid: { key: "grid", type: "select", label: "Grid and axes", options: [["show", "Grid lines and axes"], ["hide", "Axes only"], ["none", "Neither (minimal)"]] },
  scale: { key: "scale", type: "select", label: "Value axis", hint: "Logarithmic helps when one series dwarfs the others", options: [["linear", "Linear"], ["log", "Logarithmic"]] },
  values: { key: "values", type: "check", label: "Write the values on the chart" },
  curve: { key: "curve", type: "select", label: "Lines", options: [["smooth", "Smooth"], ["straight", "Straight"], ["step", "Steps"]] },
  points: { key: "points", type: "check", label: "Mark every data point" },
  avg: { key: "avg", type: "select", label: "Smoothing", hint: "Averages each point with the ones before it", options: [[0, "None"], [3, "Average of 3 points"], [7, "Average of 7 points"], [14, "Average of 14 points"], [30, "Average of 30 points"]] },
  total: { key: "total", type: "check", label: "Add a line for the total" },
  rest: { key: "rest", type: "select", label: "The others", options: [["other", "Fold into one “Other” entry"], ["hide", "Leave out"]] },
  compact: { key: "compact", type: "check", label: "Short numbers (12.3K instead of 12,345)" },
};
const colorsField = (first, extra = []) => ({ key: "colors", type: "select", label: "Colours",
  options: [["auto", first], ...extra, ["palette", "Page palette, in order"], ["mono", "Shades of the accent colour"]] });
const topField = (what, auto = "Automatic (up to 8, else the 7 largest and “Other”)") => ({ key: "top", type: "select", label: `${what} shown on their own`,
  options: [["auto", auto], [1, "1"], [3, "3"], [5, "5"], [7, "7"], [10, "10"], [15, "15"], [20, "20"], ["all", "All"]] });

export const TIME_STYLES = [
  ["line", "Line"], ["area", "Area, stacked"], ["area-overlap", "Area, overlapping"], ["share", "Area, share of the total (100%)"],
  ["bar", "Bars, stacked"], ["bar-grouped", "Bars, side by side"], ["bar-share", "Bars, share of the total (100%)"],
];
const timeLook = (multi) => [
  f.look,
  { ...f.legend, show: multi },
  f.height, f.grid,
  { ...f.scale, show: (c) => !["share", "bar-share"].includes(c.style) && !(multi(c) && ["area", "bar"].includes(c.style)) },
  { ...f.curve, show: (c) => !String(c.style).startsWith("bar") },
  { ...f.points, show: (c) => !String(c.style).startsWith("bar") },
  f.avg,
  { ...f.total, show: (c) => multi(c) && !["share", "bar-share"].includes(c.style) },
  f.values, f.card,
];

/* --------------------------------------------------------------- types */
export const TYPES = {
  hero: {
    label: "Headline", blurb: "Big total with a pulse of new downloads",
    defaults: { size: "full", range: "global", repos: [] },
    sizes: sizes("full"),
    fields: [f.title, f.repos, f.range,
      { key: "pulse", type: "select", label: "Pulse shows", options: [["new", "New downloads"], ["cumulative", "Total downloads (running total)"]] },
      f.bucket,
      f.look,
      { key: "chart", type: "select", label: "Pulse chart", options: [["area", "Area"], ["line", "Line"], ["bar", "Bars"], ["none", "No chart"]] },
      f.compact, f.card],
    autoTitle: () => "Total downloads",
    render: renderHero,
  },
  kpi: {
    label: "Number", blurb: "One figure, like downloads this month",
    defaults: { size: "quarter", metric: "new", range: "global", repos: [], spark: true },
    sizes: sizes("quarter", "third", "half"),
    fields: [
      { key: "metric", type: "select", label: "Show", options: [
        ["total", "Total downloads"], ["new", "New downloads in the range"], ["avg", "Average downloads per day"],
        ["stars", "Stars"], ["forks", "Forks"], ["top", "Most downloaded repository in the range", "overview"],
        ["repos", "Repositories tracked", "overview"], ["releases", "Releases published"], ["latest", "Downloads of the newest release", "repo"]] },
      f.title, f.repos, f.range,
      f.look,
      { key: "spark", type: "check", label: "Show a small trend line" },
      { key: "sparkType", type: "select", label: "Trend as", show: (c) => c.spark, options: [["line", "Line"], ["bar", "Bars"]] },
      { key: "align", type: "select", label: "Alignment", options: [["left", "Left"], ["center", "Centred"]] },
      f.compact, f.card,
    ],
    autoTitle: (c) => ({ total: "Total downloads", new: "New downloads", avg: "Downloads per day", stars: "Stars",
      forks: "Forks", top: "Most downloaded", repos: "Repositories", releases: "Releases", latest: "Newest release" })[c.metric] || "Number",
    render: renderKpi,
  },
  timeline: {
    label: "Over time", blurb: "Lines, areas or bars by day, week or month",
    defaults: { size: "two-thirds", measure: "cumulative", split: "repo", style: "line", bucket: "auto", range: "global", repos: [] },
    sizes: sizes("half", "two-thirds", "three-quarters", "full"),
    fields: [
      { key: "measure", type: "select", label: "Measure", options: [["cumulative", "Total downloads (running total)"], ["new", "New downloads"], ["stars", "Stars"]] },
      { key: "split", type: "select", label: "Series", options: [["repo", "One per repository"], ["combined", "All repositories combined"]] },
      { key: "style", type: "select", label: "Chart type", options: TIME_STYLES },
      f.bucket,
      { ...topField("Repositories"), show: (c) => c.split !== "combined", overviewOnly: true },
      { ...f.rest, show: (c) => c.split !== "combined" && c.top && c.top !== "auto" && c.top !== "all", overviewOnly: true },
      f.title, f.repos, f.range,
      ...timeLook((c) => c.split !== "combined"),
      { ...colorsField("Repository colours"), show: (c) => c.split !== "combined", overviewOnly: true },
    ],
    autoTitle: (c) => ({ cumulative: "Total downloads over time", new: "New downloads", stars: "Stars over time" })[c.measure],
    render: renderTimeline,
  },
  breakdown: {
    label: "Per repository", blurb: "Compare repositories as bars, rings, pies or a ranked list", where: ["overview"],
    defaults: { size: "third", measure: "total", style: "doughnut", range: "global", repos: [] },
    sizes: sizes("quarter", "third", "half", "two-thirds", "full"),
    fields: [
      { key: "measure", type: "select", label: "Measure", options: [["total", "Total downloads"], ["new", "New downloads in the range"], ["stars", "Stars"], ["forks", "Forks"]] },
      { key: "style", type: "select", label: "Chart type", options: [["hbar", "Horizontal bars"], ["bar", "Vertical bars"], ["doughnut", "Ring (share of total)"], ["pie", "Pie (share of total)"], ["polar", "Polar area"], ["list", "Ranked list with bars"]] },
      topField("Repositories"),
      { ...f.rest, show: (c) => c.top && c.top !== "auto" && c.top !== "all" },
      { key: "sort", type: "select", label: "Order", options: [["value", "Largest first"], ["value-asc", "Smallest first"], ["name", "By name"], ["order", "As on the dashboard"]] },
      f.title, f.repos,
      { ...f.range, show: (c) => c.measure === "new" },
      f.look,
      { ...f.legend, label: "List of repositories", show: (c) => ARC_STYLES.includes(c.style), options: [["auto", "Below the chart"], ["right", "Beside the chart"], ["none", "Hidden"]] },
      { ...f.height, show: (c) => c.style !== "list" },
      { ...f.grid, show: (c) => ["hbar", "bar"].includes(c.style) },
      { ...f.scale, show: (c) => ["hbar", "bar"].includes(c.style) },
      { ...f.values, show: (c) => c.style !== "list" },
      colorsField("Repository colours"),
      f.card,
    ],
    autoTitle: (c) => ({ total: "Downloads per repository", new: "New downloads per repository", stars: "Stars per repository", forks: "Forks per repository" })[c.measure],
    render: renderBreakdown,
  },
  releases: {
    label: "Releases", blurb: "Downloads of each release tag",
    defaults: { size: "half", repo: null, measure: "downloads", style: "hbar", limit: 10 },
    sizes: sizes("third", "half", "two-thirds", "full"),
    fields: [
      { key: "repo", type: "repo", label: "Repository", overviewOnly: true },
      { key: "measure", type: "select", label: "Measure", options: [["downloads", "Total downloads"], ["last_7_days", "Downloads in the last 7 days"]] },
      { key: "style", type: "select", label: "Show as", options: [["hbar", "Horizontal bars"], ["bar", "Vertical bars"], ["line", "Line"], ["doughnut", "Ring (share of total)"], ["table", "Table"]] },
      { key: "limit", type: "select", label: "Releases shown", options: [[5, "Latest 5"], [10, "Latest 10"], [20, "Latest 20"], [50, "Latest 50"], [100, "Latest 100"], [0, "All"]] },
      { key: "order", type: "select", label: "Order", options: [["newest", "Newest first"], ["oldest", "Oldest first"], ["most", "Most downloaded first"]] },
      { key: "pre", type: "check", label: "Leave out pre-releases" },
      f.title,
      f.look,
      { ...f.height, show: (c) => c.style !== "table" },
      { ...f.grid, show: (c) => ["hbar", "bar", "line"].includes(c.style) },
      { ...f.scale, show: (c) => ["hbar", "bar", "line"].includes(c.style) },
      { ...f.values, show: (c) => c.style !== "table" },
      { ...colorsField("Repository colour"), show: (c) => c.style !== "table" && c.style !== "line" },
      f.card,
    ],
    autoTitle: (c, ctx) => { if (ctx.repo) return "Downloads per release"; const r = ctx.model.byId.get(Number(c.repo)); return r ? `Releases of ${r.label}` : "Releases"; },
    render: renderReleases,
  },
  table: {
    label: "Table", blurb: "Sortable list of repositories or days",
    defaults: { size: "full", table: "repos", range: "global", repos: [], limit: 30 },
    sizes: sizes("half", "two-thirds", "full"),
    fields: [
      { key: "table", type: "select", label: "Rows", options: [["repos", "One row per repository"], ["daily", "One row per day"]] },
      f.title, f.repos, f.range,
      { key: "limit", type: "select", label: "Days shown", show: (c) => c.table === "daily", options: [[7, "7"], [14, "14"], [30, "30"], [90, "90"]] },
      { key: "rows", type: "select", label: "Repositories shown", show: (c) => c.table !== "daily", options: [[0, "All"], [3, "Top 3"], [5, "Top 5"], [10, "Top 10"], [20, "Top 20"]] },
      { key: "sortBy", type: "select", label: "Sorted by", show: (c) => c.table !== "daily", options: [["total", "Downloads"], ["gained", "Downloads in the range"], ["week", "Last 7 days"], ["stars", "Stars"], ["forks", "Forks"], ["label", "Name"], ["rel", "Latest release"]] },
      { key: "cols", type: "multi", label: "Columns", show: (c) => c.table !== "daily", options: [["total", "Downloads"], ["gained", "In the range"], ["week", "Last 7 days"], ["stars", "Stars"], ["forks", "Forks"], ["rel", "Latest release"]] },
      f.look, f.card,
    ],
    autoTitle: (c) => (c.table === "daily" ? "Downloads per day" : "All repositories"),
    render: renderTable,
  },
  repohead: {
    label: "Repository header", blurb: "Name, totals and a pulse of new downloads", where: ["repo"],
    defaults: { size: "full", range: "global" },
    sizes: sizes("full"),
    fields: [f.range,
      { key: "pulse", type: "select", label: "Pulse shows", options: [["new", "New downloads"], ["cumulative", "Total downloads (running total)"]] },
      f.bucket,
      f.look,
      { key: "chart", type: "select", label: "Pulse chart", options: [["area", "Area"], ["line", "Line"], ["bar", "Bars"], ["none", "No chart"]] },
      { key: "facts", type: "check", label: "Hide the facts (stars, forks, releases…)" },
      f.compact, f.card],
    autoTitle: (c, ctx) => ctx.repo?.label || "Repository",
    render: renderRepoHead,
  },
  releasetime: {
    label: "Releases over time", blurb: "How each release tag is picked up, day by day",
    defaults: { size: "half", repo: null, measure: "new", style: "bar", bucket: "auto", range: "global" },
    sizes: sizes("half", "two-thirds", "three-quarters", "full"),
    fields: [
      { key: "repo", type: "repo", label: "Repository", overviewOnly: true },
      { key: "measure", type: "select", label: "Measure", options: [["new", "New downloads per release"], ["cumulative", "Total downloads per release (running total)"]] },
      { key: "style", type: "select", label: "Chart type", options: TIME_STYLES },
      f.bucket,
      topField("Releases"),
      { ...f.rest, show: (c) => c.top && c.top !== "auto" && c.top !== "all" },
      { key: "pre", type: "check", label: "Leave out pre-releases" },
      f.title, f.range,
      ...timeLook(() => true),
      { key: "colors", type: "select", label: "Colours", options: [["auto", "Page palette, oldest release first"], ["mono", "Shades of the accent colour"]] },
    ],
    autoTitle: (c, ctx) => { const r = ctx.repo ? null : ctx.model.byId.get(Number(c.repo)); const base = c.measure === "cumulative" ? "Downloads per release over time" : "New downloads per release"; return r ? `${base}: ${r.label}` : base; },
    render: renderReleaseTime,
  },
  files: {
    label: "Files", blurb: "Downloads per release file, and which ones are counted",
    defaults: { size: "third", repo: null, style: "table" },
    sizes: sizes("third", "half", "two-thirds", "full"),
    fields: [
      { key: "repo", type: "repo", label: "Repository", overviewOnly: true },
      { key: "style", type: "select", label: "Show as", options: [["table", "Table"], ["hbar", "Horizontal bars"], ["bar", "Vertical bars"], ["doughnut", "Ring (share of total)"], ["pie", "Pie (share of total)"]] },
      { ...topField("Files", "All"), options: [["auto", "All"], [3, "3"], [5, "5"], [10, "10"], [20, "20"]] },
      { ...f.rest, show: (c) => c.top && c.top !== "auto" },
      f.title,
      f.look,
      { ...f.height, show: (c) => c.style !== "table" },
      { ...f.grid, show: (c) => ["hbar", "bar"].includes(c.style) },
      { ...f.scale, show: (c) => ["hbar", "bar"].includes(c.style) },
      { ...f.values, show: (c) => c.style !== "table" },
      { ...colorsField("Repository colour, grey when not counted"), show: (c) => c.style !== "table" },
      f.card,
    ],
    autoTitle: (c, ctx) => { const r = ctx.repo ? null : ctx.model.byId.get(Number(c.repo)); return r ? `Files of ${r.label}` : "Downloads per file"; },
    render: renderFiles,
  },
  note: {
    label: "Text", blurb: "A short note for visitors",
    defaults: { size: "third", text: "" },
    sizes: sizes("quarter", "third", "half", "two-thirds", "full"),
    fields: [f.title, { key: "text", type: "textarea", label: "Text", hint: "Links starting with https:// become clickable" },
      f.look,
      { key: "textSize", type: "select", label: "Text size", options: [["normal", "Normal"], ["large", "Large"], ["small", "Small"]] },
      { key: "align", type: "select", label: "Alignment", options: [["left", "Left"], ["center", "Centred"]] },
      { key: "hideTitle", type: "check", label: "Hide the title" },
      f.card],
    autoTitle: () => "About",
    render: renderNote,
  },
};

/** Settings kept when the widget type is changed in the editor. */
export const SHARED_KEYS = ["id", "title", "repos", "range", "card", "height", "legend", "grid", "scale", "values", "colors", "top", "rest", "compact", "curve", "points", "avg", "total"];


export function titleOf(cfg, ctx) {
  return (cfg.title || "").trim() || TYPES[cfg.type].autoTitle(cfg, ctx) || "";
}

export function subtitleOf(cfg, ctx) {
  const t = cfg.type;
  const parts = [];
  if (["kpi", "timeline", "table", "hero", "releasetime"].includes(t) || (t === "breakdown" && cfg.measure === "new")) {
    if (!(t === "kpi" && ["total", "stars", "forks", "repos", "releases", "latest"].includes(cfg.metric))) parts.push(rangeLabel(widgetDays(cfg, ctx)));
  }
  if (!ctx.repo && cfg.repos && cfg.repos.length && t !== "releases") {
    const names = ctx.model.pick(cfg.repos).map((r) => r.label);
    parts.push(names.length <= 2 ? names.join(" and ") : `${names.length} repositories`);
  }
  const top = Number(cfg.top);
  if (cfg.rest === "hide" && top > 0 && ["timeline", "breakdown", "releasetime", "files"].includes(t) && !(t === "timeline" && cfg.split === "combined")) parts.push(`top ${top}`);
  return parts.join(", ");
}

export function defaultLayout(model) {
  const W = (type, extra = {}) => ({ id: Math.random().toString(36).slice(2, 10), type, ...TYPES[type].defaults, ...extra });
  return {
    widgets: [
      W("hero"),
      W("kpi", { metric: "new" }), W("kpi", { metric: "avg" }), W("kpi", { metric: "top", spark: false }), W("kpi", { metric: "stars" }),
      W("timeline", { measure: "cumulative", split: "repo", style: "line", range: 0 }),
      W("breakdown", { measure: "total", style: "doughnut" }),
      W("timeline", { size: "full", measure: "new", split: "repo", style: "bar", bucket: "auto" }),
      W("table", { table: "repos" }),
    ],
  };
}

export function defaultRepoLayout() {
  const W = (type, extra = {}) => ({ id: Math.random().toString(36).slice(2, 10), type, ...TYPES[type].defaults, ...extra });
  return {
    widgets: [
      W("repohead"),
      W("releases", { size: "half", style: "hbar", limit: 10 }),
      W("releasetime", { size: "half", measure: "new", style: "bar" }),
      W("timeline", { size: "two-thirds", measure: "cumulative", split: "combined", style: "area", range: 0 }),
      W("files", { size: "third" }),
      W("releases", { size: "full", style: "table", limit: 50, title: "All releases" }),
    ],
  };
}

/** Widget types and options that make sense where the layout is shown. */
export function typesFor(where) {
  return Object.entries(TYPES).filter(([, t]) => !t.where || t.where.includes(where));
}

/* ------------------------------------------------------------- render */
const CARDS = ["accent", "tint", "plain", "clear"];

/** Renders one widget into a new element. ctx: {model, globalDays, charts, mode, tools} */
export function renderWidget(cfg, ctx) {
  const type = TYPES[cfg.type];
  const slot = document.createElement("div");
  slot.dataset.id = cfg.id;
  if (!type) { slot.className = "slot w-full"; slot.textContent = "Unknown widget"; if (ctx.tools) ctx.tools(slot, cfg); return slot; }
  slot.className = `slot w-${type.sizes.length === 1 ? type.sizes[0][0] : cfg.size || type.defaults.size}`;
  if (CARDS.includes(cfg.card)) slot.classList.add(`card-${cfg.card}`);
  // Widgets draw into their own box, so ones that finish loading later never
  // wipe what is added around them (the edit toolbar).
  const content = document.createElement("div");
  content.className = "slot-content";
  slot.appendChild(content);
  try {
    type.render(content, cfg, ctx);
  } catch (e) {
    console.error(e);
    setHTML(content, markup`<div class="widget"><p class="error-text">This widget could not be drawn: ${e.message}</p></div>`);
  }
  if (ctx.tools) ctx.tools(slot, cfg);
  return slot;
}

function shell(slot, cfg, ctx, { tableToggle = false } = {}) {
  const sub = subtitleOf(cfg, ctx);
  setHTML(slot, markup`<section class="widget" aria-labelledby="t-${cfg.id}">
    <div class="widget-head ${cfg.hideTitle && !tableToggle ? "sr-only" : ""}">
      <div><h2 class="widget-title" id="t-${cfg.id}">${titleOf(cfg, ctx)}</h2>${sub ? markup`<div class="widget-sub">${sub}</div>` : ""}</div>
      <div class="widget-tools">${tableToggle ? markup`<button type="button" class="icon-btn" data-act="table" aria-pressed="false" title="Show as table" aria-label="Show as table">${icon("table")}</button>` : ""}</div>
    </div>
    <div class="widget-body"></div></section>`);
  return slot.querySelector(".widget-body");
}

/** Chart + table toggle; draw(container) draws the chart, table() returns [cols, rows]. */
function chartWithTable(slot, cfg, ctx, draw, table) {
  const body = shell(slot, cfg, ctx, { tableToggle: true });
  const btn = slot.querySelector('[data-act="table"]');
  const show = (asTable) => {
    btn.setAttribute("aria-pressed", String(asTable));
    btn.title = btn.ariaLabel = asTable ? "Show as chart" : "Show as table";
    setHTML(btn, icon(asTable ? "chart" : "table"));
    ctx.charts.filter((c) => body.contains(c.canvas)).forEach((c) => { c.destroy(); ctx.charts.splice(ctx.charts.indexOf(c), 1); });
    if (asTable) { const [cols, rows] = table(); setHTML(body, tableHTML(cols, rows)); }
    else draw(body);
  };
  btn.addEventListener("click", () => show(btn.getAttribute("aria-pressed") !== "true"));
  show(false);
}

function noData(body, text = "No data yet. Numbers appear after the first daily collection.") {
  setHTML(body, markup`<p class="empty">${text}</p>`);
}

const pad = (on, right = 48) => (on ? { layout: { padding: { top: 20, right, left: 0, bottom: 0 } } } : {});
const logValues = (vals, log) => (log ? vals.map((v) => (v > 0 ? v : null)) : vals);

/* pulse (headline and repository header) ------------------------------- */
function pulseData(cfg, model, repos, days, win) {
  const by = cfg.bucket && cfg.bucket !== "auto" ? cfg.bucket : autoBucket(days, win.dates.length);
  const cum = cfg.pulse === "cumulative";
  const series = bucket(win.dates, model.sum(repos, cum ? "cum" : "daily", win), by, cum ? "last" : "sum");
  const unit = { day: "day", week: "week", month: "month" }[by];
  return { by, cum, series, unit, word: cum ? "total downloads" : "new downloads",
    foot: cum ? `Total downloads by ${unit}` : `New downloads per ${unit}` };
}

function drawPulse(ctx, canvas, cfg, p, color) {
  const pal = palette();
  const fmtd = dateFormatter(p.by);
  const style = cfg.chart || "area";
  const isBar = style === "bar";
  chart(ctx, canvas, {
    type: isBar ? "bar" : "line",
    data: { labels: p.series.labels, datasets: [{
      label: p.word, data: p.series.values, borderColor: color, borderWidth: isBar ? 0 : 2, tension: 0.35, spanGaps: true,
      pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: bandFilled() ? pal.accent : pal.panel, pointHoverBackgroundColor: color,
      fill: style === "area" ? "origin" : false, borderRadius: isBar ? 3 : 0, maxBarThickness: 22,
      backgroundColor: isBar ? alpha(color, 0.6) : (c) => {
        const { chartArea, ctx: g } = c.chart;
        if (!chartArea) return alpha(color, 0.15);
        const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        grad.addColorStop(0, alpha(color, 0.32)); grad.addColorStop(1, alpha(color, 0.02));
        return grad;
      },
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: anim(500),
      layout: { padding: { top: 12, bottom: 0, left: 0, right: 0 } },
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltip(pal, (it) => fmtd.title(it[0].label), (c) => ` ${fmt(c.parsed.y)} ${p.word}`) },
      scales: { x: { display: false }, y: { display: false, beginAtZero: !p.cum, grace: "8%" } },
    },
  });
}

function deltaLine(days, gained, pct, lead = "") {
  const periodWord = days ? rangeLabel(days).toLowerCase() : "since tracking started";
  const prevWord = days ? `the ${days === 365 ? "12 months" : days + " days"} before` : "";
  return markup`<div class="pulse-delta">
    <span>${lead}<strong>${gained == null ? "–" : "+" + fmt(gained)}</strong> ${periodWord}</span>
    ${pct == null ? "" : markup`<span><span class="${pct >= 0 ? "delta-up" : "delta-down"}">${pct >= 0 ? "▲" : "▼"} ${fmt1(Math.abs(pct))}%</span> compared with ${prevWord}</span>`}
  </div>`;
}

/* hero ---------------------------------------------------------------- */
function renderHero(slot, cfg, ctx) {
  const { model } = ctx;
  const repos = scope(cfg, ctx);
  const days = widgetDays(cfg, ctx);
  const win = model.window(days);
  const total = repos.reduce((s, r) => s + (r.total || 0), 0);
  const gained = model.gained(repos, win.startI, win.endI);
  const prev = model.previous(win);
  const prevGained = days && model.hasPrevious(repos, prev) ? model.gained(repos, prev.startI, prev.endI) : null;
  const pct = pctChange(gained, prevGained);
  const p = pulseData(cfg, model, repos, days, win);
  const noChart = cfg.chart === "none";
  const periodWord = days ? rangeLabel(days).toLowerCase() : "since tracking started";

  setHTML(slot, markup`<section class="pulse ${noChart ? "no-chart" : ""}" aria-labelledby="t-${cfg.id}">
    <div class="pulse-figures">
      <div class="pulse-label" id="t-${cfg.id}">${titleOf(cfg, ctx)}</div>
      <div class="pulse-total">${(cfg.compact ? fmtCompact : fmt)(total)}</div>
      ${deltaLine(days, gained, pct)}
    </div>
    ${noChart ? "" : markup`<div class="pulse-chart"><canvas role="img" aria-label="${p.foot}, ${periodWord}"></canvas></div>`}
    <div class="pulse-foot"><span>${noChart ? "" : p.foot}</span>
      <span>${repos.length} ${repos.length === 1 ? "repository" : "repositories"}, updated ${timeAgo(model.lastUpdate)}</span></div>
  </section>`);
  if (noChart) return;
  if (model.empty || p.series.values.every((v) => v == null)) {
    setHTML(slot.querySelector(".pulse-chart"), markup`<p class="empty">The pulse starts after two daily collections.</p>`);
    return;
  }
  const pal = palette();
  drawPulse(ctx, slot.querySelector("canvas"), cfg, p, bandFilled() ? pal.onAccent : pal.accent);
}

/* kpi ----------------------------------------------------------------- */
function renderKpi(slot, cfg, ctx) {
  const { model } = ctx;
  const body = shell(slot, cfg, ctx);
  const repos = scope(cfg, ctx);
  const days = widgetDays(cfg, ctx);
  const win = model.window(days);
  const prev = model.previous(win);
  const pal = palette();
  const F = cfg.compact ? fmtCompact : fmt;
  let value = "–", note = "", spark = null, sparkColor = pal.accent, small = false;
  // Change per repository inside the window, so a repository added midway
  // doesn't count its whole total as growth.
  const delta = (key) => {
    let sum = null;
    for (const r of repos) {
      const s = model.series(r, key, win).filter((v) => v != null);
      if (s.length) sum = (sum || 0) + (s[s.length - 1] - s[0]);
    }
    return sum;
  };
  const vs = (now, before) => {
    const p = pctChange(now, before);
    return p == null ? "" : markup`<span class="${p >= 0 ? "delta-up" : "delta-down"}">${p >= 0 ? "▲" : "▼"} ${fmt1(Math.abs(p))}%</span> compared with the period before`;
  };
  switch (cfg.metric) {
    case "total":
      value = F(repos.reduce((s, r) => s + r.total, 0));
      note = `across ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`;
      spark = model.sum(repos, "cum", win);
      break;
    case "new": {
      const g = model.gained(repos, win.startI, win.endI);
      value = g == null ? "–" : F(g);
      const pg = days && model.hasPrevious(repos, prev) ? model.gained(repos, prev.startI, prev.endI) : null;
      note = vs(g, pg) || (g == null ? "waiting for the second collection" : "new downloads");
      spark = model.sum(repos, "daily", win);
      break;
    }
    case "avg": {
      const g = model.gained(repos, win.startI, win.endI);
      const known = model.sum(repos, "daily", win).filter((v) => v != null).length;
      value = g == null || !known ? "–" : fmt1(g / known);
      const pg = days && model.hasPrevious(repos, prev) ? model.gained(repos, prev.startI, prev.endI) : null;
      note = vs(g, pg) || `over ${known} ${known === 1 ? "day" : "days"} with data`;
      spark = model.sum(repos, "daily", win);
      break;
    }
    case "stars": case "forks": {
      const key = cfg.metric;
      value = F(repos.reduce((s, r) => s + (r[key] || 0), 0));
      const d = delta(key);
      note = d == null ? "" : `${d >= 0 ? "+" : ""}${fmt(d)} ${rangeLabel(days).toLowerCase()}`;
      spark = model.sum(repos, key, win);
      break;
    }
    case "top": {
      let best = null, bestG = -1;
      for (const r of repos) { const g = model.gained([r], win.startI, win.endI) ?? -1; if (g > bestG) { best = r; bestG = g; } }
      if (best && bestG >= 0) {
        value = ctx.links ? markup`<a href="${repoHref(ctx, best)}" class="kpi-link">${best.label}</a>` : best.label; small = true;
        note = `+${F(bestG)} downloads, ${F(best.total)} in total`;
        sparkColor = colorsFor(repos, pal).get(best.id);
        spark = model.series(best, "daily", win);
      }
      break;
    }
    case "repos":
      value = fmt(repos.length);
      note = `${fmt(repos.filter((r) => r.total > 0).length)} with downloads`;
      break;
    case "releases":
      value = fmt(repos.reduce((s, r) => s + (r.releases || 0), 0));
      note = ctx.repo ? (ctx.repo.latest_release ? `newest: ${ctx.repo.latest_release.tag}` : "") : `across ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`;
      break;
    case "latest": {
      const rel = (ctx.pageData?.releases || []).find((r) => !r.prerelease) || ctx.pageData?.releases?.[0];
      if (rel) {
        value = F(rel.downloads);
        note = `${rel.tag}${rel.published_at ? ", published " + timeAgo(rel.published_at) : ""}${rel.last_7_days != null ? `, +${fmt(rel.last_7_days)} in the last 7 days` : ""}`;
      } else note = ctx.repo ? "No releases yet" : "Only shown on repository pages";
      break;
    }
  }
  setHTML(body, markup`<div class="${cfg.align === "center" ? "kpi-center" : ""}"><div class="kpi-value num ${small ? "small" : ""}">${value}</div>
    <div class="kpi-note">${note}</div>
    ${cfg.spark && spark && spark.some((v) => v != null) ? markup`<div class="kpi-spark"><canvas aria-hidden="true"></canvas></div>` : ""}</div>`);
  const canvas = body.querySelector("canvas");
  if (canvas) {
    const bars = cfg.sparkType === "bar";
    chart(ctx, canvas, {
      type: bars ? "bar" : "line",
      data: { labels: win.dates, datasets: [{ data: spark, borderColor: sparkColor, borderWidth: bars ? 0 : 2, pointRadius: 0, tension: 0.3, fill: "origin",
        backgroundColor: alpha(sparkColor, bars ? 0.55 : 0.1), borderRadius: bars ? 2 : 0, spanGaps: true }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, beginAtZero: bars || !["total", "stars", "forks"].includes(cfg.metric) } } },
    });
  }
}

/* timeline ------------------------------------------------------------ */
function renderTimeline(slot, cfg, ctx) {
  const { model } = ctx;
  const pal = palette();
  const repos = scope(cfg, ctx);
  const days = widgetDays(cfg, ctx);
  const win = model.window(days);
  const key = cfg.measure === "new" ? "daily" : cfg.measure === "stars" ? "stars" : "cum";
  const how = key === "daily" ? "sum" : "last";
  const by = cfg.bucket && cfg.bucket !== "auto" ? cfg.bucket : autoBucket(days, win.dates.length);
  const colors = colorsFor(repos, pal);
  let series = [];
  if (cfg.split === "combined" || repos.length < 2) {
    const b = bucket(win.dates, model.sum(repos, key, win), by, how);
    series = [{ label: repos.length === 1 ? repos[0].label : "All repositories", color: repos.length === 1 ? colors.get(repos[0].id) : pal.accent, labels: b.labels, values: b.values, repo: repos.length === 1 ? repos[0] : null }];
  } else {
    const score = (r) => (key === "daily" ? model.gained([r], win.startI, win.endI) || 0 : key === "stars" ? r.stars || 0 : r.total);
    const { shown, rest } = foldItems(repos, score, cfg);
    series = shown.map((r) => { const b = bucket(win.dates, model.series(r, key, win), by, how); return { label: r.label, color: colors.get(r.id), labels: b.labels, values: b.values, repo: r }; });
    if (rest.length) { const b = bucket(win.dates, model.sum(rest, key, win), by, how); series.push({ label: `Other (${rest.length})`, color: pal.other, labels: b.labels, values: b.values, other: true }); }
    applyColors(cfg, series, pal);
  }
  const unitWord = cfg.measure === "new" ? "new downloads" : cfg.measure === "stars" ? "stars" : "downloads";
  seriesChart(slot, cfg, ctx, series, by, unitWord, model.empty ? null : undefined);
}

/** Line/area/bar chart of several date series, with legend and table view. */
function seriesChart(slot, cfg, ctx, series, by, unitWord, emptyText) {
  const pal = palette();
  const fmtd = dateFormatter(by);
  const labels = series[0]?.labels || [];
  const style = TIME_STYLES.some(([k]) => k === cfg.style) ? cfg.style : "line";
  const isBar = style.startsWith("bar");
  const share = style === "share" || style === "bar-share";
  const multi = series.length > 1;
  const stacked = multi && ["area", "share", "bar", "bar-share"].includes(style);
  const filled = ["area", "share", "area-overlap"].includes(style);
  const log = cfg.scale === "log" && !share && !stacked;
  const plotted = series.map((s) => rolling(s.values, Number(cfg.avg) || 0));
  const totals = labels.map((_, i) => plotted.reduce((a, v) => (v[i] == null ? a : (a || 0) + v[i]), null));
  const data = plotted.map((vals) => vals.map((v, i) => {
    if (share) return totals[i] ? ((v || 0) / totals[i]) * 100 : null;
    if (stacked) return v ?? 0;
    if (log) return v > 0 ? v : null;
    return v;
  }));
  const withTotal = cfg.total && multi && !share;
  const curve = { tension: cfg.curve === "straight" || cfg.curve === "step" ? 0 : 0.25, stepped: cfg.curve === "step" ? "middle" : false };
  chartWithTable(slot, cfg, ctx, (body) => {
    if (emptyText === null || !labels.length || series.every((x) => x.values.every((v) => v == null))) return noData(body, emptyText || undefined);
    setHTML(body, chartFrame(cfg, ctx, series, { label: titleOf(cfg, ctx) }));
    const datasets = series.map((s, i) => ({
      label: s.label, data: data[i], borderColor: isBar ? pal.panel : s.color,
      backgroundColor: isBar ? s.color : filled ? alpha(s.color, stacked ? 0.55 : 0.18) : s.color,
      borderWidth: isBar ? (stacked && i > 0 ? { top: 0, bottom: 2, left: 0, right: 0 } : 0) : 2,
      borderRadius: isBar ? (stacked ? (i === series.length - 1 ? { topLeft: 4, topRight: 4 } : 0) : 4) : 0,
      borderSkipped: isBar ? false : undefined,
      maxBarThickness: 36, pointRadius: cfg.points ? 2.5 : 0, pointBackgroundColor: s.color, pointBorderWidth: 0,
      pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: pal.panel, pointHoverBackgroundColor: s.color,
      ...curve, spanGaps: true,
      fill: filled ? (stacked ? (i === 0 ? "origin" : "-1") : "origin") : false,
      stack: stacked ? "s" : `s${i}`,
    }));
    if (withTotal) datasets.push({ type: "line", label: "Total", data: logValues(totals, log), borderColor: pal.ink, backgroundColor: pal.ink,
      borderWidth: 2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4, ...curve, fill: false, stack: "total", order: -1, spanGaps: true });
    chart(ctx, body.querySelector("canvas"), {
      type: isBar ? "bar" : "line",
      data: { labels, datasets },
      plugins: [valueLabels(cfg.values, pal, share ? (v) => `${fmt1(v)}%` : fmtCompact)],
      options: {
        responsive: true, maintainAspectRatio: false, animation: anim(400), ...pad(cfg.values, isBar ? 8 : 48),
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: {
          ...tooltip(pal),
          itemSort: (a, b) => (b.parsed.y || 0) - (a.parsed.y || 0),
          callbacks: { ...tooltip(pal).callbacks, title: (it) => fmtd.title(it[0].label),
            label: (c) => (share ? ` ${c.dataset.label}: ${fmt1(c.parsed.y)}% (${fmt(plotted[c.datasetIndex][c.dataIndex])})` : ` ${c.dataset.label}: ${fmt(c.parsed.y)}`),
            footer: (items) => (items.length > 1 && (stacked || share) && !withTotal ? `Total: ${fmt(totals[items[0].dataIndex])} ${unitWord}` : "") } } },
        scales: axisOptions(pal, { stacked, grid: cfg.grid, log, percent: share, xTick: function (v) { return fmtd.tick(this.getLabelForValue(v)); } }),
      },
    });
  }, () => [[by === "week" ? "Week of" : by === "month" ? "Month" : "Day", ...series.map((s) => s.label)],
    labels.map((d, i) => [by === "month" ? fmtd.title(d) : fmtDay(d, { day: "numeric", month: "short", year: "numeric" }), ...series.map((s) => s.values[i])]).reverse()]);
}

/* bars and slices, shared by the per-repository, release and file widgets */
/** items: [{label, value, color, repo?}]; draws them as cfg.style says. */
function drawItems(body, cfg, ctx, items, { unit, total, label, legendItems, barSize = 38, links = true, tooltipTitle }) {
  const pal = palette();
  const style = cfg.style;
  const linkFor = (it) => (links && ctx.links && it.repo ? markup`<a href="${repoHref(ctx, it.repo)}">${it.label}</a>` : it.label);
  const pctOf = (v) => (total ? fmt1((v / total) * 100) + "%" : "–");
  const click = links ? clickThrough(ctx, items.map((x) => x.repo)) : {};
  if (style === "list") {
    const max = Math.max(1, ...items.map((x) => x.value));
    setHTML(body, markup`<ol class="rank-list">${items.map((it, i) => markup`<li>
      <span class="rank-name"><span class="rank-n">${it.other ? "" : i + 1}</span><i style="background:${it.color}"></i><span class="rank-label">${linkFor(it)}</span></span>
      <span class="num">${fmt(it.value)} <span class="muted">${pctOf(it.value)}</span></span>
      <span class="rank-bar" aria-hidden="true"><i style="width:${Math.max(0.5, (it.value / max) * 100)}%;background:${it.color}"></i></span></li>`)}</ol>`);
    return;
  }
  if (ARC_STYLES.includes(style)) {
    const pos = cfg.legend === "right" || cfg.legend === "none" ? cfg.legend : "bottom";
    const h = HEIGHTS[cfg.height];
    setHTML(body, markup`<div class="chart-wrap arc legend-${pos}"><div class="chart-box round" style="${h ? `height:${h}px` : ""}"><canvas role="img" aria-label="${label}"></canvas>
      ${style === "doughnut" ? markup`<div class="ring-centre"><div><div class="kpi-value num">${fmtCompact(total)}</div><div class="muted">${unit}</div></div></div>` : ""}</div>
      ${pos === "none" ? "" : markup`<div class="legend legend-list">${items.map((it) => markup`<span>
        <span class="legend-name"><i style="background:${it.color}"></i><span>${linkFor(it)}</span></span>
        <span class="num">${fmt(it.value)} <span class="muted">${pctOf(it.value)}</span></span></span>`)}</div>`}</div>`);
    const polar = style === "polar";
    chart(ctx, body.querySelector("canvas"), {
      type: polar ? "polarArea" : style,
      data: { labels: items.map((x) => x.label), datasets: [{ data: items.map((x) => x.value), backgroundColor: items.map((x) => (polar ? alpha(x.color, 0.8) : x.color)), borderColor: pal.panel, borderWidth: 2, hoverOffset: 4, borderRadius: style === "doughnut" ? 3 : 0 }] },
      plugins: [valueLabels(cfg.values, pal)],
      options: { responsive: true, maintainAspectRatio: false, cutout: style === "doughnut" ? "68%" : 0, animation: anim(450), ...click,
        scales: polar ? { r: { grid: { color: pal.grid }, angleLines: { color: pal.grid }, ticks: { display: false } } } : {},
        plugins: { legend: { display: false }, tooltip: tooltip(pal, tooltipTitle || ((it) => it[0].label), (c) => ` ${fmt(polar ? c.parsed.r : c.parsed)} ${unit} (${pctOf(polar ? c.parsed.r : c.parsed)})`) } },
    });
    return;
  }
  if (style === "line") {
    const log = cfg.scale === "log";
    const color = items[0]?.color || pal.accent;
    setHTML(body, chartFrame(cfg, ctx, [], { label }));
    chart(ctx, body.querySelector("canvas"), {
      type: "line",
      data: { labels: items.map((x) => x.label), datasets: [{ label: unit, data: logValues(items.map((x) => x.value), log), borderColor: color, borderWidth: 2,
        backgroundColor: alpha(color, 0.14), fill: "origin", tension: 0.25, pointRadius: 3, pointBackgroundColor: color, pointHoverRadius: 5, spanGaps: true }] },
      plugins: [valueLabels(cfg.values, pal)],
      options: { responsive: true, maintainAspectRatio: false, animation: anim(400), ...pad(cfg.values),
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: tooltip(pal, tooltipTitle || ((it) => it[0].label), (c) => ` ${fmt(c.parsed.y)} ${unit}`) },
        scales: axisOptions(pal, { grid: cfg.grid, log }) },
    });
    return;
  }
  const horizontal = style !== "bar";
  const log = cfg.scale === "log";
  const height = horizontal ? Math.max(160, items.length * barSize + 40) : 280;
  setHTML(body, chartFrame(cfg, ctx, legendItems || [], { height, label }));
  chart(ctx, body.querySelector("canvas"), {
    type: "bar",
    data: { labels: items.map((x) => x.label), datasets: [{ label: unit, data: logValues(items.map((x) => x.value), log), backgroundColor: items.map((x) => x.color), borderRadius: 4, borderSkipped: "start", maxBarThickness: horizontal ? 24 : 48 }] },
    plugins: [valueLabels(cfg.values, pal)],
    options: { indexAxis: horizontal ? "y" : "x", responsive: true, maintainAspectRatio: false, animation: anim(400), ...pad(cfg.values, horizontal ? 56 : 8),
      interaction: { mode: "nearest", intersect: false, axis: horizontal ? "y" : "x" }, ...click,
      plugins: { legend: { display: false }, tooltip: tooltip(pal, tooltipTitle || ((it) => it[0].label), (c) => ` ${fmt(horizontal ? c.parsed.x : c.parsed.y)} ${unit}`) },
      scales: axisOptions(pal, { horizontal, grid: cfg.grid, log }) },
  });
}

/* breakdown ----------------------------------------------------------- */
const SORTS = {
  value: (a, b) => b.value - a.value, "value-asc": (a, b) => a.value - b.value,
  name: (a, b) => a.label.localeCompare(b.label), order: (a, b) => a.pos - b.pos,
};

function renderBreakdown(slot, cfg, ctx) {
  const { model } = ctx;
  const pal = palette();
  const repos = scope(cfg, ctx);
  const days = widgetDays(cfg, ctx);
  const win = model.window(days);
  const val = (r) => cfg.measure === "new" ? model.gained([r], win.startI, win.endI) || 0 : cfg.measure === "stars" ? r.stars : cfg.measure === "forks" ? r.forks : r.total;
  const colors = colorsFor(repos, pal);
  const all = repos.map((r, i) => ({ label: r.label, value: val(r) || 0, color: colors.get(r.id), repo: r, pos: i }));
  const { shown, rest } = foldItems(all, (x) => x.value, cfg);
  const items = shown.slice().sort(SORTS[cfg.sort] || SORTS.value);
  if (rest.length) items.push({ label: `Other (${rest.length})`, value: rest.reduce((s, x) => s + x.value, 0), color: pal.other, other: true });
  applyColors(cfg, items, pal);
  const total = items.reduce((s, x) => s + x.value, 0);
  const unit = { total: "downloads", new: "new downloads", stars: "stars", forks: "forks" }[cfg.measure] || "downloads";
  const label = titleOf(cfg, ctx);
  const draw = (body) => {
    if (!repos.length || total === 0) return noData(body, repos.length ? `No ${unit} yet.` : "No repositories yet.");
    drawItems(body, cfg, ctx, items, { unit, total, label });
  };
  const table = () => [["Repository", unit[0].toUpperCase() + unit.slice(1), "Share"], items.map((x) => [ctx.links && x.repo ? markup`<a href="${repoHref(ctx, x.repo)}">${x.label}</a>` : x.label, x.value, total ? fmt1((x.value / total) * 100) + "%" : "–"])];
  if (cfg.style === "list") draw(shell(slot, cfg, ctx));
  else chartWithTable(slot, cfg, ctx, draw, table);
}

/* releases ------------------------------------------------------------ */
function loadReleases(ctx, repoId) {
  return loadPage(ctx, repoId).then((d) => d.releases);
}

function renderReleases(slot, cfg, ctx) {
  const repo = targetRepo(cfg, ctx);
  const pal = palette();
  if (!repo) { noData(shell(slot, cfg, ctx), "Choose a repository in this widget's settings."); return; }
  const color = colorsFor([repo], pal).get(repo.id);
  const unit = cfg.measure === "last_7_days" ? "downloads in the last 7 days" : "downloads";
  const asTable = cfg.style === "table";
  const value = (r) => (cfg.measure === "last_7_days" ? r.last_7_days ?? 0 : r.downloads);
  let rows = [];
  const tableCols = ["Release", "Published", "Downloads", "Last 7 days"];
  const tableRows = () => rows.map((r) => [markup`<a href="${r.url || repo.url + "/releases"}" target="_blank" rel="noopener">${r.tag}</a>${r.name && r.name !== r.tag ? markup` <span class="muted">${r.name}</span>` : ""}${r.prerelease ? markup` <span class="tag">pre-release</span>` : ""}`,
    r.published_at ? new Date(r.published_at).toLocaleDateString() : "–", r.downloads, r.last_7_days]);
  const draw = (body) => {
    setHTML(body, markup`<p class="empty"><span class="spinner"></span></p>`);
    loadReleases(ctx, repo.id).then((list) => {
      rows = list.filter((r) => !(cfg.pre && r.prerelease));
      if (cfg.order === "most") rows = rows.slice().sort((a, b) => value(b) - value(a));
      const limit = cfg.limit == null ? 10 : Number(cfg.limit);
      if (limit > 0) rows = rows.slice(0, limit);
      if (cfg.order === "oldest") rows = rows.slice().reverse();
      if (!rows.length) return noData(body, "This repository has no releases yet.");
      if (asTable) { setHTML(body, tableHTML(tableCols, tableRows())); return; }
      const items = rows.map((r) => ({ label: r.tag, value: value(r), color }));
      // a ring in one colour says nothing, so it uses the palette unless shades are asked for
      applyColors(cfg.style === "doughnut" && cfg.colors !== "mono" ? { colors: "palette" } : cfg, items, pal);
      drawItems(body, cfg, ctx, items, { unit, total: items.reduce((s, x) => s + x.value, 0), label: titleOf(cfg, ctx), barSize: 32, links: false,
        tooltipTitle: (it) => { const r = rows[it[0].dataIndex]; return r.name && r.name !== r.tag ? `${r.tag}, ${r.name}` : r.tag; } });
    }).catch((e) => noData(body, e.message));
  };
  if (asTable) draw(shell(slot, cfg, ctx));
  else chartWithTable(slot, cfg, ctx, draw, () => [tableCols, tableRows()]);
}

/* table --------------------------------------------------------------- */
function renderTable(slot, cfg, ctx) {
  const { model } = ctx;
  const body = shell(slot, cfg, ctx);
  const pal = palette();
  const repos = scope(cfg, ctx);
  const days = widgetDays(cfg, ctx);
  const win = model.window(days);
  if (cfg.table === "daily") {
    const limit = Number(cfg.limit) || 30;
    const sum = model.sum(repos, "daily", win), cum = model.sum(repos, "cum", win);
    const rows = win.dates.map((d, i) => [fmtDay(d, { weekday: "short", day: "numeric", month: "short", year: "numeric" }), sum[i], cum[i]]).reverse().slice(0, limit);
    if (model.empty) return noData(body);
    setHTML(body, tableHTML(["Day", "New downloads", "Total downloads"], rows));
    return;
  }
  if (!repos.length) return noData(body, "No repositories yet.");
  const colors = colorsFor(repos, pal);
  const w7 = model.window(7);
  const data = repos.map((r) => ({
    r, total: r.total, gained: model.gained([r], win.startI, win.endI), week: model.gained([r], w7.startI, w7.endI),
    stars: r.stars, forks: r.forks, rel: r.latest_release,
  }));
  const visible = Array.isArray(cfg.cols) ? cfg.cols : null;
  const cols = [
    ["label", "Repository"], ["total", "Downloads"], ["gained", rangeLabel(days)], ["week", "Last 7 days"],
    ["stars", "Stars"], ["forks", "Forks"], ["rel", "Latest release"],
  ].filter(([k]) => k === "label" || !visible || visible.includes(k));
  const plus = (v) => (v == null ? "–" : "+" + fmt(v));
  const cell = {
    label: (x) => markup`<td><div class="repo-cell"><span class="dot" style="background:${colors.get(x.r.id)}"></span><div><a href="${ctx.links ? repoHref(ctx, x.r) : x.r.url}" ${ctx.links ? "" : raw('target="_blank" rel="noopener"')}>${x.r.label}</a><small>${x.r.full_name} <a class="ext" href="${x.r.url}" target="_blank" rel="noopener" aria-label="${x.r.full_name} on GitHub" title="Open on GitHub">${icon("external")}</a></small></div></div></td>`,
    total: (x) => markup`<td class="r">${fmt(x.total)}</td>`,
    gained: (x) => markup`<td class="r">${plus(x.gained)}</td>`,
    week: (x) => markup`<td class="r">${plus(x.week)}</td>`,
    stars: (x) => markup`<td class="r">${fmt(x.stars)}</td>`,
    forks: (x) => markup`<td class="r">${fmt(x.forks)}</td>`,
    rel: (x) => markup`<td>${x.rel ? markup`<a href="${x.rel.html_url || x.r.url + "/releases"}" target="_blank" rel="noopener">${x.rel.tag}</a> <span class="muted">${x.rel.published_at ? timeAgo(x.rel.published_at) : ""}</span>` : markup`<span class="muted">none</span>`}</td>`,
  };
  let sortKey = cell[cfg.sortBy] ? cfg.sortBy : "total", dir = sortKey === "label" ? 1 : -1;
  const limit = Number(cfg.rows) || 0;
  const draw = () => {
    let sorted = data.slice().sort((a, b) => {
      const va = sortKey === "label" ? a.r.label.toLowerCase() : sortKey === "rel" ? a.rel?.published_at || "" : a[sortKey] ?? -1;
      const vb = sortKey === "label" ? b.r.label.toLowerCase() : sortKey === "rel" ? b.rel?.published_at || "" : b[sortKey] ?? -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    if (limit) sorted = sorted.slice(0, limit);
    setHTML(body, markup`<div class="table-wrap"><table class="data"><thead><tr>${cols.map(([k, label], i) => markup`<th scope="col" class="${i && k !== "rel" ? "r" : ""}" aria-sort="${sortKey === k ? (dir < 0 ? "descending" : "ascending") : "none"}"><button type="button" class="sort" data-k="${k}">${label}${sortKey === k ? (dir < 0 ? " ↓" : " ↑") : ""}</button></th>`)}</tr></thead>
      <tbody>${sorted.map((x) => markup`<tr>${cols.map(([k]) => cell[k](x))}</tr>`)}</tbody></table></div>`);
    body.querySelectorAll("button.sort").forEach((b) => b.addEventListener("click", () => {
      if (sortKey === b.dataset.k) dir = -dir; else { sortKey = b.dataset.k; dir = b.dataset.k === "label" ? 1 : -1; }
      draw();
      body.querySelector(`button.sort[data-k="${sortKey}"]`).focus();
    }));
  };
  draw();
}

/* note ---------------------------------------------------------------- */
const NOTE_CLASSES = { large: " note-large", small: " note-small" };
function renderNote(slot, cfg, ctx) {
  const body = shell(slot, cfg, ctx);
  // only fixed class names from NOTE_CLASSES, never the stored value itself
  const cls = "note-text" + (NOTE_CLASSES[cfg.textSize] || "") + (cfg.align === "center" ? " center" : "");
  // nosemgrep: javascript.lang.security.html-in-template-string -- u is part of the esc()-escaped text and cannot contain " or <
  const text = esc(cfg.text || "").replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  // nosemgrep: javascript.lang.security.html-in-template-string -- text is esc()-escaped; links are https URLs without quotes or <; cls is built from fixed strings
  setHTML(body, text ? raw(`<div class="${cls}">${text}</div>`) : markup`<p class="empty">Write something in this widget's settings.</p>`);
}

/* repository header ------------------------------------------------------ */
function renderRepoHead(slot, cfg, ctx) {
  const { model } = ctx;
  const repo = ctx.repo;
  if (!repo) { noData(shell(slot, cfg, ctx), "Shown on repository pages."); return; }
  const pal = palette();
  const color = colorsFor([repo], pal).get(repo.id);
  const days = widgetDays(cfg, ctx);
  const win = model.window(days);
  const gained = model.gained([repo], win.startI, win.endI);
  const prev = model.previous(win);
  const prevGained = days && model.hasPrevious([repo], prev) ? model.gained([repo], prev.startI, prev.endI) : null;
  const pct = pctChange(gained, prevGained);
  const p = pulseData(cfg, model, [repo], days, win);
  const noChart = cfg.chart === "none";
  const periodWord = days ? rangeLabel(days).toLowerCase() : "since tracking started";
  const rel = repo.latest_release;
  setHTML(slot, markup`<section class="pulse repo-head ${noChart ? "no-chart" : ""}" aria-labelledby="t-${cfg.id}">
    <div class="pulse-figures">
      <div class="repo-name"><span class="dot" style="background:${color}" aria-hidden="true"></span><h1 id="t-${cfg.id}">${repo.label}</h1></div>
      <div class="repo-sub"><a href="${repo.url}" target="_blank" rel="noopener">${repo.full_name} ${icon("external")}</a>${repo.hidden ? markup` <span class="tag">hidden from visitors</span>` : ""}</div>
      ${repo.description ? markup`<p class="repo-desc">${repo.description}</p>` : ""}
      <div class="pulse-total">${(cfg.compact ? fmtCompact : fmt)(repo.total)}</div>
      ${deltaLine(days, gained, pct, "downloads, ")}
      ${cfg.facts ? "" : markup`<dl class="repo-facts">
        <div><dt>Stars</dt><dd>${fmt(repo.stars)}</dd></div>
        <div><dt>Forks</dt><dd>${fmt(repo.forks)}</dd></div>
        <div><dt>Releases</dt><dd>${fmt(repo.releases)}</dd></div>
        <div><dt>Newest</dt><dd>${rel ? markup`<a href="${rel.html_url || repo.url + "/releases"}" target="_blank" rel="noopener">${rel.tag}</a>` : "none"}</dd></div>
        <div><dt>Tracked since</dt><dd>${repo.trackedSince ? fmtDay(repo.trackedSince, { day: "numeric", month: "short", year: "numeric" }) : "not yet"}</dd></div>
      </dl>`}
    </div>
    ${noChart ? "" : markup`<div class="pulse-chart"><canvas role="img" aria-label="${p.foot} of ${repo.label}, ${periodWord}"></canvas></div>`}
    <div class="pulse-foot"><span>${noChart ? "" : p.foot}</span><span>Updated ${timeAgo(repo.last_collected)}</span></div>
  </section>`);
  if (noChart) return;
  if (p.series.values.every((v) => v == null)) {
    setHTML(slot.querySelector(".pulse-chart"), markup`<p class="empty">The pulse starts after two daily collections.</p>`);
    return;
  }
  drawPulse(ctx, slot.querySelector("canvas"), cfg, p, bandFilled() ? pal.onAccent : color);
}

/* releases over time ----------------------------------------------------- */
function loading(slot, cfg, ctx) {
  setHTML(shell(slot, cfg, ctx), markup`<p class="empty"><span class="spinner"></span></p>`);
}

function renderReleaseTime(slot, cfg, ctx) {
  const { model } = ctx;
  const repo = targetRepo(cfg, ctx);
  if (!repo) { noData(shell(slot, cfg, ctx), "Choose a repository in this widget's settings."); return; }
  loading(slot, cfg, ctx);
  loadPage(ctx, repo.id).then((d) => {
    if (!slot.isConnected) return;
    const pal = palette();
    const days = widgetDays(cfg, ctx);
    const win = model.window(days);
    const key = cfg.measure === "cumulative" ? "cum" : "daily";
    const how = key === "daily" ? "sum" : "last";
    const by = cfg.bucket && cfg.bucket !== "auto" ? cfg.bucket : autoBucket(days, win.dates.length);
    const published = new Map((d.releases || []).map((r) => [r.tag, r.published_at || ""]));
    const pre = new Set((d.releases || []).filter((r) => r.prerelease).map((r) => r.tag));
    const hist = d.release_history || {};
    // oldest release first: each tag keeps its colour as new releases arrive
    const tags = Object.keys(hist).sort((a, b) => (published.get(a) || hist[a][0][0]).localeCompare(published.get(b) || hist[b][0][0]));
    const rows = tags.map((tag, i) => {
      const sr = model.releaseSeries(repo, hist[tag]);
      const vals = sr[key].slice(win.startI, win.endI + 1);
      const score = key === "daily" ? vals.reduce((a, v) => a + (v || 0), 0) : vals.filter((v) => v != null).pop() || 0;
      return { tag, color: pal.series[i % 8], vals, score };
    }).filter((x) => !(cfg.pre && pre.has(x.tag)) && x.vals.some((v) => v != null && (key === "cum" || v > 0)));
    const { shown, rest } = foldItems(rows, (x) => x.score, cfg);
    const keep = new Set(shown.map((x) => x.tag));
    const series = rows.filter((x) => keep.has(x.tag)).map((x) => { const b = bucket(win.dates, x.vals, by, how); return { label: x.tag, color: x.color, labels: b.labels, values: b.values }; });
    if (rest.length) {
      const sum = win.dates.map((_, i) => rest.reduce((a, x) => (x.vals[i] == null ? a : (a || 0) + x.vals[i]), null));
      const b = bucket(win.dates, sum, by, how);
      series.push({ label: `Other releases (${rest.length})`, color: pal.other, labels: b.labels, values: b.values, other: true });
    }
    if (cfg.colors === "mono") applyColors(cfg, series, pal);
    if (!series.length) { noData(shell(slot, cfg, ctx), key === "daily" ? "No new downloads in this period." : "No release downloads yet."); return; }
    seriesChart(slot, cfg, ctx, series, by, key === "daily" ? "new downloads" : "downloads");
  }).catch((e) => noData(shell(slot, cfg, ctx), e.message));
}

/* files ------------------------------------------------------------------ */
function renderFiles(slot, cfg, ctx) {
  const repo = targetRepo(cfg, ctx);
  if (!repo) { noData(shell(slot, cfg, ctx), "Choose a repository in this widget's settings."); return; }
  loading(slot, cfg, ctx);
  loadPage(ctx, repo.id).then((d) => {
    if (!slot.isConnected) return;
    const pal = palette();
    const color = colorsFor([repo], pal).get(repo.id);
    const files = new Map();
    for (const rel of d.releases || []) for (const a of rel.assets) {
      const f0 = files.get(a.name) || { name: a.name, downloads: 0, releases: 0, counted: a.counted };
      f0.downloads += a.downloads; f0.releases += 1;
      files.set(a.name, f0);
    }
    const list = [...files.values()].sort((a, b) => b.downloads - a.downloads);
    const asTable = !["hbar", "bar", "doughnut", "pie"].includes(cfg.style);
    const body = shell(slot, cfg, ctx);
    if (!list.length) { noData(body, "No release files yet."); return; }
    const allCounted = list.every((x) => x.counted);
    const footnote = markup`<p class="muted footnote">${allCounted ? "Every file counts towards the download totals." : "Only counted files add to the download totals. Change this under Admin, Repositories, Edit."}</p>`;
    if (asTable) {
      setHTML(body, markup`${tableHTML(["File", "Downloads", "Releases", "Counted"], list.map((x) => [x.name, x.downloads, x.releases, x.counted ? "yes" : markup`<span class="muted">no</span>`]))}${footnote}`);
      return;
    }
    const all = list.map((x) => ({ label: x.name, value: x.downloads, counted: x.counted, color: x.counted ? color : pal.other }));
    const { shown, rest } = foldItems(all, (x) => x.value, cfg, Infinity);
    const items = shown.slice();
    if (rest.length) items.push({ label: `Other files (${rest.length})`, value: rest.reduce((s, x) => s + x.value, 0), color: pal.other, other: true, counted: true });
    if (cfg.colors === "palette" || cfg.colors === "mono") applyColors(cfg, items, pal);
    else if (ARC_STYLES.includes(cfg.style)) applyColors({ colors: "palette" }, items, pal);
    const chartBox = document.createElement("div");
    setHTML(body, markup`<div class="files-chart"></div>${footnote}`);
    body.querySelector(".files-chart").replaceWith(chartBox);
    const legend = !allCounted && (!cfg.colors || cfg.colors === "auto") && !ARC_STYLES.includes(cfg.style) ? [{ label: "Counted", color }, { label: "Not counted", color: pal.other }] : [];
    drawItems(chartBox, cfg, ctx, items, { unit: "downloads", total: items.reduce((s, x) => s + x.value, 0), label: titleOf(cfg, ctx), barSize: 34, links: false, legendItems: legend });
  }).catch((e) => noData(shell(slot, cfg, ctx), e.message));
}
