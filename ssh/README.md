# @sdillen/pi-ssh

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that runs all tools on an SSH host.

- read/write/edit/bash and `!` commands execute remotely.
- A dedicated `sudo` tool with a masked password dialog. The password is never written to the LLM context or the session file.
- One-time interactive YubiKey / ED25519-SK authentication, then all calls reuse a ControlMaster socket.

## Install

```sh
pi install npm:@sdillen/pi-ssh
```

Try it for a single run:

```sh
pi -e npm:@sdillen/pi-ssh --ssh user@host[:/remote/path]
```

Requirements: bash on the remote host and a reachable SSH key.

## Notes

- **sudo is its own tool.** `sudo ...` in the bash tool is rejected remotely. The sudo tool runs the command as `sudo bash -c`, so pipes, `&&`, and redirects all run as root.
- **Password**: remembered for 4 minutes, then asked again. A wrong password triggers one retry.
- **Authentication**: after the first interactive authentication, the ControlMaster socket (`~/.ssh/controlmaster/...`) is reused. Its lifetime after the last connection is `SSH_CONTROL_PERSIST` seconds (default 43200 = 12 h). If the master dies mid-session, pi re-authenticates once automatically.

Full architecture notes and the development setup are in the [repository README](https://github.com/sdillen/pi-extensions#readme).

## License

[MIT](LICENSE)
