// Admin pages: login / first-run setup, repositories, collection log, settings.

import { api, session } from "./api.js";
import { ACCENTS, DEFAULTS, SECTIONS, appearance, setAppearance } from "./appearance.js";
import { Dashboard } from "./dashboard.js";
import { $, $$, confirmDialog, dialog, fmt, fmtDateTime, markup, icon, raw, safeUrl, setHTML, timeAgo, toast } from "./util.js";
import { colorsFor, palette, repoHref } from "./widgets.js";

const TABS = [["", "Dashboard layout"], ["repos", "Repositories"], ["collection", "Data collection"], ["appearance", "Appearance"], ["settings", "Settings"]];

/* ------------------------------------------------------------ login */
export function renderLogin(main, site, onDone) {
  if (site.needs_setup) {
    if (!site.setup_allowed) {
      setHTML(main, markup`<div class="auth-wrap"><div class="auth-card">
        <h1>Create the admin account</h1>
        <p>For safety, the first admin account can only be created on the server itself. Open
        <strong>http://localhost:${location.port || 80}/admin</strong> on that computer, or run this in the RepoPulse folder:</p>
        <pre class="input" style="white-space:pre-wrap;font-size:13.5px">python -m repopulse create-admin</pre>
        <p class="muted" style="margin-top:12px">On Windows use <code>.venv\\Scripts\\python</code>, on Linux <code>.venv/bin/python</code>.</p>
      </div></div>`);
      return;
    }
    setHTML(main, markup`<div class="auth-wrap"><div class="auth-card">
      <h1>Create the admin account</h1>
      <p>This account manages the repositories and the dashboard. Visitors don't need one.</p>
      <form id="setup-form" novalidate>
        <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" required value="admin"></label>
        <label class="field"><span>Password <span class="hint">at least 8 characters</span></span><input class="input" name="password" type="password" autocomplete="new-password" required minlength="8"></label>
        <label class="field"><span>Repeat password</span><input class="input" name="repeat" type="password" autocomplete="new-password" required></label>
        <p class="error-text" id="auth-error" role="alert" hidden></p>
        <button class="btn primary" type="submit">Create account</button>
      </form></div></div>`);
    $("#setup-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target, err = $("#auth-error");
      err.hidden = true;
      if (f.password.value !== f.repeat.value) { err.textContent = "The passwords don't match."; err.hidden = false; return; }
      try {
        const r = await api("/api/auth/setup", { method: "POST", body: { username: f.username.value, password: f.password.value } });
        session.user = r.user; session.csrf = r.csrf; onDone();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    return;
  }
  setHTML(main, markup`<div class="auth-wrap"><div class="auth-card">
    <h1>Log in</h1>
    <p>Log in to manage repositories and build the dashboard.</p>
    <form id="login-form" novalidate>
      <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
      <label class="check"><input type="checkbox" name="remember"> Keep me logged in for 30 days</label>
      <p class="error-text" id="auth-error" role="alert" hidden></p>
      <button class="btn primary" type="submit">Log in</button>
    </form>
    <p class="muted" style="margin:16px 0 0;font-size:13.5px">Forgot the password? Run <code>python -m repopulse set-password</code> on the server.</p>
  </div></div>`);
  $("#login-form [name=username]").focus();
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, err = $("#auth-error"), btn = $("button[type=submit]", f);
    err.hidden = true; btn.disabled = true;
    try {
      const r = await api("/api/auth/login", { method: "POST", body: { username: f.username.value, password: f.password.value, remember: f.remember.checked } });
      session.user = r.user; session.csrf = r.csrf; onDone();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; f.password.select(); }
    finally { btn.disabled = false; }
  });
}

/* ------------------------------------------------------------ shell */
export async function renderAdmin(main, sub, navigate, slug = null) {
  // the views that show a running collection start polling again themselves
  stopPolling();
  setHTML(main, markup`
    <div class="admin-head"><h1>Admin</h1>
      <div class="row" style="align-items:center"><span class="muted">Logged in as ${session.user}</span>
      <button type="button" class="btn small" id="logout">Log out</button></div></div>
    <nav class="tabs" aria-label="Admin sections">${TABS.map(([k, l]) => markup`<a href="/admin${k ? "/" + k : ""}" ${sub === k ? raw('aria-current="page"') : ""}>${l}</a>`)}</nav>
    <div id="admin-body"><p class="muted">Loading…</p></div>`);
  $("#logout").addEventListener("click", async () => {
    stopPolling();
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    session.user = null; session.csrf = null;
    navigate("/");
  });
  const body = $("#admin-body");
  try {
    if (sub === "repos") return await reposView(body);
    if (sub === "collection") return await collectionView(body);
    if (sub === "settings") return await settingsView(body);
    if (sub === "appearance") return await appearanceView(body);
    const dash = new Dashboard(body, { editable: true, slug });
    await dash.load();
    dash.render();
    return dash;
  } catch (e) {
    setHTML(body, markup`<p class="error-text">${e.message}</p>`);
  }
}

