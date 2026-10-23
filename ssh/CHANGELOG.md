# @sdillen/pi-ssh

## 0.2.4

### Patch Changes

- 333f05b: - Quote remote paths with `shq` instead of `JSON.stringify`, so paths with special shell characters are passed correctly.
  - Map only the local cwd prefix to the remote cwd, so paths outside the working directory are no longer rewritten.
  - Return byte-exact stdout from remote reads and fail reads on error instead of returning partial output.
  - Send file contents to the remote host via stdin instead of embedding them in the command.
  - Split the `--ssh` argument at the first colon, so IPv6 hosts and remote paths with colons parse correctly.
  - Replace the YubiKey-specific authentication prompt with generic text, since `ssh` may also ask for a passphrase or password.

## 0.2.3

### Patch Changes

- 2313f51: Run the sudo tool sequentially so parallel sudo calls share a single password prompt.

## 0.2.2

### Patch Changes

- 42618c0: Ship compiled JavaScript from `dist/` instead of TypeScript sources.

## 0.2.1

### Patch Changes

- a2b6ffb: Fix the sudo password dialog: the closing border of the input line no longer shifts left, and long passwords no longer overflow the frame.

## 0.2.0

### Minor Changes

- e95b535: Add a default 300s timeout for remote bash and sudo commands in `--ssh` mode. An explicit timeout still overrides the default. The cached sudo password TTL is now renewed on each use, so it only expires after inactivity.

## 0.1.1

### Patch Changes

- 7db985c: Initial release through Changesets and npm trusted publishing: publish workflow, per-package READMEs and MIT license.
