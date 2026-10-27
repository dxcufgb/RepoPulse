// Applied before first paint so there is no light/dark flash.
(function () {
  var t = null;
  try { t = localStorage.getItem("repopulse-theme"); } catch (e) {}
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
})();
