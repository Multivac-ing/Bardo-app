import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const MAX_CLOCK_SYNC_AGE_MS = 45_000;
const RECONNECT_GRACE_MS = 10_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: MAX_AUDIO_BYTES + 1024 * 1024 });
const clients = new Map();
const hostToken = crypto.randomUUID();
let currentAsset = null;

function getLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function getPublicHost() {
  return process.env.BARDO_HOST || getLanAddresses()[0] || "localhost";
}

function getJoinUrl() {
  return `http://${getPublicHost()}:${PORT}`;
}

function getHostUrl() {
  return `http://localhost:${PORT}/?hostToken=${hostToken}`;
}

function getClientList() {
  return [...clients.values()].map((client) => ({
    id: client.id,
    clientId: client.clientId,
    connected: client.connected,
    connectedAt: client.connectedAt,
    label: client.label,
    role: client.role,
    ready: client.ready,
    audioUnlocked: client.audioUnlocked,
    userAgent: client.userAgent,
    clockOffsetMs: client.clockOffsetMs,
    latencyMs: client.latencyMs,
    playbackCalibrationMs: client.playbackCalibrationMs,
    lastSyncedAt: client.lastSyncedAt,
    assetReady: client.assetReady
  }));
}

function broadcastClients() {
  io.emit("server:clients", getClientList());
}

app.use(express.static(path.join(projectRoot, "client")));

app.get("/api/config", async (req, res) => {
  const joinUrl = getJoinUrl();
  res.json({
    appName: "Bardo",
    version: "0.0.2",
    joinUrl,
    qrDataUrl: await QRCode.toDataURL(joinUrl),
    isHost: req.query.hostToken === hostToken,
    lanAddresses: getLanAddresses(),
    serverTime: Date.now()
  });
});

