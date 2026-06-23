import { spawn } from "node:child_process";
import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { io } from "socket.io-client";

describe("Bardo Server Integration Tests", () => {
  let serverProcess;
  let port;
  let token;
  let serverUrl;

  before(() => {
    return new Promise((resolve, reject) => {
      // Start server on port 0 to bind to a free port
      serverProcess = spawn("node", ["server/index.js"], {
        env: { ...process.env, PORT: "0" }
      });

      let started = false;
      serverProcess.stdout.on("data", (data) => {
        const line = data.toString();
        const match = line.match(/\[server:started\] port=(\d+) token=(\w+)/);
        if (match) {
          port = Number(match[1]);
          token = match[2];
          serverUrl = `http://localhost:${port}`;
          started = true;
          resolve();
        }
      });

      serverProcess.stderr.on("data", (data) => {
        console.error("[SERVER ERR]:", data.toString());
      });

      serverProcess.on("error", (err) => {
        if (!started) reject(err);
      });

      setTimeout(() => {
        if (!started) {
          serverProcess.kill();
          reject(new Error("Timeout waiting for server startup"));
        }
      }, 5000);
    });
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  test("Only the host can upload audio", async () => {
    const phoneSocket = io(serverUrl, { transports: ["websocket"] });
    const hostSocket = io(serverUrl, {
      transports: ["websocket"],
      auth: { token }
    });

    await new Promise((resolve) => {
      let phoneConnected = false;
      let hostConnected = false;
      
      phoneSocket.on("connect", () => { phoneConnected = true; check(); });
      hostSocket.on("connect", () => { hostConnected = true; check(); });

      function check() {
        if (phoneConnected && hostConnected) resolve();
      }
    });

    // Try to upload audio from phone client
    const uploadPromise = new Promise((resolve, reject) => {
      phoneSocket.emit("host:upload-audio", {
        name: "test.mp3",
        type: "audio/mp3",
        size: 1000,
        data: Buffer.from("fake data")
      });

      phoneSocket.on("server:error", (msg) => {
        if (msg.includes("Unauthorized")) {
          resolve(msg);
        } else {
          reject(new Error(`Unexpected error message: ${msg}`));
        }
      });

      setTimeout(() => reject(new Error("Timeout waiting for authorization failure")), 2000);
    });

    const errorMsg = await uploadPromise;
    assert.match(errorMsg, /Unauthorized/);

    // Upload audio from host client
    const successPromise = new Promise((resolve, reject) => {
      hostSocket.emit("host:upload-audio", {
        name: "test.mp3",
        type: "audio/mp3",
        size: 1000,
        data: Buffer.from("fake data")
      });

      phoneSocket.on("server:asset-loaded", (asset) => {
        assert.equal(asset.name, "test.mp3");
        resolve();
      });

      setTimeout(() => reject(new Error("Timeout waiting for asset broadcast")), 2000);
    });

    await successPromise;

    phoneSocket.close();
    hostSocket.close();
  });

  test("Host cannot play asset until all phones are ready and have decoded it", async () => {
    const hostSocket = io(serverUrl, {
      transports: ["websocket"],
      auth: { token }
    });

    const phoneSocket = io(serverUrl, {
      transports: ["websocket"]
    });

    await new Promise((resolve) => {
      let count = 0;
      hostSocket.on("connect", () => { count++; if (count === 2) resolve(); });
      phoneSocket.on("connect", () => { count++; if (count === 2) resolve(); });
    });

    // 1. Host uploads audio
    hostSocket.emit("host:upload-audio", {
      name: "sample.mp3",
      type: "audio/mp3",
      size: 500,
      data: Buffer.from("audio data")
    });

    await new Promise((resolve) => {
      phoneSocket.on("server:asset-loaded", () => resolve());
    });

    // 2. Host tries to play asset. It should fail because phone is not unlocked/synced/decoded
    const playFailPromise = new Promise((resolve, reject) => {
      hostSocket.emit("host:play-asset");
      hostSocket.on("server:error", (msg) => {
        if (msg.includes("Cannot play")) {
          resolve(msg);
        } else {
          reject(new Error(`Unexpected error: ${msg}`));
        }
      });
      setTimeout(() => reject(new Error("Timeout waiting for play-asset failure")), 2000);
    });

    const failMsg = await playFailPromise;
    assert.match(failMsg, /Cannot play/);

    // 3. Mark phone ready (unlocked) and report sync
    phoneSocket.emit("client:ready", { ready: true, audioUnlocked: true });
    phoneSocket.emit("client:sync-report", { clockOffsetMs: 5, latencyMs: 10 });
    
    // 4. Phone reports asset decoding success
    phoneSocket.emit("client:asset-ready", { ready: true });

    // Wait for server to receive all status updates and broadcast client list
    await new Promise((resolve) => {
      hostSocket.on("server:clients", (clients) => {
        const phone = clients.find(c => c.clientType === "phone" || c.clientType === "simulator");
        if (phone && phone.ready && phone.assetDecoded) {
          resolve();
        }
      });
    });

    // 5. Try to play again. It should succeed and broadcast server:play-asset
    const playSuccessPromise = new Promise((resolve, reject) => {
      hostSocket.emit("host:play-asset");
      phoneSocket.on("server:play-asset", (payload) => {
        assert.ok(payload.serverStartAt);
        resolve();
      });
      setTimeout(() => reject(new Error("Timeout waiting for play-asset success")), 2000);
    });

    await playSuccessPromise;

    hostSocket.close();
    phoneSocket.close();
  });
});
