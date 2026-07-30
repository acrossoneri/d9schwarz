/* AC Rossoneri – Zugangsschutz.

   This is a static site, so there is no server to check a password against.
   A login form that only hides a <div> would be pointless — data/matches.json
   could just be opened directly. So the data files themselves are AES-256-GCM
   ciphertext and are unreadable without a password, however they are fetched.

   Several accounts share one set of files: the files are encrypted with a random
   MASTER key, and each account carries that master key wrapped under a key
   derived from its own password (PBKDF2-SHA256). Logging in = unwrapping it.

   Each account also has a `meta` blob holding its name and role, encrypted under
   the MASTER key. That is what lets an admin list accounts and change a role
   without knowing anyone's password, while the public file still names nobody.

   Session handling:
     "Angemeldet bleiben" -> key kept for 30 days
     otherwise            -> key expires after 30 minutes without activity  */

const AUTH = (() => {
  const CFG_URL = "data/auth.json";
  const CHECK_URL = "data/config.enc.json";  // smallest file, used to test a stored key
  const STORE_KEY = "acr.auth";
  const CFG_VERSION = 3;

  const IDLE_MS = 30 * 60 * 1000;                // 30 Minuten Inaktivität
  const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;  // 30 Tage
  const TICK_MS = 15000;                         // how often we check for expiry
  const SAVE_EVERY_MS = 30000;                   // throttle for sliding-expiry writes

  const te = new TextEncoder();
  const td = new TextDecoder();
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64e = b => btoa(String.fromCharCode(...new Uint8Array(b)));
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  const rand = n => crypto.getRandomValues(new Uint8Array(n));

  let cfg = null;        // contents of auth.json
  let aesKey = null;     // master key, in memory only while unlocked
  let hmacKey = null;    // same bytes, for the deterministic nonce
  let masterRaw = null;
  let me = null;         // { uid, user, role }
  let session = null;    // { remember, exp }
  let lastSaved = 0;
  let ticker = null;

  /* ---------- crypto ---------- */

  async function loadCfg(force) {
    if (cfg && !force) return cfg;
    const r = await fetch(CFG_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`auth config: HTTP ${r.status}`);
    const next = await r.json();
    if (next.v !== CFG_VERSION) throw new Error(`auth config v${next.v} not supported`);
    cfg = next;
    return cfg;
  }

  // Accounts are indexed by a hash of the username, so auth.json does not list
  // who has access.
  async function accountId(username) {
    const h = await crypto.subtle.digest("SHA-256", te.encode(username.trim().toLowerCase()));
    return hex(h).slice(0, 32);
  }

  async function deriveUserKey(user, pass, salt, c) {
    const base = await crypto.subtle.importKey(
      "raw", te.encode(user.trim().toLowerCase() + ":" + pass),
      "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: c.iterations, hash: c.hash },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function useMaster(raw) {
    masterRaw = raw;
    aesKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
    hmacKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" },
                                           false, ["sign"]);
  }

  function forgetMaster() {
    aesKey = hmacKey = masterRaw = null;
    me = null;
  }

  async function sealed(key, bytes) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
    return { iv: b64e(iv), ct: b64e(ct) };
  }

  async function opened(key, blob) {
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(blob.iv) }, key, b64d(blob.ct));
  }

  async function readMeta(entry) {
    try {
      const m = JSON.parse(td.decode(await opened(aesKey, entry.meta)));
      return { user: m.user || "?", role: m.role === "admin" ? "admin" : "viewer" };
    } catch { return null; }
  }

  // Returns { raw, uid, user, role } or null. A wrong password yields a wrong
  // wrapping key and AES-GCM's tag check then fails.
  async function tryLogin(user, pass) {
    const c = await loadCfg(true);
    const ids = Object.keys(c.users || {});
    if (!ids.length) throw new Error("auth config has no accounts");
    const uid = await accountId(user);
    const entry = c.users[uid];
    // Run the KDF even for an unknown username, so a wrong name costs the same
    // as a wrong password and the two cannot be told apart by timing.
    const salt = b64d((entry || c.users[ids[0]]).salt);
    const uk = await deriveUserKey(user, pass, salt, c);
    if (!entry) return null;
    let raw;
    try {
      raw = new Uint8Array(await opened(uk, entry));
    } catch { return null; }
    await useMaster(raw);
    const meta = await readMeta(entry);
    return { raw, uid, user: (meta && meta.user) || user.trim(), role: (meta && meta.role) || "viewer" };
  }

  async function decryptJSON(path) {
    if (!aesKey) throw new Error("locked");
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const env = await r.json();
    const pt = await opened(aesKey, env);
    const data = JSON.parse(td.decode(pt));
    if (env.updated) data.updated = env.updated;
    return data;
  }

  // Key order must be stable and match Python's json.dumps(sort_keys=True,
  // separators=(",",":")), so re-saving unchanged data yields identical bytes.
  function stableStringify(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(v).sort()
      .filter(k => v[k] !== undefined)
      .map(k => JSON.stringify(k) + ":" + stableStringify(v[k]))
      .join(",") + "}";
  }

  // Same envelope the scraper writes, including the deterministic nonce.
  async function encryptEnvelope(payload, updated) {
    if (!aesKey) throw new Error("locked");
    const pt = te.encode(stableStringify(payload));
    const sig = await crypto.subtle.sign("HMAC", hmacKey, pt);
    const iv = new Uint8Array(sig).slice(0, 12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, pt);
    return { v: 1, updated: updated || null, iv: b64e(iv), ct: b64e(ct) };
  }

  /* ---------- account management (admin) ---------- */

  function requireAdmin() {
    if (!aesKey || !me) throw new Error("Nicht angemeldet.");
    if (me.role !== "admin") throw new Error("Nur Admins dürfen Konten verwalten.");
  }

  async function accounts(c) {
    const conf = c || await loadCfg();
    const out = [];
    for (const [id, entry] of Object.entries(conf.users || {})) {
      const m = await readMeta(entry);
      out.push({ id, user: (m && m.user) || "?", role: (m && m.role) || "viewer" });
    }
    return out.sort((a, b) => a.user.localeCompare(b.user));
  }

  const cloneCfg = () => JSON.parse(JSON.stringify(cfg));

  async function buildEntry(user, pass, role) {
    const c = await loadCfg();
    const salt = rand(16);
    const uk = await deriveUserKey(user, pass, salt, c);
    const wrapped = await sealed(uk, masterRaw);      // master key, for this password
    return {
      salt: b64e(salt),
      iv: wrapped.iv,
      ct: wrapped.ct,
      meta: await sealMeta(user, role),
    };
  }

  function sealMeta(user, role) {
    return sealed(aesKey, te.encode(JSON.stringify({ user: (user || "").trim(), role })));
  }

  async function countAdmins(c, skipId) {
    const list = await accounts(c);
    return list.filter(a => a.role === "admin" && a.id !== skipId).length;
  }

  // Each of these returns a NEW cfg to be published; the cached one is only
  // replaced once the publish succeeded (see adoptCfg).
  async function addAccount(user, pass, role) {
    requireAdmin();
    const name = (user || "").trim();
    if (!name) throw new Error("Benutzername fehlt.");
    if (!pass) throw new Error("Passwort fehlt.");
    if (role !== "admin" && role !== "viewer") throw new Error("Ungültige Rolle.");
    const id = await accountId(name);
    const next = cloneCfg();
    if (next.users[id]) throw new Error(`„${name}“ existiert bereits.`);
    next.users[id] = await buildEntry(name, pass, role);
    return next;
  }

  async function resetPassword(user, pass) {
    requireAdmin();
    if (!pass) throw new Error("Passwort fehlt.");
    const id = await accountId(user);
    const next = cloneCfg();
    const entry = next.users[id];
    if (!entry) throw new Error(`Kein Konto „${user}“.`);
    const role = (await readMeta(entry) || {}).role || "viewer";
    next.users[id] = await buildEntry(user, pass, role);  // same id, fresh salt
    return next;
  }

  async function setRole(user, role) {
    requireAdmin();
    if (role !== "admin" && role !== "viewer") throw new Error("Ungültige Rolle.");
    const id = await accountId(user);
    const next = cloneCfg();
    const entry = next.users[id];
    if (!entry) throw new Error(`Kein Konto „${user}“.`);
    if (role !== "admin" && !(await countAdmins(next, id)))
      throw new Error("Das ist der einzige Admin — zuerst jemand anderen befördern.");
    // Only `meta` changes, so this works without knowing their password.
    entry.meta = await sealMeta(user, role);
    return next;
  }

  async function removeAccount(user) {
    requireAdmin();
    const id = await accountId(user);
    const next = cloneCfg();
    if (!next.users[id]) throw new Error(`Kein Konto „${user}“.`);
    if (id === me.uid) throw new Error("Das eigene Konto kann nicht gelöscht werden.");
    if (Object.keys(next.users).length === 1) throw new Error("Das letzte Konto bleibt.");
    if (!(await countAdmins(next, id)))
      throw new Error("Das ist der einzige Admin — zuerst jemand anderen befördern.");
    delete next.users[id];
    return next;
  }

  const serializeCfg = c => JSON.stringify(c, null, 2) + "\n";

  // Called after the new auth.json is live, so later edits build on it.
  async function adoptCfg(c) {
    cfg = c;
    const entry = c.users[me.uid];
    const m = entry && await readMeta(entry);
    if (m) me = { uid: me.uid, user: m.user, role: m.role };
    if (session) await save();
  }

  /* ---------- session storage ---------- */

  async function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      mk: b64e(masterRaw), uid: me.uid, ...session,
    }));
    lastSaved = Date.now();
  }

  function clearStored() {
    localStorage.removeItem(STORE_KEY);
  }

  async function restore() {
    let rec;
    try { rec = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { rec = null; }
    if (!rec || !rec.mk || !rec.uid || !(rec.exp > Date.now())) { clearStored(); return false; }
    try {
      await useMaster(b64d(rec.mk));
      // Prove the stored key still opens the data — catches a rotated password
      // or a re-encrypted site, and any forged record.
      await decryptJSON(CHECK_URL);
      // Read the role from auth.json rather than from storage, so a promotion,
      // demotion or deletion by an admin takes effect on the next page load.
      const c = await loadCfg(true);
      const entry = (c.users || {})[rec.uid];
      const m = entry && await readMeta(entry);
      if (!m) throw new Error("account gone");
      me = { uid: rec.uid, user: m.user, role: m.role };
    } catch {
      forgetMaster();
      clearStored();
      return false;
    }
    session = { remember: !!rec.remember, exp: rec.exp };
    return true;
  }

  /* ---------- inactivity ---------- */

  // Only non-remembered sessions slide; "Angemeldet bleiben" is a fixed 30 days.
  function touch() {
    if (!session || session.remember) return;
    session.exp = Date.now() + IDLE_MS;
    if (Date.now() - lastSaved > SAVE_EVERY_MS) save();
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(() => {
      if (session && Date.now() > session.exp) {
        lock(session.remember
          ? "Sitzung abgelaufen. Bitte erneut anmelden."
          : "Nach 30 Minuten Inaktivität automatisch abgemeldet.");
      }
    }, TICK_MS);
  }

  function stopTicker() {
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  const ACTIVITY = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"];
  function watchActivity() {
    ACTIVITY.forEach(ev =>
      window.addEventListener(ev, touch, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) touch(); });
  }

  /* ---------- lock / unlock ---------- */

  function el(id) { return document.getElementById(id); }

  function showLogin(message) {
    const box = el("login-error");
    if (message) { box.textContent = message; box.hidden = false; }
    else { box.hidden = true; box.textContent = ""; }
    el("app").hidden = true;
    el("login").hidden = false;
    el("login-pass").value = "";
    const first = el("login-user");
    if (!first.value) first.focus(); else el("login-pass").focus();
  }

  function unlockUI() {
    el("login").hidden = true;
    el("app").hidden = false;
    el("login-pass").value = "";
    startTicker();
    App.start();
  }

  function lock(message) {
    forgetMaster();
    session = null; // cfg stays cached — the KDF params are public anyway
    stopTicker();
    clearStored();
    App.stop();
    showLogin(message);
  }

  async function submit(user, pass, remember) {
    const got = await tryLogin(user, pass);
    if (!got) return false;
    me = { uid: got.uid, user: got.user, role: got.role };
    session = { remember, exp: Date.now() + (remember ? REMEMBER_MS : IDLE_MS) };
    await save();
    unlockUI();
    return true;
  }

  /* ---------- wiring ---------- */

  function setupForm() {
    const form = el("login-form");
    const btn = el("login-submit");
    let failures = 0;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("busy");
      el("login-error").hidden = true;
      try {
        // PBKDF2 runs ~300ms; yield first so the button state paints.
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
        const ok = await submit(el("login-user").value, el("login-pass").value,
                               el("login-remember").checked);
        if (ok) { failures = 0; return; }
        failures++;
        showLogin("Benutzername oder Passwort ist falsch.");
        // Small escalating pause — the real cost to an attacker is the KDF,
        // this just discourages hammering the form by hand.
        if (failures > 2) await new Promise(r => setTimeout(r, Math.min(failures, 6) * 500));
      } catch (err) {
        console.error(err);
        showLogin("Anmeldung momentan nicht möglich. Bitte später erneut versuchen.");
      } finally {
        btn.disabled = false;
        btn.classList.remove("busy");
      }
    });

    const out = el("logout-btn");
    if (out) out.addEventListener("click", () => lock());
  }

  async function init() {
    setupForm();
    watchActivity();
    try {
      if (await restore()) { unlockUI(); return; }
    } catch (err) { console.error(err); }
    showLogin();
  }

  return {
    init, decryptJSON, encryptEnvelope, touch, lock,
    isUnlocked: () => !!aesKey,
    role: () => me && me.role,
    isAdmin: () => !!me && me.role === "admin",
    me: () => me && me.user,
    // account management
    accounts, addAccount, resetPassword, setRole, removeAccount,
    serializeCfg, adoptCfg,
  };
})();

document.addEventListener("DOMContentLoaded", () => AUTH.init());
