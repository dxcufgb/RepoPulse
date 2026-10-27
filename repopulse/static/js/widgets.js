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
    font: cssVar("--font-ui"),
  };
}
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

/** More than 8 series: keep the 7 largest, fold the rest into "Other". */
function fold(repos, score) {
  if (repos.length <= 8) return { shown: repos, rest: [] };
  const sorted = repos.slice().sort((a, b) => score(b) - score(a));
  return { shown: sorted.slice(0, 7), rest: sorted.slice(7) };
}

function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
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

function axisOptions(pal, { stacked = false, horizontal = false, xTick } = {}) {
  const valueAxis = {
    beginAtZero: true, stacked, grid: { color: pal.grid, drawTicks: false }, border: { display: false },
    ticks: { color: pal.muted, padding: 8, maxTicksLimit: 6, callback: (v) => fmtCompact(v), font: { family: pal.font, size: 12 } },
  };
  const catTicks = { color: pal.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 14, font: { family: pal.font, size: 12 } };
  if (xTick && !horizontal) catTicks.callback = xTick;
  const catAxis = { stacked, grid: { display: false }, border: { color: pal.line }, ticks: catTicks };
  if (horizontal) {
    catAxis.ticks = { ...catTicks, color: pal.ink2, autoSkip: false,
      callback: function (v) { const l = String(this.getLabelForValue(v)); return l.length > 26 ? l.slice(0, 25) + "…" : l; } };
    return { x: valueAxis, y: catAxis };
  }
  return { x: catAxis, y: valueAxis };
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

const f = {
  title: { key: "title", type: "text", label: "Title", hint: "Leave empty for an automatic title" },
  repos: { key: "repos", type: "repos", label: "Repositories", hint: "None selected means all repositories", overviewOnly: true },
  range: { key: "range", type: "select", label: "Time range", options: RANGE_OPTIONS },
};

/* --------------------------------------------------------------- types */
export const TYPES = {
  hero: {
    label: "Headline", blurb: "Big total with a pulse of new downloads",
    defaults: { size: "full", range: "global", repos: [] },
    sizes: sizes("full"),
    fields: [f.title, f.repos, f.range],
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
      { key: "spark", type: "check", label: "Show a small trend line" },
    ],
    autoTitle: (c) => ({ total: "Total downloads", new: "New downloads", avg: "Downloads per day", stars: "Stars",
      forks: "Forks", top: "Most downloaded", repos: "Repositories", releases: "Releases", latest: "Newest release" })[c.metric] || "Number",
    render: renderKpi,
  },
  timeline: {
    label: "Over time", blurb: "Line, area or bar chart by day, week or month",
    defaults: { size: "two-thirds", measure: "cumulative", split: "repo", style: "line", bucket: "auto", range: "global", repos: [] },
    sizes: sizes("half", "two-thirds", "three-quarters", "full"),
    fields: [
      { key: "measure", type: "select", label: "Measure", options: [["cumulative", "Total downloads (running total)"], ["new", "New downloads"], ["stars", "Stars"]] },
      { key: "split", type: "select", label: "Lines", options: [["repo", "One per repository"], ["combined", "All repositories combined"]] },
      { key: "style", type: "select", label: "Chart type", options: [["line", "Line"], ["area", "Area (stacked per repository)"], ["bar", "Bars (stacked per repository)"]] },
      { key: "bucket", type: "select", label: "Group by", options: [["auto", "Automatic"], ["day", "Day"], ["week", "Week"], ["month", "Month"]] },
      f.title, f.repos, f.range,
    ],
    autoTitle: (c) => ({ cumulative: "Total downloads over time", new: "New downloads", stars: "Stars over time" })[c.measure],
    render: renderTimeline,
  },
  breakdown: {
    label: "Per repository", blurb: "Compare repositories as bars or a ring", where: ["overview"],
    defaults: { size: "third", measure: "total", style: "doughnut", range: "global", repos: [] },
    sizes: sizes("quarter", "third", "half", "two-thirds", "full"),
    fields: [
      { key: "measure", type: "select", label: "Measure", options: [["total", "Total downloads"], ["new", "New downloads in the range"], ["stars", "Stars"], ["forks", "Forks"]] },
      { key: "style", type: "select", label: "Chart type", options: [["hbar", "Horizontal bars"], ["bar", "Vertical bars"], ["doughnut", "Ring (share of total)"]] },
      f.title, f.repos,
      { ...f.range, show: (c) => c.measure === "new" },
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
      { key: "style", type: "select", label: "Show as", options: [["hbar", "Horizontal bars"], ["bar", "Vertical bars"], ["table", "Table"]] },
      { key: "limit", type: "select", label: "Releases shown", options: [[5, "Latest 5"], [10, "Latest 10"], [20, "Latest 20"], [50, "Latest 50"]] },
      f.title,
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
    ],
    autoTitle: (c) => (c.table === "daily" ? "Downloads per day" : "All repositories"),
    render: renderTable,
  },
  repohead: {
    label: "Repository header", blurb: "Name, totals and a pulse of new downloads", where: ["repo"],
    defaults: { size: "full", range: "global" },
    sizes: sizes("full"),
    fields: [f.range],
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
      { key: "style", type: "select", label: "Chart type", options: [["bar", "Bars (stacked per release)"], ["area", "Area (stacked per release)"], ["line", "Line per release"]] },
      { key: "bucket", type: "select", label: "Group by", options: [["auto", "Automatic"], ["day", "Day"], ["week", "Week"], ["month", "Month"]] },
      f.title, f.range,
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
      { key: "style", type: "select", label: "Show as", options: [["table", "Table"], ["hbar", "Horizontal bars"]] },
      f.title,
    ],
    autoTitle: (c, ctx) => { const r = ctx.repo ? null : ctx.model.byId.get(Number(c.repo)); return r ? `Files of ${r.label}` : "Downloads per file"; },
    render: renderFiles,
  },
  note: {
    label: "Text", blurb: "A short note for visitors",
    defaults: { size: "third", text: "" },
    sizes: sizes("quarter", "third", "half", "two-thirds", "full"),
    fields: [f.title, { key: "text", type: "textarea", label: "Text", hint: "Links starting with https:// become clickable" }],
    autoTitle: () => "About",
    render: renderNote,
  },
};

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
/** Renders one widget into a new element. ctx: {model, globalDays, charts, mode, tools} */
export function renderWidget(cfg, ctx) {
  const type = TYPES[cfg.type];
  const slot = document.createElement("div");
  slot.dataset.id = cfg.id;
  if (!type) { slot.className = "slot w-full"; slot.textContent = "Unknown widget"; if (ctx.tools) ctx.tools(slot, cfg); return slot; }
  slot.className = `slot w-${type.sizes.length === 1 ? type.sizes[0][0] : cfg.size || type.defaults.size}`;
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
    <div class="widget-head">
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
  const by = autoBucket(days, win.dates.length);
  const daily = bucket(win.dates, model.sum(repos, "daily", win), by);
  const unit = { day: "day", week: "week", month: "month" }[by];
  const periodWord = days ? rangeLabel(days).toLowerCase() : "since tracking started";
  const prevWord = days ? `the ${days === 365 ? "12 months" : days + " days"} before` : "";

  setHTML(slot, markup`<section class="pulse" aria-labelledby="t-${cfg.id}">
    <div class="pulse-figures">
      <div class="pulse-label" id="t-${cfg.id}">${titleOf(cfg, ctx)}</div>
      <div class="pulse-total">${fmt(total)}</div>
      <div class="pulse-delta">
        <span><strong>${gained == null ? "–" : "+" + fmt(gained)}</strong> ${periodWord}</span>
        ${pct == null ? "" : markup`<span><span class="${pct >= 0 ? "delta-up" : "delta-down"}">${pct >= 0 ? "▲" : "▼"} ${fmt1(Math.abs(pct))}%</span> compared with ${prevWord}</span>`}
      </div>
    </div>
    <div class="pulse-chart"><canvas role="img" aria-label="New downloads per ${unit}, ${periodWord}"></canvas></div>
    <div class="pulse-foot"><span>New downloads per ${unit}</span>
      <span>${repos.length} ${repos.length === 1 ? "repository" : "repositories"}, updated ${timeAgo(model.lastUpdate)}</span></div>
  </section>`);
  const pal = palette();
  const canvas = slot.querySelector("canvas");
  if (model.empty || daily.values.every((v) => v == null)) {
    setHTML(slot.querySelector(".pulse-chart"), markup`<p class="empty">The pulse starts after two daily collections.</p>`);
    return;
  }
  const fmtd = dateFormatter(by);
  chart(ctx, canvas, {
    type: "line",
    data: { labels: daily.labels, datasets: [{
      label: "New downloads", data: daily.values, borderColor: pal.accent, borderWidth: 2, tension: 0.35,
      pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: pal.panel, pointHoverBackgroundColor: pal.accent,
      fill: "origin", spanGaps: true,
      backgroundColor: (c) => {
        const { chartArea, ctx: g } = c.chart;
        if (!chartArea) return alpha(pal.accent, 0.15);
        const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        grad.addColorStop(0, alpha(pal.accent, 0.32)); grad.addColorStop(1, alpha(pal.accent, 0.02));
        return grad;
      },
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: reducedMotion() ? false : { duration: 500 },
      layout: { padding: { top: 12, bottom: 0, left: 0, right: 0 } },
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltip(pal, (it) => fmtd.title(it[0].label), (c) => ` ${fmt(c.parsed.y)} new downloads`) },
      scales: { x: { display: false }, y: { display: false, beginAtZero: true, grace: "8%" } },
    },
  });
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
      value = fmt(repos.reduce((s, r) => s + r.total, 0));
      note = `across ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`;
      spark = model.sum(repos, "cum", win);
      break;
    case "new": {
      const g = model.gained(repos, win.startI, win.endI);
      value = g == null ? "–" : fmt(g);
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
      value = fmt(repos.reduce((s, r) => s + (r[key] || 0), 0));
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
        note = `+${fmt(bestG)} downloads, ${fmt(best.total)} in total`;
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
        value = fmt(rel.downloads);
        note = `${rel.tag}${rel.published_at ? ", published " + timeAgo(rel.published_at) : ""}${rel.last_7_days != null ? `, +${fmt(rel.last_7_days)} in the last 7 days` : ""}`;
      } else note = ctx.repo ? "No releases yet" : "Only shown on repository pages";
      break;
    }
  }
  setHTML(body, markup`<div class="kpi-value num" style="${small ? "font-size:28px;line-height:1.1;word-break:break-word" : ""}">${value}</div>
    <div class="kpi-note">${note}</div>
    ${cfg.spark && spark && spark.some((v) => v != null) ? markup`<div class="kpi-spark"><canvas aria-hidden="true"></canvas></div>` : ""}`);
  const canvas = body.querySelector("canvas");
  if (canvas) {
    chart(ctx, canvas, {
      type: "line",
      data: { labels: win.dates, datasets: [{ data: spark, borderColor: sparkColor, borderWidth: 2, pointRadius: 0, tension: 0.3, fill: "origin", backgroundColor: alpha(sparkColor, 0.1), spanGaps: true }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, beginAtZero: cfg.metric !== "total" && cfg.metric !== "stars" && cfg.metric !== "forks" } } },
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
  const fmtd = dateFormatter(by);
  const colors = colorsFor(repos, pal);
  let series = [];
  if (cfg.split === "combined" || repos.length < 2) {
    const b = bucket(win.dates, model.sum(repos, key, win), by, how);
    series = [{ label: repos.length === 1 ? repos[0].label : "All repositories", color: repos.length === 1 ? colors.get(repos[0].id) : pal.accent, labels: b.labels, values: b.values, repo: repos.length === 1 ? repos[0] : null }];
  } else {
    const { shown, rest } = fold(repos, (r) => (key === "daily" ? model.gained([r], win.startI, win.endI) || 0 : r.total));
    series = shown.map((r) => { const b = bucket(win.dates, model.series(r, key, win), by, how); return { label: r.label, color: colors.get(r.id), labels: b.labels, values: b.values, repo: r }; });
    if (rest.length) { const b = bucket(win.dates, model.sum(rest, key, win), by, how); series.push({ label: `Other (${rest.length})`, color: pal.other, labels: b.labels, values: b.values }); }
  }
  const unitWord = cfg.measure === "new" ? "new downloads" : cfg.measure === "stars" ? "stars" : "downloads";
  seriesChart(slot, cfg, ctx, series, by, unitWord, model.empty ? null : undefined);
}

/** Line/area/bar chart of several date series, with legend and table view. */
function seriesChart(slot, cfg, ctx, series, by, unitWord, emptyText) {
  const pal = palette();
  const fmtd = dateFormatter(by);
  const labels = series[0]?.labels || [];
  const stacked = series.length > 1 && cfg.style !== "line";
  chartWithTable(slot, cfg, ctx, (body) => {
    if (emptyText === null || !labels.length || series.every((x) => x.values.every((v) => v == null))) return noData(body, emptyText || undefined);
    setHTML(body, markup`${legendHTML(series, ctx)}<div class="chart-box"><canvas role="img" aria-label="${titleOf(cfg, ctx)}"></canvas></div>`);
    const isBar = cfg.style === "bar";
    chart(ctx, body.querySelector("canvas"), {
      type: isBar ? "bar" : "line",
      data: { labels, datasets: series.map((s, i) => ({
        label: s.label, data: stacked ? s.values.map((v) => v ?? 0) : s.values, borderColor: isBar ? pal.panel : s.color,
        backgroundColor: isBar ? s.color : cfg.style === "area" ? alpha(s.color, stacked ? 0.55 : 0.18) : s.color,
        borderWidth: isBar ? (stacked && i > 0 ? { top: 0, bottom: 2, left: 0, right: 0 } : 0) : 2,
        borderRadius: isBar ? (stacked ? (i === series.length - 1 ? { topLeft: 4, topRight: 4 } : 0) : 4) : 0,
        borderSkipped: isBar ? false : undefined,
        maxBarThickness: 36, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: pal.panel,
        pointHoverBackgroundColor: s.color, tension: 0.25, spanGaps: true,
        fill: cfg.style === "area" ? (stacked ? (i === 0 ? "origin" : "-1") : "origin") : false,
        stack: stacked ? "s" : `s${i}`,
      })) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: reducedMotion() ? false : { duration: 400 },
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: {
          ...tooltip(pal, (it) => fmtd.title(it[0].label), (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}`),
          itemSort: (a, b) => (b.parsed.y || 0) - (a.parsed.y || 0),
          callbacks: { ...tooltip(pal).callbacks, title: (it) => fmtd.title(it[0].label), label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}`,
            footer: (items) => (items.length > 1 && stacked ? `Total: ${fmt(items.reduce((s, x) => s + (x.parsed.y || 0), 0))} ${unitWord}` : "") } } },
        scales: axisOptions(pal, { stacked, xTick: function (v) { return fmtd.tick(this.getLabelForValue(v)); } }),
      },
    });
  }, () => [[by === "week" ? "Week of" : by === "month" ? "Month" : "Day", ...series.map((s) => s.label)],
    labels.map((d, i) => [by === "month" ? fmtd.title(d) : fmtDay(d, { day: "numeric", month: "short", year: "numeric" }), ...series.map((s) => s.values[i])]).reverse()]);
}

