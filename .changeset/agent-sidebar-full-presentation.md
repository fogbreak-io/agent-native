---
"@agent-native/toolkit": minor
---

Add `presentation: "sidebar" | "full"` to `AgentSidebar`: full presents the same live chat controller over the whole shell without remounting it, while the sidebar's children stay mounted but hidden. A route-owned thread binding switched on for a live controller now takes effect in the same render.
