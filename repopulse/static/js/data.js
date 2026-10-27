// Turns the raw daily snapshots from the API into series the widgets can draw.
//
// GitHub only reports a running total per release asset, so "new downloads"
// on a day is the difference between two snapshots. When the server missed
// some days, the difference is spread evenly over the missing days.

import { addDays, daysBetween, isoDate } from "./util.js";

export class Model {
  constructor(data) {
    this.repos = data.repos || [];
    this.lastUpdate = data.last_update;
    this.byId = new Map(this.repos.map((r) => [r.id, r]));
    const hist = data.history || {};
    let first = null, last = null;
    for (const r of this.repos) {
      const h = hist[r.id] || [];
      r._hist = h;
      if (h.length) {
        if (!first || h[0][0] < first) first = h[0][0];
        if (!last || h[h.length - 1][0] > last) last = h[h.length - 1][0];
      }
    }
    this.empty = !first;
    this.end = last || isoDate(new Date());
    this.start = first || this.end;
    this.axis = [];
    for (let d = this.start; d <= this.end; d = addDays(d, 1)) this.axis.push(d);
    this.index = new Map(this.axis.map((d, i) => [d, i]));
    for (const r of this.repos) this.#prepare(r);
  }

  #prepare(r) {
    const n = this.axis.length;
    const cum = new Array(n).fill(null), daily = new Array(n).fill(null);
    const stars = new Array(n).fill(null), forks = new Array(n).fill(null), rels = new Array(n).fill(null);
    const h = r._hist;
    for (let k = 0; k < h.length; k++) {
      const [d, dl, st, fk, rc] = h[k];
      const i = this.index.get(d);
      const nextI = k + 1 < h.length ? this.index.get(h[k + 1][0]) : n;
      for (let j = i; j < nextI; j++) { cum[j] = dl; stars[j] = st; forks[j] = fk; rels[j] = rc; daily[j] = 0; }
      if (k === 0) { daily[i] = null; continue; }
      const prevI = this.index.get(h[k - 1][0]);
      const gap = i - prevI;
      const delta = Math.max(0, dl - h[k - 1][1]);
      // spread over the gap days: integer parts that add up to delta
      for (let g = 1; g <= gap; g++) {
        daily[prevI + g] = Math.floor((delta * g) / gap) - Math.floor((delta * (g - 1)) / gap);
      }
    }
    r._s = { cum, daily, stars, forks, rels };
    const lastRow = h[h.length - 1];
    r.total = lastRow ? lastRow[1] : 0;
    r.stars = lastRow ? lastRow[2] : 0;
    r.forks = lastRow ? lastRow[3] : 0;
    r.releases = lastRow ? lastRow[4] : 0;
    r.trackedSince = h.length ? h[0][0] : null;
  }

  /** Daily series for one release of a repo from its snapshots [[date, total], ...].
   * A release that first shows up after tracking started was published while
   * being tracked, so all its downloads count as new on that day. */
  releaseSeries(repo, rows) {
    const n = this.axis.length;
    const cum = new Array(n).fill(null), daily = new Array(n).fill(null);
    if (!rows.length) return { cum, daily };
    const lastRepoDay = repo._hist.length ? repo._hist[repo._hist.length - 1][0] : null;
    for (let k = 0; k < rows.length; k++) {
      const [d, dl] = rows[k];
      const i = this.index.get(d);
      if (i == null) continue;
      const stillThere = k + 1 < rows.length || d === lastRepoDay;
      const nextI = k + 1 < rows.length ? this.index.get(rows[k + 1][0]) : stillThere ? n : i + 1;
      for (let j = i; j < nextI; j++) { cum[j] = dl; daily[j] = 0; }
      if (k === 0) {
        daily[i] = repo.trackedSince && d > repo.trackedSince ? dl : null;
        continue;
      }
      const prevI = this.index.get(rows[k - 1][0]);
      const gap = i - prevI, delta = Math.max(0, dl - rows[k - 1][1]);
      for (let g = 1; g <= gap; g++) daily[prevI + g] = Math.floor((delta * g) / gap) - Math.floor((delta * (g - 1)) / gap);
    }
    return { cum, daily };
  }

  /** Find a repo by "owner/name" (any case) or by id. */
  find(slug) {
    const s = String(slug || "").toLowerCase();
    return this.repos.find((r) => r.full_name.toLowerCase() === s) || this.byId.get(Number(slug)) || null;
  }

  pick(ids) {
    if (!ids || !ids.length) return this.repos.slice();
    const set = new Set(ids.map(Number));
    return this.repos.filter((r) => set.has(r.id));
  }

  /** {startI, endI, dates, days} for "last N days" (0 = everything). */
  window(days) {
    const endI = this.axis.length - 1;
    const startI = days > 0 ? Math.max(0, endI - days + 1) : 0;
    return { startI, endI, dates: this.axis.slice(startI, endI + 1), days: days > 0 ? days : this.axis.length };
  }

  /** The window right before the given one, same length (may be partly outside data). */
  previous(win) {
    const len = win.endI - win.startI + 1;
    return { startI: win.startI - len, endI: win.startI - 1 };
  }

  series(repo, key, win) {
    return repo._s[key].slice(win.startI, win.endI + 1);
  }

  /** Downloads gained by these repos in [startI, endI]; null if nothing known. */
  gained(repos, startI, endI) {
    let sum = 0, known = false;
    for (const r of repos) {
      const d = r._s.daily;
      for (let i = Math.max(0, startI); i <= endI && i < d.length; i++) {
        if (d[i] != null) { sum += d[i]; known = true; }
      }
    }
    return known ? sum : null;
  }

  /** Is there at least a full previous period of data to compare with? */
  hasPrevious(repos, prev) {
    if (prev.startI < 0) return false;
    return repos.some((r) => r._s.daily[prev.startI] != null);
  }

  sum(repos, key, win) {
    const out = new Array(win.endI - win.startI + 1).fill(null);
    for (const r of repos) {
      const s = r._s[key];
      for (let i = win.startI; i <= win.endI; i++) {
        if (s[i] != null) out[i - win.startI] = (out[i - win.startI] || 0) + s[i];
      }
    }
    return out;
  }
}

/** Group a daily series into weeks (starting Monday) or months. */
export function bucket(dates, values, by, how = "sum") {
  if (by === "day") return { labels: dates, values };
  const labels = [], out = [];
  let key = null;
  dates.forEach((d, i) => {
    let k;
    if (by === "month") k = d.slice(0, 7) + "-01";
    else {
      const dt = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
      const dow = (dt.getDay() + 6) % 7;
      dt.setDate(dt.getDate() - dow);
      k = isoDate(dt);
    }
    if (k !== key) { key = k; labels.push(k); out.push(null); }
    const v = values[i];
    if (v != null) {
      const j = out.length - 1;
      out[j] = how === "last" ? v : (out[j] || 0) + v;
    }
  });
  return { labels, values: out };
}

export function rangeLabel(days) {
  if (!days) return "All time";
  if (days === 7) return "Last 7 days";
  if (days === 30) return "Last 30 days";
  if (days === 90) return "Last 90 days";
  if (days === 365) return "Last 12 months";
  return `Last ${days} days`;
}

export function pctChange(now, before) {
  if (now == null || before == null || before === 0) return null;
  return ((now - before) / before) * 100;
}

export { daysBetween };
