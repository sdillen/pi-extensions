---
"@sdillen/pi-brave-search": patch
---

Declare `typebox` as a peer dependency instead of a regular dependency. This fixes the extension loader warning for host-provided packages and avoids loading a duplicate copy of `typebox`.
