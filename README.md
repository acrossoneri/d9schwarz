# d9schwarz

Team-Website der **Junioren D-9 schwarz** (AC Rossoneri): Tabelle, Spielplan/Resultate
und Torschützen. Die Daten werden stündlich automatisch aus dem FVNWS-Matchcenter
geladen (GitHub Actions + Playwright, alle zwei Stunden).

**Live:** https://acrossoneri.github.io/d9schwarz/ — Zugang nur mit Login.

## Zugangsschutz

Die Seite ist statisch, es gibt also keinen Server, der ein Passwort prüfen könnte.
Ein Login-Formular allein wäre wirkungslos — man könnte `data/matches.json` einfach
direkt aufrufen. Deshalb sind **die Datendateien selbst verschlüsselt**:

`data/scorers.enc.json`, `data/players.enc.json`, `data/lineups.enc.json` und
`data/friendlies.enc.json` sind handgepflegt und dürfen **fehlen** — die Seite lädt
dann mit leeren Listen, und das erste Veröffentlichen legt die Datei an. Der Scraper
schreibt keine davon.

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

Schnellerfassung: Namen in der Reihenfolge der Tore ins Feld über der Liste,
`Marlon, Dean, Dean 33, Dean` — Komma trennt, eine Zahl dahinter ist die Minute.
Der Vorname genügt; zugeordnet wird gegen das Aufgebot dieses Spiels, Tippfehler
bis zwei Buchstaben inklusive. Passt die Anzahl nicht zum Resultat, sagt die
Statuszeile es.

Das Namensfeld schlägt vor, wer im Matchcenter für dieses Spiel **aufgestellt**
war — Startformation und eingesetzte Ersatzspieler, in der Schreibweise des
Verbands. Für Spiele ohne Aufstellung greift die von Hand gepflegte Spielerliste.

**Aufstellung erfassen** — dieselbe Aufstellung, die der Trainer ohnehin beim
Verband meldet, für das gewählte Spiel eingetippt: Nummer, Name, Position und
Rolle (Start / Start·C / Ersatz / Ersatz·kein Einsatz). Sie landet in
`data/lineups.enc.json`, die der Scraper **nie** schreibt, und wird beim Anzeigen
in den Spielbericht gemischt — neben eine fremde Aufstellung, falls es die je
gibt. „Vom letzten Spiel übernehmen“ kopiert das Aufgebot des letzten erfassten
Spiels; meist ändern sich nur ein, zwei Namen.

Die Daten sind ohnehin unsere — hier machen sie nur einen Umweg weniger.

**Eigene Spiele** — Berichte zu Spielen, die nicht im Gruppen-Spielplan stehen
(Trainingsspiele, Cup), legen sich beim Einlesen selbst als Spiel an: Datum,
Anpfiff, Teams, Resultat und Runde stehen im Kopf des Berichts. Sie landen in
`data/friendlies.enc.json`, erscheinen in der Spieleliste mit dem Vermerk „Test“
und tauchen in der **Tabelle nie** auf — die kommt vom Scraper und wird
ausschliesslich aus Gruppenspielen gerechnet.

**Spielbericht-Datei einlesen** — die Spielseite im Browser mit Strg+S speichern
und die HTML-Datei(en) im Einstellungen-Tab wählen. Daraus kommen Aufstellung,
Spielort, Drittelsresultate, Karten **und die Aufstellung des Gegners**; zugeordnet
wird über die Spielnummer im Bericht. Mehrere Dateien auf einmal gehen. Berichte zu
Spielen, die nicht im Gruppen-Spielplan stehen (z. B. Trainingsspiele), werden mit
Begründung übersprungen. Gelesen wird lokal im Browser — es geht keine Abfrage von
der Seite aus. `parseReportHTML()` in `admin.js` spiegelt `parse_game_detail()` in
`scrape.py`; die zwei gehören zusammen gepflegt.

**Aufstellung als Text einfügen** — wer die Spielseite im Browser offen hat, kann
den Block „Aufstellung“ markieren, kopieren und hier einfügen; Nummer, Name,
Position und Captain werden übernommen. Das Kopieren macht der Mensch im eigenen
Browser, die Seite parst nur den Text — es geht keine Abfrage von uns aus. Die
Markierung „kein Einsatz“ ist ein Bildchen und lässt sich nicht mitkopieren, die
bleibt von Hand.

**Unsere Spieler** — Nummer und Name. Ein Eintrag war früher ein blosser Name,
jetzt ist er `{name, number}`; alte Dateien voller Strings laden weiter. Wer in
einer erfassten Aufstellung auftaucht, wird darunter zur Übernahme vorgeschlagen
— samt Nummer aus dem jüngsten Spiel, in dem er gespielt hat. Einzeln anklicken
oder alle auf einmal. Automatisch aufgenommen wird niemand: ein vertippter Name
in einer Aufstellung soll nicht stillschweigend zum Kaderspieler werden.

**Nicht verlieren** — Änderungen liegen bis zum Veröffentlichen nur im Browser.
Damit ein Reload, ein geschlossener Tab oder ein fehlgeschlagenes Veröffentlichen
sie nicht verschluckt, werden sie bei jeder Eingabe zusätzlich im `localStorage`
gespiegelt (`acr.draft`) und beim nächsten Öffnen des Tabs wiederhergestellt —
mit Hinweis in der Statuszeile. Erst ein erfolgreiches Veröffentlichen räumt sie
weg, ebenso ein bewusstes Verwerfen beim Neuladen. Der Entwurf bleibt auf dem
Gerät und wird nie hochgeladen.

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
| `venue` | Spielort — schon vor dem Anpfiff da, geholt wird er aber erst danach (siehe Zeitplan) |
| `periods` | Drittelsresultate, z. B. `0:1 / 3:3 / 6:6` |
| `events` | Verlauf: Karten mit Minute (**Torschützen stehen dort im D-9 nicht** — die werden von Hand erfasst) |
| `lineups` | Aufstellung **beider** Teams: Startformation mit Nummer und Position, Ersatzbank inkl. „kein Einsatz“, Captain, Trainer |

Wie oft geholt wird, entscheidet `wants_detail()` — bewusst sparsam, denn ein
Bericht, den noch niemand geschrieben hat, entsteht nicht dadurch, dass man öfter
fragt:

| | Wann gefragt wird |
|---|---|
| **Unsere Spiele, vorher** | **ein** Blick rund `PRE_MATCH_LOOK` Stunden vor Anpfiff — nur für den Spielort, und nur solange wir ihn nicht haben |
| **Unsere Spiele, nachher** | erstmals 4 h nach Anpfiff, danach alle 2 h — bis die Aufstellung da ist, dann nie wieder |
| **Fremde Spiele** | genau einmal, sobald ihr Wochenende vorbei ist (Montag 00:00), höchstens `MAX_OTHER_PER_RUN` pro Lauf |
| **Beide** | nach `GIVE_UP_DAYS` Tagen gar nicht mehr — was bis dahin fehlt, kommt nicht mehr |

Der Blick davor ist ein einzelner Termin, kein Pollen: Wird er verpasst oder
abgewiesen, kommt der Spielort eben mit der Abfrage nach dem Spiel.

Was nicht geholt wird, behält das Detail des letzten Laufs — eine fehlgeschlagene
oder ausgelassene Abfrage löscht nie etwas.

