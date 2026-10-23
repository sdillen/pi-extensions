---
"@sdillen/pi-ssh": patch
---

- Quote remote paths with `shq` instead of `JSON.stringify`, so paths with special shell characters are passed correctly.
- Map only the local cwd prefix to the remote cwd, so paths outside the working directory are no longer rewritten.
- Return byte-exact stdout from remote reads and fail reads on error instead of returning partial output.
- Send file contents to the remote host via stdin instead of embedding them in the command.
- Split the `--ssh` argument at the first colon, so IPv6 hosts and remote paths with colons parse correctly.
- Replace the YubiKey-specific authentication prompt with generic text, since `ssh` may also ask for a passphrase or password.
