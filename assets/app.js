/* AC Rossoneri – Junioren D-9 schwarz
   Loads local JSON and renders Tabelle, Spiele and Torschützen.
   No framework, no build step. */

const DATA = { config: null, standings: null, matches: null, scorers: null,
               players: null, lineups: null, friendlies: null };

// A friendly note for anyone poking around in the sources.
console.log(
  "%c⚽ Bitte mach nichts kaputt, das ist für unsere Spieler.%c\nDanke! – AC Rossoneri, Junioren D-9 schwarz",
  "font-weight:700;font-size:13px;color:#C8102E", "color:inherit;font-size:12px");

/* ---------- helpers ---------- */

// The data files are AES-GCM ciphertext; AUTH holds the key from the login.
async function loadJSON(path) {
  return AUTH.decryptJSON(path);
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

  renderUpdatedLabel();
  document.getElementById("sample-banner").hidden = !c.sampleData;
}

/* Two different facts, and conflating them reads as a broken site: "Stand" is when
   the data last CHANGED, "geprüft" when the updater last looked. In a week without
   a game the first is old and the second is minutes ago — both correct. */
let checkedLabel = "";

function renderUpdatedLabel() {
  const el = document.getElementById("updated-label");
  if (!el) return;
  const stamp = (DATA.matches && DATA.matches.updated)
             || (DATA.config && DATA.config.lastUpdated);
  el.textContent = [stamp ? "Stand: " + fmtStamp(stamp) : "",
                    checkedLabel ? "geprüft: " + checkedLabel : ""]
                    .filter(Boolean).join(" · ");
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
async function updateLastChecked(force = false) {
  // Throttled for the automatic calls on tab focus; the refresh button means now.
  if (!force && Date.now() - lastCheckedAt < 90000) return;
  lastCheckedAt = Date.now();
  try {
    const r = await fetch("https://api.github.com/repos/acrossoneri/d9schwarz/actions/runs?per_page=1",
      { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    const run = j.workflow_runs && j.workflow_runs[0];
    const s = run && fmtStampFromISO(run.run_started_at || run.updated_at);
    if (s) { checkedLabel = s; renderUpdatedLabel(); }
  } catch (e) { /* the "Stand:" half stands on its own */ }
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
      `<td class="c-team"><button type="button" class="team-link" data-team="${esc(r.team)}">${esc(r.team)}</button></td>` +
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

function filterValue(id) {
  const sel = document.getElementById(id);
  return sel && sel.value ? sel.value : "__us__";
}

// Options for a team dropdown: our team (default) -> "Alle Teams" -> every other team.
function teamOptionsHTML() {
  const our = DATA.config && DATA.config.ourTeam;
  const all = (DATA.matches && DATA.matches.matches) || [];
  const teams = [...new Set(all.flatMap(m => [m.home, m.away]))].sort((a, b) => a.localeCompare(b));
  const others = teams.filter(t => t !== our);
  let html = our ? `<option value="__us__">${esc(our)}</option>` : "";
  html += `<option value="__all__">Alle Teams</option>`;
  html += others.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  return html;
}
function populateSelect(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = teamOptionsHTML();
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : "__us__";
}

function renderMatches() {
  const all = (DATA.matches && DATA.matches.matches) || [];
  const our = DATA.config && DATA.config.ourTeam;
  const f = filterValue("team-filter");
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
  // Upcoming games carry a detail too — the Spielort is published well before
  // kickoff, and "wo spielen wir am Samstag?" is worth a tap.
  const hasDetail = isPlayed || !!(m.detail && m.detail.venue);
  li.className = "match" + (hasDetail ? " clickable" : "");

  // Anspielzeit bleibt auch nach dem Spiel sichtbar: unter dem Resultat, sobald
  // gespielt wurde — an dessen Stelle, solange das Spiel noch bevorsteht.
  const kickoff = m.time ? `<span class="kickoff">${esc(m.time)}</span>` : "";
  const scoreHtml = isPlayed
    ? `<div class="match-score">${m.homeScore}<span>:</span>${m.awayScore}${kickoff}</div>`
    : `<div class="match-score small">${esc(m.time || "")}</div>`;

  const head = document.createElement("button");
  head.className = "match-head";
  head.type = "button";
  // A hand-kept game is marked, so nobody wonders why it is not in the table.
  const tag = m.friendly ? `<span class="round friendly-tag">Test</span>` : "";
  head.innerHTML =
    `<div class="match-date">${fmtDate(m.date)}` +
      `<span class="round">${esc(m.round || "")}</span>${tag}</div>` +
    `<div class="match-teams">` +
      `<div class="row"><span class="name${isUs(m.home) ? " us" : ""}">${esc(m.home)}</span></div>` +
      `<div class="row"><span class="name${isUs(m.away) ? " us" : ""}">${esc(m.away)}</span></div>` +
    `</div>` +
    scoreHtml +
    (hasDetail ? `<span class="chev">▾</span>` : "");
  li.appendChild(head);

  if (hasDetail) {
    const detail = document.createElement("div");
    detail.className = "match-goals";
    detail.innerHTML = renderMatchDetail(m, isPlayed);
    li.appendChild(detail);
    head.addEventListener("click", () => li.classList.toggle("open"));
  }
  return li;
}

// The Spielbericht of one game: Spielort and Drittel from the matchcenter, our
// hand-entered Torschützen, then Verlauf and Aufstellung — also from the
// matchcenter, which publishes both teams' line-ups once a game has been played.
function renderMatchDetail(m, isPlayed) {
  const d = m.detail || {};
  const venue = d.venue || m.venue;
  let html = venue ? `<p class="venue">📍 ${esc(venue)} · ${fmtDateLongSafe(m.date)}</p>` : "";

  if (Array.isArray(d.periods) && d.periods.length) {
    html += `<p class="periods"><span>Drittel</span> ${d.periods.map(esc).join(" · ")}</p>`;
  }
  if (!isPlayed) return html || `<p class="none">Noch keine Angaben.</p>`;

  html += renderScorerLines(m);
  html += renderEventLines(d.events);
  html += renderLineups(d.lineups);
  return html;
}

function renderScorerLines(m) {
  const scorers = (m.scorers || []).filter(g => g && g.player);
  if (!scorers.length) return `<p class="none">Keine Torschützen erfasst.</p>`;
  // Grouped by team (home first) like a game report — in practice only ours.
  let html = "";
  [m.home, m.away].forEach(team => {
    const list = scorers.filter(g => g.team === team);
    if (!list.length) return;
    html += `<strong${isUs(team) ? ' class="us"' : ""}>${esc(team)}</strong><ul>`;
    list.forEach(g => {
      html += `<li><span>⚽ ${esc(g.player)}</span><span class="min">${g.minute ? esc(g.minute) + "'" : ""}</span></li>`;
    });
    html += `</ul>`;
  });
  return html;
}

// The matchcenter names each event by its icon: gelb, rot, gelbrot, …
const EVENT_ICON = { gelb: "🟨", rot: "🟥", gelbrot: "🟨🟥", tor: "⚽", wechsel: "🔁" };

function renderEventLines(events) {
  if (!Array.isArray(events) || !events.length) return "";
  let html = `<strong>Verlauf</strong><ul>`;
  events.forEach(e => {
    const icon = EVENT_ICON[e.kind] || "•";
    html += `<li><span>${icon} ${esc(e.text || "")}</span>` +
            `<span class="min">${e.minute ? esc(e.minute) + "'" : ""}</span></li>`;
  });
  return html + `</ul>`;
}

function renderLineups(lineups) {
  if (!Array.isArray(lineups) || !lineups.length) return "";
  let html = `<strong>Aufstellung</strong><div class="lineups">`;
  lineups.forEach(l => {
    html += `<div class="lineup">` +
            `<strong${isUs(l.team) ? ' class="us"' : ""}>${esc(l.team || "")}</strong>`;
    html += playerBlock(l.starting);
    if ((l.subs || []).length) {
      html += `<p class="sub-title">Ersatz</p>` + playerBlock(l.subs);
    }
    if ((l.coaches || []).length) {
      html += `<p class="sub-title">Trainer</p>` +
              `<p class="coaches">${l.coaches.map(c => esc(c.name || "")).join(", ")}</p>`;
    }
    html += `</div>`;
  });
  return html + `</div>`;
}

function playerBlock(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return `<ul class="xi">` + list.map(p =>
    `<li class="${p.unused ? "unused" : ""}">` +
      `<span class="nr">${p.number != null ? esc(p.number) : ""}</span>` +
      `<span class="pn">${esc(p.name || "")}${p.captain ? ' <span class="capt">C</span>' : ""}</span>` +
      `<span class="pos">${esc(p.position || (p.unused ? "kein Einsatz" : ""))}</span>` +
    `</li>`).join("") + `</ul>`;
}

// Torschützen werden von Hand erfasst und darum nur für unser eigenes Team —
// eine Team-Auswahl gäbe es hier nichts zu filtern.
function renderScorers() {
  const all = (DATA.matches && DATA.matches.matches) || [];
  const our = DATA.config && DATA.config.ourTeam;

  // key = player -> { player, team, total, goals: [{date, opponent, minute}] }
  const stats = new Map();
  all.forEach(m => {
    (m.scorers || []).forEach(g => {
      if (!g || !g.player) return;
      const team = g.team || our;
      if (team !== our) return;
      const opponent = m.home === team ? m.away : m.home;
      const key = g.player;
      let s = stats.get(key);
      if (!s) { s = { player: g.player, team, total: 0, goals: [] }; stats.set(key, s); }
      s.total += 1;
      s.goals.push({ date: m.date, opponent, minute: g.minute, home: m.home, away: m.away });
    });
  });

  const ranked = [...stats.values()].sort((a, b) => b.total - a.total || a.player.localeCompare(b.player));
  // Newest goal first, so "when" reads naturally.
  ranked.forEach(s => s.goals.sort((a, b) =>
    (b.date || "").localeCompare(a.date || "") || (b.minute || 0) - (a.minute || 0)));

  const list = document.getElementById("scorer-list");
  list.innerHTML = "";
  if (!ranked.length) {
    list.innerHTML = `<li class="hint">Noch keine Tore erfasst.</li>`;
    return;
  }
  ranked.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "scorer clickable";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "scorer-head";
    const last = s.goals.find(g => g.date);
    const sub = [last ? "letztes Tor: " + fmtDate(last.date) : ""].filter(Boolean);
    head.innerHTML =
      `<span class="scorer-rank">${i + 1}</span>` +
      `<span class="sc-name">${esc(s.player)}` +
        sub.map(t => `<span class="sc-team">${t}</span>`).join("") +
      `</span>` +
      `<span class="sc-goals">${s.total}<span>${s.total === 1 ? "Tor" : "Tore"}</span></span>` +
      `<span class="chev">▾</span>`;

    // Every goal with when it fell, newest first.
    const detail = document.createElement("div");
    detail.className = "scorer-vs";
    detail.innerHTML = `<strong>${s.total === 1 ? "Das Tor" : "Die Tore"}</strong><ul>` +
      s.goals.map(g => {
        const when = g.date ? fmtDate(g.date) : "";
        const vs = g.opponent ? ` gegen ${esc(g.opponent)}` : "";
        return `<li><span>${when}${vs}</span>` +
               `<span class="c">${g.minute ? esc(g.minute) + "." + " Min." : ""}</span></li>`;
      }).join("") +
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

function activateTab(target) {
  document.querySelectorAll(".tab").forEach(t => {
    const on = t.dataset.tab === target;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach(p => { p.hidden = p.id !== "tab-" + target; });
  if (target === "spiele") scrollToNextMatch();
  else window.scrollTo({ top: 0, behavior: "smooth" });
}

/* Which build the browser actually has. GitHub Pages serves index.html with
   cache-control: max-age=600 and no way to change that, so a stale page is a real
   possibility — this makes it visible instead of a guess. */
function showBuild() {
  const el = document.getElementById("build-label");
  if (!el) return;
  const src = [...document.scripts].map(s => s.src).find(s => s.includes("app.js"));
  const v = (src || "").match(/[?&]v=([0-9a-z]+)/);
  el.textContent = v ? "Version " + v[1] : "";
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });
}

// From a team in the Tabelle -> show that team's games in the Spiele tab.
function showTeamGames(team) {
  const our = DATA.config && DATA.config.ourTeam;
  const val = team === our ? "__us__" : team;
  const sel = document.getElementById("team-filter");
  if (sel && [...sel.options].some(o => o.value === val)) sel.value = val;
  renderMatches();
  activateTab("spiele");
}

/* ---------- init ---------- */

async function loadAndRender(force = false) {
  const [config, standings, matches, scorers, players, lineups, friendlies] =
    await Promise.all([
    loadJSON("data/config.enc.json"),
    loadJSON("data/standings.enc.json"),
    loadJSON("data/matches.enc.json"),
    // Both are hand-maintained and may not exist at all — an empty site is valid.
    loadJSON("data/scorers.enc.json").catch(() => ({ byMatch: {} })),
    loadJSON("data/players.enc.json").catch(() => ({ players: [] })),
    // Written from the Einstellungen tab; absent until an admin saves the first one.
    loadJSON("data/lineups.enc.json").catch(() => ({ byMatch: {} })),
    loadJSON("data/friendlies.enc.json").catch(() => ({ matches: [] })),
  ]);
  DATA.config = config;
  DATA.standings = standings;
  DATA.matches = matches;
  DATA.scorers = scorers && scorers.byMatch ? scorers : { byMatch: {} };
  DATA.players = { players: (players && players.players) || [] };
  DATA.lineups = lineups && lineups.byMatch ? lineups : { byMatch: {} };
  DATA.friendlies = { matches: (friendlies && friendlies.matches) || [] };
  addFriendlies();

  renderAll();
  updateLastChecked(force);
}

/* Games the group Spielplan does not carry — friendlies, cup ties — kept in their
   own file and folded into the fixture list. They deliberately never reach
   renderStandings(): the table comes from the scraper, computed from group results
   only, so a friendly cannot move anyone up it. */
function addFriendlies() {
  const extra = (DATA.friendlies && DATA.friendlies.matches) || [];
  if (!extra.length || !DATA.matches) return;
  const all = DATA.matches.matches || (DATA.matches.matches = []);
  const have = new Set(all.map(m => String(m.id)));
  extra.forEach(m => {
    if (m && m.id && !have.has(String(m.id))) all.push({ ...m, friendly: true });
  });
}

// Our own line-up, typed in the Einstellungen tab. The coach files it with the
// association anyway, so this is the same data by a shorter route — and unlike the
// scraped detail it is ours to keep. It slots into m.detail.lineups next to any
// opponent line-up, replacing our entry there if both exist.
function mergeLineups() {
  const byMatch = (DATA.lineups && DATA.lineups.byMatch) || {};
  const our = (DATA.config && DATA.config.ourTeam) || "";
  ((DATA.matches && DATA.matches.matches) || []).forEach(m => {
    const own = byMatch[m.id];
    if (!own || !(own.starting || own.subs)) return;
    const mine = { team: our, starting: own.starting || [], subs: own.subs || [],
                   coaches: own.coaches || [] };
    const detail = m.detail || (m.detail = {});
    // An imported report also carries the things the group Spielplan never has.
    if (own.venue && !detail.venue) detail.venue = own.venue;
    if (own.periods && !detail.periods) detail.periods = own.periods;
    if (own.events && !detail.events) detail.events = own.events;
    // Opponent line-ups from the same report, minus any we already hold.
    const imported = (own.opponents || []).filter(l => l && l.team && l.team !== our);
    const importedNames = new Set(imported.map(l => l.team));
    const rest = [...imported,
                  ...(detail.lineups || []).filter(l => l && l.team !== our
                                                        && !importedNames.has(l.team))];
    // Home team first, the way a game report reads.
    detail.lineups = m.home === our ? [mine, ...rest] : [...rest, mine];
  });
}

// Hand-entered scorers live in their own file so an hourly scrape can never wipe
// them. Where both exist, the manual entry for that match wins.
function mergeScorers() {
  const byMatch = (DATA.scorers && DATA.scorers.byMatch) || {};
  ((DATA.matches && DATA.matches.matches) || []).forEach(m => {
    if (Object.prototype.hasOwnProperty.call(byMatch, m.id)) m.scorers = byMatch[m.id];
  });
}

function renderAll() {
  mergeScorers();
  mergeLineups();
  renderHeader();
  populateSelect("team-filter");
  renderStandings();
  renderMatches();
  renderScorers();
  if (AUTH.isAdmin()) ADMIN.render();
}

let refreshing = false;
let lastLoad = 0;
// force=true always reloads (button); otherwise skip if we reloaded < 60s ago (tab refocus).
async function refresh(force = false) {
  if (refreshing || !AUTH.isUnlocked()) return;
  if (!force && Date.now() - lastLoad < 60000) return;
  // Never let a reload silently throw away an admin's unsaved edits.
  if (ADMIN.isDirty()) {
    if (!force) return;
    if (!confirm("Es gibt ungespeicherte Änderungen. Neu laden und endgültig verwerfen?")) return;
    ADMIN.discard();
  }
  refreshing = true;
  const btn = document.getElementById("refresh-btn");
  if (btn) btn.classList.add("spin");
  try {
    await loadAndRender(force);
    lastLoad = Date.now();
    document.getElementById("error-box").hidden = true;
  } catch (err) {
    console.error(err); // details stay in the console, not on the page
    showError(`<strong>Daten konnten momentan nicht geladen werden.</strong><br>Bitte versuche es später erneut.`);
  } finally {
    refreshing = false;
    if (btn) btn.classList.remove("spin");
  }
}

let wired = false;
function wire() {
  showBuild();
  if (wired) return;
  wired = true;
  setupTabs();
  const btn = document.getElementById("refresh-btn");
  if (btn) btn.addEventListener("click", () => refresh(true));
  const filter = document.getElementById("team-filter");
  if (filter) filter.addEventListener("change", () => { renderMatches(); scrollToNextMatch(); });
  const standings = document.getElementById("standings-table");
  if (standings) standings.addEventListener("click", (e) => {
    const link = e.target.closest(".team-link");
    if (link) showTeamGames(link.dataset.team);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  window.addEventListener("focus", () => refresh());
}

/* auth.js owns the gate and calls these when the session opens and closes. */
const App = {
  start() {
    wire();
    // The Einstellungen tab only exists for admins.
    const admin = AUTH.isAdmin();
    document.querySelector('.tab[data-tab="einstellungen"]').hidden = !admin;
    if (admin) ADMIN.mount();
    activateTab("tabelle");
    refresh(true);
  },
  // Wipe everything decrypted, in memory and in the DOM, so nothing survives
  // behind the login screen.
  stop() {
    ADMIN.unmount();
    DATA.config = DATA.standings = DATA.matches = DATA.scorers = null;
    DATA.players = DATA.lineups = DATA.friendlies = null;
    lastLoad = 0;
    document.querySelector("#standings-table tbody").innerHTML = "";
    ["match-list", "scorer-list", "team-filter",
     "settings-match", "scorer-editor"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });
    ["updated-label", "standings-group"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = id === "standings-group" ? "Tabelle" : "";
    });
    const err = document.getElementById("error-box");
    if (err) { err.hidden = true; err.innerHTML = ""; }
    const banner = document.getElementById("sample-banner");
    if (banner) banner.hidden = true;
  },
};
