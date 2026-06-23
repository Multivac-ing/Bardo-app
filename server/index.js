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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const clients = new Map();

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }

  return addresses;
}

function getPublicHost() {
  const forcedHost = process.env.BARDO_HOST;
  if (forcedHost) return forcedHost;

  const [firstLanAddress] = getLanAddresses();
  return firstLanAddress || "localhost";
}

function getJoinUrl() {
  return `http://${getPublicHost()}:${PORT}`;
}

function getClientList() {
  return [...clients.values()].map((client) => ({
    id: client.id,
    connectedAt: client.connectedAt,
    label: client.label,
    ready: client.ready,
    audioUnlocked: client.audioUnlocked,
    userAgent: client.userAgent,
    clockOffsetMs: client.clockOffsetMs,
    latencyMs: client.latencyMs
  }));
}

function broadcastClients() {
  io.emit("server:clients", getClientList());
}

app.use(express.static(path.join(projectRoot, "client")));

app.get("/api/config", async (_req, res) => {
  const joinUrl = getJoinUrl();

  res.json({
    appName: "Bardo",
    version: "0.0.1",
    joinUrl,
    qrDataUrl: await QRCode.toDataURL(joinUrl),
    lanAddresses: getLanAddresses(),
    serverTime: Date.now()
  });
});

io.on("connection", (socket) => {
  const client = {
    id: socket.id,
    connectedAt: new Date().toISOString(),
    label: `Device ${clients.size + 1}`,
    ready: false,
    audioUnlocked: false,
    userAgent: "",
    clockOffsetMs: null,
    latencyMs: null
  };

  clients.set(socket.id, client);

  socket.emit("server:hello", {
    id: socket.id,
    serverTime: Date.now(),
    joinUrl: getJoinUrl()
  });

  broadcastClients();

  socket.on("client:profile", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current) return;

    current.userAgent = String(payload.userAgent || "");
    current.label = String(payload.label || current.label).slice(0, 80);
    broadcastClients();
  });

  socket.on("client:ready", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current) return;

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
    if (!current) return;

    current.clockOffsetMs = Number.isFinite(payload.clockOffsetMs)
      ? Math.round(payload.clockOffsetMs)
      : null;

    current.latencyMs = Number.isFinite(payload.latencyMs)
      ? Math.round(payload.latencyMs)
      : null;

    broadcastClients();
  });

  socket.on("host:play-test", () => {
    const serverStartAt = Date.now() + 3000;

    io.emit("server:play-test", {
      serverStartAt,
      pattern: [
        { frequency: 392, durationMs: 180 },
        { frequency: 0, durationMs: 80 },
        { frequency: 523.25, durationMs: 180 },
        { frequency: 0, durationMs: 80 },
        { frequency: 659.25, durationMs: 280 },
        { frequency: 0, durationMs: 100 },
        { frequency: 783.99, durationMs: 360 }
      ]
    });
  });

  socket.on("host:stop", () => {
    io.emit("server:stop");
  });

  socket.on("disconnect", () => {
    clients.delete(socket.id);
    broadcastClients();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("Bardo local server is running.");
  console.log(`Host dashboard: http://localhost:${PORT}`);
  console.log(`Phone join URL: ${getJoinUrl()}`);
  console.log("");
  console.log("Connect phones to the same WiFi and open the phone join URL.");
});