/* -------------------------------------------------- waiting for collection */
let pollTimer = null;
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
function waitForCollection(onDone, label = "Collecting from GitHub…") {
  clearTimeout(pollTimer);
  const banner = $("#collect-status");
  if (banner) { banner.hidden = false; setHTML(banner, markup`<span class="spinner"></span> ${label}`); }
  const tick = async () => {
    try {
      const r = await api("/api/admin/runs");
      if (r.busy) { pollTimer = setTimeout(tick, 1500); return; }
      if (banner) banner.hidden = true;
      const last = r.runs[0];
      if (last) {
        if (last.status === "ok") toast(`Collected ${last.repos_ok} ${last.repos_ok === 1 ? "repository" : "repositories"}`);
        else toast(last.message ? last.message.split("\n")[0] : `Collection ${last.status}`, "error");
      }
      onDone && onDone(r);
    } catch (ex) {
      // logged out or no longer allowed: stop instead of asking forever
      if (ex.status === 401 || ex.status === 403 || !session.user) { if (banner) banner.hidden = true; pollTimer = null; return; }
      pollTimer = setTimeout(tick, 3000);
    }
  };
  pollTimer = setTimeout(tick, 800);
}

/* ------------------------------------------------------- repositories */
async function reposView(body) {
  let repos = [];
  const pal = palette();
  setHTML(body, markup`
    <section class="panel" aria-labelledby="add-h">
      <h2 id="add-h">Add repositories</h2>
      <p class="lead">Paste one or more repositories as <strong>owner/name</strong> or GitHub links. Their release downloads are collected right away and then once a day.</p>
      <form id="add-form" class="stack" novalidate>
        <label class="field"><span class="sr-only">Repositories</span>
          <textarea class="input" name="repos" rows="3" placeholder="octocat/Hello-World&#10;https://github.com/owner/another-repo"></textarea></label>
        <details><summary class="muted" style="cursor:pointer">Count only some files</summary>
          <label class="field" style="margin-top:10px"><span>Files to count <span class="hint">for example <code>*.zip</code> or <code>!module.json</code> to leave one out. Empty counts every file in a release.</span></span>
          <input class="input" name="asset_filter" placeholder="*.zip" maxlength="200"></label></details>
        <div class="row"><button class="btn primary" type="submit">${icon("plus")} Add and collect</button>
          <button class="btn" type="button" id="discover-btn">Browse a user or organisation</button></div>
        <p class="error-text" id="add-error" role="alert" hidden style="white-space:pre-line"></p>
      </form>
    </section>
    <p class="callout info" id="collect-status" hidden style="margin-top:16px"></p>
    <section class="panel" aria-labelledby="list-h">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px">
        <h2 id="list-h">Tracked repositories</h2>
        <button class="btn small" type="button" id="collect-all">${icon("refresh")} Collect all now</button></div>
      <p class="lead" style="margin-bottom:6px">Drag to change the order used on the dashboard. History starts on the day a repository is added: GitHub only reports running totals, not past days.</p>
      <ul class="repo-list" id="repo-list"></ul>
    </section>`);

  const list = $("#repo-list");
  const load = async () => {
    const r = await api("/api/admin/repos");
    repos = r.repos;
    draw();
    return r;
  };
  const draw = () => {
    const colors = colorsFor(repos, pal);
    if (!repos.length) { setHTML(list, markup`<li class="empty">Nothing tracked yet. Add a repository above to start.</li>`); return; }
    setHTML(list, markup`${repos.map((r) => markup`<li class="repo-item" data-id="${r.id}">
      <button type="button" class="handle" title="Drag to reorder" aria-label="Reorder ${r.full_name}. Use arrow keys up and down.">${icon("grip")}</button>
      <span class="swatch" style="background:${colors.get(r.id)}" aria-hidden="true"></span>
      <div class="repo-main">
        <div class="name">${r.label} ${r.label !== r.name ? markup`<span class="muted" style="font-weight:400">${r.full_name}</span>` : ""}
          ${!r.enabled ? markup`<span class="tag">paused</span>` : ""} ${r.hidden ? markup`<span class="tag">hidden</span>` : ""} ${r.own_layout ? markup`<span class="tag">own page layout</span>` : ""}</div>
        <div class="meta">
          <span>${r.downloads == null ? "no data yet" : fmt(r.downloads) + " downloads"}</span>
          <span>${fmt(r.stars ?? 0)} stars</span>
          <span>${r.days} ${r.days === 1 ? "day" : "days"} of history</span>
          ${r.asset_filter ? markup`<span>counting ${r.asset_filter}</span>` : ""}
          <span>${r.last_collected ? "collected " + timeAgo(r.last_collected) : "not collected yet"}</span>
          ${safeUrl(r.url) ? markup`<a href="${safeUrl(r.url)}" target="_blank" rel="noopener">GitHub</a>` : ""}
        </div>
        ${r.last_error ? markup`<div class="error-text" style="font-size:13.5px;margin-top:3px">${r.last_error}</div>` : ""}
      </div>
      <div class="repo-actions">
        <a class="btn small ghost" href="${repoHref({ base: "/admin" }, r)}">Page</a>
        <button type="button" class="btn small" data-a="edit" aria-expanded="false">${icon("edit")} Edit</button>
        <button type="button" class="btn small ghost" data-a="collect" title="Collect this repository now" aria-label="Collect ${r.full_name} now">${icon("refresh")}</button>
        <button type="button" class="btn small ghost danger" data-a="delete" title="Remove" aria-label="Remove ${r.full_name}">${icon("trash")}</button>
      </div>
    </li>`)}`);
  };

  const editPanel = (r) => markup`<div class="repo-edit">
    <label class="field"><span>Name on the dashboard</span><input class="input" data-f="label" value="${r.label_custom}" placeholder="${r.name}" maxlength="80"></label>
    <div class="field"><span>Colour</span><div class="row" style="align-items:center;gap:8px">
      <input type="color" data-f="color" value="${r.color_custom || colorsFor([r], palette()).get(r.id)}" style="width:44px;height:36px;border:1px solid var(--line-strong);border-radius:8px;background:var(--panel);padding:2px">
      <label class="check"><input type="checkbox" data-f="auto" ${r.color_custom ? "" : "checked"}> Automatic</label></div></div>
    <label class="field"><span>Files to count <span class="hint">e.g. <code>*.zip</code>, empty = all</span></span><input class="input" data-f="asset_filter" value="${r.asset_filter}" placeholder="all files" maxlength="200"></label>
    <div class="field"><span>Options</span>
      <label class="switch"><input type="checkbox" data-f="enabled" ${r.enabled ? "checked" : ""}><span class="track"></span>Collect every day</label>
      <label class="switch"><input type="checkbox" data-f="visible" ${r.hidden ? "" : "checked"}><span class="track"></span>Show on the public dashboard</label></div>
    <div class="row" style="grid-column:1/-1"><button type="button" class="btn small primary" data-a="save">Save changes</button><button type="button" class="btn small ghost" data-a="cancel">Cancel</button></div>
  </div>`;

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-a]");
    if (!btn) return;
    const item = btn.closest(".repo-item");
    const r = repos.find((x) => x.id === Number(item.dataset.id));
    const a = btn.dataset.a;
    if (a === "edit") {
      const open = item.querySelector(".repo-edit");
      if (open) { open.remove(); btn.setAttribute("aria-expanded", "false"); return; }
      item.insertAdjacentHTML("beforeend", editPanel(r).__raw);
      btn.setAttribute("aria-expanded", "true");
      $("[data-f=label]", item).focus();
      $("[data-f=color]", item).addEventListener("input", () => { $("[data-f=auto]", item).checked = false; });
    }
    if (a === "cancel") { item.querySelector(".repo-edit").remove(); item.querySelector("[data-a=edit]").setAttribute("aria-expanded", "false"); }
    if (a === "save") {
      const g = (k) => $(`[data-f=${k}]`, item);
      try {
        const res = await api(`/api/admin/repos/${r.id}`, { method: "PATCH", body: {
          label: g("label").value, color: g("auto").checked ? "" : g("color").value, asset_filter: g("asset_filter").value,
          enabled: g("enabled").checked, hidden: !g("visible").checked } });
        Object.assign(r, res.repo); draw(); toast("Saved");
      } catch (ex) { toast(ex.message, "error"); }
    }
    if (a === "collect") {
      try { await api("/api/admin/collect", { method: "POST", body: { repo_ids: [r.id] } }); waitForCollection(load, `Collecting ${r.full_name}…`); }
      catch (ex) { toast(ex.message, "error"); }
    }
    if (a === "delete") {
      if (!(await confirmDialog(`Remove ${r.full_name}?`, "Its whole download history is deleted from RepoPulse. To keep the history but stop collecting, use Edit and turn off Collect every day instead.", "Remove repository", true))) return;
      try { await api(`/api/admin/repos/${r.id}`, { method: "DELETE" }); repos = repos.filter((x) => x !== r); draw(); toast(`Removed ${r.full_name}`); }
      catch (ex) { toast(ex.message, "error"); }
    }
  });

  // reordering: drag with the handle, or arrow keys on the handle
  let dragId = null;
  const saveOrder = () => api("/api/admin/repos/order", { method: "POST", body: { ids: repos.map((r) => r.id) } }).catch((ex) => toast(ex.message, "error"));
  list.addEventListener("pointerdown", (e) => { const h = e.target.closest(".handle"); if (h) h.closest(".repo-item").draggable = true; });
  list.addEventListener("dragstart", (e) => { const it = e.target.closest(".repo-item"); dragId = Number(it.dataset.id); it.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(dragId)); });
  list.addEventListener("dragover", (e) => { e.preventDefault(); $$(".drop-before", list).forEach((x) => x.classList.remove("drop-before")); e.target.closest(".repo-item")?.classList.add("drop-before"); });
  list.addEventListener("dragend", () => { $$(".repo-item", list).forEach((x) => { x.draggable = false; x.classList.remove("dragging", "drop-before"); }); });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const target = e.target.closest(".repo-item");
    if (!target || dragId == null) return;
    const from = repos.findIndex((r) => r.id === dragId);
    const [moved] = repos.splice(from, 1);
    const to = repos.findIndex((r) => r.id === Number(target.dataset.id));
    repos.splice(to < 0 ? repos.length : to, 0, moved);
    draw(); saveOrder();
  });
  list.addEventListener("keydown", (e) => {
    const h = e.target.closest(".handle");
    if (!h || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const id = Number(h.closest(".repo-item").dataset.id);
    const i = repos.findIndex((r) => r.id === id), j = i + (e.key === "ArrowUp" ? -1 : 1);
    if (j < 0 || j >= repos.length) return;
    [repos[i], repos[j]] = [repos[j], repos[i]];
    draw(); saveOrder();
    $(`.repo-item[data-id="${id}"] .handle`, list).focus();
  });

  $("#add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, err = $("#add-error"), btn = $("button[type=submit]", f);
    err.hidden = true;
    const entries = f.repos.value.split(/[\s,]+/).filter(Boolean);
    if (!entries.length) { err.textContent = "Enter at least one repository, like octocat/Hello-World."; err.hidden = false; f.repos.focus(); return; }
    btn.disabled = true;
    try {
      const res = await api("/api/admin/repos", { method: "POST", body: { repos: entries, asset_filter: f.asset_filter.value } }).catch((ex) => ({ added: [], errors: [ex.message] }));
      if (res.errors?.length) { err.textContent = res.errors.join("\n"); err.hidden = false; }
      if (res.added?.length) {
        f.repos.value = res.errors?.length ? f.repos.value : "";
        toast(`Added ${res.added.length} ${res.added.length === 1 ? "repository" : "repositories"}`);
        await load();
        waitForCollection(load);
      }
    } finally { btn.disabled = false; }
  });

  $("#collect-all").addEventListener("click", async () => {
    try { await api("/api/admin/collect", { method: "POST", body: {} }); waitForCollection(load); }
    catch (ex) { toast(ex.message, "error"); }
  });

  $("#discover-btn").addEventListener("click", () => discoverDialog(async (picked) => {
    const res = await api("/api/admin/repos", { method: "POST", body: { repos: picked, asset_filter: $("#add-form").asset_filter.value } });
    toast(`Added ${res.added.length} ${res.added.length === 1 ? "repository" : "repositories"}`);
    if (res.errors.length) toast(res.errors[0], "error");
    await load(); waitForCollection(load);
  }));

  const r = await load();
  if (r.busy) waitForCollection(load);
}

