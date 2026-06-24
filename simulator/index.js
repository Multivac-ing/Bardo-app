import { io } from "socket.io-client";

const requestedCount = Number.parseInt(process.argv[2] || "5", 10);
const count = Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 5;
const url = process.env.BARDO_URL || "http://localhost:3001";

console.log(`[simulator] Starting ${count} fake client(s) against ${url}`);

const clients = Array.from({ length: count }, (_, index) => {
  const number = index + 1;
  const socket = io(url, { transports: ["websocket"] });
  const label = `Simulator ${number}`;
  const fakeOffsetMs = (number * 7) % 31 - 15;
  const fakeLatencyMs = 8 + ((number * 11) % 24);

  socket.on("connect", () => {
    console.log(`[${label}] connected (${socket.id})`);
    socket.emit("client:profile", {
      label,
      userAgent: "Bardo Node simulator",
      clientType: "simulator"
    });
    socket.emit("client:ready", { ready: true, audioUnlocked: true });
    socket.emit("client:sync-report", {
      clockOffsetMs: fakeOffsetMs,
      latencyMs: fakeLatencyMs
    });
    socket.emit("client:sync-ping", { seq: number, clientSentAt: Date.now() });
    console.log(`[${label}] ready; offset=${fakeOffsetMs}ms latency=${fakeLatencyMs}ms`);
  });

  socket.on("server:sync-pong", (payload) => {
    console.log(`[${label}] sync pong seq=${payload.seq ?? "?"}`);
  });

  socket.on("server:play-test", ({ serverStartAt }) => {
    console.log(`[${label}] play-test scheduled for ${new Date(serverStartAt).toISOString()}`);
    socket.emit("client:play-test-received", { serverStartAt });
  });

  socket.on("server:stop", () => {
    console.log(`[${label}] stop received`);
    socket.emit("client:stop-received");
  });

  socket.on("disconnect", (reason) => {
    console.log(`[${label}] disconnected: ${reason}`);
  });

  socket.on("connect_error", (error) => {
    console.error(`[${label}] connection error: ${error.message}`);
  });

  return socket;
});

function shutdown() {
  console.log("[simulator] Disconnecting fake clients.");
  clients.forEach((socket) => socket.disconnect());
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
