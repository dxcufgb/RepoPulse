// Page-wide look (Admin, Appearance): theme, colours, fonts, shapes, spacing.
// The server keeps the same option lists (repopulse/appearance.py). The look is
// also cached in localStorage so theme.js can apply it before the first paint.

const LOOK_KEY = "repopulse-look";

/** [key, label, hint, [[value, label], ...]]; the first value is the default. */
export const SECTIONS = [
  ["Colours", [
    ["theme", "Theme", "Visitors can still switch with the sun/moon button", [["system", "Follow the visitor's system"], ["light", "Light"], ["dark", "Dark"]]],
    ["palette", "Chart colours", "The colours repositories and series get, in order", [["default", "RepoPulse"], ["vivid", "Vivid"], ["pastel", "Pastel"], ["ocean", "Ocean"], ["sunset", "Sunset"], ["forest", "Forest"], ["berry", "Berry"], ["mono", "Shades of the accent colour"], ["grey", "Greys"]]],
    ["surface", "Page and card colours", "", [["neutral", "Neutral grey"], ["warm", "Warm paper"], ["cool", "Cool blue"], ["tinted", "Tinted with the accent colour"], ["contrast", "High contrast"]]],
    ["background", "Page background", "", [["plain", "Plain"], ["gradient", "Soft gradient at the top"], ["glow", "Coloured glow"], ["dots", "Dots"], ["grid", "Grid paper"]]],
  ]],
  ["Shapes and spacing", [
    ["cards", "Cards", "", [["bordered", "Thin border"], ["shadow", "Floating, with a shadow"], ["flat", "Flat, no border"], ["outline", "Outline only, no fill"]]],
    ["radius", "Corners", "", [["default", "Rounded"], ["sharp", "Sharp"], ["soft", "Slightly rounded"], ["round", "Very round"]]],
    ["density", "Spacing", "", [["comfortable", "Comfortable"], ["compact", "Compact"], ["spacious", "Spacious"]]],
    ["width", "Page width", "", [["standard", "Standard"], ["narrow", "Narrow"], ["wide", "Wide"], ["full", "Full window"]]],
  ]],
  ["Text", [
    ["font", "Font", "Only fonts that come with RepoPulse or the visitor's system; nothing is loaded from the internet", [["default", "RepoPulse (Bricolage Grotesque and Instrument Sans)"], ["system", "System font"], ["serif", "Serif"], ["mono", "Monospace"], ["rounded", "Rounded"]]],
    ["titles", "Widget titles", "", [["normal", "Normal"], ["caps", "Small capitals"], ["large", "Large"]]],
  ]],
  ["Headline and header", [
    ["headline", "Headline band", "The big total at the top and the repository header", [["panel", "Like the other cards"], ["tint", "Tinted"], ["accent", "Filled with the accent colour"], ["gradient", "Accent gradient"]]],
    ["brand", "Logo", "", [["show", "Show"], ["hide", "Hide"]]],
    ["subtitle", "Subtitle under the title", "", [["show", "Show"], ["hide", "Hide"]]],
  ]],
  ["For visitors", [
    ["default_range", "Starting range", "The range the dashboard opens with", [["30", "30 days"], ["7", "7 days"], ["90", "90 days"], ["365", "12 months"], ["0", "All time"]]],
    ["rangebar", "Range switch", "Hidden: visitors always see the starting range", [["show", "Show"], ["hide", "Hide"]]],
    ["csv", "Download CSV button", "", [["show", "Show"], ["hide", "Hide"]]],
    ["motion", "Animations", "Always off for visitors who ask their system for less motion", [["on", "On"], ["off", "Off"]]],
  ]],
];
const CHOICES = Object.fromEntries(SECTIONS.flatMap(([, opts]) => opts.map(([k, , , c]) => [k, c.map((x) => x[0])])));
export const DEFAULTS = { ...Object.fromEntries(Object.entries(CHOICES).map(([k, v]) => [k, v[0]])), accent: "" };
export const ACCENTS = ["#2a78d6", "#6250d6", "#c2185b", "#e34948", "#eb6834", "#c98500", "#1baf7a", "#008300", "#0f8b8d", "#171a20"];
const BUILTIN_ACCENT = { light: "#2a78d6", dark: "#3987e5" };

