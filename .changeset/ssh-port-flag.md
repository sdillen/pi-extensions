---
"@sdillen/pi-ssh": minor
---

- Add `--ssh-port <port>` to set a non-default SSH port for all connections (ControlMaster auth, control commands, remote commands). Each port gets its own ControlMaster socket.
- Apply the remote context by mutating the system prompt options in place instead of returning a replaced `systemPrompt`, which avoids a prompt cache miss.
