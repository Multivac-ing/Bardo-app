let clientId = localStorage.getItem("bardo_client_id");
if (!clientId) {
  clientId = Math.random().toString(36).slice(2, 15);
  localStorage.setItem("bardo_client_id", clientId);
}

let deviceLabel = localStorage.getItem("bardo_device_label");
if (!deviceLabel) {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser";
  deviceLabel = `${platform} / ${Math.random().toString(16).slice(2, 6)}`;
  localStorage.setItem("bardo_device_label", deviceLabel);
}

const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");
const socket = io({ auth: { token, clientId } });

const elements = {
  qrImage: document.querySelector("#qrImage"),
  joinUrl: document.querySelector("#joinUrl"),
  connectionStatus: document.querySelector("#connectionStatus"),
  syncStatus: document.querySelector("#syncStatus"),
  unlockAudioButton: document.querySelector("#unlockAudioButton"),
  syncButton: document.querySelector("#syncButton"),
  playTestButton: document.querySelector("#playTestButton"),
  stopButton: document.querySelector("#stopButton"),
  devices: document.querySelector("#devices"),
  log: document.querySelector("#log"),
  joinCard: document.querySelector("#joinCard"),
  hostCard: document.querySelector("#hostCard"),
  audioUpload: document.querySelector("#audioUpload"),
  uploadStatus: document.querySelector("#uploadStatus"),
  playAssetButton: document.querySelector("#playAssetButton")
};

let audioContext = null;
let audioUnlocked = false;
let clockOffsetMs = null;
let latencyMs = null;
let activeNodes = [];
let isHost = false;
let loadedAudioBuffer = null;

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  elements.log.textContent = `${line}\n${elements.log.textContent}`.slice(0, 6000);
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  elements.qrImage.src = config.qrDataUrl;
  elements.joinUrl.textContent = config.joinUrl;
  log(`Join URL: ${config.joinUrl}`);
}

function ensureAudioContext() {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

function clearActiveNodes() {
  for (const node of activeNodes) {
    try { node.stop(); } catch { /* already stopped */ }
  }
  activeNodes = [];
}

function playUnlockChirp() {
  const ctx = ensureAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 660;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.18);
}

function playPatternAt(audioStartTime, pattern) {
  const ctx = ensureAudioContext();
  clearActiveNodes();
  let cursorSeconds = 0;
  for (const step of pattern) {
    const dur = step.durationMs / 1000;
    if (step.frequency > 0) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = audioStartTime + cursorSeconds;
      const end = start + dur;
      osc.type = "sine";
      osc.frequency.value = step.frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.34, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, Math.max(start + 0.02, end - 0.018));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end);
      activeNodes.push(osc);
    }
    cursorSeconds += dur;
  }
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runClockSync(sampleCount = 9) {
  const samples = [];
  for (let seq = 0; seq < sampleCount; seq++) {
    const sample = await new Promise((resolve) => {
      const clientSentAt = performance.now();
      socket.timeout(1500).emit("client:sync-ping", { seq, clientSentAt }, () => {});
      function handlePong(payload) {
        if (payload.seq !== seq) return;
        socket.off("server:sync-pong", handlePong);
        const clientReceivedAt = performance.now();
        const rttMs = clientReceivedAt - clientSentAt;
        const estimatedOffsetMs = payload.serverReceivedAt - (clientSentAt + rttMs / 2);
        resolve({ rttMs, offsetMs: estimatedOffsetMs });
      }
      socket.on("server:sync-pong", handlePong);
      setTimeout(() => { socket.off("server:sync-pong", handlePong); resolve(null); }, 1600);
    });
    if (sample) samples.push(sample);
    await new Promise((r) => setTimeout(r, 80));
  }

  if (!samples.length) {
    elements.syncStatus.textContent = "Clock sync failed.";
    log("Clock sync failed.");
    return false;
  }

  const best = samples.slice().sort((a, b) => a.rttMs - b.rttMs).slice(0, Math.max(3, Math.ceil(samples.length / 2)));
  clockOffsetMs = median(best.map((s) => s.offsetMs));
  latencyMs = median(best.map((s) => s.rttMs / 2));

  elements.syncStatus.textContent = `Clock offset: ${Math.round(clockOffsetMs)} ms · latency: ${Math.round(latencyMs)} ms`;
  socket.emit("client:sync-report", { clockOffsetMs, latencyMs });
  log(`Clock sync complete. Offset ${Math.round(clockOffsetMs)} ms, latency ${Math.round(latencyMs)} ms.`);
  return true;
}