function discoverDialog(onAdd) {
  let found = [];
  return dialog({
    title: "Browse a user or organisation",
    body: markup`<form id="disc-form" class="row" novalidate style="margin-bottom:12px">
        <label class="field grow"><span>GitHub user or organisation</span><input class="input" name="owner" placeholder="octocat" autocomplete="off"></label>
        <button class="btn" type="submit">Look up</button></form>
      <div id="disc-result" class="muted">Public repositories are listed, most recently updated first.</div>`,
    buttons: [{ label: "Cancel", value: false, cls: "ghost" }, { label: "Add selected", cls: "primary", value: async (root) => {
      const picked = $$("#disc-result input:checked", root).map((x) => x.value);
      if (!picked.length) { toast("Select at least one repository", "error"); return false; }
      try { await onAdd(picked); return true; } catch (ex) { toast(ex.message, "error"); return false; }
    } }],
    onOpen: (root) => {
      $("#disc-form", root).addEventListener("submit", async (e) => {
        e.preventDefault();
        const out = $("#disc-result", root);
        setHTML(out, markup`<span class="spinner"></span> Looking up…`);
        try {
          found = (await api("/api/admin/discover", { method: "POST", body: { owner: e.target.owner.value } })).repos;
          if (!found.length) { setHTML(out, markup`No public repositories found.`); return; }
          setHTML(out, markup`<label class="check" style="margin-bottom:8px"><input type="checkbox" id="disc-all"> Select all except forks and archived repositories</label>
            <div class="discover-list">${found.map((r) => markup`<label><input type="checkbox" value="${r.full_name}" ${r.tracked ? "disabled checked" : ""} data-plain="${!r.fork && !r.archived}">
              <span><strong>${r.full_name.split("/")[1]}</strong>${r.description ? markup`<small>${r.description}</small>` : ""}</span>
              <span class="muted" style="font-size:13px;white-space:nowrap">${r.tracked ? "tracked" : r.fork ? "fork" : r.archived ? "archived" : fmt(r.stars) + " ★"}</span></label>`)}</div>`);
          $("#disc-all", root).addEventListener("change", (ev) => $$('.discover-list input:not(:disabled)[data-plain="true"]', root).forEach((x) => { x.checked = ev.target.checked; }));
        } catch (ex) { setHTML(out, markup`<span class="error-text">${ex.message}</span>`); }
      });
    },
  });
}