io.on("connection", (socket) => {
  const clientId = String(socket.handshake.auth?.clientId || socket.id).slice(0, 100);
  let client = [...clients.values()].find((entry) => entry.clientId === clientId);

  if (client) {
    clearTimeout(client.cleanupTimeout);
    clients.delete(client.id);
    client.id = socket.id;
    client.connected = true;
    client.ready = false;
    client.audioUnlocked = false;
    client.clockOffsetMs = null;
    client.latencyMs = null;
    client.lastSyncedAt = null;
    clients.set(socket.id, client);
  } else {
    client = {
    id: socket.id,
    clientId,
    connected: true,
    connectedAt: new Date().toISOString(),
    label: `Device ${clients.size + 1}`,
    role: "phone",
    ready: false,
    audioUnlocked: false,
    userAgent: "",
    clockOffsetMs: null,
    latencyMs: null,
    playbackCalibrationMs: 0,
    lastSyncedAt: null,
    assetReady: false,
    cleanupTimeout: null
    };

    clients.set(socket.id, client);
  }

  socket.emit("server:hello", {
    id: socket.id,
    clientId,
    serverTime: Date.now(),
    joinUrl: getJoinUrl()
  });
  if (currentAsset && client.role === "phone") {
    socket.emit("server:asset-loaded", currentAsset);
  }
  broadcastClients();

  socket.on("client:profile", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current) return;

    current.userAgent = String(payload.userAgent || "");
    current.label = String(payload.label || current.label).slice(0, 80);
    current.role = payload.hostToken === hostToken ? "host" : "phone";
    broadcastClients();
  });

  socket.on("client:ready", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current || current.role !== "phone") return;
    current.ready = Boolean(payload.ready);
    current.audioUnlocked = Boolean(payload.audioUnlocked);
    broadcastClients();
  });

  socket.on("client:sync-ping", (payload = {}) => {
    socket.emit("server:sync-pong", {
      seq: payload.seq,
      clientSentAt: payload.clientSentAt,
      serverReceivedAt: Date.now()
    });
  });

  socket.on("client:sync-report", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current || current.role !== "phone") return;
    current.clockOffsetMs = Number.isFinite(payload.clockOffsetMs) ? Math.round(payload.clockOffsetMs) : null;
    current.latencyMs = Number.isFinite(payload.latencyMs) ? Math.round(payload.latencyMs) : null;
    current.playbackCalibrationMs = Number.isFinite(payload.playbackCalibrationMs)
      ? Math.max(-200, Math.min(200, Math.round(payload.playbackCalibrationMs)))
      : 0;
    current.lastSyncedAt = new Date().toISOString();
    broadcastClients();
  });

  socket.on("host:upload-audio", (payload = {}, ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    const current = clients.get(socket.id);
    if (!current || current.role !== "host") {
      respond({ ok: false, message: "Only the host can upload audio." });
      return;
    }
    const { name, type, data } = payload;
    if (!Buffer.isBuffer(data) || !String(type).startsWith("audio/") || data.length > MAX_AUDIO_BYTES) {
      respond({ ok: false, message: "Use a supported audio file up to 8 MB." });
      return;
    }
    currentAsset = { id: crypto.randomUUID(), name: String(name || "audio").slice(0, 120), type, size: data.length, data };
    for (const phone of clients.values()) {
      if (phone.role === "phone") phone.assetReady = false;
    }
    for (const phone of clients.values()) {
      if (phone.role === "phone" && phone.connected) io.to(phone.id).emit("server:asset-loaded", currentAsset);
    }
    broadcastClients();
    respond({ ok: true, asset: { id: currentAsset.id, name: currentAsset.name, size: currentAsset.size } });
  });

  socket.on("client:asset-ready", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current || current.role !== "phone" || !currentAsset) return;
    current.assetReady = payload.assetId === currentAsset.id && Boolean(payload.ready);
    broadcastClients();
  });

  socket.on("host:play-test", (ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    const current = clients.get(socket.id);
    if (!current || current.role !== "host") {
      respond({ ok: false, message: "Only the host can start a sync test." });
      return;
    }

    const phones = [...clients.values()].filter((client) => client.role === "phone");
    const unavailable = phones.filter(
      (phone) =>
        !phone.ready ||
        !Number.isFinite(phone.clockOffsetMs) ||
        !phone.lastSyncedAt ||
        Date.now() - new Date(phone.lastSyncedAt).getTime() > MAX_CLOCK_SYNC_AGE_MS
    );

    if (!phones.length) {
      respond({ ok: false, message: "No phones connected yet." });
      return;
    }
    if (unavailable.length) {
      respond({ ok: false, message: `${unavailable.length} phone(s) need audio unlock and a recent clock sync.` });
      return;
    }

    const serverStartAt = Date.now() + 3000;
    const pattern = [
      { frequency: 392, durationMs: 180 }, { frequency: 0, durationMs: 80 },
      { frequency: 523.25, durationMs: 180 }, { frequency: 0, durationMs: 80 },
      { frequency: 659.25, durationMs: 280 }, { frequency: 0, durationMs: 100 },
      { frequency: 783.99, durationMs: 360 }
    ];
    for (const phone of phones) {
      io.to(phone.id).emit("server:play-test", { serverStartAt, pattern });
    }
    respond({ ok: true, phoneCount: phones.length });
  });

  socket.on("host:stop", (ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    const current = clients.get(socket.id);
    if (!current || current.role !== "host") {
      respond({ ok: false, message: "Only the host can stop playback." });
      return;
    }
    for (const phone of clients.values()) {
      if (phone.role === "phone") io.to(phone.id).emit("server:stop");
    }
    respond({ ok: true });
  });

  socket.on("host:play-asset", (ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    const current = clients.get(socket.id);
    if (!current || current.role !== "host") return respond({ ok: false, message: "Only the host can play audio." });
    if (!currentAsset) return respond({ ok: false, message: "Upload an audio file first." });
    const phones = [...clients.values()].filter((client) => client.role === "phone");
    const unavailable = phones.filter((phone) => !phone.ready || !phone.assetReady || !Number.isFinite(phone.clockOffsetMs));
    if (!phones.length || unavailable.length) return respond({ ok: false, message: "Every connected phone must be ready and decode the audio." });
    const serverStartAt = Date.now() + 3000;
    for (const phone of phones) io.to(phone.id).emit("server:play-asset", { assetId: currentAsset.id, serverStartAt });
    respond({ ok: true, phoneCount: phones.length });
  });

  socket.on("host:kick-device", (payload = {}, ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    const current = clients.get(socket.id);
    if (!current || current.role !== "host") {
      respond({ ok: false, message: "Only the host can remove a phone." });
      return;
    }

    const targetId = String(payload.id || "");
    const target = clients.get(targetId);
    if (!target || target.role !== "phone") {
      respond({ ok: false, message: "That phone is no longer connected." });
      return;
    }

    io.to(target.id).emit("server:kicked");
    io.sockets.sockets.get(target.id)?.disconnect(true);
    respond({ ok: true, label: target.label });
  });

  socket.on("disconnect", () => {
    const current = clients.get(socket.id);
    if (!current) return;

    if (current.role === "host") {
      clients.delete(socket.id);
      broadcastClients();
      return;
    }

    current.connected = false;
    current.ready = false;
    broadcastClients();

    current.cleanupTimeout = setTimeout(() => {
      if (clients.get(current.id) === current && !current.connected) {
        clients.delete(current.id);
        broadcastClients();
      }
    }, RECONNECT_GRACE_MS);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("Bardo local server is running.");
  console.log(`Host dashboard: ${getHostUrl()}`);
  console.log(`Phone join URL: ${getJoinUrl()}`);
  console.log("");
  console.log("Connect phones to the same WiFi and open the phone join URL.");
});
