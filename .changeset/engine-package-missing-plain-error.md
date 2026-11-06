---
"@agent-native/core": patch
---

A chat run on an engine whose optional package is not installed now fails with the typed code `engine_package_not_installed` and a plain message that says to choose a different model, instead of a developer-only "pnpm add" instruction. The install hint is logged on the server.