/* breakdown ----------------------------------------------------------- */
function renderBreakdown(slot, cfg, ctx) {
  const { model } = ctx;
  const pal = palette();
  const repos = scope(cfg, ctx);
  const days = widgetDays(cfg, ctx);
  const win = model.window(days);
  const val = (r) => cfg.measure === "new" ? model.gained([r], win.startI, win.endI) || 0 : cfg.measure === "stars" ? r.stars : cfg.measure === "forks" ? r.forks : r.total;
  const colors = colorsFor(repos, pal);
  const { shown, rest } = fold(repos, val);
  let items = shown.map((r) => ({ label: r.label, value: val(r), color: colors.get(r.id), repo: r })).sort((a, b) => b.value - a.value);
  if (rest.length) items.push({ label: `Other (${rest.length})`, value: rest.reduce((s, r) => s + val(r), 0), color: pal.other });
  const total = items.reduce((s, x) => s + x.value, 0);
  const unit = { total: "downloads", new: "new downloads", stars: "stars", forks: "forks" }[cfg.measure];

  chartWithTable(slot, cfg, ctx, (body) => {
    if (!repos.length || total === 0) return noData(body, repos.length ? `No ${unit} yet.` : "No repositories yet.");
    if (cfg.style === "doughnut") {
      setHTML(body, markup`<div class="chart-box round"><canvas role="img" aria-label="${titleOf(cfg, ctx)}"></canvas>
        <div style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;text-align:center">
          <div><div class="kpi-value num" style="font-size:30px;margin:0">${fmtCompact(total)}</div><div class="muted" style="font-size:13px">${unit}</div></div></div></div>
        <div class="legend" style="margin:14px 0 0;flex-direction:column;gap:6px">${items.map((it) => markup`<span style="justify-content:space-between;display:flex">
          <span style="display:inline-flex;gap:8px;align-items:center;min-width:0"><i style="background:${it.color}"></i><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ctx.links && it.repo ? markup`<a href="${repoHref(ctx, it.repo)}">${it.label}</a>` : it.label}</span></span>
          <span class="num" style="color:var(--ink)">${fmt(it.value)} <span class="muted">${fmt1((it.value / total) * 100)}%</span></span></span>`)}</div>`);
      chart(ctx, body.querySelector("canvas"), {
        type: "doughnut",
        data: { labels: items.map((x) => x.label), datasets: [{ data: items.map((x) => x.value), backgroundColor: items.map((x) => x.color), borderColor: pal.panel, borderWidth: 2, hoverOffset: 4, borderRadius: 3 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "68%", animation: reducedMotion() ? false : { duration: 450 }, ...clickThrough(ctx, items.map((x) => x.repo)),
          plugins: { legend: { display: false }, tooltip: tooltip(pal, (it) => it[0].label, (c) => ` ${fmt(c.parsed)} ${unit} (${fmt1((c.parsed / total) * 100)}%)`) } },
      });
      return;
    }
    const horizontal = cfg.style === "hbar";
    const height = horizontal ? Math.max(160, items.length * 38 + 40) : 280;
    setHTML(body, markup`<div class="chart-box" style="height:${height}px"><canvas role="img" aria-label="${titleOf(cfg, ctx)}"></canvas></div>`);
    chart(ctx, body.querySelector("canvas"), {
      type: "bar",
      data: { labels: items.map((x) => x.label), datasets: [{ label: unit, data: items.map((x) => x.value), backgroundColor: items.map((x) => x.color), borderRadius: 4, borderSkipped: "start", maxBarThickness: horizontal ? 24 : 48 }] },
      options: { indexAxis: horizontal ? "y" : "x", responsive: true, maintainAspectRatio: false, animation: reducedMotion() ? false : { duration: 400 },
        interaction: { mode: "nearest", intersect: false, axis: horizontal ? "y" : "x" }, ...clickThrough(ctx, items.map((x) => x.repo)),
        plugins: { legend: { display: false }, tooltip: tooltip(pal, (it) => it[0].label, (c) => ` ${fmt(horizontal ? c.parsed.x : c.parsed.y)} ${unit}`) },
        scales: axisOptions(pal, { horizontal }) },
    });
  }, () => [["Repository", unit[0].toUpperCase() + unit.slice(1), "Share"], items.map((x) => [ctx.links && x.repo ? markup`<a href="${repoHref(ctx, x.repo)}">${x.label}</a>` : x.label, x.value, total ? fmt1((x.value / total) * 100) + "%" : "–"])]);
}

/* releases ------------------------------------------------------------ */
function loadReleases(ctx, repoId) {
  return loadPage(ctx, repoId).then((d) => d.releases);
}

function renderReleases(slot, cfg, ctx) {
  const { model } = ctx;
  const repo = targetRepo(cfg, ctx);
  const pal = palette();
  if (!repo) { noData(shell(slot, cfg, ctx), "Choose a repository in this widget's settings."); return; }
  const color = colorsFor([repo], pal).get(repo.id);
  const unit = cfg.measure === "last_7_days" ? "downloads in the last 7 days" : "downloads";
  const asTable = cfg.style === "table";
  let rows = [];
  const tableCols = ["Release", "Published", "Downloads", "Last 7 days"];
  const tableRows = () => rows.map((r) => [markup`<a href="${r.url || repo.url + "/releases"}" target="_blank" rel="noopener">${r.tag}</a>${r.name && r.name !== r.tag ? markup` <span class="muted">${r.name}</span>` : ""}${r.prerelease ? markup` <span class="tag">pre-release</span>` : ""}`,
    r.published_at ? new Date(r.published_at).toLocaleDateString() : "–", r.downloads, r.last_7_days]);
  const draw = (body) => {
    setHTML(body, markup`<p class="empty"><span class="spinner"></span></p>`);
    loadReleases(ctx, repo.id).then((list) => {
      rows = list.slice(0, Number(cfg.limit) || 10);
      if (!rows.length) return noData(body, "This repository has no releases yet.");
      if (asTable) { setHTML(body, tableHTML(tableCols, tableRows())); return; }
      const horizontal = cfg.style !== "bar";
      const vals = rows.map((r) => (cfg.measure === "last_7_days" ? r.last_7_days ?? 0 : r.downloads));
      const height = horizontal ? Math.max(160, rows.length * 32 + 40) : 280;
      setHTML(body, markup`<div class="chart-box" style="height:${height}px"><canvas role="img" aria-label="${titleOf(cfg, ctx)}"></canvas></div>`);
      chart(ctx, body.querySelector("canvas"), {
        type: "bar",
        data: { labels: rows.map((r) => r.tag), datasets: [{ label: unit, data: vals, backgroundColor: color, borderRadius: 4, borderSkipped: "start", maxBarThickness: horizontal ? 22 : 40 }] },
        options: { indexAxis: horizontal ? "y" : "x", responsive: true, maintainAspectRatio: false, animation: reducedMotion() ? false : { duration: 400 },
          interaction: { mode: "nearest", intersect: false, axis: horizontal ? "y" : "x" },
          plugins: { legend: { display: false }, tooltip: tooltip(pal, (it) => { const r = rows[it[0].dataIndex]; return r.name !== r.tag ? `${r.tag}, ${r.name}` : r.tag; },
            (c) => ` ${fmt(horizontal ? c.parsed.x : c.parsed.y)} ${unit}`) } ,
          scales: axisOptions(pal, { horizontal }) },
      });
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
  const cols = [
    ["label", "Repository"], ["total", "Downloads"], ["gained", rangeLabel(days)], ["week", "Last 7 days"],
    ["stars", "Stars"], ["forks", "Forks"], ["rel", "Latest release"],
  ];
  let sortKey = "total", dir = -1;
  const draw = () => {
    const sorted = data.slice().sort((a, b) => {
      const va = sortKey === "label" ? a.r.label.toLowerCase() : sortKey === "rel" ? a.rel?.published_at || "" : a[sortKey] ?? -1;
      const vb = sortKey === "label" ? b.r.label.toLowerCase() : sortKey === "rel" ? b.rel?.published_at || "" : b[sortKey] ?? -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    setHTML(body, markup`<div class="table-wrap"><table class="data"><thead><tr>${cols.map(([k, label], i) => markup`<th scope="col" class="${i && k !== "rel" ? "r" : ""}" aria-sort="${sortKey === k ? (dir < 0 ? "descending" : "ascending") : "none"}"><button type="button" class="sort" data-k="${k}">${label}${sortKey === k ? (dir < 0 ? " ↓" : " ↑") : ""}</button></th>`)}</tr></thead>
      <tbody>${sorted.map((x) => markup`<tr>
        <td><div class="repo-cell"><span class="dot" style="background:${colors.get(x.r.id)}"></span><div><a href="${ctx.links ? repoHref(ctx, x.r) : x.r.url}" ${ctx.links ? "" : raw('target="_blank" rel="noopener"')}>${x.r.label}</a><small>${x.r.full_name} <a class="ext" href="${x.r.url}" target="_blank" rel="noopener" aria-label="${x.r.full_name} on GitHub" title="Open on GitHub">${icon("external")}</a></small></div></div></td>
        <td class="r">${fmt(x.total)}</td><td class="r">${x.gained == null ? "–" : "+" + fmt(x.gained)}</td><td class="r">${x.week == null ? "–" : "+" + fmt(x.week)}</td>
        <td class="r">${fmt(x.stars)}</td><td class="r">${fmt(x.forks)}</td>
        <td>${x.rel ? markup`<a href="${x.rel.html_url || x.r.url + "/releases"}" target="_blank" rel="noopener">${x.rel.tag}</a> <span class="muted">${x.rel.published_at ? timeAgo(x.rel.published_at) : ""}</span>` : markup`<span class="muted">none</span>`}</td>
      </tr>`)}</tbody></table></div>`);
    body.querySelectorAll("button.sort").forEach((b) => b.addEventListener("click", () => {
      if (sortKey === b.dataset.k) dir = -dir; else { sortKey = b.dataset.k; dir = b.dataset.k === "label" ? 1 : -1; }
      draw();
      body.querySelector(`button.sort[data-k="${sortKey}"]`).focus();
    }));
  };
  draw();
}

/* note ---------------------------------------------------------------- */
function renderNote(slot, cfg, ctx) {
  const body = shell(slot, cfg, ctx);
  // nosemgrep: javascript.lang.security.html-in-template-string -- u is part of the esc()-escaped text and cannot contain " or <
  const text = esc(cfg.text || "").replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  // nosemgrep: javascript.lang.security.html-in-template-string -- text is esc()-escaped; links are https URLs without quotes or <
  setHTML(body, text ? raw(`<div class="note-text">${text}</div>`) : markup`<p class="empty">Write something in this widget's settings.</p>`);
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
  const by = autoBucket(days, win.dates.length);
  const daily = bucket(win.dates, model.series(repo, "daily", win), by);
  const unit = { day: "day", week: "week", month: "month" }[by];
  const periodWord = days ? rangeLabel(days).toLowerCase() : "since tracking started";
  const prevWord = days ? `the ${days === 365 ? "12 months" : days + " days"} before` : "";
  const rel = repo.latest_release;
  setHTML(slot, markup`<section class="pulse repo-head" aria-labelledby="t-${cfg.id}">
    <div class="pulse-figures">
      <div class="repo-name"><span class="dot" style="background:${color}" aria-hidden="true"></span><h1 id="t-${cfg.id}">${repo.label}</h1></div>
      <div class="repo-sub"><a href="${repo.url}" target="_blank" rel="noopener">${repo.full_name} ${icon("external")}</a>${repo.hidden ? markup` <span class="tag">hidden from visitors</span>` : ""}</div>
      ${repo.description ? markup`<p class="repo-desc">${repo.description}</p>` : ""}
      <div class="pulse-total" style="font-size:clamp(46px,6vw,80px)">${fmt(repo.total)}</div>
      <div class="pulse-delta">
        <span>downloads, <strong>${gained == null ? "–" : "+" + fmt(gained)}</strong> ${periodWord}</span>
        ${pct == null ? "" : markup`<span><span class="${pct >= 0 ? "delta-up" : "delta-down"}">${pct >= 0 ? "▲" : "▼"} ${fmt1(Math.abs(pct))}%</span> compared with ${prevWord}</span>`}
      </div>
      <dl class="repo-facts">
        <div><dt>Stars</dt><dd>${fmt(repo.stars)}</dd></div>
        <div><dt>Forks</dt><dd>${fmt(repo.forks)}</dd></div>
        <div><dt>Releases</dt><dd>${fmt(repo.releases)}</dd></div>
        <div><dt>Newest</dt><dd>${rel ? markup`<a href="${rel.html_url || repo.url + "/releases"}" target="_blank" rel="noopener">${rel.tag}</a>` : "none"}</dd></div>
        <div><dt>Tracked since</dt><dd>${repo.trackedSince ? fmtDay(repo.trackedSince, { day: "numeric", month: "short", year: "numeric" }) : "not yet"}</dd></div>
      </dl>
    </div>
    <div class="pulse-chart"><canvas role="img" aria-label="New downloads of ${repo.label} per ${unit}, ${periodWord}"></canvas></div>
    <div class="pulse-foot"><span>New downloads per ${unit}</span><span>Updated ${timeAgo(repo.last_collected)}</span></div>
  </section>`);
  if (daily.values.every((v) => v == null)) {
    setHTML(slot.querySelector(".pulse-chart"), markup`<p class="empty">The pulse starts after two daily collections.</p>`);
    return;
  }
  const fmtd = dateFormatter(by);
  chart(ctx, slot.querySelector("canvas"), {
    type: "line",
    data: { labels: daily.labels, datasets: [{
      label: "New downloads", data: daily.values, borderColor: color, borderWidth: 2, tension: 0.35, spanGaps: true,
      pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: pal.panel, pointHoverBackgroundColor: color, fill: "origin",
      backgroundColor: (c) => {
        const { chartArea, ctx: g } = c.chart;
        if (!chartArea) return alpha(color, 0.15);
        const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        grad.addColorStop(0, alpha(color, 0.32)); grad.addColorStop(1, alpha(color, 0.02));
        return grad;
      },
    }] },
    options: { responsive: true, maintainAspectRatio: false, animation: reducedMotion() ? false : { duration: 500 },
      layout: { padding: { top: 12 } }, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltip(pal, (it) => fmtd.title(it[0].label), (c) => ` ${fmt(c.parsed.y)} new downloads`) },
      scales: { x: { display: false }, y: { display: false, beginAtZero: true, grace: "8%" } } },
  });
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
    const hist = d.release_history || {};
    // oldest release first: each tag keeps its colour as new releases arrive
    const tags = Object.keys(hist).sort((a, b) => (published.get(a) || hist[a][0][0]).localeCompare(published.get(b) || hist[b][0][0]));
    let rows = tags.map((tag, i) => {
      const sr = model.releaseSeries(repo, hist[tag]);
      const vals = sr[key].slice(win.startI, win.endI + 1);
      const score = key === "daily" ? vals.reduce((a, v) => a + (v || 0), 0) : vals.filter((v) => v != null).pop() || 0;
      return { tag, color: pal.series[i % 8], vals, score };
    }).filter((x) => x.vals.some((v) => v != null && (key === "cum" || v > 0)));
    let rest = [];
    if (rows.length > 8) {
      const keep = new Set(rows.slice().sort((a, b) => b.score - a.score).slice(0, 7).map((x) => x.tag));
      rest = rows.filter((x) => !keep.has(x.tag));
      rows = rows.filter((x) => keep.has(x.tag));
    }
    const series = rows.map((x) => { const b = bucket(win.dates, x.vals, by, how); return { label: x.tag, color: x.color, labels: b.labels, values: b.values }; });
    if (rest.length) {
      const sum = win.dates.map((_, i) => rest.reduce((a, x) => (x.vals[i] == null ? a : (a || 0) + x.vals[i]), null));
      const b = bucket(win.dates, sum, by, how);
      series.push({ label: `Other releases (${rest.length})`, color: pal.other, labels: b.labels, values: b.values });
    }
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
    const asTable = cfg.style !== "hbar";
    const body = shell(slot, cfg, ctx);
    if (!list.length) { noData(body, "No release files yet."); return; }
    const allCounted = list.every((x) => x.counted);
    const footnote = markup`<p class="muted" style="font-size:13px;margin:10px 0 0">${allCounted ? "Every file counts towards the download totals." : "Only counted files add to the download totals. Change this under Admin, Repositories, Edit."}</p>`;
    if (asTable) {
      setHTML(body, markup`${tableHTML(["File", "Downloads", "Releases", "Counted"], list.map((x) => [x.name, x.downloads, x.releases, x.counted ? "yes" : markup`<span class="muted">no</span>`]))}${footnote}`);
      return;
    }
    const height = Math.max(140, list.length * 34 + 40);
    setHTML(body, markup`${allCounted ? "" : legendHTML([{ label: "Counted", color }, { label: "Not counted", color: pal.other }])}
      <div class="chart-box" style="height:${height}px"><canvas role="img" aria-label="${titleOf(cfg, ctx)}"></canvas></div>${footnote}`);
    chart(ctx, body.querySelector("canvas"), {
      type: "bar",
      data: { labels: list.map((x) => x.name), datasets: [{ label: "downloads", data: list.map((x) => x.downloads), backgroundColor: list.map((x) => (x.counted ? color : pal.other)), borderRadius: 4, borderSkipped: "start", maxBarThickness: 22 }] },
      options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: reducedMotion() ? false : { duration: 400 },
        interaction: { mode: "nearest", intersect: false, axis: "y" },
        plugins: { legend: { display: false }, tooltip: tooltip(pal, (it) => it[0].label, (c) => ` ${fmt(c.parsed.x)} downloads${list[c.dataIndex].counted ? "" : " (not counted)"}`) },
        scales: axisOptions(pal, { horizontal: true }) },
    });
  }).catch((e) => noData(shell(slot, cfg, ctx), e.message));
}
