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
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const clients = new Map();
const hostToken = crypto.randomUUID();

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
    connectedAt: client.connectedAt,
    label: client.label,
    role: client.role,
    ready: client.ready,
    audioUnlocked: client.audioUnlocked,
    userAgent: client.userAgent,
    clockOffsetMs: client.clockOffsetMs,
    latencyMs: client.latencyMs,
    playbackCalibrationMs: client.playbackCalibrationMs,
    lastSyncedAt: client.lastSyncedAt
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
  const client = {
    id: socket.id,
    connectedAt: new Date().toISOString(),
    label: `Device ${clients.size + 1}`,
    role: "phone",
    ready: false,
    audioUnlocked: false,
    userAgent: "",
    clockOffsetMs: null,
    latencyMs: null,
    playbackCalibrationMs: 0,
    lastSyncedAt: null
  };

  clients.set(socket.id, client);
  socket.emit("server:hello", { id: socket.id, serverTime: Date.now(), joinUrl: getJoinUrl() });
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
    clients.delete(socket.id);
    broadcastClients();
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
