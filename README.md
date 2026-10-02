# pi-extensions

Eigene Extensions für den [pi coding agent](https://github.com/earendil-works/pi-coding-agent).
Zwei unabhängige Module, je ein Ordner:

| Modul | Datei(en) | Was es tut |
|---|---|---|
| `ssh/` | `index.ts` (+ `master.ts`, `sudo.ts`) | Remote-Execution: alle Built-in-Tools laufen auf einem SSH-Host, eigenes `sudo`-Tool mit maskiertem Passwort-Dialog, einmalige interaktive YubiKey/ED25519-SK-Authentifizierung via ControlMaster |
| `brave-search/` | `brave-search.ts` | Web-Search-Tool über die Brave „LLM Context“-API (Key aus macOS-Keychain / `BRAVE_API_KEY` / `~/.config/brave/api-key`) |

## Für Nutzer

### Installation

Symlinke oder kopiere die Verzeichnisse/Dateien nach `~/.pi/agent/extensions/`;
pi entdeckt dort Ordner mit `index.ts` und einzelne `.ts`-Dateien automatisch,
`/reload` aktiviert Änderungen. Zum Ausprobieren aus diesem Repo:

```sh
# SSH-Remote-Modus (Verzeichnis mit index.ts)
pi -e ./ssh --ssh user@host[:/remote/path]

# Brave-Search-Tool
pi -e ./brave-search/brave-search.ts
```

### SSH-Modus: was nicht offensichtlich ist

- **Alles läuft remote**: read/write/edit/bash und `!`-Kommandos führen auf dem
  SSH-Host aus, nicht lokal. Die Statuszeile zeigt `SSH: host:/pfad`, das
  System-Prompt die Remote-CWD.
- **sudo ist ein eigenes Tool**, kein Aufruf im bash-Tool: `sudo …` im bash-Tool
  wird remote abgelehnt (Verweis aufs sudo-Tool); `!`-Kommandos mit `sudo`
  werden automatisch umgeschrieben. Das sudo-Tool bekommt den Befehl **ohne**
  führendes `sudo` (`sudo bash -c` — Pipes, `&&` und Redirects laufen alle als
  root).
- **Passwort-Handling**: Das sudo-Passwort erscheint in einem maskierten
  Dialogfenster (Zeichen als `*`), wird nie in den LLM-Context oder die
  Session-Datei geschrieben und 4 Minuten lang gemerkt (danach wird erneut
  gefragt; bei falschem Passwort gibt es eine Wiederholung). `-n`/`-S` im
  Befehl sind unnötig und werden entfernt.
- **YubiKey / ED25519-SK**: Einmalige interaktive Authentifizierung beim
  Session-Start (PIN + Touch, die TUI pausiert kurz). Danach reiten alle
  Remote-Aufrufe über einen ControlMaster-Socket (`~/.ssh/controlmaster/…`)
  und fragen nie wieder; stirbt der Master unterwegs, wird einmal automatisch
  neu authentifiziert. Lebensdauer nach der letzten Verbindung:
  `SSH_CONTROL_PERSIST` Sekunden (Default 43200 = 12 h).
- **Voraussetzungen**: bash auf dem Remote-Host, erreichbarer SSH-Schlüssel.

### Brave-Suche: was nicht offensichtlich ist

- Nutzt den Brave **LLM-Context**-Endpoint statt der klassischen Websuche:
  liefert vor-extrahierte, LLM-optimierte Snippets (Text, Tabellen, Code)
  inkl. Quelle und Datum — kein Scraping nötig.
- **API-Key** (Priorität): macOS Keychain (Service `pi-brave-search`) →
  `BRAVE_API_KEY` → `~/.config/brave/api-key`. Der Key verlässt nie den
  Rechner und wird nie in den LLM-Context geschrieben. Key besorgen:
  https://api-dashboard.search.brave.com
- **Slash-Kommandos**: `/brave-key status|set|delete` (`set` liest die
  Zwischenablage) und `/brave-test` (Key + Endpoint prüfen). Fehlt der Key bei
  einem Aufruf, fragt pi interaktiv, ob er aus der Zwischenablage in die
  Keychain gelegt werden soll.
- **Robustheit**: Bei Rate-Limiting (429) oder 5xx wird mit Backoff bis zu 3×
  wiederholt, Timeout 30 s. Überschreitet das Ergebnis das Token-Budget, wird
  gekürzt und der vollständige Output in eine Temp-Datei geschrieben (der Pfad
  steht im Ergebnis).

## Für Entwickler

### Setup

```sh
npm install        # installiert auch den pre-commit-Hook (simple-git-hooks)
```

### Typecheck, Lint & Format

```sh
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # biome check (Format + Lint)
npm run format     # biome check --write (autofix)
```

Biome: Formatierung (Tabs, lineWidth 100, double quotes) plus die eine
gezielte Regel `noFloatingPromises` („Promise nicht behandelt") — bewusst
kein kompletter Regelkatalog. Vor jedem Commit: `lint-staged` formatiert
die gestageten Dateien, danach läuft `npm run typecheck`.

Gegen die offiziellen Pakete `@earendil-works/pi-coding-agent` und
`@earendil-works/pi-tui` (Version muss zur installierten pi-Version passen).

### Architektur: ssh/

- `index.ts` — Extension-Wiring: Remote-Tools (read/write/edit/bash) plus
  `sudo`; `session_start`-Hook primt den ControlMaster und aktiviert das
  sudo-Tool erst **nach** erfolgreicher Verbindung (normale Sessions sehen es
  nie); `user_bash`-Hook für remote `!`-Kommandos; `before_agent_start`
  ersetzt die CWD im System-Prompt. Das maskierte Passwort-Fenster ist eine
  eigene `ctx.ui.custom`-Komponente (nur `*` gerendert, volle Bearbeitung,
  Cursor als Reverse-Video).
- `master.ts` — ControlMaster-Lebenszyklus, reine Logik. Zwei
  nicht-offensichtliche Entscheidungen:
  - **Zombie-Erkennung**: `ssh -O check` akzeptiert Zombie-Master (Prozess
    lebt, Verbindung tot). Zuverlässiger Lebensnachweis ist nur ein echter
    Roundtrip (`ssh -o ControlMaster=no -o BatchMode=yes remote true`).
  - **`ControlMaster=no`** statt `auto`: Ein toter Socket schlägt sofort und
    erkennbar fehl, statt still in einen neuen Verbindungsversuch zu fallen —
    der ohne TTY die YubiKey-PIN nicht abfragen könnte.
  - Der Master-Check wird 2 s gecacht (spart pro Tool-Call einen `ssh -O
    check`).
- `sudo.ts` — Passwort-State und Kommando-Umschreibung, **reine Logik ohne
  pi-Abhängigkeit** (deshalb direkt unit-testbar). `sudo` wird zu
  `sudo -S -p ''` umgeschrieben, damit das Passwort über stdin ankommt;
  `-n`/`--non-interactive` fliegt raus (sonst ignoriert sudo stdin). Die
  Regex erkennt sudo auch hinter Wrappern (`timeout`, `nice`, `nohup`, `env`,
  …). Das Passwort lebt nur im Extension-Speicher, TTL 4 min.
- `guard.ts` — Remote-Watchdog für abbrechbare Aufrufe (bash, `!`, sudo).
  Ohne PTY gibt es remote kein SIGHUP; ein gekillter ssh-Client ließe den
  Befehl verwaist weiterlaufen. Der Befehl läuft daher in eigener
  Prozessgruppe, ein Watchdog liest stdin: EOF (ESC, Timeout, Client/Netz/
  Master weg) → TERM an die Gruppe, nach 2 s KILL. Lokal bleibt stdin
  deshalb offen; Abbrechen = stdin schließen. Beim sudo-Tool räumt ein
  zweiter Wrapper als root ab (sudo reicht TERM weiter). Grenze: bei
  `!`-Kommandos mit eingebettetem `sudo` können root-Kindprozesse
  überleben; Prozesse, die sich selbst per `setsid` lösen, ebenso.

### Architektur: brave-search/

- Ein Tool (`brave_search`) + zwei Slash-Kommandos (`/brave-key`,
  `/brave-test`), Key-Auflösung als kleine Funktion ohne pi-Abhängigkeit.
- HTTP: 30-s-Timeout plus externe Cancellation via `AbortSignal.any`,
  `RetryableError` für 429/5xx mit Backoff, harte Fehler sofort (max. 3
  Versuche).
- Rendering: eigener `renderCall`/`renderResult` — kompakte Quellenliste (bis
  20 Einträge), Quellen/Snippet-Zähler, Token-Budget, „gekürzt“-Hinweis.
- `notifySuccess` castet „success“ bewusst auf `"info"` — kein offizielles
  notify-Level, wird von der TUI aber gerendert (Kommentar im Code).

### Tests

```sh
npm test   # vitest run
```

Vitest-Tests für die reine Logik des SSH-Moduls (kein echtes SSH nötig):
`ssh/sudo.test.ts` (sudo-Erkennung/-Umschreibung, Passwort-TTL) und
`ssh/master.test.ts` (Socket-Pfade, `ssh`-Argumente, Zombie-Erkennung,
Master-Lebenszyklus mit gemocktem `spawnSync`).
