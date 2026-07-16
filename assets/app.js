/* AC Rossoneri – Junioren D-9 schwarz
   Loads local JSON and renders Tabelle, Spiele and Torschützen.
   No framework, no build step. */

const DATA = { config: null, standings: null, matches: null, goals: null };

/* ---------- helpers ---------- */

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const WEEKDAY = { weekday: "short", day: "2-digit", month: "2-digit" };
function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return new Intl.DateTimeFormat("de-CH", WEEKDAY).format(d); // e.g. "Sa., 23.08."
}
function fmtDateLong(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return new Intl.DateTimeFormat("de-CH", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(d);
}

function isUs(teamName) {
  return teamName && DATA.config && teamName === DATA.config.ourTeam;
}

function showError(msg) {
  const box = document.getElementById("error-box");
  box.hidden = false;
  box.innerHTML = msg;
}

/* ---------- rendering ---------- */

function renderHeader() {
  const c = DATA.config;
  if (!c) return;
  document.getElementById("club-name").textContent = c.clubName || "AC Rossoneri";
  document.getElementById("team-name").textContent = c.teamName || "";
  document.getElementById("season-label").textContent = c.season || "";
  document.title = `${c.clubName} · ${c.teamName}`;

  const stamp = (DATA.matches && DATA.matches.updated) || c.lastUpdated;
  if (stamp) document.getElementById("updated-label").textContent = "Stand: " + fmtStamp(stamp);
  document.getElementById("sample-banner").hidden = !c.sampleData;
}
function fmtDateLongSafe(iso) { try { return fmtDateLong(iso); } catch { return iso; } }
// Accepts "2026-08-22" or "2026-08-22 13:59" -> "22.08.2026" / "22.08.2026, 13:59"
function fmtStamp(s) {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return s;
  return m[4] ? `${m[3]}.${m[2]}.${m[1]}, ${m[4]}:${m[5]}` : `${m[3]}.${m[2]}.${m[1]}`;
}
function fmtStampFromISO(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat("de-CH", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(d);
}

// Show when the auto-updater last ran, read from the GitHub Actions API (no commit needed).
let lastCheckedAt = 0;
async function updateLastChecked() {
  if (Date.now() - lastCheckedAt < 90000) return;
  lastCheckedAt = Date.now();
  try {
    const r = await fetch("https://api.github.com/repos/acrossoneri/d9schwarz/actions/runs?per_page=1",
      { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    const run = j.workflow_runs && j.workflow_runs[0];
    const s = run && fmtStampFromISO(run.run_started_at || run.updated_at);
    if (s) document.getElementById("updated-label").textContent = "Zuletzt geprüft: " + s;
  } catch (e) { /* keep the fallback "Stand:" label */ }
}

function renderStandings() {
  const s = DATA.standings;
  if (!s) return;
  if (s.group) document.getElementById("standings-group").textContent = s.group;
  const tbody = document.querySelector("#standings-table tbody");
  tbody.innerHTML = "";
  (s.rows || []).forEach(r => {
    const diff = (r.goalsFor ?? 0) - (r.goalsAgainst ?? 0);
    const tr = document.createElement("tr");
    if (isUs(r.team)) tr.className = "is-us";
    tr.innerHTML =
      `<td class="c-rank">${r.rank ?? ""}</td>` +
      `<td class="c-team">${esc(r.team)}</td>` +
      `<td>${r.played ?? ""}</td>` +
      `<td>${r.won ?? ""}</td>` +
      `<td>${r.drawn ?? ""}</td>` +
      `<td>${r.lost ?? ""}</td>` +
      `<td>${r.goalsFor ?? 0}:${r.goalsAgainst ?? 0}</td>` +
      `<td>${diff > 0 ? "+" + diff : diff}</td>` +
      `<td class="c-pts">${r.points ?? ""}</td>`;
    tbody.appendChild(tr);
  });
}

function currentFilter() {
  const sel = document.getElementById("team-filter");
  return sel && sel.value ? sel.value : "__us__";
}

// Fill the team dropdown: our team (default) -> "Alle Teams" -> every other team.
function populateTeamFilter() {
  const sel = document.getElementById("team-filter");
  if (!sel) return;
  const our = DATA.config && DATA.config.ourTeam;
  const all = (DATA.matches && DATA.matches.matches) || [];
  const teams = [...new Set(all.flatMap(m => [m.home, m.away]))].sort((a, b) => a.localeCompare(b));
  const others = teams.filter(t => t !== our);
  const prev = sel.value;
  let html = our ? `<option value="__us__">${esc(our)}</option>` : "";
  html += `<option value="__all__">Alle Teams</option>`;
  html += others.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  sel.innerHTML = html;
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : "__us__";
}

function renderMatches() {
  const all = (DATA.matches && DATA.matches.matches) || [];
  const our = DATA.config && DATA.config.ourTeam;
  const f = currentFilter();
  let list = all;
  if (f === "__us__") list = all.filter(m => m.home === our || m.away === our);
  else if (f !== "__all__") list = all.filter(m => m.home === f || m.away === f);

  // One continuous timeline, oldest first.
  const sorted = [...list].sort((a, b) =>
    (a.date + "T" + (a.time || "00:00")).localeCompare(b.date + "T" + (b.time || "00:00")));

  const el = document.getElementById("match-list");
  el.innerHTML = "";
  if (!sorted.length) {
    el.innerHTML = `<li class="hint">Keine Spiele erfasst.</li>`;
    return;
  }
  const nextId = findNextMatchId(sorted);
  sorted.forEach(m => {
    const li = matchCard(m, m.status === "played");
    if (m.id === nextId) { li.classList.add("is-next"); li.id = "next-match"; }
    el.appendChild(li);
  });
}

// First match whose kickoff is now or in the future; null if every match is in the past.
function findNextMatchId(sortedAsc) {
  const now = new Date();
  for (const m of sortedAsc) {
    const dt = new Date(`${m.date}T${m.time || "00:00"}:00`);
    if (!isNaN(dt) && dt >= now) return m.id;
  }
  return null;
}

// Jump the Spiele list to the next upcoming game (past games above, future below).
function scrollToNextMatch() {
  requestAnimationFrame(() => {
    const el = document.getElementById("next-match");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      // Season finished: land on the most recent game at the bottom.
      const last = document.getElementById("match-list").lastElementChild;
      if (last) last.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  });
}

function matchCard(m, isPlayed) {
  const li = document.createElement("li");
  li.className = "match" + (isPlayed ? " clickable" : "");

  const scoreHtml = isPlayed
    ? `<div class="match-score">${m.homeScore}<span>:</span>${m.awayScore}</div>`
    : `<div class="match-score small">${m.time || ""}</div>`;

  const head = document.createElement("button");
  head.className = "match-head";
  head.type = "button";
  head.innerHTML =
    `<div class="match-date">${fmtDate(m.date)}<span class="round">${esc(m.round || "")}</span></div>` +
    `<div class="match-teams">` +
      `<div class="row"><span class="name${isUs(m.home) ? " us" : ""}">${esc(m.home)}</span></div>` +
      `<div class="row"><span class="name${isUs(m.away) ? " us" : ""}">${esc(m.away)}</span></div>` +
    `</div>` +
    scoreHtml +
    (isPlayed ? `<span class="chev">▾</span>` : "");
  li.appendChild(head);

  if (isPlayed) {
    const detail = document.createElement("div");
    detail.className = "match-goals";
    detail.innerHTML = renderGoalDetail(m);
    li.appendChild(detail);
    head.addEventListener("click", () => li.classList.toggle("open"));
  }
  return li;
}

function renderGoalDetail(m) {
  const goals = (DATA.goals && DATA.goals[m.id]) || [];
  let html = m.venue ? `<p class="venue">📍 ${esc(m.venue)} · ${fmtDateLongSafe(m.date)}</p>` : "";
  if (!goals.length) {
    html += `<p class="none">Keine Torschützen erfasst.</p>`;
    return html;
  }
  html += `<strong>Unsere Torschützen</strong><ul>`;
  goals.forEach(g => {
    html += `<li><span>⚽ ${esc(g.player)}</span><span class="min">${g.minute ? g.minute + "'" : ""}</span></li>`;
  });
  html += `</ul>`;
  return html;
}

function renderScorers() {
  const matches = (DATA.matches && DATA.matches.matches) || [];
  const goals = DATA.goals || {};
  const our = DATA.config ? DATA.config.ourTeam : null;

  // player -> { total, vs: Map(opponent -> count) }
  const stats = new Map();
  matches.forEach(m => {
    const opponent = m.home === our ? m.away : m.home;
    (goals[m.id] || []).forEach(g => {
      if (!g || !g.player) return;
      let s = stats.get(g.player);
      if (!s) { s = { total: 0, vs: new Map() }; stats.set(g.player, s); }
      s.total += 1;
      s.vs.set(opponent, (s.vs.get(opponent) || 0) + 1);
    });
  });

  const ranked = [...stats.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));

  const list = document.getElementById("scorer-list");
  list.innerHTML = "";
  if (!ranked.length) {
    list.innerHTML = `<li class="hint">Noch keine Tore erfasst.</li>`;
    return;
  }
  ranked.forEach(([player, s], i) => {
    const vs = [...s.vs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const li = document.createElement("li");
    li.className = "scorer clickable";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "scorer-head";
    head.innerHTML =
      `<span class="scorer-rank">${i + 1}</span>` +
      `<span class="sc-name">${esc(player)}</span>` +
      `<span class="sc-goals">${s.total}<span>${s.total === 1 ? "Tor" : "Tore"}</span></span>` +
      `<span class="chev">▾</span>`;

    const detail = document.createElement("div");
    detail.className = "scorer-vs";
    detail.innerHTML = `<strong>Getroffen gegen</strong><ul>` +
      vs.map(([opp, c]) =>
        `<li><span>${esc(opp)}</span><span class="c">${c}×</span></li>`).join("") +
      `</ul>`;

    li.appendChild(head);
    li.appendChild(detail);
    head.addEventListener("click", () => li.classList.toggle("open"));
    list.appendChild(li);
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- tabs ---------- */

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => { t.classList.remove("is-active"); t.setAttribute("aria-selected", "false"); });
      tab.classList.add("is-active");
      tab.setAttribute("aria-selected", "true");
      const target = tab.dataset.tab;
      document.querySelectorAll(".panel").forEach(p => { p.hidden = true; });
      document.getElementById("tab-" + target).hidden = false;
      if (target === "spiele") scrollToNextMatch();
      else window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

/* ---------- init ---------- */

async function loadAndRender() {
  const [config, standings, matches, goals] = await Promise.all([
    loadJSON("data/config.json"),
    loadJSON("data/standings.json"),
    loadJSON("data/matches.json"),
    loadJSON("data/goals.json"),
  ]);
  DATA.config = config;
  DATA.standings = standings;
  DATA.matches = matches;
  DATA.goals = goals;

  renderHeader();
  populateTeamFilter();
  renderStandings();
  renderMatches();
  renderScorers();
  updateLastChecked();
}

let refreshing = false;
let lastLoad = 0;
// force=true always reloads (button); otherwise skip if we reloaded < 60s ago (tab refocus).
async function refresh(force = false) {
  if (refreshing) return;
  if (!force && Date.now() - lastLoad < 60000) return;
  refreshing = true;
  const btn = document.getElementById("refresh-btn");
  if (btn) btn.classList.add("spin");
  try {
    await loadAndRender();
    lastLoad = Date.now();
    document.getElementById("error-box").hidden = true;
  } catch (err) {
    console.error(err);
    showError(
      `<strong>Daten konnten nicht geladen werden.</strong><br>` +
      `Wird die Seite über <code>file://</code> geöffnet, blockiert der Browser lokale JSON-Dateien. ` +
      `Über http(s) ausliefern (z.&nbsp;B. <code>python3 -m http.server 8000</code>). ` +
      `(Fehler: ${esc(err.message)})`
    );
  } finally {
    refreshing = false;
    if (btn) btn.classList.remove("spin");
  }
}

function init() {
  setupTabs();
  const btn = document.getElementById("refresh-btn");
  if (btn) btn.addEventListener("click", () => refresh(true));
  const filter = document.getElementById("team-filter");
  if (filter) filter.addEventListener("change", () => { renderMatches(); scrollToNextMatch(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  window.addEventListener("focus", () => refresh());
  refresh(true);
}

document.addEventListener("DOMContentLoaded", init);