/* --------------------------------------------------------- collection */
async function collectionView(body) {
  const draw = (r) => {
    const last = r.runs[0];
    setHTML(body, markup`
      <section class="panel">
        <div class="cols-2">
          <div><h2>Next automatic collection</h2><p class="lead" style="margin:4px 0 0;font-size:18px">${fmtDateTime(r.next_run)}</p>
            <p class="muted" style="margin:4px 0 0">Change the time under Settings. If the server is off at that time, it collects as soon as it starts again.</p></div>
          <div><h2>Last collection</h2><p class="lead" style="margin:4px 0 0;font-size:18px">${last ? fmtDateTime(last.started_at) : "Not run yet"}</p>
            ${last ? markup`<p style="margin:4px 0 0">${statusTag(last.status)} <span class="muted">${last.repos_ok} collected, ${last.repos_failed} failed</span></p>` : ""}</div>
        </div>
        <div class="row" style="margin-top:16px"><button class="btn primary" id="run-now" ${r.busy ? "disabled" : ""}>${icon("refresh")} Collect all now</button></div>
      </section>
      <p class="callout info" id="collect-status" ${r.busy ? "" : "hidden"} style="margin-top:16px">${r.busy ? markup`<span class="spinner"></span> Collecting from GitHub…` : ""}</p>
      <section class="panel"><h2>History</h2><p class="lead">The last 50 collections.</p>
        ${r.runs.length ? markup`<div class="table-wrap"><table class="data"><thead><tr><th>Started</th><th>Started by</th><th>Result</th><th class="r">Collected</th><th class="r">Failed</th><th class="r">Took</th><th>Details</th></tr></thead>
        <tbody>${r.runs.map((x) => markup`<tr><td>${fmtDateTime(x.started_at)}</td><td>${x.trigger}</td><td>${statusTag(x.status)}</td>
          <td class="r">${x.repos_ok}</td><td class="r">${x.repos_failed}</td><td class="r">${x.finished_at ? Math.max(0, Math.round((new Date(x.finished_at) - new Date(x.started_at)) / 1000)) + " s" : "–"}</td>
          <td style="max-width:420px;white-space:pre-line;font-size:13.5px" class="muted">${x.message || ""}</td></tr>`)}</tbody></table></div>` : markup`<p class="empty">Nothing collected yet.</p>`}
      </section>`);
    $("#run-now").addEventListener("click", async () => {
      try { await api("/api/admin/collect", { method: "POST", body: {} }); $("#run-now").disabled = true; waitForCollection(reload); }
      catch (ex) { toast(ex.message, "error"); }
    });
  };
  const reload = async () => { const r = await api("/api/admin/runs"); draw(r); if (r.busy) waitForCollection(reload); };
  await reload();
}

