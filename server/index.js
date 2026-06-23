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
    clientType: client.clientType,
    clockOffsetMs: client.clockOffsetMs,
    latencyMs: client.latencyMs
  }));
}

function broadcastClients() {
  io.emit("server:clients", getClientList());
}

app.use(express.static(path.join(projectRoot, "client")));

app.get("/lab", (_req, res) => {
  res.sendFile(path.join(projectRoot, "client", "lab.html"));
});

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
    clientType: "phone",
    clockOffsetMs: null,
    latencyMs: null
  };

  clients.set(socket.id, client);
  console.log(`[client connected] ${client.label} (${socket.id})`);

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
    current.clientType = payload.clientType === "simulator" ? "simulator" : "phone";
    console.log(`[client profile] ${current.label} (${current.clientType})`);
    broadcastClients();
  });

  socket.on("client:ready", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current) return;

    current.ready = Boolean(payload.ready);
    current.audioUnlocked = Boolean(payload.audioUnlocked);
    console.log(
      `[client ready] ${current.label}: ready=${current.ready} audioUnlocked=${current.audioUnlocked}`
    );
    broadcastClients();
  });

  socket.on("client:sync-ping", (payload = {}) => {
    console.log(`[sync ping] ${clients.get(socket.id)?.label || socket.id} seq=${payload.seq ?? "?"}`);
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

    console.log(
      `[sync report] ${current.label}: offset=${current.clockOffsetMs ?? "unknown"}ms latency=${current.latencyMs ?? "unknown"}ms`
    );

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
    console.log(`[play-test] sent to ${clients.size} client(s), start=${serverStartAt}`);
  });

  socket.on("host:stop", () => {
    io.emit("server:stop");
    console.log(`[stop] sent to ${clients.size} client(s)`);
  });

  socket.on("client:play-test-received", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current) return;
    console.log(`[play-test received] ${current.label} start=${payload.serverStartAt ?? "unknown"}`);
  });

  socket.on("client:stop-received", () => {
    const current = clients.get(socket.id);
    if (!current) return;
    console.log(`[stop received] ${current.label}`);
  });

  socket.on("disconnect", () => {
    console.log(`[client disconnected] ${clients.get(socket.id)?.label || socket.id}`);
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
