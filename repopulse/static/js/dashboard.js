// The dashboard page (public), plus the layout editor used on the admin side.

import { ApiError, api } from "./api.js";
import { Model } from "./data.js";
import { $, $$, confirmDialog, frag, markup, icon, setHTML, store, toast, trapFocus, uid } from "./util.js";
import { appearance } from "./appearance.js";
import { SHARED_KEYS, TYPES, defaultLayout, defaultRepoLayout, renderWidget, repoHref, titleOf, typeOf, typesFor } from "./widgets.js";

const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "12 months"], [0, "All time"]];

export class Dashboard {
  /** slug = "owner/name" to show one repository's page instead of the overview. */
  constructor(root, { editable = false, slug = null } = {}) {
    this.root = root;
    this.editable = editable;
    this.slug = slug;
    this.base = editable ? "/admin" : "";
    this.editing = false;
    this.charts = [];
    // The admin picks the visitors' starting range (Admin, Appearance); with the
    // range switch hidden, visitors always see that range.
    const look = appearance();
    const fallback = Number(look.default_range);
    this.globalDays = look.rangebar === "hide" && !editable ? fallback : store.get("repopulse-range", fallback);
    this.onTheme = () => this.renderGrid();
    window.addEventListener("repopulse:theme", this.onTheme);
  }

  destroy() {
    window.removeEventListener("repopulse:theme", this.onTheme);
    this.charts.forEach((c) => c.destroy());
    this.charts = [];
  }

  async load() {
    const data = await api("/api/dashboard" + (this.editable ? "?all=1" : ""));
    this.model = new Model(data);
    const ok = (l) => l && Array.isArray(l.widgets);
    if (this.slug) {
      this.repo = this.model.find(this.slug);
      if (!this.repo) throw new ApiError(`There is no repository called ${this.slug} on this dashboard.`, 404);
      this.pageData = await api(`/api/repos/${this.repo.id}/page`);
      this.source = ok(this.pageData.layout) ? "own" : ok(this.pageData.shared_layout) ? "shared" : "starter";
      this.saved = this.source === "own" ? this.pageData.layout : this.source === "shared" ? this.pageData.shared_layout : defaultRepoLayout();
      document.title = `${this.repo.label}, ${$("#site-title")?.textContent || "RepoPulse"}`;
    } else {
      this.saved = ok(data.layout) ? data.layout : defaultLayout(this.model);
    }
    this.layout = structuredClone(this.saved);
  }

  ctx(extra = {}) {
    return {
      model: this.model, globalDays: this.globalDays, charts: this.charts, base: this.base, editable: this.editable,
      repo: this.repo || null, pageData: this.pageData || null, pageCache: (this.pageCache ||= new Map()),
      links: !this.editing, ...extra,
    };
  }

  starter() {
    return this.repo ? defaultRepoLayout() : defaultLayout(this.model);
  }

  async saveRepoLayout(scope) {
    const own = this.source === "own";
    const label = this.repo.label;
    if (scope === "all" && own && !(await confirmDialog("Save for all repositories?",
      `This becomes the layout of every repository page, and ${label} stops using its own layout.`, "Save for all"))) return;
    try {
      if (scope === "all") {
        await api("/api/admin/repo-layout", { method: "PUT", body: { layout: this.layout } });
        if (own) await api(`/api/admin/repos/${this.repo.id}/layout`, { method: "PUT", body: { layout: null } });
        const others = this.model.repos.filter((r) => r.own_layout && r.id !== this.repo.id).length;
        this.source = "shared"; this.repo.own_layout = false;
        toast(others ? `Saved for all repositories. ${others} with their own layout keep it.` : "Saved for all repositories");
      } else {
        await api(`/api/admin/repos/${this.repo.id}/layout`, { method: "PUT", body: { layout: this.layout } });
        this.source = "own"; this.repo.own_layout = true;
        toast(`Saved for ${label} only`);
      }
      this.saved = structuredClone(this.layout); this.editing = false; this.render();
    } catch (e) { toast(e.message, "error"); }
  }

