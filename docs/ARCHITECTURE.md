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
