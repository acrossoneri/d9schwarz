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
  const AUTH_FILE = "data/auth.json";
  const TOKEN_KEY = "acr.ghtoken";
  const API = "https://api.github.com";

  let mounted = false;
  let dirty = false;
  let selectedId = null;

  const el = id => document.getElementById(id);
  const allMatches = () => (DATA.matches && DATA.matches.matches) || [];
  const byMatch = () => (DATA.scorers && DATA.scorers.byMatch) || {};

  /* ---------- token ---------- */

  const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
  const setToken = t => t ? localStorage.setItem(TOKEN_KEY, t)
                          : localStorage.removeItem(TOKEN_KEY);

  /* ---------- match picker ---------- */

  function matchLabel(m) {
    const d = m.date ? m.date.slice(8, 10) + "." + m.date.slice(5, 7) + "." : "";
    const score = m.status === "played" ? ` ${m.homeScore}:${m.awayScore}` : "";
    return `${d} ${m.home} – ${m.away}${score}`;
  }

  function renderMatchPicker() {
    const sel = el("settings-match");
    if (!sel) return;
    const our = DATA.config && DATA.config.ourTeam;
    const byDateDesc = (a, b) => (b.date || "").localeCompare(a.date || "");
    const ours = allMatches().filter(m => m.home === our || m.away === our).sort(byDateDesc);
    const rest = allMatches().filter(m => m.home !== our && m.away !== our).sort(byDateDesc);

    sel.innerHTML = "";
    const group = (label, list) => {
      if (!list.length) return;
      const g = document.createElement("optgroup");
      g.label = label;
      list.forEach(m => {
        const o = document.createElement("option");
        o.value = m.id;
        // textContent, never innerHTML — team names come from scraped HTML.
        o.textContent = matchLabel(m) + (byMatch()[m.id] ? "  ●" : "");
        g.appendChild(o);
      });
      sel.appendChild(g);
    };
    group("Unsere Spiele", ours);
    group("Andere Spiele", rest);

    const ids = allMatches().map(m => m.id);
    if (!ids.includes(selectedId)) selectedId = (ours[0] || rest[0] || {}).id || null;
    if (selectedId) sel.value = selectedId;
  }

  /* ---------- scorer rows ---------- */

  function currentMatch() {
    return allMatches().find(m => m.id === selectedId) || null;
  }

  function rowsFor(m) {
    // Only materialise an entry once the admin actually edits this match, so
    // untouched matches stay absent from the file.
    const list = byMatch()[m.id];
    return Array.isArray(list) ? list : (m.scorers || []);
  }

  function makeRow(m, scorer, index) {
    const row = document.createElement("div");
    row.className = "sc-row";
    row.dataset.index = index;

    const name = document.createElement("input");
    name.type = "text";
    name.className = "sc-player";
    name.placeholder = "Name";
    name.autocomplete = "off";
    name.value = (scorer && scorer.player) || "";

    const team = document.createElement("select");
    team.className = "sc-team";
    [m.home, m.away].forEach(t => {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      team.appendChild(o);
    });
    team.value = (scorer && scorer.team) || m.home;

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

    [name, team, min].forEach(inp =>
      inp.addEventListener("input", () => { commitRows(); markDirty(); }));

    row.append(name, team, min, del);
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
    const list = rowsFor(m);
    if (!list.length) box.appendChild(hint("Noch keine Torschützen für dieses Spiel."));
    list.forEach((s, i) => box.appendChild(makeRow(m, s, i)));

    const total = list.filter(s => s && s.player && s.player.trim()).length;
    const expected = m.status === "played" ? (m.homeScore || 0) + (m.awayScore || 0) : null;
    if (expected != null && total !== expected) {
      box.appendChild(hint(`Resultat ${m.homeScore}:${m.awayScore} = ${expected} Tore, `
                          + `erfasst sind ${total}.`, "warn"));
    }
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
      const entry = { player, team: row.querySelector(".sc-team").value };
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
    const our = DATA.config && DATA.config.ourTeam;
    const team = (m.home === our || m.away === our) ? our : m.home;
    byMatch()[m.id].push({ player: "", team });
    markDirty();
    renderEditor();
    const last = el("scorer-editor").querySelector(".sc-row:last-of-type .sc-player");
    if (last) last.focus();
  }

  /* ---------- state ---------- */

  function markDirty() {
    dirty = true;
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
      s.className = "publish-state" + (kind ? " " + kind : "");
      s.textContent = message
        || (dirty ? "Ungespeicherte Änderungen." : "Alles gespeichert.");
    }
    const btn = el("publish-btn");
    if (btn) btn.disabled = busy || !dirty;
    const tok = el("token-state");
    if (tok) {
      tok.textContent = getToken()
        ? "Token gespeichert — Veröffentlichen geht direkt."
        : "Kein Token — Speichern lädt die Datei herunter, du musst sie selbst committen.";
    }
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

  function download(text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "scorers.enc.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function fileText() {
    commitRows();
    const env = await AUTH.encryptEnvelope(payload(), stamp());
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

  async function publish() {
    busy = true;
    renderStatus("Wird veröffentlicht …");
    try {
      const text = await fileText();
      if (!getToken()) {
        download(text);
        busy = false;
        renderStatus("Datei heruntergeladen — bitte als " + FILE + " committen.", "ok");
        return;
      }
      const err = await commitFile(FILE, text, "data: Torschützen manuell erfasst");
      busy = false;
      if (err) { renderStatus(err, "err"); return; }
      dirty = false;
      renderMatchPicker();
      renderStatus("Veröffentlicht. " + LIVE_SOON, "ok");
    } catch (err) {
      console.error(err);
      busy = false;
      renderStatus("Veröffentlichen fehlgeschlagen. Details in der Konsole.", "err");
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

  function mount() {
    if (mounted) return;
    mounted = true;

    el("settings-match").addEventListener("change", (e) => {
      selectedId = e.target.value;
      renderEditor();
    });
    el("scorer-add").addEventListener("click", addRow);
    el("publish-btn").addEventListener("click", publish);
    el("user-add").addEventListener("click", addUser);
    el("new-pass").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addUser(); }
    });
    el("download-btn").addEventListener("click", async () => {
      try { download(await fileText()); }
      catch (err) { console.error(err); renderStatus("Export fehlgeschlagen.", "err"); }
    });
    el("token-save").addEventListener("click", async () => {
      const input = el("token-input");
      const state = el("token-state");
      const value = input.value.trim();
      setToken(value);
      input.value = "";
      if (!value) { renderStatus(); state.textContent = "Token entfernt."; return; }
      state.textContent = "Token wird geprüft …";
      try {
        const r = await ghFetch(`/repos/${REPO}/contents/${FILE}`);
        state.textContent = r.ok ? "Token funktioniert." : `Token abgelehnt (${r.status}).`;
      } catch { state.textContent = "Token konnte nicht geprüft werden."; }
    });

    // A half-typed scorer is easy to lose on a phone; warn before leaving.
    window.addEventListener("beforeunload", (e) => {
      if (dirty) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function unmount() {
    dirty = false;
    selectedId = null;
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

  function render() {
    if (!AUTH.isAdmin()) return;
    renderMatchPicker();
    renderEditor();
    renderStatus();
    renderUsers();
  }

  return {
    mount, unmount, render,
    isDirty: () => dirty,
    discard: () => { dirty = false; },
  };
})();