  pageHeader() {
    if (!this.repo && this.editable && this.model.repos.length && !this.editing) {
      return markup`<nav class="repo-nav" aria-label="Pages"><span class="muted">This is the overview page. Repository pages have a layout of their own:</span>
        <label class="repo-switch"><span class="sr-only">Open a repository page</span>
          <select class="input" id="repo-switch"><option value="">Open a repository page…</option>${this.model.repos.map((r) => markup`<option value="${repoHref({ base: this.base }, r)}">${r.label}</option>`)}</select></label></nav>`;
    }
    if (!this.repo) return "";
    return markup`<nav class="repo-nav" aria-label="Repositories">
      <a href="${this.base || "/"}" class="back">← All repositories</a>
      <label class="repo-switch"><span class="sr-only">Show another repository</span>
        <select class="input" id="repo-switch">${this.model.repos.map((r) => markup`<option value="${repoHref({ base: this.base }, r)}" ${r.id === this.repo.id ? "selected" : ""}>${r.label}</option>`)}</select></label>
    </nav>`;
  }

  editIntro() {
    if (!this.repo) return markup`<strong>Editing the dashboard.</strong><span class="muted">Visitors see the changes after you save.</span>`;
    return this.source === "own"
      ? markup`<strong>Editing the page of ${this.repo.label}.</strong><span class="muted">It has its own layout; other repositories are not affected.</span>`
      : markup`<strong>Editing repository pages.</strong><span class="muted">Save for all repositories, or give ${this.repo.label} its own layout.</span>`;
  }

  editButtons() {
    if (!this.repo) return markup`
      <button type="button" class="btn small ghost" data-act="reset">Use the starter layout</button>
      <button type="button" class="btn small" data-act="discard">Discard changes</button>
      <button type="button" class="btn small primary" data-act="save">Save layout</button>`;
    const own = this.source === "own";
    return markup`
      <button type="button" class="btn small ghost" data-act="reset">Use the starter layout</button>
      ${own ? markup`<button type="button" class="btn small ghost" data-act="unown">Use the shared layout</button>` : ""}
      <button type="button" class="btn small" data-act="discard">Discard changes</button>
      <button type="button" class="btn small ${own ? "primary" : ""}" data-act="save-own">Save for ${this.repo.label} only</button>
      <button type="button" class="btn small ${own ? "" : "primary"}" data-act="save-all">Save for all repositories</button>`;
  }

