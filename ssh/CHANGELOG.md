# Changelog — ssh

Alle Einträge vor 2026-08-14 stammen aus dem dotfiles-Repository
(pi-extensions/ssh.ts), in dem dieses Modul zuvor versioniert wurde.

## 2026-09-30

- feat(pi-ssh): tell the agent how sudo works in --ssh mode
- fix(pi-ssh): feed sudo password even with -n or wrapper commands
- feat(pi-ssh): report sudo and YubiKey prompts as blocked to herdr
- feat(pi-ssh): add dedicated sudo tool for the SSH remote
- fix(pi-ssh): render sudo tool calls with their command

## 2026-08-17

- feat(ssh-extension): authenticate ed25519-sk YubiKey interactively via ControlMaster
- fix(ssh-extension): detect and recover from zombie ControlMaster

## 2026-08-14

- feat(pi): add SSH remote execution extension (initial version, aus dotfiles übernommen)
