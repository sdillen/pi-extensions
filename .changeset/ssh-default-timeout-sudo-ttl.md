---
"@sdillen/pi-ssh": minor
---

Add a default 300s timeout for remote bash and sudo commands in `--ssh` mode. An explicit timeout still overrides the default. The cached sudo password TTL is now renewed on each use, so it only expires after inactivity.
