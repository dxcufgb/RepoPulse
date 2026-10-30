// Entry point: loads site info, routes between the dashboard and admin pages.

import { renderAdmin, renderLogin } from "./admin.js";
import { api, session } from "./api.js";
import { applyLook, setAppearance } from "./appearance.js";
import { Dashboard } from "./dashboard.js";
import { $, $$, markup, setHTML } from "./util.js";

const main = $("#main");
let current = null; // view with a destroy() method
let site = null;

function setSiteText(title, subtitle) {
  $("#site-title").textContent = title || "RepoPulse";
  $("#site-subtitle").textContent = subtitle || "";
}


export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  route();
}

async function route() {
  if (current && current.destroy) current.destroy();
  current = null;
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  $$(".topnav a").forEach((a) => {
    const on = a.dataset.link === (isAdmin ? "admin" : "dashboard");
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = (isAdmin ? "Admin, " : "") + (site?.title || "RepoPulse");
  try {
    if (isAdmin) {
      if (!session.user) {
        renderLogin(main, site, async () => { site = await api("/api/site"); route(); });
        return;
      }
      const sub = path.slice("/admin/".length);
      if (sub.startsWith("repo/")) {
        current = await renderAdmin(main, "", navigate, decodeURIComponent(sub.slice(5)));
        return;
      }
      current = await renderAdmin(main, ["repos", "collection", "appearance", "settings"].includes(sub) ? sub : "", navigate);
      return;
    }
    if (!site.public && !session.user) {
      setHTML(main, markup`<div class="auth-wrap"><div class="auth-card"><h1>This dashboard is private</h1>
        <p>The owner has turned off public access.</p><a class="btn primary" href="/admin" data-nav>Log in</a></div></div>`);
      return;
    }
    const slug = path.startsWith("/repo/") ? decodeURIComponent(path.slice(6)) : null;
    const dash = new Dashboard(main, { slug });
    current = dash;
    await dash.load();
    if (current === dash) dash.render();
  } catch (e) {
    if (e.status === 404) {
      setHTML(main, markup`<div class="auth-wrap"><div class="auth-card"><h1>Not found</h1><p>${e.message}</p>
        <a class="btn primary" href="${isAdmin ? "/admin" : "/"}">Show all repositories</a></div></div>`);
      return;
    }
    setHTML(main, markup`<div class="auth-wrap"><div class="auth-card"><h1>Something went wrong</h1><p>${e.message}</p>
      <p class="muted">Reload the page to try again.</p></div></div>`);
  }
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute("download")) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/static/")) return;
  e.preventDefault();
  if (url.pathname !== location.pathname) navigate(url.pathname);
  main.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
});
window.addEventListener("popstate", route);
window.addEventListener("repopulse:navigate", (e) => { navigate(e.detail); main.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); });
window.addEventListener("repopulse:logged-out", () => route());
window.addEventListener("repopulse:site", (e) => { site.title = e.detail.title; site.subtitle = e.detail.subtitle; setSiteText(site.title, site.subtitle); });

$("#theme-toggle").addEventListener("click", () => {
  const rootEl = document.documentElement;
  const dark = rootEl.dataset.theme ? rootEl.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  rootEl.dataset.theme = next;
  try { localStorage.setItem("repopulse-theme", next); } catch { /* ignore */ }
  applyLook();
  window.dispatchEvent(new CustomEvent("repopulse:theme"));
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!document.documentElement.dataset.theme) { applyLook(); window.dispatchEvent(new CustomEvent("repopulse:theme")); }
});

async function boot() {
  try {
    site = await api("/api/site");
  } catch (e) {
    setHTML(main, markup`<div class="auth-wrap"><div class="auth-card"><h1>Can't reach RepoPulse</h1><p>${e.message}</p></div></div>`);
    return;
  }
  session.user = site.user;
  session.csrf = site.csrf;
  setSiteText(site.title, site.subtitle);
  setAppearance(site.appearance);
  if (document.readyState !== "complete") await new Promise((r) => window.addEventListener("load", r, { once: true }));
  applyLook();
  route();
}
boot();