const PALETTES = {
  vivid: ["#0a6cff", "#ff3d71", "#00b86b", "#ffab00", "#a020f0", "#00b8d4", "#ff6d00", "#c51162"],
  pastel: ["#6fa8dc", "#f4a582", "#7cc9a4", "#e8c15b", "#b39ddb", "#f19cbb", "#80c7e0", "#b7c96b"],
  ocean: ["#0b5394", "#1d8fd1", "#14a3b8", "#3cc29b", "#2e6f95", "#6cb4e4", "#126e82", "#5b7fe8"],
  sunset: ["#d1495b", "#edae49", "#f2733a", "#8f2d56", "#e8875f", "#b5543a", "#f5b85c", "#a23b72"],
  forest: ["#2d6a4f", "#52a375", "#8aa93b", "#a68a64", "#4f772d", "#bc6c25", "#d4a24c", "#3a7d8c"],
  berry: ["#7b2cbf", "#c2185b", "#e85d75", "#5a3fc0", "#f06292", "#9d4edd", "#ad1457", "#ff8fab"],
  grey: { light: ["#24282f", "#5a616c", "#8a919c", "#3f4650", "#737a85", "#a7adb6", "#4d545e", "#959ca6"],
    dark: ["#f0f2f5", "#b5bbc4", "#858c97", "#d2d6dc", "#9aa1ab", "#6c737e", "#c3c8cf", "#7d848f"] },
};
const SURFACES = {
  warm: {
    light: { paper: "#f3efe8", panel: "#fffdf9", "panel-2": "#f7f2ea", line: "#e3dccf", "line-strong": "#cfc6b6", grid: "#ebe5da" },
    dark: { paper: "#14110e", panel: "#1d1915", "panel-2": "#241f1a", line: "#332c25", "line-strong": "#453c32", grid: "#2b251f" },
  },
  cool: {
    light: { paper: "#e8eef6", panel: "#fbfdff", "panel-2": "#f0f5fb", line: "#d3dde9", "line-strong": "#bccadb", grid: "#dfe7f1" },
    dark: { paper: "#0b1220", panel: "#121b2b", "panel-2": "#182335", line: "#23314a", "line-strong": "#31425f", grid: "#1d2a40" },
  },
  contrast: {
    light: { paper: "#ffffff", panel: "#ffffff", "panel-2": "#f1f2f4", line: "#9aa1ac", "line-strong": "#6b7280", grid: "#e2e4e8", ink: "#000000", "ink-2": "#25282e", muted: "#4b5160" },
    dark: { paper: "#000000", panel: "#0b0b0c", "panel-2": "#17181a", line: "#5a5f68", "line-strong": "#80858e", grid: "#26272a", ink: "#ffffff", "ink-2": "#e4e6ea", muted: "#b2b7bf" },
  },
};
// what "tinted" mixes the accent into (the neutral surfaces from app.css)
const NEUTRAL = {
  light: { paper: ["#eceff3", 0.9], panel: ["#fcfcfb", 0.97], "panel-2": ["#f4f6f8", 0.93], line: ["#d9dde3", 0.82], "line-strong": ["#c3c8d0", 0.78], grid: ["#e4e6ea", 0.86] },
  dark: { paper: ["#0e1115", 0.9], panel: ["#171a1f", 0.9], "panel-2": ["#1d2127", 0.88], line: ["#2a2f37", 0.8], "line-strong": ["#3a404a", 0.8], grid: ["#262a31", 0.86] },
};

