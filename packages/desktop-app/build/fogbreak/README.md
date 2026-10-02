# Fogbreak app icon prerequisite

Place the approved existing Fogbreak 1024-pixel square PNG at `icon-source.png`, with its verified source revision and hash recorded in the handoff. No icon was supplied in the implementation packet. The upstream Agent-Native artwork and inherited website favicon are not Fogbreak assets.

The desktop-local `build:fogbreak:mac-assets` script uses this input with macOS `sips`, `iconutil`, and Xcode `actool`; it does not invoke the upstream repository-wide branding generator. Mac asset generation, Swift helper and Chrome extension packaging remain a macOS-runner stage. Generated products stay in this directory. Do not run the generic `build:mac` branding path for the owned distribution.
