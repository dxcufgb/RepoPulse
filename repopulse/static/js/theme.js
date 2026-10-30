// Applied before first paint so there is no light/dark flash: the visitor's own
// theme choice, else the admin's default, and the cached look (appearance.js).
(function () {
  var root = document.documentElement, t = null, look = null, k;
  try {
    t = localStorage.getItem("repopulse-theme");
    look = JSON.parse(localStorage.getItem("repopulse-look") || "null");
  } catch (e) {}
  if (t !== "light" && t !== "dark" && look && (look.theme === "light" || look.theme === "dark")) t = look.theme;
  if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
  if (!look || typeof look !== "object") return;
  for (k in look.attrs || {}) root.setAttribute("data-" + k, String(look.attrs[k]));
  var dark = t ? t === "dark" : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var vars = (dark ? look.dark : look.light) || {};
  for (k in vars) if (k.indexOf("--") === 0) root.style.setProperty(k, String(vars[k]));
})();
