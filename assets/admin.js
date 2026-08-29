/* AC Rossoneri – Einstellungen (nur Admin).

   Lets an admin enter goal scorers by hand, for when the matchcenter game report
   has none. They are kept in data/scorers.enc.json, a file the scraper never
   writes, so an hourly scrape can never wipe them.

   Saving on a static site: there is nothing to POST to, so publishing goes
   straight to GitHub's Contents API with a fine-grained token the admin stores
   on their own device. Without a token the encrypted file can still be
   downloaded and committed by hand. Note the consequence: the login gates the
   UI, but the GitHub token is what actually gates publishing. */

const ADMIN = (() => {
  const REPO = "acrossoneri/d9schwarz";
  const FILE = "data/scorers.enc.json";
  const PLAYERS_FILE = "data/players.enc.json";
  const LINEUP_FILE = "data/lineups.enc.json";
  const ADMIN_FILE = "data/admin.enc.json";
  const AUTH_FILE = "data/auth.json";
  const TOKEN_KEY = "acr.ghtoken";
  const DRAFT_KEY = "acr.draft";
  const API = "https://api.github.com";

  let mounted = false;
  let dirty = false;          // unsaved scorer edits
  let dirtyPlayers = false;   // unsaved roster edits
  let dirtyLineup = false;    // unsaved line-up edits
  let selectedId = null;

  const el = id => document.getElementById(id);
  const allMatches = () => (DATA.matches && DATA.matches.matches) || [];
  const byMatch = () => (DATA.scorers && DATA.scorers.byMatch) || {};
  const ourTeam = () => (DATA.config && DATA.config.ourTeam) || "";
  const byMatchLineup = () => (DATA.lineups && DATA.lineups.byMatch) || {};

  /* Torschützen werden von Hand erfasst, darum nur für unser eigenes Team: für
     fremde Paarungen liegen die Namen gar nicht vor. Deshalb stehen hier auch
     nur unsere Spiele zur Auswahl, und jede Zeile gehört automatisch uns. */
  const ourMatches = () => allMatches()
    .filter(m => m.home === ourTeam() || m.away === ourTeam())
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  /* ---------- unsaved work ---------- */

  /* Edits live in memory until "Veröffentlichen" commits them, so a reload, a
     closed tab or a failed publish used to lose them silently. They are mirrored
     into localStorage on every keystroke and restored on mount; publishing clears
     them. Per device, never uploaded — the encrypted files remain the record. */

  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        at: Date.now(),
        scorers: dirty ? byMatch() : null,
        lineups: dirtyLineup ? byMatchLineup() : null,
        players: dirtyPlayers ? roster() : null,
      }));
    } catch { /* private mode, quota — the editor still works, just unprotected */ }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
  }

  // Returns a note for the status line if anything was recovered.
  function restoreDraft() {
    let d;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return ""; }
    if (!d) return "";
    const what = [];
    if (d.scorers && DATA.scorers) {
      DATA.scorers.byMatch = d.scorers; dirty = true; what.push("Torschützen");
    }
    if (d.lineups && DATA.lineups) {
      DATA.lineups.byMatch = d.lineups; dirtyLineup = true; what.push("Aufstellung");
    }
    if (d.players && DATA.players) {
      DATA.players.players = d.players; dirtyPlayers = true; what.push("Spieler");
    }
    if (!what.length) return "";
    mergeScorers();
    mergeLineups();
    const when = d.at ? new Date(d.at).toLocaleString("de-CH") : "";
    return `Nicht veröffentlichte Änderungen wiederhergestellt (${what.join(", ")}`
         + (when ? `, ${when}` : "") + "). Bitte veröffentlichen.";
  }

  /* ---------- token ---------- */

  /* The token lives in data/admin.enc.json, encrypted with the master key, so every
     admin device inherits it and nobody has to paste it. It is NOT in the source:
     a plaintext token in a public repo is world-readable repo write access, and
     GitHub's push protection/secret scanning would revoke it within minutes anyway.
     A localStorage entry can override it per device. */
  let repoToken = null;

  async function loadRepoToken() {
    try {
      const a = await AUTH.decryptJSON(ADMIN_FILE);
      repoToken = (a && a.ghToken) || null;
    } catch { repoToken = null; }   // missing file is fine
  }

  const getToken = () => localStorage.getItem(TOKEN_KEY) || repoToken || "";
  const setLocalToken = t => t ? localStorage.setItem(TOKEN_KEY, t)
                               : localStorage.removeItem(TOKEN_KEY);

  const maskToken = t => t.length > 12 ? t.slice(0, 7) + "…" + t.slice(-4) : "…";

  function renderTokenState(message) {
    const state = el("token-state");
    const has = !!getToken();
    const fromRepo = !localStorage.getItem(TOKEN_KEY) && !!repoToken;
    if (state) {
      state.textContent = message || (has
        ? `Aktiv (${maskToken(getToken())}) — ${fromRepo
            ? "verschlüsselt in der Seite gespeichert, gilt auf allen Admin-Geräten."
            : "auf diesem Gerät gespeichert."} Kein Eingeben nötig.`
        : "Kein Token — „Speichern“ lädt die Datei stattdessen herunter.");
    }
    const rm = el("token-remove");
    if (rm) rm.hidden = !has;
  }

  /* ---------- match picker ---------- */

  function matchLabel(m) {
    const d = m.date ? m.date.slice(8, 10) + "." + m.date.slice(5, 7) + "." : "";
    const score = m.status === "played" ? ` ${m.homeScore}:${m.awayScore}` : "";
    return `${d} ${m.home} – ${m.away}${score}`;
  }

  function renderMatchPicker() {
    const sel = el("settings-match");
    if (!sel) return;
    const ours = ourMatches();

    sel.innerHTML = "";
    ours.forEach(m => {
      const o = document.createElement("option");
      o.value = m.id;
      // textContent, never innerHTML — team names come from scraped HTML.
      o.textContent = matchLabel(m) + (byMatch()[m.id] ? "  ●" : "");
      sel.appendChild(o);
    });

    if (!ours.some(m => m.id === selectedId)) selectedId = (ours[0] || {}).id || null;
    if (selectedId) sel.value = selectedId;
  }

  /* ---------- scorer rows ---------- */

  function currentMatch() {
    return ourMatches().find(m => m.id === selectedId) || null;
  }

  function rowsFor(m) {
    // Only materialise an entry once the admin actually edits this match, so
    // untouched matches stay absent from the file.
    const list = byMatch()[m.id];
    return Array.isArray(list) ? list : (m.scorers || []);
  }

  // Erfasst wird nur noch unser Team. Ältere Einträge gegnerischer Teams werden
  // darum nicht mehr angezeigt — renderEditor weist auf sie hin, bevor ein
  // Speichern dieses Spiels sie fallen lässt.
  const isOurs = s => !s || !s.team || s.team === ourTeam();

  function makeRow(m, scorer, index) {
    const row = document.createElement("div");
    row.className = "sc-row";
    row.dataset.index = index;

    const name = document.createElement("input");
    name.type = "text";
    name.className = "sc-player";
    name.placeholder = "Name";
    name.autocomplete = "off";
    // Suggests our squad while still allowing a typed-in opponent name.
    name.setAttribute("list", "roster-list");
    name.value = (scorer && scorer.player) || "";

    const min = document.createElement("input");
    min.type = "number";
    min.className = "sc-min";
    min.min = "1";
    min.max = "200";
    min.placeholder = "Min.";
    min.value = scorer && scorer.minute != null ? scorer.minute : "";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "sc-del";
    del.title = "Entfernen";
    del.setAttribute("aria-label", "Torschütze entfernen");
    del.textContent = "×";
    del.addEventListener("click", () => {
      commitRows();
      byMatch()[m.id].splice(index, 1);
      markDirty();
      renderEditor();
    });

    [name, min].forEach(inp =>
      inp.addEventListener("input", () => { commitRows(); markDirty(); }));

    row.append(name, min, del);
    return row;
  }

  function renderEditor() {
    const box = el("scorer-editor");
    if (!box) return;
    box.innerHTML = "";
    const m = currentMatch();
    if (!m) {
      box.appendChild(hint("Kein Spiel ausgewählt."));
      return;
    }
    const list = rowsFor(m).filter(isOurs);
    const dropped = rowsFor(m).length - list.length;
    if (!list.length) box.appendChild(hint("Noch keine Torschützen für dieses Spiel."));
    list.forEach((s, i) => box.appendChild(makeRow(m, s, i)));
    if (dropped) {
      box.appendChild(hint(`${dropped} ältere${dropped === 1 ? "r Eintrag" : " Einträge"} `
                          + `gegnerischer Teams werden beim nächsten Speichern entfernt.`, "warn"));
    }

    // Nur unsere Tore werden erfasst, also zählt auch nur unsere Hälfte des Resultats.
    const total = list.filter(s => s && s.player && s.player.trim()).length;
    const expected = m.status === "played"
      ? (m.home === ourTeam() ? m.homeScore : m.awayScore) || 0
      : null;
    if (expected != null && total !== expected) {
      box.appendChild(hint(`Resultat ${m.homeScore}:${m.awayScore} — ${expected} eigene `
                          + `${expected === 1 ? "Tor" : "Tore"}, erfasst sind ${total}.`, "warn"));
    }
    // Suggestions and the line-up both follow the selected game.
    renderLineup();
    renderRosterOptions();
  }

  function hint(text, cls) {
    const p = document.createElement("p");
    p.className = "hint" + (cls ? " " + cls : "");
    p.textContent = text;
    return p;
  }

  // Read every row back into DATA.scorers, so the other tabs can re-render from
  // the same data the file will hold.
  function commitRows() {
    const m = currentMatch();
    if (!m) return;
    const out = [];
    el("scorer-editor").querySelectorAll(".sc-row").forEach(row => {
      const player = row.querySelector(".sc-player").value.trim();
      const entry = { player, team: ourTeam() };
      const min = parseInt(row.querySelector(".sc-min").value, 10);
      if (Number.isFinite(min)) entry.minute = min;
      out.push(entry);
    });
    byMatch()[m.id] = out;
  }

  function addRow() {
    const m = currentMatch();
    if (!m) return;
    commitRows();
    byMatch()[m.id].push({ player: "", team: ourTeam() });
    markDirty();
    renderEditor();
    const last = el("scorer-editor").querySelector(".sc-row:last-of-type .sc-player");
    if (last) last.focus();
  }

  /* ---------- our line-up ---------- */

  /* The coach files the Aufstellung with the association before every game, so we
     already have it — typing it here is the short way round. Kept in its own file,
     which the scraper never writes, and merged into the game detail on display. */

  const ROLES = [
    ["start", "Start"],
    ["captain", "Start · C"],
    ["sub", "Ersatz"],
    ["unused", "Ersatz · kein Einsatz"],
  ];

  function lineupRows(m) {
    const stored = byMatchLineup()[m.id];
    if (!stored) return [];
    return [...(stored.starting || []).map(p => ({ ...p, role: p.captain ? "captain" : "start" })),
            ...(stored.subs || []).map(p => ({ ...p, role: p.unused ? "unused" : "sub" }))];
  }

  function makeLineupRow(m, player, index) {
    const row = document.createElement("div");
    row.className = "lu-row";
    row.dataset.index = index;

    const num = document.createElement("input");
    num.type = "number";
    num.className = "lu-nr";
    num.min = "1";
    num.max = "99";
    num.placeholder = "Nr.";
    num.value = player && player.number != null ? player.number : "";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "lu-name";
    name.placeholder = "Name";
    name.autocomplete = "off";
    name.setAttribute("list", "roster-list");
    name.value = (player && player.name) || "";

    const pos = document.createElement("input");
    pos.type = "text";
    pos.className = "lu-pos";
    pos.placeholder = "Position";
    pos.autocomplete = "off";
    pos.setAttribute("list", "position-list");
    pos.value = (player && player.position) || "";

    const role = document.createElement("select");
    role.className = "lu-role";
    ROLES.forEach(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      role.appendChild(o);
    });
    role.value = (player && player.role) || "start";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "sc-del";
    del.title = "Entfernen";
    del.setAttribute("aria-label", "Spieler entfernen");
    del.textContent = "×";
    del.addEventListener("click", () => {
      const list = commitLineup();
      list.splice(index, 1);
      storeLineup(m, list);
      markLineupDirty();
      renderLineup();
    });

    [num, name, pos, role].forEach(inp =>
      inp.addEventListener("input", () => { storeLineup(m, commitLineup()); markLineupDirty(); }));

    row.append(num, name, pos, role, del);
    return row;
  }

  function renderLineup() {
    const box = el("lineup-editor");
    if (!box) return;
    box.innerHTML = "";
    const m = currentMatch();
    if (!m) {
      box.appendChild(hint("Kein Spiel ausgewählt."));
      return;
    }
    const rows = lineupRows(m);
    if (!rows.length) {
      box.appendChild(hint("Noch keine Aufstellung für dieses Spiel."));
    }
    rows.forEach((p, i) => box.appendChild(makeLineupRow(m, p, i)));

    const starting = rows.filter(p => p.role === "start" || p.role === "captain").length;
    if (starting && starting !== 9) {
      box.appendChild(hint(`${starting} in der Startformation — im D-9 sind es neun.`, "warn"));
    }
    if (rows.filter(p => p.role === "captain").length > 1) {
      box.appendChild(hint("Mehr als ein Captain markiert.", "warn"));
    }
  }

  // Read the rows back out of the DOM, in the order they appear.
  function commitLineup() {
    const box = el("lineup-editor");
    if (!box) return [];
    return [...box.querySelectorAll(".lu-row")].map(row => {
      const p = { name: row.querySelector(".lu-name").value.trim(),
                  role: row.querySelector(".lu-role").value };
      const n = parseInt(row.querySelector(".lu-nr").value, 10);
      if (Number.isFinite(n)) p.number = n;
      const pos = row.querySelector(".lu-pos").value.trim();
      if (pos) p.position = pos;
      return p;
    });
  }

  // Split the flat editor list back into the shape the display expects.
  function storeLineup(m, rows) {
    const shape = p => {
      const out = { name: p.name };
      if (p.number != null) out.number = p.number;
      if (p.position) out.position = p.position;
      if (p.role === "captain") out.captain = true;
      if (p.role === "unused") out.unused = true;
      return out;
    };
    byMatchLineup()[m.id] = {
      starting: rows.filter(p => p.role === "start" || p.role === "captain").map(shape),
      subs: rows.filter(p => p.role === "sub" || p.role === "unused").map(shape),
    };
  }

  function addLineupRow() {
    const m = currentMatch();
    if (!m) return;
    const rows = commitLineup();
    const starting = rows.filter(p => p.role === "start" || p.role === "captain").length;
    rows.push({ name: "", role: starting < 9 ? "start" : "sub" });
    storeLineup(m, rows);
    markLineupDirty();
    renderLineup();
    const last = el("lineup-editor").querySelector(".lu-row:last-of-type .lu-name");
    if (last) last.focus();
  }

  // Carry last game's squad over — most of the names repeat week to week.
  function copyPreviousLineup() {
    const m = currentMatch();
    if (!m) return;
    const earlier = ourMatches().filter(x => (x.date || "") < (m.date || ""));
    const source = earlier.find(x => (byMatchLineup()[x.id] || {}).starting);
    if (!source) {
      renderStatus("Kein früheres Spiel mit Aufstellung gefunden.", "err");
      return;
    }
    byMatchLineup()[m.id] = JSON.parse(JSON.stringify(byMatchLineup()[source.id]));
    markLineupDirty();
    renderLineup();
    renderStatus(`Aufstellung von ${matchLabel(source)} übernommen.`, "ok");
  }

  function markLineupDirty() {
    dirtyLineup = true;
    saveDraft();
    renderRosterOptions();
    renderStatus();
  }

  async function lineupFileText() {
    const out = {};
    Object.entries(byMatchLineup()).forEach(([id, l]) => {
      const clean = list => (list || []).filter(p => p && p.name && p.name.trim())
                                        .map(p => ({ ...p, name: p.name.trim() }));
      const starting = clean(l && l.starting);
      const subs = clean(l && l.subs);
      if (starting.length || subs.length) out[id] = { starting, subs };
    });
    const env = await AUTH.encryptEnvelope({ byMatch: out }, stamp());
    return JSON.stringify(env, null, 2) + "\n";
  }

  /* ---------- our players ---------- */

  const roster = () => (DATA.players && DATA.players.players) || [];

  function renderPlayers() {
    const box = el("player-editor");
    if (!box) return;
    const label = el("roster-team");
    if (label) label.textContent = (DATA.config && DATA.config.ourTeam) || "unserem Team";
    box.innerHTML = "";
    const list = roster();
    if (!list.length) {
      box.appendChild(hint("Noch keine Spieler erfasst. Sie erscheinen dann beim "
                         + "Erfassen der Torschützen als Vorschlag."));
    }
    list.forEach((player, index) => {
      const row = document.createElement("div");
      row.className = "sc-row player-row";

      const name = document.createElement("input");
      name.type = "text";
      name.className = "sc-player";
      name.placeholder = "Name";
      name.autocomplete = "off";
      name.value = player || "";
      name.addEventListener("input", () => { commitPlayers(); markPlayersDirty(); });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "sc-del";
      del.title = "Entfernen";
      del.setAttribute("aria-label", `${player || "Spieler"} entfernen`);
      del.textContent = "×";
      del.addEventListener("click", () => {
        commitPlayers();
        roster().splice(index, 1);
        markPlayersDirty();
        renderPlayers();
      });

      row.append(name, del);
      box.appendChild(row);
    });
    renderRosterOptions();
  }

  // Everyone the matchcenter listed in OUR line-up for a game — the match-day
  // squad, spelled the way the Verband spells it. Better than the hand-kept roster
  // for a specific game: it is exactly the players who could have scored.
  function matchSquad(m) {
    const lineups = (m && m.detail && m.detail.lineups) || [];
    // By name first. The parser emits home before away, so the side we play on is
    // the fallback for the day the matchcenter spells our name differently.
    const side = m && m.away === ourTeam() ? 1 : 0;
    const ours = lineups.find(l => l && l.team === ourTeam()) || lineups[side];
    if (!ours) return [];
    return [...(ours.starting || []), ...(ours.subs || [])]
      .filter(p => p && !p.unused)
      .map(p => (p.name || "").trim())
      .filter(Boolean);
  }

  // Feeds the <datalist> the scorer name fields suggest from: the line-up of the
  // selected game first, then the hand-kept roster for games without one.
  function renderRosterOptions() {
    const dl = el("roster-list");
    if (!dl) return;
    dl.innerHTML = "";
    const m = currentMatch();
    const own = (m && byMatchLineup()[m.id]) || null;
    const typed = own ? [...(own.starting || []), ...(own.subs || [])]
                          .map(p => (p.name || "").trim()).filter(Boolean)
                      : [];
    const squad = typed.length ? typed : matchSquad(m);
    const rest = roster().map(p => (p || "").trim()).filter(Boolean)
                         .sort((a, b) => a.localeCompare(b));
    const seen = new Set();
    [...squad, ...rest].forEach(name => {
      if (seen.has(name)) return;
      seen.add(name);
      const o = document.createElement("option");
      o.value = name;
      dl.appendChild(o);
    });
  }

  function commitPlayers() {
    const box = el("player-editor");
    if (!box) return;
    DATA.players.players = [...box.querySelectorAll(".player-row .sc-player")]
      .map(i => i.value);
  }

  function addPlayer() {
    commitPlayers();
    roster().push("");
    markPlayersDirty();
    renderPlayers();
    const last = el("player-editor").querySelector(".player-row:last-of-type .sc-player");
    if (last) last.focus();
  }

  function markPlayersDirty() {
    dirtyPlayers = true;
    saveDraft();
    renderRosterOptions();
    renderStatus();
  }

  /* ---------- state ---------- */

  function markDirty() {
    dirty = true;
    saveDraft();
    // Let the Spiele and Torschützen tabs show the edit right away.
    mergeScorers();
    renderMatches();
    renderScorers();
    renderStatus();
  }

  let busy = false;
  function renderStatus(message, kind) {
    const s = el("publish-state");
    if (s) {
      const what = [dirty ? "Torschützen" : "", dirtyLineup ? "Aufstellung" : "",
                    dirtyPlayers ? "Spieler" : ""].filter(Boolean);
      s.className = "publish-state" + (kind ? " " + kind : "");
      s.textContent = message
        || (what.length ? `Ungespeicherte Änderungen (${what.join(" und ")}).`
                        : "Alles gespeichert.");
    }
    const btn = el("publish-btn");
    if (btn) btn.disabled = busy || !(dirty || dirtyLineup || dirtyPlayers);
    renderTokenState();
  }

  /* ---------- publishing ---------- */

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
         + `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function payload() {
    // Blank names are dropped; an empty list is kept, because "this match had no
    // scorers" is a statement the admin may want to make.
    const out = {};
    Object.entries(byMatch()).forEach(([id, list]) => {
      out[id] = (list || [])
        .filter(s => s && s.player && s.player.trim())
        .map(s => {
          const e = { player: s.player.trim(), team: s.team };
          if (Number.isFinite(s.minute)) e.minute = s.minute;
          return e;
        });
    });
    return { byMatch: out };
  }

  function utf8Base64(text) {
    const bytes = new TextEncoder().encode(text);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function download(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "scorers.enc.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function fileText() {
    commitRows();
    const env = await AUTH.encryptEnvelope(payload(), stamp());
    return JSON.stringify(env, null, 2) + "\n";
  }

  async function playersFileText() {
    commitPlayers();
    // Trimmed, de-duplicated and sorted, so the file stays tidy and stable.
    const clean = [...new Set(roster().map(p => (p || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const env = await AUTH.encryptEnvelope({ players: clean }, stamp());
    return JSON.stringify(env, null, 2) + "\n";
  }

  async function ghFetch(path, options) {
    return fetch(API + path, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${getToken()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options && options.headers),
      },
    });
  }

  /* Commit one file through the Contents API. Returns null on success, else a
     message ready to show. */
  async function commitFile(path, text, message) {
    const head = await ghFetch(`/repos/${REPO}/contents/${path}`);
    if (head.status === 401) return "Token ungültig oder abgelaufen.";
    // The Contents API needs the blob sha of the file being replaced.
    const sha = head.ok ? (await head.json()).sha : undefined;
    const res = await ghFetch(`/repos/${REPO}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: utf8Base64(text),
        branch: "main",
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.ok) return null;
    const detail = await res.json().catch(() => ({}));
    // 409 = someone else changed the file since we read the sha.
    return res.status === 409
      ? "Konflikt — bitte neu laden und nochmals versuchen."
      : `Fehler ${res.status}: ${detail.message || "Veröffentlichen fehlgeschlagen."}`;
  }

  const LIVE_SOON = "Für andere sichtbar, sobald GitHub Pages neu gebaut hat "
                  + "(etwa eine Minute).";

  // Encrypt the token into the site. Returns null on success, else a message.
  async function saveRepoToken(token) {
    try {
      const env = await AUTH.encryptEnvelope(token ? { ghToken: token } : {}, null);
      return await commitFile(ADMIN_FILE, JSON.stringify(env, null, 2) + "\n",
                              token ? "auth: GitHub-Token gesetzt"
                                    : "auth: GitHub-Token entfernt");
    } catch (err) {
      console.error(err);
      return "Token konnte nicht gespeichert werden.";
    }
  }

  async function publish() {
    busy = true;
    renderStatus("Wird veröffentlicht …");
    try {
      // Only touch what actually changed, so each publish is one small commit.
      const jobs = [];
      if (dirty) jobs.push([FILE, await fileText(), "data: Torschützen manuell erfasst"]);
      if (dirtyLineup) jobs.push([LINEUP_FILE, await lineupFileText(),
                                  "data: Aufstellung erfasst"]);
      if (dirtyPlayers) jobs.push([PLAYERS_FILE, await playersFileText(),
                                   "data: Spielerliste aktualisiert"]);
      if (!jobs.length) { busy = false; renderStatus(); return; }

      if (!getToken()) {
        jobs.forEach(([path, text]) => download(text, path.split("/").pop()));
        busy = false;
        renderStatus("Datei(en) heruntergeladen — bitte in data/ committen.", "ok");
        return;
      }
      for (const [path, text, message] of jobs) {
        const err = await commitFile(path, text, message);
        if (err) {
          busy = false;
          // The draft stays put, so nothing is lost while the cause is sorted out.
          renderStatus(err + " — Änderungen bleiben auf diesem Gerät gespeichert.", "err");
          return;
        }
        if (path === FILE) dirty = false;
        else if (path === LINEUP_FILE) dirtyLineup = false;
        else dirtyPlayers = false;
      }
      busy = false;
      clearDraft();
      renderMatchPicker();
      renderLineup();
      renderPlayers();
      renderStatus("Veröffentlicht. " + LIVE_SOON, "ok");
    } catch (err) {
      console.error(err);
      busy = false;
      renderStatus("Veröffentlichen fehlgeschlagen — Änderungen bleiben auf diesem "
                 + "Gerät gespeichert. Details in der Konsole.", "err");
    }
  }

  /* ---------- accounts ---------- */

  function userStatus(message, kind) {
    const s = el("user-state");
    if (!s) return;
    s.className = "publish-state" + (kind ? " " + kind : "");
    s.textContent = message || "";
  }

  // Every account change rewrites data/auth.json, so it needs the token too.
  async function saveAccounts(nextCfg, note) {
    if (!getToken()) {
      userStatus("Dafür braucht es den GitHub-Token (siehe unten).", "err");
      return false;
    }
    userStatus("Wird gespeichert …");
    const err = await commitFile(AUTH_FILE, AUTH.serializeCfg(nextCfg),
                                "auth: Konten aktualisiert");
    if (err) { userStatus(err, "err"); return false; }
    await AUTH.adoptCfg(nextCfg);
    await renderUsers();
    userStatus(note + " " + LIVE_SOON, "ok");
    return true;
  }

  function roleSelect(value) {
    const sel = document.createElement("select");
    sel.className = "sc-team";
    [["viewer", "Nur lesen"], ["admin", "Admin"]].forEach(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    });
    sel.value = value;
    return sel;
  }

  async function renderUsers() {
    const box = el("user-list");
    if (!box) return;
    box.innerHTML = "";
    let list;
    try { list = await AUTH.accounts(); }
    catch (err) { console.error(err); box.appendChild(hint("Konten nicht lesbar.")); return; }

    list.forEach(acc => {
      const row = document.createElement("div");
      row.className = "user-row";

      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = acc.user;                       // textContent, never HTML
      if (acc.user === AUTH.me()) {
        const you = document.createElement("span");
        you.className = "user-you";
        you.textContent = "du";
        // real space, so a screen reader doesn't read "admindu"
        name.append(" ", you);
      }

      const role = roleSelect(acc.role);
      role.addEventListener("change", async () => {
        const wanted = role.value;
        role.disabled = true;
        try {
          const next = await AUTH.setRole(acc.user, wanted);
          if (!await saveAccounts(next, `Rolle von „${acc.user}“ geändert.`)) {
            role.value = acc.role;
          }
        } catch (e) { userStatus(e.message, "err"); role.value = acc.role; }
        finally { role.disabled = false; }
      });

      const pw = document.createElement("button");
      pw.type = "button";
      pw.className = "btn-secondary btn-slim";
      pw.textContent = "Passwort";
      pw.addEventListener("click", async () => {
        const next = prompt(`Neues Passwort für „${acc.user}“:`);
        if (next == null || !next.trim()) return;
        try {
          const cfg = await AUTH.resetPassword(acc.user, next);
          await saveAccounts(cfg, `Passwort von „${acc.user}“ neu gesetzt.`);
        } catch (e) { userStatus(e.message, "err"); }
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "sc-del";
      del.title = "Konto löschen";
      del.setAttribute("aria-label", `Konto ${acc.user} löschen`);
      del.textContent = "×";
      del.addEventListener("click", async () => {
        if (!confirm(`Konto „${acc.user}“ wirklich löschen?`)) return;
        try {
          const cfg = await AUTH.removeAccount(acc.user);
          await saveAccounts(cfg, `Konto „${acc.user}“ gelöscht.`);
        } catch (e) { userStatus(e.message, "err"); }
      });

      row.append(name, role, pw, del);
      box.appendChild(row);
    });
  }

  async function addUser() {
    const nameEl = el("new-user");
    const passEl = el("new-pass");
    const roleEl = el("new-role");
    try {
      const cfg = await AUTH.addAccount(nameEl.value, passEl.value, roleEl.value);
      if (await saveAccounts(cfg, `Konto „${nameEl.value.trim()}“ angelegt.`)) {
        nameEl.value = "";
        passEl.value = "";
        roleEl.value = "viewer";
      }
    } catch (e) { userStatus(e.message, "err"); }
  }

  /* ---------- wiring ---------- */

  // Bind if the element is there. A page served from cache can be one deploy behind
  // this script; without the guard the first missing id threw and everything after
  // it — including the publish button — silently stayed unwired.
  function on(id, event, handler) {
    const node = el(id);
    if (node) node.addEventListener(event, handler);
    else console.warn(`admin: #${id} fehlt — Seite neu laden (Strg+Umschalt+R).`);
  }

  function mount() {
    if (mounted) return;
    mounted = true;

    on("settings-match", "change", (e) => {
      selectedId = e.target.value;
      renderEditor();
    });
    on("scorer-add", "click", addRow);
    on("lineup-add", "click", addLineupRow);
    on("lineup-copy", "click", copyPreviousLineup);
    on("player-add", "click", addPlayer);
    on("publish-btn", "click", publish);
    on("user-add", "click", addUser);
    on("new-pass", "keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addUser(); }
    });
    on("download-btn", "click", async () => {
      try {
        download(await fileText(), "scorers.enc.json");
        download(await playersFileText(), "players.enc.json");
      } catch (err) { console.error(err); renderStatus("Export fehlgeschlagen.", "err"); }
    });
    el("token-save").addEventListener("click", async () => {
      const input = el("token-input");
      const value = input.value.trim();
      if (!value) { renderTokenState("Bitte zuerst einen Token einfügen."); return; }
      setLocalToken(value);
      input.value = "";
      renderTokenState("Token wird geprüft …");
      try {
        const r = await ghFetch(`/repos/${REPO}/contents/${FILE}`);
        if (!r.ok) {
          renderTokenState(`Token abgelehnt (${r.status}). Bitte Berechtigung `
                         + "„Contents: Read and write“ prüfen.");
          return;
        }
        // Store it encrypted in the site too, so other admin devices inherit it.
        renderTokenState("Token gültig — wird für alle Admin-Geräte gespeichert …");
        const err = await saveRepoToken(value);
        renderTokenState(err || undefined);
        if (!err) { repoToken = value; setLocalToken(""); renderTokenState(); }
      } catch { renderTokenState("Token konnte nicht geprüft werden."); }
    });

    el("token-remove").addEventListener("click", async () => {
      el("token-input").value = "";
      setLocalToken("");
      if (!repoToken) { renderTokenState("Token entfernt."); return; }
      if (!confirm("Token auch für alle anderen Admin-Geräte entfernen?")) {
        renderTokenState(); return;
      }
      renderTokenState("Wird entfernt …");
      const err = await saveRepoToken(null);
      if (err) { renderTokenState(err); return; }
      repoToken = null;
      renderTokenState("Token überall entfernt.");
    });

    // A half-typed scorer is easy to lose on a phone; warn before leaving.
    window.addEventListener("beforeunload", (e) => {
      if (dirty || dirtyLineup || dirtyPlayers) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function unmount() {
    dirty = false;
    dirtyLineup = false;
    dirtyPlayers = false;
    selectedId = null;
    ["player-editor", "roster-list", "lineup-editor"].forEach(id => {
      const box = el(id);
      if (box) box.innerHTML = "";
    });
    ["publish-state", "user-state"].forEach(id => {
      const s = el(id);
      if (s) s.textContent = "";
    });
    ["token-input", "new-user", "new-pass"].forEach(id => {
      const t = el(id);
      if (t) t.value = "";
    });
    const list = el("user-list");
    if (list) list.innerHTML = "";
  }

  async function render() {
    if (!AUTH.isAdmin()) return;
    const recovered = restoreDraft();
    renderMatchPicker();
    renderEditor();
    renderPlayers();
    renderStatus(recovered || undefined, recovered ? "warn" : undefined);
    renderUsers();
    await loadRepoToken();
    renderTokenState();
    // Open the token box only on a device that has none — nudge once, then stay
    // out of the way. Set here rather than in renderStatus so it never snaps
    // shut while the box is being used.
    const det = document.querySelector(".token-details");
    if (det) det.open = !getToken();
  }

  return {
    mount, unmount, render,
    isDirty: () => dirty || dirtyLineup || dirtyPlayers,
    // An explicit discard is the one place the saved draft should go too.
    discard: () => { dirty = dirtyLineup = dirtyPlayers = false; clearDraft(); },
  };
})();
