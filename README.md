# pi-extensions

Eigene Extensions für den [pi coding agent](https://github.com/earendil-works/pi-coding-agent).
Zwei unabhängige Module, je ein Ordner:

| Modul | Datei(en) | Was es tut |
|---|---|---|
| `ssh/` | `index.ts` (+ `master.ts`, `sudo.ts`) | Remote-Execution: alle Built-in-Tools (read/write/edit/bash) laufen auf einem SSH-Host, eigenes `sudo`-Tool mit maskiertem Passwort-Dialog, einmalige interaktive YubiKey/ED25519-SK-Authentifizierung via ControlMaster |
| `brave-search/` | `brave-search.ts` | Web-Search-Tool über die Brave „LLM Context“-API (Key aus macOS-Keychain / `BRAVE_API_KEY` / `~/.config/brave/api-key`) |

## Lokal ausprobieren (ohne Deploy)

```sh
# SSH-Remote-Modus (Verzeichnis mit index.ts)
pi -e ./ssh --ssh user@host[:/remote/path]

# Brave-Search-Tool
pi -e ./brave-search/brave-search.ts
```

## Deploy

Auf dem Desktop (nexus) symlinkt home-manager die Verzeichnisse/Dateien nach
`~/.pi/agent/extensions/` (siehe `home-manager/nexus.nix` im
dotfiles-Repo); pi entdeckt dort Ordner mit `index.ts` und einzelne `.ts`-Dateien
automatisch, `/reload` aktiviert Änderungen. Der SSH-Modus nutzt dagegen
meist `pi -e` direkt.

## Typecheck, Lint & Format

```sh
npm install        # installiert auch den pre-commit-Hook (simple-git-hooks)
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

## Tests

```sh
npm test   # vitest run
```

Vitest-Tests für die reine Logik des SSH-Moduls (kein echtes SSH nötig):
`ssh/sudo.test.ts` (sudo-Erkennung/-Umschreibung, Passwort-TTL) und
`ssh/master.test.ts` (Socket-Pfade, `ssh`-Argumente, Zombie-Erkennung,
Master-Lebenszyklus mit gemocktem `spawnSync`).
