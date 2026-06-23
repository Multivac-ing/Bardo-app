const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");
const socket = io({
  auth: { token }
});

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

function getDeviceLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser";
  return `${platform} / ${Math.random().toString(16).slice(2, 6)}`;
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();

  elements.qrImage.src = config.qrDataUrl;
  elements.joinUrl.textContent = config.joinUrl;

  log(`Join URL: ${config.joinUrl}`);
}

function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  return audioContext;
}

function clearActiveNodes() {
  for (const node of activeNodes) {
    try {
      node.stop();
    } catch {
      // Ignore already stopped nodes.
    }
  }

  activeNodes = [];
}

function playUnlockChirp() {
  const context = ensureAudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.start(context.currentTime);
  oscillator.stop(context.currentTime + 0.18);
}

function playPatternAt(audioStartTime, pattern) {
  const context = ensureAudioContext();
  clearActiveNodes();

  let cursorSeconds = 0;

  for (const step of pattern) {
    const durationSeconds = step.durationMs / 1000;

    if (step.frequency > 0) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = audioStartTime + cursorSeconds;
      const end = start + durationSeconds;

      oscillator.type = "sine";
      oscillator.frequency.value = step.frequency;

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.34, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, Math.max(start + 0.02, end - 0.018));

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(start);
      oscillator.stop(end);

      activeNodes.push(oscillator);
    }

    cursorSeconds += durationSeconds;
  }
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function runClockSync(sampleCount = 9) {
  const samples = [];

  for (let seq = 0; seq < sampleCount; seq += 1) {
    const sample = await new Promise((resolve) => {
      const clientSentAt = performance.now();

      socket.timeout(1500).emit(
        "client:sync-ping",
        { seq, clientSentAt },
        () => {}
      );

      function handlePong(payload) {
        if (payload.seq !== seq) return;

        socket.off("server:sync-pong", handlePong);

        const clientReceivedAt = performance.now();
        const rttMs = clientReceivedAt - clientSentAt;
        const clientMidpointAt = clientSentAt + rttMs / 2;
        const estimatedOffsetMs = payload.serverReceivedAt - clientMidpointAt;

        resolve({
          rttMs,
          offsetMs: estimatedOffsetMs
        });
      }

      socket.on("server:sync-pong", handlePong);

      setTimeout(() => {
        socket.off("server:sync-pong", handlePong);
        resolve(null);
      }, 1600);
    });

    if (sample) {
      samples.push(sample);
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  if (!samples.length) {
    elements.syncStatus.textContent = "Clock sync failed.";
    log("Clock sync failed.");
    return;
  }

  const bestSamples = samples
    .slice()
    .sort((a, b) => a.rttMs - b.rttMs)
    .slice(0, Math.max(3, Math.ceil(samples.length / 2)));

  clockOffsetMs = median(bestSamples.map((sample) => sample.offsetMs));
  latencyMs = median(bestSamples.map((sample) => sample.rttMs / 2));

  elements.syncStatus.textContent = `Clock offset: ${Math.round(clockOffsetMs)} ms · latency: ${Math.round(latencyMs)} ms`;

  socket.emit("client:sync-report", {
    clockOffsetMs,
    latencyMs
  });

  log(`Clock sync complete. Offset ${Math.round(clockOffsetMs)} ms, latency ${Math.round(latencyMs)} ms.`);
}

function renderDevices(devices) {
  if (!devices.length) {
    elements.devices.innerHTML = "<p class='small'>No devices connected.</p>";
    return;
  }

  elements.devices.innerHTML = devices
    .map((device) => {
      const readyClass = device.ready ? "ok" : "warn";
      const readyText = device.ready ? "ready" : "locked";
      const offsetText = Number.isFinite(device.clockOffsetMs)
        ? `${device.clockOffsetMs}ms offset`
        : "no sync";

      const latencyText = Number.isFinite(device.latencyMs)
        ? `${device.latencyMs}ms latency`
        : "no latency";

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
        </div>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

elements.unlockAudioButton.addEventListener("click", async () => {
  const context = ensureAudioContext();
  await context.resume();

  audioUnlocked = true;
  playUnlockChirp();

  socket.emit("client:ready", {
    ready: true,
    audioUnlocked: true
  });

  elements.connectionStatus.textContent = "Audio unlocked. Ready.";
  log("Audio unlocked.");

  await runClockSync();
});

elements.syncButton.addEventListener("click", () => {
  runClockSync();
});

elements.playTestButton.addEventListener("click", () => {
  socket.emit("host:play-test");
  log("Requested synchronized test.");
});

elements.playAssetButton.addEventListener("click", () => {
  socket.emit("host:play-asset");
  log("Requested synchronized asset playback.");
});

elements.stopButton.addEventListener("click", () => {
  socket.emit("host:stop");
});

elements.audioUpload.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const MAX_SIZE = 8 * 1024 * 1024; // 8MB
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

  elements.uploadStatus.textContent = "Uploading...";
  log(`Reading asset "${file.name}"...`);

  const reader = new FileReader();
  reader.onload = () => {
    const arrayBuffer = reader.result;
    socket.emit("host:upload-audio", {
      name: file.name,
      type: file.type,
      size: file.size,
      data: arrayBuffer
    });
    log(`Uploading asset "${file.name}" to server...`);
  };
  reader.readAsArrayBuffer(file);
});

socket.on("connect", () => {
  elements.connectionStatus.textContent = "Connected.";
  log(`Connected as ${socket.id}.`);

  socket.emit("client:profile", {
    label: getDeviceLabel(),
    userAgent: navigator.userAgent
  });

  runClockSync(5);
});

socket.on("disconnect", () => {
  elements.connectionStatus.textContent = "Disconnected.";
  log("Disconnected from Bardo server.");
});

socket.on("server:hello", (payload) => {
  log(`Server hello. Join URL: ${payload.joinUrl}`);
  isHost = payload.clientType === "host";

  if (isHost) {
    elements.hostCard.style.display = "block";
    elements.joinCard.style.display = "block";
  } else {
    elements.hostCard.style.display = "none";
    elements.joinCard.style.display = "none";
  }

  if (payload.currentAsset) {
    elements.uploadStatus.textContent = `Asset: ${payload.currentAsset.name} (${Math.round(payload.currentAsset.size / 1024)} KB)`;
    elements.playAssetButton.style.display = "inline-block";
  }
});

socket.on("server:clients", (devices) => {
  renderDevices(devices);
});

socket.on("server:asset-loaded", async (asset) => {
  log(`Audio asset received: "${asset.name}" (${Math.round(asset.size / 1024)} KB). Decoding...`);

  if (isHost) {
    elements.uploadStatus.textContent = `Asset: ${asset.name} (${Math.round(asset.size / 1024)} KB)`;
    elements.playAssetButton.style.display = "inline-block";
  }

  try {
    const context = ensureAudioContext();
    // decodeAudioData consumes the ArrayBuffer, so we slice it to keep a copy just in case
    const buffer = await new Promise((resolve, reject) => {
      context.decodeAudioData(
        asset.data.slice(0),
        (decoded) => resolve(decoded),
        (err) => reject(err)
      );
    });

    loadedAudioBuffer = buffer;
    log("Audio asset decoded successfully.");
    socket.emit("client:asset-ready", { ready: true });
  } catch (err) {
    log(`Audio asset decoding failed: ${err.message || err}`);
    socket.emit("client:asset-ready", { ready: false, error: err.message || "Decode error" });
  }
});

socket.on("server:play-test", async ({ serverStartAt, pattern }) => {
  socket.emit("client:play-test-received", { serverStartAt });

  if (!audioUnlocked) {
    elements.connectionStatus.textContent = "Tap Unlock audio before playing.";
    log("Cannot play: audio is locked by browser policy.");
    return;
  }

  if (!Number.isFinite(clockOffsetMs)) {
    await runClockSync();
  }

  const estimatedLocalStartPerfMs = serverStartAt - clockOffsetMs;
  const delaySeconds = Math.max(0.08, (estimatedLocalStartPerfMs - performance.now()) / 1000);
  const audioStartTime = ensureAudioContext().currentTime + delaySeconds;

  playPatternAt(audioStartTime, pattern);
  log(`Scheduled test in ${Math.round(delaySeconds * 1000)} ms.`);
});

socket.on("server:play-asset", async ({ serverStartAt }) => {
  if (!audioUnlocked) {
    elements.connectionStatus.textContent = "Tap Unlock audio before playing.";
    log("Cannot play asset: audio is locked.");
    return;
  }

  if (!loadedAudioBuffer) {
    log("Cannot play asset: no decoded audio asset available.");
    return;
  }

  if (!Number.isFinite(clockOffsetMs)) {
    await runClockSync();
  }

  const estimatedLocalStartPerfMs = serverStartAt - clockOffsetMs;
  const delaySeconds = Math.max(0.08, (estimatedLocalStartPerfMs - performance.now()) / 1000);
  const audioStartTime = ensureAudioContext().currentTime + delaySeconds;

  const context = ensureAudioContext();
  clearActiveNodes();

  const source = context.createBufferSource();
  source.buffer = loadedAudioBuffer;
  source.connect(context.destination);
  source.start(audioStartTime);

  activeNodes.push(source);
  log(`Scheduled asset playback in ${Math.round(delaySeconds * 1000)} ms.`);
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

loadConfig().catch((error) => {
  log(`Config error: ${error.message}`);
});
