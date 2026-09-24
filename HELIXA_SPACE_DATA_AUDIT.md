# Helixa Space — Data Efficiency + Vision Audit

## Current pass
- Preserved the existing Flask/Socket.IO/WebRTC architecture.
- Preserved the existing Helixa custom SVG icon system; `window.HXIcon` remains the shared icon API.
- Camera capture defaults: 640x360, 15 FPS target / 20 FPS max, 400 kbps video ceiling.
- Screen capture defaults: 1280x720, 8 FPS target / 12 FPS max, 700 kbps video ceiling.
- Audio sender ceiling: 32 kbps.
- Sender bitrate/frame-rate controls are reapplied during peer creation and camera/screen-share track replacement.
- Screen-share rendering remains contain/no-crop.

## Waiting-before-host fix
The waiting state now has two paths:
1. Socket.IO `space-started` event for immediate transition.
2. A 2.5-second REST lifecycle check as a recovery path if the browser misses the event while backgrounded/sleeping/reconnecting.

When the API reports `active`, the client retries the original join credentials. When it reports `ended`, the waiting screen changes to an ended state.

## Existing vision features verified statically
- End Meeting is present and host-only in the More menu.
- Rename is present in Settings → Identity.
- More-menu handlers exist for Settings, Share Screen, Raise Hand, Whiteboard, Co-host request, Reactions, Fullscreen, Hide Controls, Rotate, QR, Mute Everyone, Admission, Presentation, Blocked Participants, Whiteboard Access, and End Meeting.
- Custom Helixa SVG icon registry contains the icons referenced by the public and meeting templates.
- Spotlight self-view translation (`my socket id` → local tile) is present.
- Reaction picker has fixed bottom `+` action.
- Whiteboard toolset is present in the meeting template and whiteboard module.
- Duplicate-session protection uses a stable participant token.
- Host identity uses a server-issued host token, not display name.

## Important limitation
Static analysis and syntax checks cannot prove real camera/microphone/WebRTC behavior on every browser/device. Runtime testing on HTTPS with two or more real devices is still required for final acceptance, especially mobile screen sharing, media permissions, reconnection, and actual network byte usage.
