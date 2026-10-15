# pi-extensions

Extensions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).
Two independent modules, one folder each:

| Package | Folder | npm | What it does |
|---|---|---|---|
| `@sdillen/pi-ssh` | `ssh/` | [`npm:@sdillen/pi-ssh`](https://www.npmjs.com/package/@sdillen/pi-ssh) | Remote execution: all built-in tools run on an SSH host, a dedicated `sudo` tool with a masked password dialog, and one-time interactive YubiKey / ED25519-SK authentication via ControlMaster |
| `@sdillen/pi-brave-search` | `brave-search/` | [`npm:@sdillen/pi-brave-search`](https://www.npmjs.com/package/@sdillen/pi-brave-search) | Web search tool backed by the Brave "LLM Context" API (key from macOS Keychain, `BRAVE_API_KEY`, or `~/.config/brave/api-key`) |

Each package has its own README with install and usage notes. The sections below cover the
details and the development setup.

## Usage

### Installation

Install the packages you need with pi:

```sh
pi install npm:@sdillen/pi-ssh
pi install npm:@sdillen/pi-brave-search
```

Or try them from a local clone for a single run:

```sh
# SSH remote mode
pi -e ./ssh --ssh user@host[:/remote/path]

# Brave search tool
pi -e ./brave-search/brave-search.ts
```

### SSH mode: what is not obvious

- **Everything runs remotely**: read/write/edit/bash and `!` commands execute on the
  SSH host, not locally. The status line shows `SSH: host:/path`, and the system prompt
  shows the remote working directory.
- **sudo is its own tool**, not a call inside the bash tool. `sudo ...` in the bash tool
  is rejected remotely with a pointer to the sudo tool. `!` commands containing `sudo`
  are rewritten automatically. The sudo tool receives the command **without** a leading
  `sudo` and runs it as `sudo bash -c`, so pipes, `&&`, and redirects all run as root.
- **Password handling**: the sudo password is entered in a masked dialog (characters are
  shown as `*`). It is never written to the LLM context or the session file. It is
  remembered for 4 minutes, after which pi asks again. A wrong password triggers one retry.
  `-n`/`-S` in the command are unnecessary and are removed.
- **YubiKey / ED25519-SK**: one interactive authentication at session start (PIN + touch;
  the TUI pauses briefly). After that, all remote calls go through a ControlMaster socket
  (`~/.ssh/controlmaster/...`) and never ask again. If the master dies mid-session, pi
  re-authenticates once automatically. Lifetime after the last connection is
  `SSH_CONTROL_PERSIST` seconds (default 43200 = 12 h).
- **Requirements**: bash on the remote host and a reachable SSH key.

### Brave search: what is not obvious

- Uses the Brave **LLM Context** endpoint rather than the classic web search. It returns
  pre-extracted, LLM-optimized snippets (text, tables, code) with source and date, so no
  scraping is needed.
- **API key lookup order**: macOS Keychain (service `pi-brave-search`) → `BRAVE_API_KEY`
  → `~/.config/brave/api-key`. The key never leaves your machine and is never written to
  the LLM context. Get a key at https://api-dashboard.search.brave.com
- **Slash commands**: `/brave-key status|set|delete` (`set` reads the clipboard) and
  `/brave-test` (checks key and endpoint). If the key is missing on a call, pi asks
  interactively whether to store the clipboard contents in the Keychain.
- **Robustness**: on rate limiting (429) or 5xx responses, pi retries with backoff up to
  3 times. The timeout is 30 s. If a result exceeds the token budget, it is truncated and
  the full output is written to a temp file, whose path is included in the result.

## Development

### Setup

With [devenv](https://devenv.sh) (recommended, the repo includes `devenv.nix` and `.envrc`):

```sh
direnv allow       # or: devenv shell
```

Without devenv, use Node.js 22.19 or newer (24 is used in CI):

```sh
npm install        # also installs the pre-commit hook (simple-git-hooks)
```

### Typecheck, lint, and format

```sh
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # biome check (format + lint)
npm run format     # biome check --write (autofix)
```

Biome handles formatting (tabs, line width 100, double quotes) and one targeted lint rule,
`noFloatingPromises`, rather than the full rule catalog. Before each commit, lint-staged
formats the staged files and then `npm run typecheck` runs.

The extensions are written against the official `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` packages. Their versions must match the installed pi version.

### Architecture: ssh/

- `index.ts`: extension wiring. Remote tools (read/write/edit/bash) plus `sudo`. The
  `session_start` hook primes the ControlMaster and enables the sudo tool only **after** a
  successful connection, so normal sessions never see it. A `user_bash` hook handles remote
  `!` commands. `before_agent_start` replaces the working directory in the system prompt.
  The masked password window is a custom `ctx.ui.custom` component that renders only `*`,
  supports full editing, and shows the cursor in reverse video.
- `master.ts`: ControlMaster lifecycle, pure logic. Two non-obvious decisions:
  - **Zombie detection**: `ssh -O check` accepts zombie masters (process alive, connection
    dead). The only reliable liveness check is a real round trip
    (`ssh -o ControlMaster=no -o BatchMode=yes remote true`).
  - **`ControlMaster=no`** instead of `auto`: a dead socket fails immediately and visibly,
    instead of silently falling into a new connection attempt that, without a TTY, could
    not prompt for the YubiKey PIN.
  - The master check is cached for 2 s, which saves one `ssh -O check` per tool call.
- `sudo.ts`: password state and command rewriting, **pure logic without a pi dependency**
  (so it is directly unit-testable). `sudo` is rewritten to `sudo -S -p ''` so the password
  arrives on stdin. `-n`/`--non-interactive` is removed, because sudo would otherwise ignore
  stdin. The regex also detects sudo behind wrappers (`timeout`, `nice`, `nohup`, `env`, ...).
  The password lives only in extension memory, with a TTL of 4 minutes.
- `guard.ts`: remote watchdog for abortable calls (bash, `!`, sudo). Without a PTY there is
  no SIGHUP on the remote side, so a killed ssh client would leave the command running as
  an orphan. The command therefore runs in its own process group, and a watchdog reads
  stdin. On EOF (ESC, timeout, client/network/master gone), it sends TERM to the group and
  KILL after 2 s. Locally, stdin stays open, so aborting means closing stdin. For the sudo
  tool, a second wrapper cleans up as root (sudo forwards TERM). Limitation: for `!` commands
  with an embedded `sudo`, root child processes can survive, and so can processes that
  detach themselves with `setsid`.

### Architecture: brave-search/

- One tool (`brave_search`) and two slash commands (`/brave-key`, `/brave-test`). Key
  resolution is a small function without a pi dependency.
- HTTP: 30 s timeout plus external cancellation via `AbortSignal.any`. `RetryableError` for
  429/5xx with backoff. Hard errors fail immediately (at most 3 attempts).
- Rendering: custom `renderCall`/`renderResult`, a compact source list (up to 20 entries),
  source and snippet counters, token budget, and a "truncated" notice.
- `notifySuccess` deliberately casts "success" to `"info"`. It is not an official notify
  level, but the TUI renders it (see the comment in the code).

### Tests

```sh
npm test   # vitest run
```

Vitest tests cover the pure logic of the SSH module, so no real SSH connection is needed:
`ssh/sudo.test.ts` (sudo detection and rewriting, password TTL), `ssh/guard.test.ts`
(watchdog and process group cleanup), and `ssh/master.test.ts` (socket paths, `ssh`
arguments, zombie detection, master lifecycle with a mocked `spawnSync`).

CI (`.github/workflows/ci.yml`) runs typecheck, lint, and tests on every push to `main` and
on every pull request.

## License

[MIT](LICENSE)
