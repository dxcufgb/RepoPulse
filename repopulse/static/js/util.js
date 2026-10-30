// Small DOM and formatting helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template: interpolated values are escaped unless wrapped in raw(). */
export function markup(strings, ...values) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (v && v.__raw !== undefined) out += v.__raw;
      else if (Array.isArray(v)) out += v.map((x) => (x && x.__raw !== undefined ? x.__raw : esc(x))).join("");
      else out += esc(v);
    }
  });
  return { __raw: out };
}
export const raw = (s) => ({ __raw: String(s ?? "") });

/** map[key] only when it is the map's own entry: keys from stored layouts such
 * as "constructor" or "__proto__" never reach Object.prototype. */
export const own = (map, key) => (map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);

/** An http(s) URL for an href, else "" (javascript:, data: and the like are dropped). */
export function safeUrl(u) {
  if (typeof u !== "string" || !u) return "";
  try {
    const url = new URL(u, location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch { return ""; }
}

export function setHTML(el, tpl) {
  // nosemgrep: javascript.browser.security.insecure-document-method, javascript.browser.security.insecure-innerhtml -- only markup`` output (every value escaped) or esc() text
  el.innerHTML = tpl && tpl.__raw !== undefined ? tpl.__raw : esc(tpl);
  return el;
}

export function frag(tpl) {
  const t = document.createElement("template");
  // nosemgrep: javascript.browser.security.insecure-document-method, javascript.browser.security.insecure-innerhtml -- tpl comes from markup``, whose values are escaped
  t.innerHTML = tpl.__raw;
  return t.content.firstElementChild;
}

const nf = new Intl.NumberFormat(undefined);
const nfCompact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const fmt = (n) => (n == null || Number.isNaN(n) ? "–" : nf.format(Math.round(n)));
export const fmtCompact = (n) => (n == null ? "–" : Math.abs(n) < 10000 ? nf.format(Math.round(n)) : nfCompact.format(n));
export const fmt1 = (n) => (n == null ? "–" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n));

export function parseDate(d) {
  // "YYYY-MM-DD" as a local date (not UTC)
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
}
export function isoDate(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
export function addDays(iso, n) {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
export const fmtDay = (iso, opts = { day: "numeric", month: "short" }) =>
  parseDate(iso).toLocaleDateString(undefined, opts);
export const fmtDateTime = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
export function timeAgo(s) {
  if (!s) return "never";
  const sec = (Date.now() - new Date(s).getTime()) / 1000;
  if (sec < 60) return "just now";
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [u, s2] of units) if (sec >= s2) return rtf.format(-Math.floor(sec / s2), u);
  return "just now";
}

export function toast(message, kind = "") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3200);
}

/** Promise-based dialog. buttons: [{label, value, cls}] */
export function dialog({ title, body, buttons = [{ label: "OK", value: true, cls: "primary" }], onOpen }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const scrim = frag(markup`<div class="modal-scrim" role="presentation">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <header><h2 id="dlg-title">${title}</h2></header>
        <div class="content">${body}</div>
        <footer>${buttons.map((b, i) => markup`<button type="button" class="btn ${b.cls || ""}" data-i="${i}">${b.label}</button>`)}</footer>
      </div></div>`);
    const close = (v) => { scrim.remove(); document.removeEventListener("keydown", onKey); prevFocus && prevFocus.focus && prevFocus.focus(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(undefined); trapFocus(e, scrim); };
    scrim.addEventListener("click", (e) => { if (e.target === scrim) close(undefined); });
    scrim.querySelectorAll("footer button").forEach((b) => b.addEventListener("click", async () => {
      const def = buttons[+b.dataset.i];
      const v = typeof def.value === "function" ? await def.value(scrim) : def.value;
      if (v !== false) close(v);
    }));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(scrim);
    if (onOpen) onOpen(scrim);
    (scrim.querySelector("input, textarea, select") || scrim.querySelector("footer .primary, footer .solid, footer button")).focus();
  });
}

export function confirmDialog(title, message, confirmLabel = "Confirm", danger = false) {
  return dialog({
    title, body: markup`<p>${message}</p>`,
    buttons: [{ label: "Cancel", value: false, cls: "ghost" }, { label: confirmLabel, value: true, cls: danger ? "danger solid" : "primary" }],
  }).then((v) => v === true);
}

export function trapFocus(e, root) {
  if (e.key !== "Tab") return;
  const items = $$("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])", root)
    .filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

export const ICONS = {
  table: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16M8 15l4-5 3 3 4-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m6 14 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 10 6 6 6-6"/></svg>',
  grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};
export const icon = (name) => raw(ICONS[name] || "");