  render() {
    setHTML(this.root, markup`${this.pageHeader()}
      <div class="toolbar ${this.editing ? "edit-bar" : ""} ${this.editable ? "" : "public"}" role="region" aria-label="Dashboard controls">
        <div class="left">
          ${this.editing ? this.editIntro() : markup`
          <span class="label range-picker" id="range-label">Range</span>
          <div class="seg range-picker" role="group" aria-labelledby="range-label">${RANGES.map(([d, l]) =>
            markup`<button type="button" data-days="${d}" aria-pressed="${String(d === this.globalDays)}">${l}</button>`)}</div>`}
        </div>
        <div class="right">
          ${this.editing ? this.editButtons() : markup`
            <a class="btn small ghost csv-link" href="/api/export.csv" download>${icon("download")} Download CSV</a>
            ${this.editable ? markup`<button type="button" class="btn small primary" data-act="edit">${icon("edit")} ${this.repo ? (this.source === "own" ? "Edit this page" : "Edit repository pages") : "Edit layout"}</button>` : ""}`}
        </div>
      </div>
      <div class="grid ${this.editing ? "editing" : ""}" id="widget-grid"></div>`);
    $$(".seg button", this.root).forEach((b) => b.addEventListener("click", () => {
      this.globalDays = Number(b.dataset.days);
      store.set("repopulse-range", this.globalDays);
      $$(".seg button", this.root).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      this.renderGrid();
    }));
    const act = (name, fn) => { const b = $(`[data-act="${name}"]`, this.root); if (b) b.addEventListener("click", fn); };
    $("#repo-switch", this.root)?.addEventListener("change", async (e) => {
      if (this.editing && JSON.stringify(this.layout) !== JSON.stringify(this.saved) &&
        !(await confirmDialog("Leave without saving?", "Your unsaved layout changes will be lost.", "Leave", true))) { e.target.value = this.repo ? repoHref({ base: this.base }, this.repo) : ""; return; }
      if (e.target.value) window.dispatchEvent(new CustomEvent("repopulse:navigate", { detail: e.target.value }));
    });
    act("save-own", () => this.saveRepoLayout("own"));
    act("save-all", () => this.saveRepoLayout("all"));
    act("unown", async () => {
      if (!(await confirmDialog("Use the shared layout?", `${this.repo.label}'s own layout is deleted and its page uses the layout all repositories share.`, "Use shared layout", true))) return;
      try {
        await api(`/api/admin/repos/${this.repo.id}/layout`, { method: "PUT", body: { layout: null } });
        this.repo.own_layout = false;
        this.source = this.pageData.shared_layout && Array.isArray(this.pageData.shared_layout.widgets) ? "shared" : "starter";
        this.saved = this.source === "shared" ? this.pageData.shared_layout : defaultRepoLayout();
        this.layout = structuredClone(this.saved); this.editing = false; this.render();
        toast(`${this.repo.label} uses the shared layout again`);
      } catch (e) { toast(e.message, "error"); }
    });
    act("edit", () => { this.editing = true; this.render(); });
    act("discard", async () => {
      if (JSON.stringify(this.layout) !== JSON.stringify(this.saved) && !(await confirmDialog("Discard changes?", "Your unsaved layout changes will be lost.", "Discard", true))) return;
      this.layout = structuredClone(this.saved); this.editing = false; this.render();
    });
    act("reset", async () => {
      if (!(await confirmDialog("Use the starter layout?", "This replaces the widgets on the dashboard with the starter set. Nothing is saved until you choose Save layout.", "Replace widgets"))) return;
      this.layout = this.starter(); this.renderGrid();
    });
    act("save", async () => {
      try {
        await api("/api/admin/layout", { method: "PUT", body: { layout: this.layout } });
        this.saved = structuredClone(this.layout); this.editing = false; this.render();
        toast("Layout saved");
      } catch (e) { toast(e.message, "error"); }
    });
    this.renderGrid();
  }

  renderGrid() {
    const grid = $("#widget-grid", this.root);
    if (!grid) return;
    this.charts.forEach((c) => c.destroy());
    this.charts.length = 0;
    grid.replaceChildren();
    if (!this.model.repos.length && !this.editing) {
      setHTML(grid, markup`<div class="widget w-full" style="grid-column:1/-1;text-align:center;padding:48px 20px">
        <h2 class="widget-title" style="font-size:22px">No repositories yet</h2>
        <p class="muted" style="margin:8px auto 18px;max-width:46ch">Statistics appear here once repositories are added and the first daily collection has run.</p>
        ${this.editable ? markup`<a class="btn primary" href="/admin/repos" data-nav>Add repositories</a>` : markup`<a class="btn" href="/admin">Log in to add repositories</a>`}</div>`);
      return;
    }
    const ctx = this.ctx({ tools: this.editing ? (slot, cfg) => this.addTools(slot, cfg) : null });
    for (const cfg of this.layout.widgets) grid.appendChild(renderWidget(cfg, ctx));
    if (this.editing) {
      const add = frag(markup`<button type="button" class="add-tile">${icon("plus")} Add a widget</button>`);
      add.querySelector("svg").setAttribute("style", "width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;vertical-align:-4px;margin-right:6px");
      add.addEventListener("click", async () => {
        const cfg = await openEditor(null, this);
        if (cfg) { this.layout.widgets.push(cfg); this.renderGrid(); $(`.slot[data-id="${cfg.id}"]`, this.root)?.scrollIntoView({ block: "center", behavior: "smooth" }); }
      });
      grid.appendChild(add);
    }
  }

