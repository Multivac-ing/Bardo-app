import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { io } from "socket.io-client";

const port = 3200 + (process.pid % 400);
const baseUrl = `http://127.0.0.1:${port}`;

function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}.`)), 2000);
    socket.once(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const done = (error, result) => {
      if (error) reject(error);
      else resolve(result);
    };

    if (payload === undefined) socket.timeout(2000).emit(event, done);
    else socket.timeout(2000).emit(event, payload, done);
  });
}

function waitForConnect(socket) {
  return socket.connected ? Promise.resolve() : once(socket, "connect");
}

function waitForDevices(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("server:clients", handleClients);
      reject(new Error("Timed out waiting for the expected device state."));
    }, 2000);

    function handleClients(devices) {
      if (!predicate(devices)) return;
      clearTimeout(timeout);
      socket.off("server:clients", handleClients);
      resolve(devices);
    }

    socket.on("server:clients", handleClients);
  });
}

test("only the host can control a fully ready phone session", { timeout: 10_000 }, async (t) => {
  const server = spawn(process.execPath, ["server/index.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  t.after(() => server.kill());

  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
  });

  server.once("exit", (code) => {
    if (code && output) process.stderr.write(output);
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(output || "Server did not start.")), 5000);
    const interval = setInterval(() => {
      const match = output.match(/hostToken=([\w-]+)/);
      if (!match) return;

      clearTimeout(timeout);
      clearInterval(interval);
      resolve(match[1]);
    }, 20);
  }).then(async (hostToken) => {
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    assert.equal(health.status, "ok");
    assert.equal(health.phoneCount, 0);

    const host = io(baseUrl, { transports: ["websocket"] });
    const clientId = "reconnectable-phone";
    let phone = io(baseUrl, { transports: ["websocket"], auth: { clientId } });

    t.after(() => {
      host.close();
      phone.close();
    });

    await Promise.all([waitForConnect(host), waitForConnect(phone)]);
    const phoneJoined = waitForDevices(host, (devices) =>
      devices.some((device) => device.label === "Phone" && device.role === "phone")
    );
    host.emit("client:profile", { label: "Host", hostToken });
    phone.emit("client:profile", { label: "Phone" });
    await phoneJoined;

    host.emit("host:play-test", { unexpected: "payload" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(host.connected, true);

    assert.deepEqual(await emitWithAck(host, "host:play-test"), {
      ok: false,
      message: "1 phone(s) need audio unlock and a recent clock sync."
    });

    const phoneReady = waitForDevices(host, (devices) =>
      devices.some(
        (device) =>
          device.label === "Phone" &&
          device.ready &&
          Number.isFinite(device.clockOffsetMs) &&
          device.playbackCalibrationMs === 25 &&
          device.syncQuality === "good"
      )
    );
    phone.emit("client:ready", { ready: true, audioUnlocked: true });
    phone.emit("client:sync-report", {
      clockOffsetMs: 4,
      latencyMs: 2,
      playbackCalibrationMs: 25,
      rttSamples: [4, 7, 6]
    });
    await phoneReady;

    const playback = waitFor(phone, "server:play-test");
    assert.deepEqual(await emitWithAck(host, "host:play-test"), { ok: true, phoneCount: 1 });
    const scheduled = await playback;
    assert.ok(scheduled.serverStartAt > Date.now());
    assert.equal(scheduled.pattern.length, 7);

    const pulse = waitFor(phone, "server:play-pulse");
    assert.deepEqual(await emitWithAck(host, "host:play-pulse", { id: phone.id }), { ok: true, label: "Phone" });
    assert.equal((await pulse).pattern[0].frequency, 880);

    assert.deepEqual(await emitWithAck(phone, "host:stop"), {
      ok: false,
      message: "Only the host can stop playback."
    });

    const stopped = waitFor(phone, "server:stop");
    assert.deepEqual(await emitWithAck(host, "host:stop"), { ok: true });
    await stopped;

    phone.disconnect();
    phone = io(baseUrl, { transports: ["websocket"], auth: { clientId } });
    await waitForConnect(phone);

    const rejoined = waitForDevices(host, (devices) => {
      const matches = devices.filter((device) => device.clientId === clientId);
      return matches.length === 1 && matches[0].connected && !matches[0].ready;
    });
    phone.emit("client:profile", { label: "Phone" });
    await rejoined;

    const readyAgain = waitForDevices(host, (devices) =>
      devices.some((device) => device.clientId === clientId && device.ready)
    );
    phone.emit("client:sync-report", { clockOffsetMs: 4, latencyMs: 2, playbackCalibrationMs: 25 });
    phone.emit("client:ready", { ready: true, audioUnlocked: true });
    await readyAgain;

    const assetLoaded = waitFor(phone, "server:asset-loaded");
    const uploaded = await emitWithAck(host, "host:upload-audio", {
      name: "test.wav",
      type: "audio/wav",
      data: Buffer.from("tiny test payload")
    });
    assert.equal(uploaded.ok, true);
    const asset = await assetLoaded;
    const assetReady = waitForDevices(host, (devices) =>
      devices.some((device) => device.clientId === clientId && device.assetReady)
    );
    phone.emit("client:asset-ready", { assetId: asset.id, ready: true });
    await assetReady;
    const assetPlayback = waitFor(phone, "server:play-asset");
    assert.deepEqual(await emitWithAck(host, "host:play-asset"), { ok: true, phoneCount: 1 });
    assert.equal((await assetPlayback).assetId, asset.id);

    const kicked = waitFor(phone, "server:kicked");
    assert.deepEqual(
      await emitWithAck(host, "host:kick-device", { id: phone.id }),
      { ok: true, label: "Phone" }
    );
    await kicked;
  });
});
