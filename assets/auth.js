/* AC Rossoneri – Zugangsschutz.

   This is a static site, so there is no server to check a password against.
   A login form that only hides a <div> would be pointless — data/matches.json
   could just be opened directly. So the data files themselves are AES-256-GCM
   ciphertext: the password derives the key (PBKDF2-SHA256), and without it the
   files are unreadable no matter how they are fetched.

   Session handling:
     "Angemeldet bleiben" -> key kept for 30 days
     otherwise            -> key expires after 30 minutes without activity  */

const AUTH = (() => {
  const CFG_URL = "data/auth.json";
  const STORE_KEY = "acr.auth";
  const CHECK_TOKEN = "acrossoneri-d9";

  const IDLE_MS = 30 * 60 * 1000;              // 30 Minuten Inaktivität
  const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage
  const TICK_MS = 15000;                        // how often we check for expiry
  const SAVE_EVERY_MS = 30000;                  // throttle for sliding-expiry writes

  const te = new TextEncoder();
  const td = new TextDecoder();
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64e = b => btoa(String.fromCharCode(...new Uint8Array(b)));

  let cfg = null;        // contents of auth.json
  let key = null;        // CryptoKey, in memory only while unlocked
  let session = null;    // { remember, exp }
  let lastSaved = 0;
  let ticker = null;

  /* ---------- crypto ---------- */

  async function loadCfg() {
    if (cfg) return cfg;
    const r = await fetch(CFG_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`auth config: HTTP ${r.status}`);
    cfg = await r.json();
    return cfg;
  }

  async function deriveKey(user, pass) {
    const c = await loadCfg();
    const base = await crypto.subtle.importKey(
      "raw", te.encode(user.trim().toLowerCase() + ":" + pass),
      "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64d(c.salt), iterations: c.iterations, hash: c.hash },
      base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }

  // A wrong password yields a wrong key, and AES-GCM's tag check then fails.
  async function keyWorks(k) {
    const c = await loadCfg();
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64d(c.check.iv) }, k, b64d(c.check.ct));
      return td.decode(pt) === CHECK_TOKEN;
    } catch { return false; }
  }

  async function decryptJSON(path) {
    if (!key) throw new Error("locked");
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const env = await r.json();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64d(env.iv) }, key, b64d(env.ct));
    const data = JSON.parse(td.decode(pt));
    if (env.updated) data.updated = env.updated;
    return data;
  }

  /* ---------- session storage ---------- */

  async function save() {
    const raw = b64e(await crypto.subtle.exportKey("raw", key));
    localStorage.setItem(STORE_KEY, JSON.stringify({ k: raw, ...session }));
    lastSaved = Date.now();
  }

  function clearStored() {
    localStorage.removeItem(STORE_KEY);
  }

  async function restore() {
    let rec;
    try { rec = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { rec = null; }
    if (!rec || !rec.k || !(rec.exp > Date.now())) { clearStored(); return false; }
    let k;
    try {
      k = await crypto.subtle.importKey("raw", b64d(rec.k), "AES-GCM", true, ["decrypt"]);
    } catch { clearStored(); return false; }
    // Also catches a rotated password: the stored key no longer verifies.
    if (!(await keyWorks(k))) { clearStored(); return false; }
    key = k;
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
    key = null;
    session = null; // cfg stays cached — the KDF params are public anyway
    stopTicker();
    clearStored();
    App.stop();
    showLogin(message);
  }

  async function submit(user, pass, remember) {
    const k = await deriveKey(user, pass);
    if (!(await keyWorks(k))) return false;
    key = k;
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

  return { init, decryptJSON, touch, lock, isUnlocked: () => !!key };
})();

document.addEventListener("DOMContentLoaded", () => AUTH.init());
