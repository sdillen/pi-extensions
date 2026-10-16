# @sdillen/pi-ssh

## 0.2.0

### Minor Changes

- e95b535: Add a default 300s timeout for remote bash and sudo commands in `--ssh` mode. An explicit timeout still overrides the default. The cached sudo password TTL is now renewed on each use, so it only expires after inactivity.

## 0.1.1

### Patch Changes

- 7db985c: Initial release through Changesets and npm trusted publishing: publish workflow, per-package READMEs and MIT license.
