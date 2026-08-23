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
* Verschlüsselt wird mit einem zufälligen **Master-Key**. Jedes Konto trägt diesen
  Key eingepackt („wrapped“) unter einem Schlüssel, der aus **Benutzername +
  Passwort** abgeleitet wird (PBKDF2-HMAC-SHA256, 310 000 Runden, im Browser).
  Anmelden heisst: den Master-Key auspacken. Konten hinzufügen oder entfernen
  verschlüsselt die Daten also nicht neu.
* `data/auth.json` ist öffentlich, verrät aber nichts: Konten sind über einen Hash
  des Benutzernamens indexiert, und Name plus Rolle liegen in einem `meta`-Block,
  der mit dem Master-Key verschlüsselt ist. Genau das erlaubt einem Admin, Konten
  aufzulisten und Rollen zu ändern, ohne ein Passwort zu kennen.
* „Angemeldet bleiben“ → Schlüssel bleibt 30 Tage im `localStorage`.
  Sonst: automatische Abmeldung nach 30 Minuten ohne Aktivität.

Klartext-Dateien (`data/config.json`, `matches.json`, `standings.json`) sind in
`.gitignore` und dürfen nie committet werden.

### Rollen

| Rolle | Sieht |
|-------|-------|
| `viewer` | Tabelle, Spiele, Torschützen |
| `admin` | zusätzlich den Tab **Einstellungen** |

Wichtig zur Einordnung: der Login schützt die **Daten**, die Rolle steuert nur die
**Oberfläche**. Wer angemeldet ist, hält den Master-Key — die Rolle ist also keine
Sicherheitsgrenze. Was Änderungen wirklich absichert, ist der GitHub-Token: ohne
ihn kann niemand etwas veröffentlichen.

## Einstellungen (Admin)

Der Tab **Einstellungen** kann zweierlei, beides direkt aus dem Browser:

**Torschützen erfassen** — für Spiele, bei denen im Matchcenter keine stehen (im
D-9 also für alle). Sie landen in `data/scorers.enc.json`, einer Datei, die der
Scraper **nie** schreibt; ein Scrape kann handeingetragene Daten also nicht
überschreiben. Erfasst wird nur das eigene Team.

Das Namensfeld schlägt vor, wer im Matchcenter für dieses Spiel **aufgestellt**
war — Startformation und eingesetzte Ersatzspieler, in der Schreibweise des
Verbands. Für Spiele ohne Aufstellung greift die von Hand gepflegte Spielerliste.

**Benutzer verwalten** — anlegen, Passwort neu setzen, Rolle wechseln, löschen.
Wächter: das eigene Konto lässt sich nicht löschen, und der letzte Admin lässt sich
weder löschen noch herabsetzen.

Gespeichert wird über die GitHub-Contents-API. Dafür braucht es einmalig einen
*fine-grained personal access token* für `acrossoneri/d9schwarz` mit
`Contents: Read and write`; er bleibt im `localStorage` des Admin-Geräts. Ohne
Token lässt sich die verschlüsselte Datei herunterladen und von Hand committen.
Nach dem Veröffentlichen dauert es etwa eine Minute, bis GitHub Pages neu gebaut hat.

## Konten von der Kommandozeile

```bash
# erstes Konto + alles verschlüsseln (nur beim Aufsetzen)
SITE_USER=... SITE_PASSWORD=... python scraper/sitecrypt.py init

# weitere Konten (braucht ein bestehendes Admin-Konto)
SITE_USER=admin SITE_PASSWORD=... \
  NEW_USER=trainer NEW_PASSWORD=... NEW_ROLE=viewer \
  python scraper/sitecrypt.py adduser

python scraper/sitecrypt.py users              # Konten und Rollen anzeigen
python scraper/sitecrypt.py passwd trainer     # NEW_PASSWORD=... setzen
python scraper/sitecrypt.py role trainer admin
python scraper/sitecrypt.py deluser trainer
```

Ein gelöschtes Konto öffnet mit seinem alten Passwort weiterhin die Ciphertexte in
der Git-History. Um es vollständig auszuschliessen: `data/auth.json` löschen und neu
`init` (neuer Master-Key, alles wird neu verschlüsselt) — danach die Actions-Secrets
`SITE_USER`/`SITE_PASSWORD` anpassen, sonst kann der Scraper nicht mehr schreiben.

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

### Spieldetails

Neben der Gruppen-Spielplanseite holt der Scraper zu jedem Spiel auch die
**Spieldetail-Seite**. Von dort kommen:

| Feld | Inhalt |
|------|--------|
| `venue` | Spielort — steht schon **vor** dem Anpfiff, darum sind auch kommende Spiele aufklappbar |
| `periods` | Drittelsresultate, z. B. `0:1 / 3:3 / 6:6` |
| `events` | Verlauf: Karten mit Minute (**Torschützen stehen dort im D-9 nicht** — die werden von Hand erfasst) |
| `lineups` | Aufstellung **beider** Teams: Startformation mit Nummer und Position, Ersatzbank inkl. „kein Einsatz“, Captain, Trainer |

Wie oft geholt wird, steht in `attach_details()`:

* **Unsere Spiele** — bei jedem Lauf, also stündlich.
* **Fremde Spiele** — einmalig, 24 h nach Anpfiff (`OTHER_AFTER`). Der Bericht ist
  dann fertig und ändert sich nicht mehr; alle 45 Spiele stündlich durch die
  Cloudflare-Prüfung zu schicken wäre langsam und unnötig. Pro Lauf werden
  höchstens `MAX_OTHER_PER_RUN` davon geholt, der Rest kommt im nächsten Lauf.

Was nicht geholt wird, behält das Detail des letzten Laufs — eine fehlgeschlagene
oder ausgelassene Abfrage löscht nie etwas.

Die Detailseiten haben eine **eigene Cloudflare-Prüfung**, die nicht immer aufgeht.
Darum wird pro Seite nur einmal angeklopft (kein Retry), und nach `GIVE_UP_AFTER`
leeren Antworten hintereinander bricht der Lauf die Detailabfrage ab, statt
minutenlang gegen eine Wand zu laufen. Der nächste Lauf fängt wieder von vorn an.
