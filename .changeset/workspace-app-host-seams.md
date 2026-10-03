---
"@agent-native/dispatch": minor
---

Add an optional `workspaceApps` extension to `DispatchExtensionConfig` for per-frame theme composition and frame lifecycle observation. App-chat full view now presents the rail's own live chat controller full-surface (same thread, draft, in-flight run and open tabs), re-checks any thread it did not produce through the app's access check, publishes the app agent's context to application state, and returns to the exact app route with its retained frame.
