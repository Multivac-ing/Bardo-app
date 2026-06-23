# Architecture

## v0 model

```text
Laptop / PC
  └─ Node.js local server
      ├─ Express static web app
      ├─ Socket.IO coordinator
      └─ QR / join URL

Phones
  └─ Chrome browser client
      ├─ WebSocket connection
      ├─ Clock offset estimation
      ├─ Manual audio unlock
      └─ Web Audio scheduled playback
```

## Session control

When the server starts, it creates an in-memory host token and prints a localhost-only dashboard URL containing it. Phone join URLs never include that token. The server authorizes control messages itself, so hiding host buttons in the phone UI is not the security boundary.

Before a test can start, every connected phone must have unlocked audio and reported a clock-sync result. Playback and stop events are emitted only to phone sockets.

## Timing approach

The server is the shared clock authority.

Each client sends multiple ping samples to estimate:

- round-trip time;
- approximate client/server clock offset.

When the host presses Sync test, the server broadcasts a future server timestamp.

Each client converts that timestamp into its local `performance.now()` clock and schedules Web Audio playback.

## Why Web Audio?

Web Audio supports precise scheduling relative to `AudioContext.currentTime`, which is better than calling `audio.play()` at the exact moment a WebSocket message arrives.

## Future improvements

- Better clock sync algorithm.
- Audio file preloading.
- Per-device calibration.
- Microphone-based acoustic calibration over HTTPS/local certificates.
- Dynamic drift correction.
- Host-only control mode.
- PWA install support.
