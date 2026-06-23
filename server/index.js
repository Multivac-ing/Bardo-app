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
const hostToken = process.env.BARDO_HOST_TOKEN || Math.random().toString(36).slice(2, 10);

const app = express();
const server = http.createServer(app);
// Increase Socket.IO maxHttpBufferSize to 10MB to support audio file uploads
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024
});

const clients = new Map();
let currentAsset = null;

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
    latencyMs: client.latencyMs,
    assetDecoded: client.assetDecoded ?? false,
    assetError: client.assetError ?? null
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
  const isHost = socket.handshake.auth?.token === hostToken || socket.handshake.query?.token === hostToken;

  const client = {
    id: socket.id,
    connectedAt: new Date().toISOString(),
    label: isHost ? "Host" : `Device ${clients.size + 1}`,
    ready: false,
    audioUnlocked: false,
    userAgent: "",
    clientType: isHost ? "host" : "phone",
    clockOffsetMs: null,
    latencyMs: null,
    assetDecoded: false,
    assetError: null
  };

  clients.set(socket.id, client);
  console.log(`[client connected] ${client.label} (${socket.id}) as ${client.clientType}`);

  socket.emit("server:hello", {
    id: socket.id,
    serverTime: Date.now(),
    joinUrl: getJoinUrl(),
    clientType: client.clientType,
    currentAsset: currentAsset ? {
      name: currentAsset.name,
      type: currentAsset.type,
      size: currentAsset.size
    } : null
  });

  // If a new client connects and an asset exists, deliver it to them
  if (currentAsset) {
    socket.emit("server:asset-loaded", currentAsset);
  }

  broadcastClients();

  socket.on("client:profile", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current) return;

    current.userAgent = String(payload.userAgent || "");
    // Keep "Host" label for host unless customized, but respect token role
    if (current.clientType === "host") {
      current.label = String(payload.label || "Host").slice(0, 80);
    } else {
      current.label = String(payload.label || current.label).slice(0, 80);
      current.clientType = payload.clientType === "simulator" ? "simulator" : "phone";
    }
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

  // Host-only upload handler
  socket.on("host:upload-audio", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current || current.clientType !== "host") {
      console.log(`[unauthorized upload] ${current?.label || socket.id} tried to upload audio.`);
      socket.emit("server:error", "Unauthorized: Only the host can upload audio.");
      return;
    }

    const { name, type, size, data } = payload;
    if (!data || !Buffer.isBuffer(data)) {
      socket.emit("server:error", "Invalid audio payload.");
      return;
    }

    const MAX_SIZE = 8 * 1024 * 1024; // 8MB
    if (size > MAX_SIZE || data.length > MAX_SIZE) {
      socket.emit("server:error", "Audio file is too large. Max size is 8MB.");
      return;
    }

    if (!type || !type.startsWith("audio/")) {
      socket.emit("server:error", "Invalid file type. Only audio files are supported.");
      return;
    }

    currentAsset = { name, type, size, data };
    console.log(`[asset uploaded] "${name}" (${size} bytes, ${type})`);

    // Reset decoding state for all connected phones
    for (const c of clients.values()) {
      if (c.clientType === "phone" || c.clientType === "simulator") {
        c.assetDecoded = false;
        c.assetError = null;
      }
    }

    io.emit("server:asset-loaded", { name, type, size, data });
    broadcastClients();
  });

  // Client decoding status reporting
  socket.on("client:asset-ready", (payload = {}) => {
    const current = clients.get(socket.id);
    if (!current) return;

    current.assetDecoded = Boolean(payload.ready);
    current.assetError = payload.error || null;
    console.log(`[client asset-ready] ${current.label}: decoded=${current.assetDecoded} error=${current.assetError}`);
    broadcastClients();
  });

  socket.on("host:play-test", () => {
    const sender = clients.get(socket.id);
    if (!sender || sender.clientType !== "host") {
      socket.emit("server:error", "Unauthorized: Only the host can start a sync test.");
      return;
    }

    const phones = [...clients.values()].filter((c) => c.clientType === "phone");
    const unreadyPhones = phones.filter((p) => !p.ready || !p.audioUnlocked || p.clockOffsetMs === null);

    if (unreadyPhones.length > 0) {
      const reasons = unreadyPhones.map((p) => {
        if (!p.ready || !p.audioUnlocked) return `${p.label} (locked audio)`;
        if (p.clockOffsetMs === null) return `${p.label} (no sync)`;
        return p.label;
      }).join(", ");
      socket.emit("server:error", `Cannot play sync test: some phones are not ready: ${reasons}`);
      return;
    }

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

  socket.on("host:play-asset", () => {
    const sender = clients.get(socket.id);
    if (!sender || sender.clientType !== "host") {
      socket.emit("server:error", "Unauthorized: Only the host can play the asset.");
      return;
    }

    if (!currentAsset) {
      socket.emit("server:error", "No audio asset has been uploaded.");
      return;
    }

    const phones = [...clients.values()].filter((c) => c.clientType === "phone" || c.clientType === "simulator");

    const unreadyPhones = phones.filter((p) => {
      return !p.ready || !p.audioUnlocked || p.clockOffsetMs === null || !p.assetDecoded;
    });

    if (unreadyPhones.length > 0) {
      const reasons = unreadyPhones.map((p) => {
        if (!p.ready || !p.audioUnlocked) return `${p.label} (locked audio)`;
        if (p.clockOffsetMs === null) return `${p.label} (no sync)`;
        if (!p.assetDecoded) return `${p.label} (audio not decoded: ${p.assetError || "pending"})`;
        return p.label;
      }).join(", ");
      socket.emit("server:error", `Cannot play: some phones are not ready: ${reasons}`);
      return;
    }

    const serverStartAt = Date.now() + 3000;
    io.emit("server:play-asset", { serverStartAt });
    console.log(`[play-asset] sent to ${clients.size} client(s), start=${serverStartAt}`);
  });

  socket.on("host:stop", () => {
    const sender = clients.get(socket.id);
    if (!sender || sender.clientType !== "host") {
      socket.emit("server:error", "Unauthorized: Only the host can stop playback.");
      return;
    }

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
  const boundPort = server.address().port;
  console.log("");
  console.log(`[server:started] port=${boundPort} token=${hostToken}`);
  console.log("Bardo local server is running.");
  console.log(`Host dashboard: http://localhost:${boundPort}/?token=${hostToken}`);
  console.log(`Phone join URL: ${getJoinUrl()}`);
  console.log("");
  console.log("Connect phones to the same WiFi and open the phone join URL.");
});
