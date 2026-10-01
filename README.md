# pi-extensions

Eigene Extensions für den [pi coding agent](https://github.com/earendil-works/pi-coding-agent).
Zwei unabhängige Module, je ein Ordner:

| Modul | Datei | Was es tut |
|---|---|---|
| `ssh/` | `ssh.ts` | Remote-Execution: alle Built-in-Tools (read/write/edit/bash) laufen auf einem SSH-Host, eigenes `sudo`-Tool mit maskiertem Passwort-Dialog, einmalige interaktive YubiKey/ED25519-SK-Authentifizierung via ControlMaster |
| `brave-search/` | `brave-search.ts` | Web-Search-Tool über die Brave „LLM Context“-API (Key aus macOS-Keychain / `BRAVE_API_KEY` / `~/.config/brave/api-key`) |

## Lokal ausprobieren (ohne Deploy)

```sh
# SSH-Remote-Modus
pi -e ./ssh/ssh.ts --ssh user@host[:/remote/path]

# Brave-Search-Tool
pi -e ./brave-search/brave-search.ts
```

## Deploy

Auf dem Desktop (nexus) symlinkt home-manager die Dateien nach
`~/.pi/agent/extensions/` (siehe `home-manager/nexus.nix` im
dotfiles-Repo); pi entdeckt sie dort automatisch, `/reload` aktiviert
Änderungen. Der SSH-Modus nutzt dagegen meist `pi -e` direkt.

## Typecheck

```sh
npm install
npm run typecheck
```

Gegen die offiziellen Pakete `@earendil-works/pi-coding-agent` und
`@earendil-works/pi-tui` (Version muss zur installierten pi-Version passen).
