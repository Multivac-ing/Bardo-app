# MVP v0

## Goal

Prove that phones connected to the same WiFi can play a short generated sound pattern almost at the same time.

## Success criteria

- At least 3 phones can join the same local session.
- Every phone can unlock browser audio.
- The host can trigger one synchronized test.
- The perceived start time difference is small enough to feel like a shared sound.
- The demo runs without paid services.

## Non-goals

- Perfect audio quality.
- Music streaming.
- App Store / Play Store publishing.
- Microphone calibration.
- Dynamic phone movement.
- Native app.

## Demo script

1. Start Bardo on a laptop.
2. Show the host dashboard.
3. Connect phones to the same WiFi.
4. Scan the QR from each phone.
5. Tap Unlock audio on each phone.
6. Press Sync test.
7. Listen for the generated sound from all phones.

## Known technical risks

- Browser audio autoplay requires user interaction.
- WiFi latency can vary a lot.
- Phones have different audio hardware latency.
- Some routers isolate clients and block phone-to-computer access.
- HTTP LAN pages cannot safely access microphone APIs in many browsers.
- Mobile browsers can suspend background tabs; Bardo marks a hidden phone unavailable and re-syncs it after it returns.