  addTools(slot, cfg) {
    slot.style.position = "relative";
    const i = this.layout.widgets.findIndex((w) => w.id === cfg.id);
    const n = this.layout.widgets.length;
    const bar = frag(markup`<div class="edit-tools" role="toolbar" aria-label="Widget ${titleOf(cfg, this.ctx())}">
      <button type="button" class="icon-btn handle-btn" title="Drag to move" aria-hidden="true" tabindex="-1">${icon("grip")}</button>
      <button type="button" class="icon-btn" data-t="up" title="Move earlier" aria-label="Move earlier" ${i === 0 ? "disabled" : ""}>${icon("up")}</button>
      <button type="button" class="icon-btn" data-t="down" title="Move later" aria-label="Move later" ${i === n - 1 ? "disabled" : ""}>${icon("down")}</button>
      <button type="button" class="icon-btn" data-t="edit" title="Edit widget" aria-label="Edit widget">${icon("edit")}</button>
      <button type="button" class="icon-btn" data-t="copy" title="Duplicate widget" aria-label="Duplicate widget">${icon("copy")}</button>
      <button type="button" class="icon-btn" data-t="del" title="Remove widget" aria-label="Remove widget">${icon("trash")}</button>
    </div>`);
    slot.appendChild(bar);
    slot.appendChild(frag(markup`<span class="edit-label">${typeOf(cfg.type)?.label || String(cfg.type ?? "")}</span>`));
    const move = (to) => {
      const [w] = this.layout.widgets.splice(i, 1);
      this.layout.widgets.splice(to, 0, w);
      this.renderGrid();
      $(`.slot[data-id="${cfg.id}"] [data-t="${to < i ? "up" : "down"}"]`, this.root)?.focus();
    };
    bar.addEventListener("click", async (e) => {
      const t = e.target.closest("button")?.dataset.t;
      if (t === "up" && i > 0) move(i - 1);
      if (t === "down" && i < n - 1) move(i + 1);
      if (t === "del") { this.layout.widgets.splice(i, 1); this.renderGrid(); toast("Widget removed. Discard changes to bring it back."); }
      if (t === "copy") { this.layout.widgets.splice(i + 1, 0, { ...structuredClone(cfg), id: uid() }); this.renderGrid(); }
      if (t === "edit") {
        const next = await openEditor(cfg, this);
        if (next) { this.layout.widgets[i] = next; this.renderGrid(); }
      }
    });
    // drag and drop with the grip
    const grip = bar.querySelector(".handle-btn");
    grip.addEventListener("pointerdown", () => { slot.draggable = true; });
    slot.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", cfg.id); e.dataTransfer.effectAllowed = "move"; slot.classList.add("dragging"); });
    slot.addEventListener("dragend", () => { slot.draggable = false; slot.classList.remove("dragging"); $$(".drag-over", this.root).forEach((x) => x.classList.remove("drag-over")); });
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.firstElementChild?.classList.add("drag-over"); });
    slot.addEventListener("dragleave", () => slot.firstElementChild?.classList.remove("drag-over"));
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = this.layout.widgets.findIndex((w) => w.id === e.dataTransfer.getData("text/plain"));
      if (from < 0 || from === i) return;
      const [w] = this.layout.widgets.splice(from, 1);
      const to = this.layout.widgets.findIndex((x) => x.id === cfg.id);
      const rect = slot.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2 || (e.clientX > rect.left + rect.width / 2 && e.clientY > rect.top);
      this.layout.widgets.splice(after ? to + 1 : to, 0, w);
      this.renderGrid();
    });
  }
}

