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

Start the local server on port 3001:

```bash
PORT=3001 npm start
```

Open the host dashboard on the computer:

```text
http://localhost:3001
```

Then open the LAN URL shown by the app from every phone connected to the same WiFi.

## Simulation lab

The lab makes browser-based fake phones so development can validate connection,
ready state, clock sync, play-test, and stop coordination without waiting for
real devices. Start the server as above, then open:

```text
http://localhost:3001/lab
```

Choose the number of simulated phones (five by default), create them, mark them
ready, run clock sync, and use **Sync test** or **Stop**. The cards and server
logs show each event.

For a Node-based simulation, in another terminal run:

```bash
BARDO_URL=http://localhost:3001 npm run simulate -- 5
```

`BARDO_URL` is optional and defaults to `http://localhost:3001`. Press Ctrl+C
to disconnect the fake clients.

Simulation validates Socket.IO coordination and scheduling messages. It does
not validate real speaker synchronization, browser audio policies, or WiFi
timing; keep a real-phone pass for those later.

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
