import { spawn } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { io } from "socket.io-client";

// Helper: start server and resolve { port, token, serverUrl }
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["server/index.js"], {
      env: { ...process.env, PORT: "0" }
    });

    let started = false;
    proc.stdout.on("data", (data) => {
      const match = data.toString().match(/\[server:started\] port=(\d+) token=(\w+)/);
      if (match) {
        started = true;
        resolve({ proc, port: Number(match[1]), token: match[2], serverUrl: `http://localhost:${match[1]}` });
      }
    });
    proc.stderr.on("data", (d) => { /* suppress */ });
    proc.on("error", (err) => { if (!started) reject(err); });
    setTimeout(() => { if (!started) { proc.kill(); reject(new Error("Server startup timeout")); } }, 5000);
  });
}

// Helper: connect and wait for socket "connect" event
function connect(url, opts = {}) {
  return new Promise((resolve) => {
    const s = io(url, { transports: ["websocket"], ...opts });
    s.once("connect", () => resolve(s));
  });
}

// Helper: wait for specific socket event
function waitFor(socket, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

describe("Bardo Server Integration Tests", () => {
  let serverProcess;
  let token;
  let serverUrl;

  before(async () => {
    const { proc, token: t, serverUrl: u } = await startServer();
    serverProcess = proc;
    token = t;
    serverUrl = u;
  });

  after(() => { if (serverProcess) serverProcess.kill(); });

  test("Only the host can upload audio", async () => {
    const phone = await connect(serverUrl);
    const host = await connect(serverUrl, { auth: { token } });

    // Phone upload should be rejected
    const errMsg = await new Promise((resolve, reject) => {
      phone.emit("host:upload-audio", { name: "t.mp3", type: "audio/mp3", size: 4, data: Buffer.from("data") });
      phone.once("server:error", resolve);
      setTimeout(() => reject(new Error("No error received")), 2000);
    });
    assert.match(errMsg, /Unauthorized/);

    // Host upload should broadcast server:asset-loaded
    const assetPromise = waitFor(phone, "server:asset-loaded");
    host.emit("host:upload-audio", { name: "song.mp3", type: "audio/mp3", size: 4, data: Buffer.from("data") });
    const asset = await assetPromise;
    assert.equal(asset.name, "song.mp3");

    phone.close();
    host.close();
  });

  test("Host cannot play asset until phone is fully ready (unlocked + synced + decoded)", async () => {
    const host = await connect(serverUrl, { auth: { token } });
    const phone = await connect(serverUrl);

    // Upload asset so there is something to play
    const assetPromise = waitFor(phone, "server:asset-loaded");
    host.emit("host:upload-audio", { name: "a.mp3", type: "audio/mp3", size: 4, data: Buffer.from("data") });
    await assetPromise;

    // Try play — should fail (phone not ready)
    const errMsg = await new Promise((resolve, reject) => {
      host.emit("host:play-asset");
      host.once("server:error", resolve);
      setTimeout(() => reject(new Error("No error received")), 2000);
    });
    assert.match(errMsg, /Cannot play/);

    // Mark phone fully ready
    phone.emit("client:ready", { ready: true, audioUnlocked: true });
    phone.emit("client:sync-report", { clockOffsetMs: 3, latencyMs: 8 });
    phone.emit("client:asset-ready", { ready: true });

    // Wait until host sees the phone as fully ready
    await new Promise((resolve) => {
      host.on("server:clients", (clients) => {
        const p = clients.find((c) => c.clientType !== "host");
        if (p && p.ready && p.assetDecoded) resolve();
      });
    });

    // Now play should succeed
    const playPromise = waitFor(phone, "server:play-asset");
    host.emit("host:play-asset");
    const payload = await playPromise;
    assert.ok(Number.isFinite(payload.serverStartAt));

    host.close();
    phone.close();
  });

  test("Phone reconnect restores client entry without creating a ghost", async () => {
    const cid = "reconnect-test-phone";
    let phone = await connect(serverUrl, { auth: { clientId: cid } });
    const host = await connect(serverUrl, { auth: { token } });

    phone.emit("client:profile", { label: "ReconnectPhone", userAgent: "test" });
    phone.emit("client:ready", { ready: true, audioUnlocked: true });
    phone.emit("client:sync-report", { clockOffsetMs: 10, latencyMs: 5 });

    // Wait for host to see one connected phone
    await new Promise((resolve) => {
      host.on("server:clients", (clients) => {
        const phones = clients.filter((c) => c.clientType !== "host");
        if (phones.length === 1 && phones[0].ready) resolve();
      });
    });

    // Disconnect phone abruptly
    phone.disconnect();

    // Wait briefly (reconnect grace window) then reconnect with same clientId
    await new Promise((r) => setTimeout(r, 200));

    phone = await connect(serverUrl, { auth: { clientId: cid } });
    phone.emit("client:profile", { label: "ReconnectPhone", userAgent: "test" });
    phone.emit("client:sync-report", { clockOffsetMs: 10, latencyMs: 5 });
    phone.emit("client:ready", { ready: true, audioUnlocked: true });

    // Host should see exactly ONE phone entry — no ghost
    await new Promise((resolve) => {
      host.on("server:clients", (clients) => {
        const phones = clients.filter((c) => c.clientType !== "host");
        if (phones.length === 1) resolve();
      });
    });

    const clientList = await new Promise((resolve) => {
      host.once("server:clients", resolve);
      host.emit("host:play-test"); // trigger broadcast
    });

    const phones = clientList.filter((c) => c.clientType !== "host");
    assert.equal(phones.length, 1, "Should have exactly one phone entry after reconnect (no ghost)");

    phone.close();
    host.close();
  });
});