function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
/** a mixed with b; t is the share of b. */
function mix(a, b, t) {
  const x = rgb(a), y = rgb(b);
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const rgba = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r}, ${g}, ${b}, ${a})`; };

/** Only values from the lists; anything else falls back to the default. */
export function cleanAppearance(a) {
  const out = { ...DEFAULTS };
  if (!a || typeof a !== "object") return out;
  for (const [k, vals] of Object.entries(CHOICES)) if (vals.includes(String(a[k]))) out[k] = String(a[k]);
  if (typeof a.accent === "string" && /^#[0-9a-f]{6}$/i.test(a.accent)) out.accent = a.accent.toLowerCase();
  return out;
}

/** CSS custom properties for one mode. */
function varsFor(a, mode) {
  const v = {};
  const accent = a.accent || BUILTIN_ACCENT[mode];
  if (a.accent) {
    // keep links readable: darker on light pages, lighter on dark ones
    const ink = mode === "light" ? (luminance(accent) > 0.25 ? mix(accent, "#000000", 0.45) : accent) : (luminance(accent) < 0.18 ? mix(accent, "#ffffff", 0.5) : accent);
    Object.assign(v, { "--accent": accent, "--accent-ink": ink, "--focus": accent, "--accent-wash": rgba(accent, mode === "light" ? 0.1 : 0.16) });
    if (a.palette === "default") v["--s1"] = accent;
  }
  const onAccent = luminance(accent) > 0.4 ? "#111317" : "#ffffff";
  v["--on-accent"] = onAccent;
  v["--accent-2"] = mix(accent, onAccent === "#ffffff" ? "#000000" : "#ffffff", 0.38);
  const pal = PALETTES[a.palette];
  let series = null;
  if (pal) series = Array.isArray(pal) ? pal : pal[mode];
  if (a.palette === "mono") {
    const toward = mode === "light" ? "#ffffff" : "#000000";
    const away = mode === "light" ? "#000000" : "#ffffff";
    series = [accent, mix(accent, away, 0.35), mix(accent, toward, 0.4), mix(accent, away, 0.6), mix(accent, toward, 0.62), mix(accent, away, 0.18), mix(accent, toward, 0.22), mix(accent, toward, 0.78)];
  }
  if (series) series.forEach((c, i) => { v[`--s${i + 1}`] = c; });
  if (SURFACES[a.surface]) for (const [k, c] of Object.entries(SURFACES[a.surface][mode])) v[`--${k}`] = c;
  if (a.surface === "tinted") for (const [k, [base, t]] of Object.entries(NEUTRAL[mode])) v[`--${k}`] = mix(accent, base, t);
  return v;
}

/** What theme.js and apply() need: data attributes, variables per mode, the default theme. */
export function lookFor(a) {
  const attrs = {};
  for (const k of ["background", "radius", "density", "width", "font", "cards", "headline", "titles", "motion", "brand", "subtitle", "rangebar", "csv"]) {
    if (a[k] !== DEFAULTS[k]) attrs[k] = a[k];
  }
  return { theme: a.theme, attrs, light: varsFor(a, "light"), dark: varsFor(a, "dark") };
}

let current = { ...DEFAULTS };
let appliedVars = [];
let appliedAttrs = [];

export const appearance = () => current;

/** Uses a (another) appearance, e.g. from /api/site or the admin's unsaved changes. */
export function setAppearance(a, { remember = true } = {}) {
  current = cleanAppearance(a);
  const look = lookFor(current);
  if (remember) { try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch { /* storage unavailable */ } }
  applyLook(look);
}

/** Applies the look for the theme that is showing; call again after the theme changes. */
export function applyLook(look = lookFor(current)) {
  const root = document.documentElement;
  let chosen = null;
  try { chosen = localStorage.getItem("repopulse-theme"); } catch { /* storage unavailable */ }
  if (chosen !== "light" && chosen !== "dark") {
    if (look.theme === "light" || look.theme === "dark") root.dataset.theme = look.theme;
    else delete root.dataset.theme;
  }
  appliedAttrs.forEach((k) => { if (!(k in look.attrs)) root.removeAttribute(`data-${k}`); });
  for (const [k, val] of Object.entries(look.attrs)) root.setAttribute(`data-${k}`, val);
  appliedAttrs = Object.keys(look.attrs);
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const vars = dark ? look.dark : look.light;
  // theme.js may have set variables before this module ran
  for (const name of Array.from(root.style)) if (name.startsWith("--") && !(name in vars)) root.style.removeProperty(name);
  appliedVars.forEach((n) => { if (!(n in vars)) root.style.removeProperty(n); });
  for (const [n, val] of Object.entries(vars)) root.style.setProperty(n, val);
  appliedVars = Object.keys(vars);
  if (window.Chart) {
    const css = getComputedStyle(root);
    window.Chart.defaults.font.family = css.getPropertyValue("--font-ui").trim();
    window.Chart.defaults.color = css.getPropertyValue("--muted").trim();
  }
}