function statusTag(s) {
  const map = { ok: ["ok", "Succeeded"], partial: ["warn", "Partly failed"], failed: ["err", "Failed"], running: ["", "Running"] };
  const [cls, label] = map[s] || ["", s];
  return markup`<span class="tag ${cls}">${label}</span>`;
}

/* ------------------------------------------------------------ updates */
const OUTCOME = { updated: ["ok", "Updated"], "rolled-back": ["warn", "Rolled back"], failed: ["err", "Failed"] };

async function updatesPanel(box) {
  let u;
  try { u = await api("/api/admin/update"); } catch (e) { setHTML(box, markup`<h2>Updates</h2><p class="error-text">${e.message}</p>`); return; }
  const linux = u.setup.platform === "linux", windows = u.setup.platform === "windows";
  const how = linux ? markup`<code>sudo ./install.sh --enable-auto-update</code>` : windows ? markup`<code>.\install.ps1 -EnableAutoUpdate</code> (as administrator)` : "";
  const last = u.last;
  setHTML(box, markup`<h2>Updates</h2>
    <p class="lead">RepoPulse ${u.installed}. ${u.setup.daily
      ? "Automatic updates are on: once a day RepoPulse checks for a new release and installs it, and goes back to the previous version if the new one does not start."
      : markup`Automatic updates are off.${how ? markup` Turn them on in the installation folder with ${how}.` : ""}`}</p>
    ${last ? markup`<p style="margin:0 0 12px">Last update: ${statusTagFor(last.outcome)} ${last.from && last.to ? `${last.from} → ${last.to}` : last.to || last.from || ""}
      <span class="muted">${last.at ? fmtDateTime(last.at) : ""}${last.emailed ? `, e-mailed to ${last.emailed}` : last.email_error ? `, e-mail not sent: ${last.email_error}` : ""}</span></p>
      ${last.message && last.outcome !== "updated" ? markup`<details style="margin:0 0 12px"><summary>Details</summary><pre class="log-box">${last.message}</pre></details>` : ""}` : ""}
    ${u.last_check ? markup`<p class="muted" style="margin:0 0 12px;font-size:13.5px">Last automatic check: ${fmtDateTime(u.last_check.at)}</p>` : ""}
    <div class="row" style="align-items:center"><button type="button" class="btn" id="upd-check">${icon("refresh")} Check for update</button>
      <span id="upd-result" aria-live="polite"></span></div>`);
  $("#upd-check", box).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const out = $("#upd-result", box);
    btn.disabled = true;
    setHTML(out, markup`<span class="spinner"></span>`);
    try {
      const r = await api("/api/admin/update/check", { method: "POST", body: { force: true } });
      if (r.error) { setHTML(out, markup`<span class="error-text">${r.error}</span>`); return; }
      if (!r.newer) { setHTML(out, markup`<span class="muted">Up to date (latest release: ${r.latest || "none"}).</span>`); return; }
      setHTML(out, markup`<span><strong>RepoPulse ${r.latest}</strong> is available.${safeUrl(r.url) ? markup` <a href="${safeUrl(r.url)}" target="_blank" rel="noopener">What's new</a>` : ""}</span>
        ${u.setup.now ? markup`<button type="button" class="btn small primary" id="upd-now">Update now</button>`
          : markup`<span class="muted">${how ? markup`Install it with ${linux ? markup`<code>sudo ./install.sh --update-now</code>` : markup`<code>.\install.ps1 -UpdateNow</code>`} after turning automatic updates on, or ` : ""}download it from the release page.</span>`}`);
      $("#upd-now", out)?.addEventListener("click", () => updateNow(r.latest, u));
    } catch (ex) { setHTML(out, markup`<span class="error-text">${ex.message}</span>`); }
    finally { btn.disabled = false; }
  });
}

function statusTagFor(outcome) {
  const [cls, label] = OUTCOME[outcome] || ["", outcome];
  return markup`<span class="tag ${cls}">${label}</span>`;
}

async function updateNow(version, before) {
  if (!(await confirmDialog(`Update to ${version}?`, "RepoPulse downloads the release, checks it and restarts with it, which takes a minute or two. If the new version does not start, the current one is put back.", "Update now"))) return;
  try { await api("/api/admin/update/now", { method: "POST" }); }
  catch (e) { toast(e.message, "error"); return; }
  toast("Updating. This page reloads when RepoPulse is back.");
  const lastAt = before.last?.at || "";
  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > 8 * 60 * 1000) { toast("The update is taking long. Check the log on the server.", "error"); return; }
    try {
      const site = await api("/api/site");
      if (site.version !== before.installed) { location.reload(); return; }
      const u = await api("/api/admin/update");
      if (u.last && u.last.at !== lastAt && u.last.outcome !== "updated") {
        toast(u.last.outcome === "rolled-back" ? "The new version did not start; the current one is running again." : "The update failed. See Updates for details.", "error");
        updatesPanel($("#p-updates"));
        return;
      }
    } catch { /* restarting */ }
    setTimeout(poll, 4000);
  };
  setTimeout(poll, 5000);
}

async function notifyForm(form) {
  let n;
  try { n = await api("/api/admin/notify"); } catch (e) { setHTML(form, markup`<p class="error-text">${e.message}</p>`); return; }
  setHTML(form, markup`
    <label class="field"><span>E-mail addresses <span class="hint">comma separated, up to 10</span></span>
      <input class="input" name="recipients" value="${n.recipients.join(", ")}" placeholder="you@example.com" autocomplete="email"></label>
    <div class="cols-2">
      <label class="field"><span>Mail server <span class="hint">for Gmail: smtp.gmail.com with an app password</span></span><input class="input" name="host" value="${n.host}" placeholder="smtp.example.com"></label>
      <div class="row"><label class="field grow"><span>Security</span><select class="input" name="security">
          ${[["starttls", "STARTTLS (port 587)"], ["tls", "TLS (port 465)"], ["none", "None (local relay, no login)"]].map(([v, l]) => markup`<option value="${v}" ${n.security === v ? "selected" : ""}>${l}</option>`)}</select></label>
        <label class="field" style="width:110px"><span>Port</span><input class="input" name="port" inputmode="numeric" value="${n.port}"></label></div>
      <label class="field"><span>User name <span class="hint">empty = no login</span></span><input class="input" name="user" value="${n.user}" autocomplete="off"></label>
      <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="new-password" placeholder="${n.password_set ? "Saved. Type to replace." : ""}"></label>
      <label class="field"><span>Sender <span class="hint">empty = the user name</span></span><input class="input" name="sender" value="${n.sender}" placeholder="repopulse@example.com"></label>
    </div>
    <div class="row"><button class="btn primary" type="submit">Save notifications</button>
      <button class="btn" type="button" id="n-test">Send test e-mail</button>
      ${n.password_set ? markup`<button class="btn danger" type="button" id="n-clear">Remove password</button>` : ""}</div>`);
  const ports = { starttls: 587, tls: 465, none: 25 };
  form.security.addEventListener("change", () => { if (Object.values(ports).includes(Number(form.port.value))) form.port.value = ports[form.security.value]; });
  const values = () => ({ recipients: form.recipients.value, host: form.host.value, security: form.security.value, port: form.port.value,
    user: form.user.value, password: form.password.value, sender: form.sender.value });
  const save = async (extra = {}) => {
    try { await api("/api/admin/notify", { method: "PUT", body: { ...values(), ...extra } }); return true; }
    catch (e) { toast(e.message, "error"); return false; }
  };
  form.addEventListener("submit", async (e) => { e.preventDefault(); if (await save()) { toast("Notifications saved"); notifyForm(form); } });
  $("#n-clear", form)?.addEventListener("click", async () => { if (await save({ password: "", clear_password: true })) { toast("Password removed"); notifyForm(form); } });
  $("#n-test", form).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      if (!(await save())) return;
      const r = await api("/api/admin/notify/test", { method: "POST" });
      toast(`Test e-mail sent to ${r.sent} ${r.sent === 1 ? "address" : "addresses"}`);
      notifyForm(form);
    } catch (ex) { toast(ex.message, "error"); }
    finally { btn.disabled = false; }
  });
}

/* --------------------------------------------------------- appearance */
// Ready-made combinations; options not named keep their default. The visitor
// options (range, buttons, animations) are never changed by a preset.
const PRESETS = [
  ["default", "RepoPulse", {}],
  ["midnight", "Midnight", { theme: "dark", surface: "cool", background: "glow", cards: "shadow", palette: "ocean", headline: "gradient", accent: "#3d8bfd" }],
  ["paper", "Paper", { theme: "light", surface: "warm", font: "serif", cards: "flat", radius: "sharp", palette: "forest", titles: "caps", accent: "#8a5a2b" }],
  ["neon", "Neon", { theme: "dark", surface: "contrast", palette: "vivid", headline: "accent", accent: "#ff3d71", background: "grid", radius: "soft" }],
  ["minimal", "Minimal", { surface: "contrast", cards: "outline", palette: "grey", titles: "caps", density: "compact", radius: "sharp", accent: "#171a20" }],
  ["soft", "Soft", { palette: "pastel", radius: "round", cards: "shadow", surface: "tinted", headline: "tint", background: "gradient", font: "rounded", accent: "#6250d6" }],
  ["terminal", "Terminal", { theme: "dark", font: "mono", palette: "forest", accent: "#1baf7a", cards: "outline", radius: "sharp", background: "dots", titles: "caps" }],
];
const VISITOR_KEYS = ["default_range", "rangebar", "csv", "motion", "brand", "subtitle"];

async function appearanceView(body) {
  let saved = { ...appearance() };
  let draft = { ...saved };
  let preview = null;
  const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved);
  const apply = () => {
    setAppearance(draft, { remember: false });
    window.dispatchEvent(new CustomEvent("repopulse:theme"));
    const bar = $("#look-bar", body);
    if (bar) bar.hidden = !dirty();
  };
  const accentNow = () => draft.accent || getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2a78d6";

  const draw = () => {
    setHTML(body, markup`
      <section class="panel"><h2>Appearance</h2>
        <p class="lead">How the dashboard looks for everyone. Changes show at once on this page and in the preview below; visitors see them after you save.</p>
        <div class="field"><span>Start from a preset</span><div class="preset-row" role="group" aria-label="Presets">
          ${PRESETS.map(([k, label]) => markup`<button type="button" class="btn small" data-preset="${k}">${label}</button>`)}</div></div>
      </section>
      ${SECTIONS.map(([title, opts], si) => markup`<section class="panel"><h2>${title}</h2>
        <div class="look-grid">
          ${si === 0 ? markup`<div class="field"><span>Accent colour <span class="hint">buttons, links, the headline pulse</span></span>
            <div class="accent-row">
              <button type="button" class="swatch-btn builtin" data-accent="" aria-pressed="${String(!draft.accent)}" title="Built-in blue" aria-label="Built-in blue"></button>
              ${ACCENTS.map((c) => markup`<button type="button" class="swatch-btn" data-accent="${c}" style="background:${c}" aria-pressed="${String(draft.accent === c)}" title="${c}" aria-label="Accent ${c}"></button>`)}
              <label class="swatch-custom" title="Any colour"><span class="sr-only">Any accent colour</span><input type="color" id="look-accent" value="${accentNow()}"></label>
            </div></div>` : ""}
          ${opts.map(([k, label, hint, choices]) => markup`<label class="field" for="look-${k}"><span>${label}${hint ? markup` <span class="hint">${hint}</span>` : ""}</span>
            <select class="input" id="look-${k}" data-look="${k}">${choices.map(([v, l]) => markup`<option value="${v}" ${draft[k] === v ? "selected" : ""}>${l}</option>`)}</select></label>`)}
        </div></section>`)}
      <section class="panel"><h2>Preview</h2><p class="lead">The first widgets of the dashboard, as visitors see them.</p>
        <div id="look-preview" class="look-preview"><p class="muted">Loading…</p></div></section>
      <div class="look-bar" id="look-bar" ${dirty() ? "" : raw("hidden")} role="region" aria-label="Unsaved appearance">
        <span><strong>Unsaved changes.</strong> <span class="muted">Visitors still see the saved look.</span></span>
        <span class="row"><button type="button" class="btn small ghost" data-look-act="defaults">Built-in look</button>
          <button type="button" class="btn small" data-look-act="discard">Discard</button>
          <button type="button" class="btn small primary" data-look-act="save">Save appearance</button></span>
      </div>`);

    $$("[data-look]", body).forEach((el) => el.addEventListener("change", () => { draft[el.dataset.look] = el.value; apply(); }));
    $$("[data-accent]", body).forEach((b) => b.addEventListener("click", () => {
      draft.accent = b.dataset.accent;
      $$("[data-accent]", body).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      apply();
      $("#look-accent", body).value = accentNow();
    }));
    $("#look-accent", body).addEventListener("input", (e) => {
      draft.accent = e.target.value.toLowerCase();
      $$("[data-accent]", body).forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.accent === draft.accent)));
      apply();
    });
    $$("[data-preset]", body).forEach((b) => b.addEventListener("click", () => {
      const [, , values] = PRESETS.find(([k]) => k === b.dataset.preset);
      const keep = Object.fromEntries(VISITOR_KEYS.map((k) => [k, draft[k]]));
      draft = { ...DEFAULTS, ...values, ...keep };
      apply(); redraw(`[data-preset="${b.dataset.preset}"]`);
    }));
    $$("[data-look-act]", body).forEach((b) => b.addEventListener("click", async () => {
      const act = b.dataset.lookAct;
      if (act === "defaults") { draft = { ...DEFAULTS }; apply(); redraw(); return; }
      if (act === "discard") { draft = { ...saved }; apply(); redraw(); return; }
      try {
        const res = await api("/api/admin/appearance", { method: "PUT", body: { appearance: draft } });
        saved = { ...res.appearance }; draft = { ...saved };
        setAppearance(saved);
        window.dispatchEvent(new CustomEvent("repopulse:theme"));
        $("#look-bar", body).hidden = true;
        toast("Appearance saved");
      } catch (ex) { toast(ex.message, "error"); }
    }));
    showPreview();
  };
  const redraw = (focusSel) => {
    const y = window.scrollY;
    preview?.destroy(); preview = null;
    draw();
    window.scrollTo({ top: y });
    if (focusSel) $(focusSel, body)?.focus();
  };
  const showPreview = async () => {
    const box = $("#look-preview", body);
    const dash = new Dashboard(box, {});
    preview = dash;
    try {
      await dash.load();
      if (preview !== dash) return;
      dash.layout = { widgets: dash.layout.widgets.slice(0, 6) };
      dash.render();
    } catch (e) { setHTML(box, markup`<p class="error-text">${e.message}</p>`); }
  };
  draw();
  return {
    destroy() {
      preview?.destroy();
      if (dirty()) { setAppearance(saved); toast("Unsaved appearance changes were discarded"); }
    },
  };
}

/* ----------------------------------------------------------- settings */
async function settingsView(body) {
  const s = await api("/api/admin/settings");
  setHTML(body, markup`
    <section class="panel"><h2>Dashboard</h2><p class="lead">What visitors see at the top of the page.</p>
      <form id="f-site" class="stack" novalidate>
        <div class="cols-2"><label class="field"><span>Title</span><input class="input" name="site_title" value="${s.site_title}" maxlength="80"></label>
        <label class="field"><span>Subtitle</span><input class="input" name="site_subtitle" value="${s.site_subtitle}" maxlength="200"></label></div>
        <label class="switch"><input type="checkbox" name="public_dashboard" ${s.public_dashboard ? "checked" : ""}><span class="track"></span>Anyone can view the dashboard without logging in</label>
        <div><button class="btn primary" type="submit">Save dashboard settings</button></div>
      </form></section>

    <section class="panel"><h2>Daily collection</h2><p class="lead">RepoPulse asks GitHub for the download numbers once a day.</p>
      <form id="f-collect" class="stack" novalidate>
        <div class="cols-2">
          <label class="field"><span>Time of day <span class="hint">server time (${s.timezone})</span></span><input class="input" type="time" name="collection_time" value="${s.collection_time}" required style="max-width:180px"></label>
          <label class="field"><span>GitHub token <span class="hint">optional. Raises the limit from 60 to 5,000 requests an hour and allows private repositories.</span></span>
            <input class="input" type="password" name="github_token" autocomplete="off" placeholder="${s.github_token_set ? "Saved (ends in " + s.github_token_hint + "). Type to replace." : "github_pat_…"}"></label>
        </div>
        <p class="muted" id="rate-line" style="margin:0">Checking the GitHub API limit…</p>
        <p class="muted" style="margin:0;font-size:13.5px">A fine-grained token with read-only access to public repositories is enough. Create one on GitHub under Settings, Developer settings, Personal access tokens.</p>
        <div class="row"><button class="btn primary" type="submit">Save collection settings</button>
          ${s.github_token_set ? markup`<button class="btn danger" type="button" id="rm-token">Remove token</button>` : ""}</div>
      </form></section>

    <section class="panel" id="p-updates"><h2>Updates</h2><p class="lead">Loading…</p></section>

    <section class="panel"><h2>Notifications</h2>
      <p class="lead">E-mails when RepoPulse installs an update or an automatic update fails. No addresses, no e-mails.</p>
      <form id="f-notify" class="stack" novalidate><p class="muted">Loading…</p></form></section>

    <div class="cols-2" style="margin-top:16px">
      <section class="panel" style="margin:0"><h2>Password</h2><p class="lead">For the account ${s.user}.</p>
        <form id="f-pass" class="stack" novalidate>
          <input type="text" name="username" value="${s.user}" autocomplete="username" hidden>
          <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label class="field"><span>New password <span class="hint">at least 8 characters</span></span><input class="input" type="password" name="new" autocomplete="new-password" required minlength="8"></label>
          <div><button class="btn primary" type="submit">Change password</button></div>
        </form></section>
      <section class="panel" style="margin:0"><h2>Your data</h2><p class="lead">Everything is stored in one file on the server. Back it up to keep the history safe.</p>
        <p style="margin:0 0 14px;word-break:break-all"><code>${s.server.db}</code></p>
        <a class="btn" href="/api/export.csv" download>${icon("download")} Download all data as CSV</a>
        <p class="muted" style="margin:14px 0 0;font-size:13.5px">RepoPulse ${s.version}, listening on port ${s.server.port}.</p>
      </section>
    </div>`);

  updatesPanel($("#p-updates"));
  notifyForm($("#f-notify"));

  api("/api/admin/rate-limit").then((r) => {
    const line = $("#rate-line");
    if (!line) return;
    line.textContent = r.error ? `GitHub check failed: ${r.error}` :
      `GitHub API: ${fmt(r.remaining)} of ${fmt(r.limit)} requests left this hour${r.authenticated ? " (using your token)" : " (no token)"}.`;
  }).catch(() => {});

  const save = async (payload, msg) => {
    try { await api("/api/admin/settings", { method: "PUT", body: payload }); toast(msg); return true; }
    catch (ex) { toast(ex.message, "error"); return false; }
  };
  $("#f-site").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (await save({ site_title: f.site_title.value, site_subtitle: f.site_subtitle.value, public_dashboard: f.public_dashboard.checked }, "Dashboard settings saved")) {
      window.dispatchEvent(new CustomEvent("repopulse:site", { detail: { title: f.site_title.value, subtitle: f.site_subtitle.value, public: f.public_dashboard.checked } }));
    }
  });
  $("#f-collect").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const payload = { collection_time: f.collection_time.value };
    if (f.github_token.value.trim()) payload.github_token = f.github_token.value.trim();
    if (await save(payload, "Collection settings saved")) settingsView(body);
  });
  $("#rm-token")?.addEventListener("click", async () => {
    if (await confirmDialog("Remove the GitHub token?", "Collection falls back to 60 requests an hour, and private repositories can no longer be read.", "Remove token", true)) {
      if (await save({ github_token: "" }, "Token removed")) settingsView(body);
    }
  });
  $("#f-pass").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api("/api/admin/password", { method: "POST", body: { current: f.current.value, new: f.new.value } }); toast("Password changed"); f.reset(); }
    catch (ex) { toast(ex.message, "error"); }
  });
}