/* --------------------------------------------------------------- editor */
function openEditor(existing, dash) {
  return new Promise((resolve) => {
    let cfg = existing ? structuredClone(existing) : { id: uid(), type: "timeline", ...structuredClone(TYPES.timeline.defaults) };
    const previewCharts = [];
    const prevFocus = document.activeElement;
    const scrim = frag(markup`<div class="scrim" role="presentation"><div class="drawer" role="dialog" aria-modal="true" aria-labelledby="ed-heading">
      <form class="drawer-form" novalidate>
        <header><h2 id="ed-heading">${existing ? "Edit widget" : "Add a widget"}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">${icon("close")}</button></header>
        <div class="drawer-fields"></div>
        <footer><button type="button" class="btn ghost" data-close>Cancel</button>
          <button type="submit" class="btn primary">${existing ? "Apply" : "Add widget"}</button></footer>
      </form>
      <div class="drawer-preview"><div class="preview-label">Preview with your current data</div><div class="grid" id="ed-preview"></div></div>
    </div></div>`);
    const fields = $(".drawer-fields", scrim);
    const close = (val) => {
      previewCharts.forEach((c) => c.destroy());
      scrim.remove(); document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.(); resolve(val);
    };
    const onKey = (e) => { if (e.key === "Escape") close(null); trapFocus(e, scrim); };
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", (e) => { if (e.target === scrim || e.target.closest("[data-close]")) close(null); });
    $("form", scrim).addEventListener("submit", (e) => { e.preventDefault(); close(cfg); });

    const preview = () => {
      previewCharts.forEach((c) => c.destroy()); previewCharts.length = 0;
      const box = $("#ed-preview", scrim);
      // its own id, so the preview's ids (t-<id>) never repeat the widget's on the page
      box.replaceChildren(renderWidget({ ...cfg, id: `preview-${cfg.id}`, size: ["quarter", "third"].includes(cfg.size) ? "half" : "full" }, dash.ctx({ charts: previewCharts, links: false, tools: null })));
    };

    const drawFields = () => {
      // an unknown type (from a newer or damaged layout) shows only the type picker
      const type = typeOf(cfg.type) || { fields: [], sizes: [], autoTitle: () => "" };
      const repos = dash.model.repos;
      const where = dash.repo ? "repo" : "overview";
      const parts = [];
      parts.push(markup`<div class="field"><span>Widget type</span><div class="type-picker" role="group" aria-label="Widget type">
        ${typesFor(where).map(([k, t]) => markup`<button type="button" data-type="${k}" aria-pressed="${String(cfg.type === k)}"><strong>${t.label}</strong><span>${t.blurb}</span></button>`)}</div></div>`);
      if (dash.repo) parts.push(markup`<p class="muted" style="margin:0;font-size:13.5px">On repository pages every widget shows the repository being viewed.</p>`);
      for (const fd of type.fields) {
        if (fd.show && !fd.show(cfg)) continue;
        if (fd.overviewOnly && dash.repo) continue;
        const id = `ed-${fd.key}`;
        const v = cfg[fd.key];
        if (fd.type === "heading") parts.push(markup`<h3 class="field-heading">${fd.label}</h3>`);
        else if (fd.type === "multi") parts.push(markup`<fieldset class="field" style="border:0;padding:0;margin:0"><legend style="font-weight:600;font-size:14px;margin-bottom:6px">${fd.label}</legend>
          <div class="chips">${fd.options.map(([ov, ol]) => markup`<label><input type="checkbox" data-multi="${fd.key}" value="${ov}" ${!Array.isArray(v) || v.includes(ov) ? "checked" : ""}>${ol}</label>`)}</div></fieldset>`);
        else if (fd.type === "text") parts.push(markup`<label class="field" for="${id}"><span>${fd.label}${fd.hint ? markup` <span class="hint">${fd.hint}</span>` : ""}</span>
          <input class="input" id="${id}" data-k="${fd.key}" value="${v || ""}" placeholder="${type.autoTitle(cfg, dash.ctx())}" maxlength="80"></label>`);
        else if (fd.type === "textarea") parts.push(markup`<label class="field" for="${id}"><span>${fd.label} <span class="hint">${fd.hint || ""}</span></span>
          <textarea class="input" id="${id}" data-k="${fd.key}" maxlength="2000" rows="6">${v || ""}</textarea></label>`);
        else if (fd.type === "select") parts.push(markup`<label class="field" for="${id}"><span>${fd.label}${fd.hint ? markup` <span class="hint">${fd.hint}</span>` : ""}</span>
          <select class="input" id="${id}" data-k="${fd.key}">${fd.options.filter((o) => !o[2] || o[2] === where).map(([ov, ol]) => markup`<option value="${ov}" ${String(ov) === String(v ?? "") ? "selected" : ""}>${ol}</option>`)}</select></label>`);
        else if (fd.type === "check") parts.push(markup`<label class="check"><input type="checkbox" data-k="${fd.key}" ${v ? "checked" : ""}> ${fd.label}</label>`);
        else if (fd.type === "repo") parts.push(markup`<label class="field" for="${id}"><span>${fd.label}</span>
          <select class="input" id="${id}" data-k="${fd.key}"><option value="">Choose a repository</option>${repos.map((r) => markup`<option value="${r.id}" ${Number(v) === r.id ? "selected" : ""}>${r.label} (${r.full_name})</option>`)}</select></label>`);
        else if (fd.type === "repos") parts.push(markup`<fieldset class="field" style="border:0;padding:0;margin:0"><legend style="font-weight:600;font-size:14px;margin-bottom:6px">${fd.label} <span class="hint">${fd.hint}</span></legend>
          <div class="chips">${repos.length ? repos.map((r) => markup`<label><input type="checkbox" data-repo="${r.id}" ${(v || []).includes(r.id) ? "checked" : ""}>${r.label}</label>`) : markup`<span class="muted">No repositories yet</span>`}</div></fieldset>`);
      }
      if (type.sizes.length > 1) parts.push(markup`<label class="field" for="ed-size"><span>Width</span>
        <select class="input" id="ed-size" data-k="size">${type.sizes.map(([sv, sl]) => markup`<option value="${sv}" ${sv === cfg.size ? "selected" : ""}>${sl}</option>`)}</select></label>`);
      setHTML(fields, markup`${parts}`);

      $$("[data-type]", fields).forEach((b) => b.addEventListener("click", () => {
        if (b.dataset.type === cfg.type) return;
        const keep = Object.fromEntries(SHARED_KEYS.filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]]));
        cfg = { ...structuredClone(typeOf(b.dataset.type).defaults), ...keep, type: b.dataset.type };
        if (!typeOf(cfg.type).fields.some((x) => x.key === "repos")) delete cfg.repos;
        if (["releases", "releasetime", "files"].includes(cfg.type) && !cfg.repo && repos[0] && !dash.repo) cfg.repo = repos[0].id;
        drawFields(); preview();
        $(`[data-type="${cfg.type}"]`, fields).focus();
      }));
      $$("[data-k]", fields).forEach((el) => el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", () => {
        const k = el.dataset.k;
        let val = el.type === "checkbox" ? el.checked : el.value;
        if (["range", "limit", "repo", "rows", "avg"].includes(k) && val !== "global" && val !== "") val = Number(val);
        cfg[k] = val;
        const fields0 = typeOf(cfg.type)?.fields || [];
        const fd = fields0.find((x) => x.key === k);
        // other options may appear or disappear with this choice
        const needsRedraw = fields0.some((x) => x.show);
        if (needsRedraw && fd && (fd.type === "select" || fd.type === "check")) { drawFields(); $(`[data-k="${k}"]`, fields)?.focus(); }
        clearTimeout(drawFields.t); drawFields.t = setTimeout(preview, el.type === "text" || el.tagName === "TEXTAREA" ? 250 : 0);
      }));
      $$("[data-multi]", fields).forEach((el) => el.addEventListener("change", () => {
        const k = el.dataset.multi;
        cfg[k] = $$(`[data-multi="${k}"]:checked`, fields).map((x) => x.value);
        preview();
      }));
      $$("[data-repo]", fields).forEach((el) => el.addEventListener("change", () => {
        cfg.repos = $$("[data-repo]:checked", fields).map((x) => Number(x.dataset.repo));
        preview();
      }));
    };
    if (cfg.type === "releases" && !cfg.repo && dash.model.repos[0]) cfg.repo = dash.model.repos[0].id;
    document.body.appendChild(scrim);
    drawFields(); preview();
    ($("[aria-pressed='true']", fields) || $("input, select, button", fields))?.focus();
  });
}