function renderDevices(devices) {
  if (!devices.length) {
    elements.devices.innerHTML = "<p class='small'>No devices connected.</p>";
    return;
  }
  elements.devices.innerHTML = devices.map((device) => {
    const readyClass = device.ready ? "ok" : (device.connected === false ? "warn" : "warn");
    const readyText = device.ready ? "ready" : (device.connected === false ? "reconnecting" : "locked");
    const offsetText = Number.isFinite(device.clockOffsetMs) ? `${device.clockOffsetMs}ms offset` : "no sync";
    const latencyText = Number.isFinite(device.latencyMs) ? `${device.latencyMs}ms latency` : "no latency";
    let assetBadge = "";
    if (device.clientType === "phone" || device.clientType === "simulator") {
      const assetClass = device.assetDecoded ? "ok" : (device.assetError ? "warn" : "");
      const assetText = device.assetDecoded ? "asset ready" : (device.assetError ? "asset error" : "asset pending");
      assetBadge = `<span class="badge ${assetClass}">${assetText}</span>`;
    }
    return `
      <div class="device">
        <strong>${escapeHtml(device.label || device.id)}</strong>
        <span class="badge ${readyClass}">${readyText}</span>
        <span class="badge">${offsetText}</span>
        <span class="badge">${latencyText}</span>
        ${assetBadge}
      </div>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ── Event listeners ──────────────────────────────────────────────────────────

elements.unlockAudioButton.addEventListener("click", async () => {
  const ctx = ensureAudioContext();
  await ctx.resume();
  audioUnlocked = true;
  playUnlockChirp();
  socket.emit("client:ready", { ready: true, audioUnlocked: true });
  elements.connectionStatus.textContent = "Audio unlocked. Ready.";
  log("Audio unlocked.");
  await runClockSync();
});

elements.syncButton.addEventListener("click", () => { runClockSync(); });

elements.playTestButton.addEventListener("click", () => {
  socket.emit("host:play-test");
  log("Requested synchronized test.");
});

elements.playAssetButton.addEventListener("click", () => {
  socket.emit("host:play-asset");
  log("Requested synchronized asset playback.");
});

elements.stopButton.addEventListener("click", () => { socket.emit("host:stop"); });

elements.audioUpload.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const MAX_SIZE = 8 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    alert("Audio file is too large. Max size is 8MB.");
    elements.audioUpload.value = "";
    return;
  }
  if (!file.type.startsWith("audio/")) {
    alert("Invalid file type. Please select an audio file.");
    elements.audioUpload.value = "";
    return;
  }

  elements.uploadStatus.textContent = "Reading file...";
  log(`Reading asset "${file.name}"...`);
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit("host:upload-audio", { name: file.name, type: file.type, size: file.size, data: reader.result });
    elements.uploadStatus.textContent = "Uploading...";
    log(`Uploading "${file.name}" to server...`);
  };
  reader.readAsArrayBuffer(file);
});

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on("connect", async () => {
  elements.connectionStatus.textContent = "Connected. Syncing...";
  log(`Connected as ${socket.id}.`);

  socket.emit("client:profile", { label: deviceLabel, userAgent: navigator.userAgent });

  // Revalidate AudioContext on reconnect
  if (audioContext && audioContext.state === "suspended" && audioUnlocked) {
    try {
      await audioContext.resume();
      log("Resumed AudioContext successfully.");
    } catch (e) {
      log(`Could not resume AudioContext: ${e.message}`);
      audioUnlocked = false;
    }
  }

  const synced = await runClockSync(5);

  if (synced && audioUnlocked) {
    socket.emit("client:ready", { ready: true, audioUnlocked: true });
    elements.connectionStatus.textContent = "Connected. Ready.";
  } else if (!audioUnlocked) {
    socket.emit("client:ready", { ready: false, audioUnlocked: false });
    elements.connectionStatus.textContent = "Connected. Tap Unlock audio.";
  } else {
    elements.connectionStatus.textContent = "Connected. Clock sync failed.";
  }
});

socket.on("disconnect", (reason) => {
  elements.connectionStatus.textContent = "Disconnected. Reconnecting...";
  log(`Disconnected: ${reason}`);
});

socket.on("server:hello", (payload) => {
  log(`Server hello. Join URL: ${payload.joinUrl}`);
  isHost = payload.clientType === "host";
  elements.hostCard.style.display = isHost ? "block" : "none";
  elements.joinCard.style.display = isHost ? "block" : "none";
  if (payload.currentAsset) {
    elements.uploadStatus.textContent = `Asset: ${payload.currentAsset.name} (${Math.round(payload.currentAsset.size / 1024)} KB)`;
    elements.playAssetButton.style.display = "inline-block";
  }
});

socket.on("server:clients", (devices) => { renderDevices(devices); });

socket.on("server:asset-loaded", async (asset) => {
  log(`Audio asset received: "${asset.name}" (${Math.round(asset.size / 1024)} KB). Decoding...`);
  if (isHost) {
    elements.uploadStatus.textContent = `Asset: ${asset.name} (${Math.round(asset.size / 1024)} KB)`;
    elements.playAssetButton.style.display = "inline-block";
  }
  try {
    const ctx = ensureAudioContext();
    const buffer = await new Promise((resolve, reject) => {
      ctx.decodeAudioData(asset.data.slice(0), resolve, reject);
    });
    loadedAudioBuffer = buffer;
    log("Audio asset decoded successfully.");
    socket.emit("client:asset-ready", { ready: true });
  } catch (err) {
    log(`Audio decoding failed: ${err.message || err}`);
    socket.emit("client:asset-ready", { ready: false, error: err.message || "Decode error" });
  }
});

socket.on("server:play-test", async ({ serverStartAt, pattern }) => {
  socket.emit("client:play-test-received", { serverStartAt });
  if (!audioUnlocked) { log("Cannot play: audio locked."); return; }
  if (!Number.isFinite(clockOffsetMs)) await runClockSync();
  const delay = Math.max(0.08, (serverStartAt - clockOffsetMs - performance.now()) / 1000);
  playPatternAt(ensureAudioContext().currentTime + delay, pattern);
  log(`Scheduled test in ${Math.round(delay * 1000)} ms.`);
});

socket.on("server:play-asset", async ({ serverStartAt }) => {
  if (!audioUnlocked) { log("Cannot play asset: audio locked."); return; }
  if (!loadedAudioBuffer) { log("Cannot play asset: not decoded yet."); return; }
  if (!Number.isFinite(clockOffsetMs)) await runClockSync();
  const delay = Math.max(0.08, (serverStartAt - clockOffsetMs - performance.now()) / 1000);
  const ctx = ensureAudioContext();
  clearActiveNodes();
  const source = ctx.createBufferSource();
  source.buffer = loadedAudioBuffer;
  source.connect(ctx.destination);
  source.start(ctx.currentTime + delay);
  activeNodes.push(source);
  log(`Scheduled asset in ${Math.round(delay * 1000)} ms.`);
});

socket.on("server:stop", () => {
  clearActiveNodes();
  socket.emit("client:stop-received");
  log("Stopped.");
});

socket.on("server:error", (message) => {
  alert(message);
  log(`Server error: ${message}`);
});

loadConfig().catch((error) => { log(`Config error: ${error.message}`); });
