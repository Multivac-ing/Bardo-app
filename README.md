# Bardo

**Bardo turns phones on the same WiFi network into a synchronized speaker group.**

This repo starts as a zero-budget, local-first experiment: one computer runs a small web server, phones join from Chrome using the local WiFi address, and every connected phone plays the same generated test sound at the same scheduled time.

> No speaker. No cloud. No app store. Just phones, WiFi, and timing.

## Current goal

Build a real MVP that proves this core idea:

> 3 to 8 phones connected to the same WiFi can reproduce a shared sound almost at the same time.

## MVP v0 scope

Included:

- Local web server.
- Host dashboard.
- Phone client page.
- Join URL and QR code.
- WebSocket connection using Socket.IO.
- Manual audio unlock on every phone.
- Clock offset estimation between client and server.
- Scheduled synchronized Web Audio test pattern.
- Connected device list.

Not included yet:

- Spotify, YouTube, Apple Music, or commercial music integration.
- Play Store publication.
- Native Android/iOS app.
- Microphone calibration.
- Echo cancellation.
- Dynamic phone movement correction.
- Cloud backend.

## Why local-first?

Bardo is being built with a poor-founder constraint: the first usable version must cost **USD 0** to run.

The first version only needs:

- One laptop or desktop.
- One WiFi network.
- Several phones with Chrome.

## Run locally

Install dependencies:

```bash
npm install
```

Start the local server:

```bash
npm start
```

Open the **Host dashboard URL printed in the terminal** on the computer. It includes a one-time local host key; keep it private from guests:

```text
http://localhost:3000/?hostToken=...
```

Then open the LAN URL shown by the app from every phone connected to the same WiFi. It joins in phone mode and cannot control playback.

## First demo flow

1. Start the server from the computer.
2. Open the host dashboard.
3. Scan the QR with each phone.
4. Tap **Unlock audio** on every phone.
5. Wait until clients show as ready.
6. Press **Sync test** from the host.
7. All phones should play the same short pattern together.

## Repository structure

```text
.
├── client/              # Browser UI used by host and phones
├── docs/                # Product and technical planning
├── server/              # Local Node.js server and WebSocket coordinator
├── package.json         # Node project scripts and dependencies
└── README.md
```

## Working name

**Bardo**

Tagline candidates:

- No tenés parlante. Tenés Bardo.
- Your speaker is already in your friends' pockets.
- Local-first party sound from shared phones.
