# d9schwarz

Team-Website der **Junioren D-9 schwarz** (AC Rossoneri): Tabelle, Spielplan/Resultate
und Torschützen. Die Daten werden stündlich automatisch aus dem FVNWS-Matchcenter
geladen (GitHub Actions + Playwright).

**Live:** https://acrossoneri.github.io/d9schwarz/ — Zugang nur mit Login.

## Zugangsschutz

Die Seite ist statisch, es gibt also keinen Server, der ein Passwort prüfen könnte.
Ein Login-Formular allein wäre wirkungslos — man könnte `data/matches.json` einfach
direkt aufrufen. Deshalb sind **die Datendateien selbst verschlüsselt**:

* `data/*.enc.json` — AES-256-GCM. Ohne Passwort nicht lesbar, egal wie man sie abruft.
* `data/auth.json` — nur die öffentlichen KDF-Parameter (Salt, Iterationen) und ein
  Prüfblock, mit dem der Browser ein falsches Passwort erkennt.
* Der Schlüssel wird im Browser aus **Benutzername + Passwort** abgeleitet
  (PBKDF2-HMAC-SHA256, 310 000 Runden). Er verlässt das Gerät nie.
* „Angemeldet bleiben“ → Schlüssel bleibt 30 Tage im `localStorage`.
  Sonst: automatische Abmeldung nach 30 Minuten ohne Aktivität.

Klartext-Dateien (`data/config.json`, `matches.json`, `standings.json`) sind in
`.gitignore` und dürfen nie committet werden.

### Zugangsdaten ändern

```bash
rm data/auth.json                      # neues Salt erzwingen
SITE_USER=... SITE_PASSWORD=... python scraper/sitecrypt.py init
```

Danach in GitHub unter *Settings → Secrets and variables → Actions* die Secrets
`SITE_USER` und `SITE_PASSWORD` anpassen, sonst kann der Scraper nicht mehr schreiben.
Bestehende Sitzungen werden dadurch ungültig.

### Daten von Hand ansehen oder ändern

```bash
python scraper/sitecrypt.py show matches        # entschlüsselt nach stdout
python scraper/sitecrypt.py put config neu.json # verschlüsselt wieder rein
```

## Scraper

```bash
SITE_USER=... SITE_PASSWORD=... python scraper/scrape.py
```

Braucht die Zugangsdaten, weil er verschlüsselt schreibt. Unveränderte Daten ergeben
byte-identische Dateien — also keine leeren Commits.
