const clientId = localStorage.getItem("bardo-client-id") || crypto.randomUUID();
localStorage.setItem("bardo-client-id", clientId);
const socket = io({ auth: { clientId } });

const elements = {
  qrImage: document.querySelector("#qrImage"),
  joinUrl: document.querySelector("#joinUrl"),
  connectionStatus: document.querySelector("#connectionStatus"),
  syncStatus: document.querySelector("#syncStatus"),
  deviceNameInput: document.querySelector("#deviceNameInput"),
  unlockAudioButton: document.querySelector("#unlockAudioButton"),
  syncButton: document.querySelector("#syncButton"),
  calibrationInput: document.querySelector("#calibrationInput"),
  calibrationValue: document.querySelector("#calibrationValue"),
  playTestButton: document.querySelector("#playTestButton"),
  playAssetButton: document.querySelector("#playAssetButton"),
  audioUpload: document.querySelector("#audioUpload"),
  audioStatus: document.querySelector("#audioStatus"),
  stopButton: document.querySelector("#stopButton"),
  sessionStatus: document.querySelector("#sessionStatus"),
  devices: document.querySelector("#devices"),
  log: document.querySelector("#log")
};

let audioContext = null;
let audioUnlocked = false;
let clockOffsetMs = null;
let latencyMs = null;
let activeNodes = [];
const hostToken = new URLSearchParams(window.location.search).get("hostToken") || "";
let isHost = false;
let latestDevices = [];
let playbackCalibrationMs = Number(localStorage.getItem("bardo-playback-calibration-ms") || 0);
let clockSyncInFlight = false;
let loadedAsset = null;
let loadedAudioBuffer = null;

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  elements.log.textContent = `${line}\n${elements.log.textContent}`.slice(0, 6000);
}

function getDeviceLabel() {
  const savedLabel = localStorage.getItem("bardo-device-label");
  if (savedLabel) return savedLabel;

  const platform = navigator.userAgentData?.platform || navigator.platform || "Browser";
  const label = `${platform} / ${Math.random().toString(16).slice(2, 6)}`;
  localStorage.setItem("bardo-device-label", label);
  return label;
}

function sendProfile() {
  socket.emit("client:profile", {
    label: getDeviceLabel(),
    userAgent: navigator.userAgent,
    hostToken
  });
}

function updateCalibration(value) {
  playbackCalibrationMs = Number(value);
  elements.calibrationInput.value = String(playbackCalibrationMs);
  elements.calibrationValue.textContent = `${playbackCalibrationMs} ms`;
  localStorage.setItem("bardo-playback-calibration-ms", String(playbackCalibrationMs));

  if (Number.isFinite(clockOffsetMs)) {
    socket.emit("client:sync-report", {
      clockOffsetMs,
      latencyMs,
      playbackCalibrationMs
    });
  }
}

async function loadConfig() {
  const response = await fetch(`/api/config${window.location.search}`);
  const config = await response.json();

  isHost = config.isHost;
  document.querySelectorAll(".host-only").forEach((element) => {
    element.hidden = !isHost;
  });

  if (isHost) {
    elements.unlockAudioButton.closest(".card").hidden = true;
    elements.connectionStatus.textContent = "Host dashboard connected.";
    renderDevices(latestDevices.filter((device) => device.role === "phone"));
  }

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
  if (clockSyncInFlight) return false;
  clockSyncInFlight = true;

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
    clockSyncInFlight = false;
    return false;
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
    latencyMs,
    playbackCalibrationMs
  });

  log(`Clock sync complete. Offset ${Math.round(clockOffsetMs)} ms, latency ${Math.round(latencyMs)} ms.`);
  clockSyncInFlight = false;
  return true;
}

function renderDevices(devices) {
  const readyDevices = devices.filter(
    (device) => device.ready && Number.isFinite(device.clockOffsetMs)
  );

  elements.sessionStatus.textContent = devices.length
    ? `${readyDevices.length} of ${devices.length} phone(s) ready.`
    : "Waiting for phones...";

  if (!devices.length) {
    elements.devices.innerHTML = "<p class='small'>No devices connected.</p>";
    return;
  }

  elements.devices.innerHTML = devices
    .map((device) => {
      const isSynced = Number.isFinite(device.clockOffsetMs);
      const readyClass = device.ready && isSynced ? "ok" : "warn";
      const readyText = device.ready ? (isSynced ? "ready" : "syncing") : "locked";
      const offsetText = Number.isFinite(device.clockOffsetMs)
        ? `${device.clockOffsetMs}ms offset`
        : "no sync";

      const latencyClass = device.latencyMs > 80 ? "warn" : "";
      const latencyText = Number.isFinite(device.latencyMs)
        ? `${device.latencyMs}ms latency`
        : "no latency";

      const calibrationText = device.playbackCalibrationMs
        ? `${device.playbackCalibrationMs}ms advance`
        : "no calibration";

      return `
        <div class="device">
          <strong>${escapeHtml(device.label || device.id)}</strong>
          <span class="badge ${readyClass}">${readyText}</span>
          <span class="badge">${offsetText}</span>
          <span class="badge ${latencyClass}">${latencyText}</span>
          <span class="badge">${calibrationText}</span>
          <button class="compact danger" data-kick-id="${escapeHtml(device.id)}" type="button">Remove</button>
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

elements.deviceNameInput.addEventListener("change", () => {
  const label = elements.deviceNameInput.value.trim().slice(0, 24) || getDeviceLabel();
  localStorage.setItem("bardo-device-label", label);
  elements.deviceNameInput.value = label;
  if (socket.connected) sendProfile();
});

elements.calibrationInput.addEventListener("input", (event) => {
  updateCalibration(event.target.value);
});

elements.playTestButton.addEventListener("click", () => {
  socket.emit("host:play-test", (result) => {
    if (result?.ok) {
      log(`Sync test scheduled for ${result.phoneCount} phone(s).`);
      return;
    }

    log(result?.message || "Could not start sync test.");
  });
});

elements.audioUpload.addEventListener("change", () => {
  const file = elements.audioUpload.files[0];
  if (!file) return;
  if (!file.type.startsWith("audio/") || file.size > 8 * 1024 * 1024) {
    elements.audioStatus.textContent = "Choose an audio file up to 8 MB.";
    return;
  }
  const reader = new FileReader();
  elements.audioStatus.textContent = "Uploading audio...";
  reader.onload = () => socket.emit("host:upload-audio", { name: file.name, type: file.type, data: reader.result }, (result) => {
    if (result?.ok) {
      elements.audioStatus.textContent = `Loaded ${result.asset.name}. Waiting for phones to decode it.`;
      elements.playAssetButton.disabled = false;
    } else {
      elements.audioStatus.textContent = result?.message || "Upload failed.";
    }
  });
  reader.readAsArrayBuffer(file);
});

elements.playAssetButton.addEventListener("click", () => {
  socket.emit("host:play-asset", (result) => log(result?.ok ? `Audio scheduled for ${result.phoneCount} phone(s).` : result?.message || "Could not play audio."));
});

elements.stopButton.addEventListener("click", () => {
  socket.emit("host:stop", (result) => {
    if (!result?.ok) log(result?.message || "Could not stop playback.");
  });
});

elements.devices.addEventListener("click", (event) => {
  const button = event.target.closest("[data-kick-id]");
  if (!button) return;

  socket.emit("host:kick-device", { id: button.dataset.kickId }, (result) => {
    if (result?.ok) log(`Removed ${result.label}.`);
    else log(result?.message || "Could not remove the phone.");
  });
});

socket.on("connect", async () => {
  elements.connectionStatus.textContent = "Connected.";
  log(`Connected as ${socket.id}.`);

  sendProfile();

  if (isHost) return;

  const synced = await runClockSync(5);
  if (audioUnlocked && synced) {
    socket.emit("client:ready", { ready: true, audioUnlocked: true });
    elements.connectionStatus.textContent = "Reconnected. Ready.";
  } else if (!audioUnlocked) {
    socket.emit("client:ready", { ready: false, audioUnlocked: false });
    elements.connectionStatus.textContent = "Reconnected. Tap Unlock audio.";
  }
});

socket.on("disconnect", () => {
  elements.connectionStatus.textContent = "Disconnected. Reconnecting...";
  log("Disconnected; waiting to reconnect.");
});

document.addEventListener("visibilitychange", async () => {
  if (isHost || !socket.connected) return;

  if (document.hidden) {
    socket.emit("client:ready", { ready: false, audioUnlocked });
    elements.connectionStatus.textContent = "Paused while this tab is in the background.";
    log("Marked unavailable while backgrounded.");
    return;
  }

  if (!audioUnlocked) return;

  try {
    await ensureAudioContext().resume();
    socket.emit("client:ready", { ready: true, audioUnlocked: true });
    elements.connectionStatus.textContent = "Back in foreground. Re-syncing...";
    log("Returned to foreground; refreshing clock sync.");
    runClockSync(5);
  } catch {
    audioUnlocked = false;
    socket.emit("client:ready", { ready: false, audioUnlocked: false });
    elements.connectionStatus.textContent = "Tap Unlock audio after returning to this tab.";
    log("Audio needs a new user unlock after foregrounding.");
  }
});

socket.on("server:hello", (payload) => {
  log(`Server hello. Join URL: ${payload.joinUrl}`);
});

socket.on("server:clients", (devices) => {
  latestDevices = devices;
  if (isHost) renderDevices(latestDevices.filter((device) => device.role === "phone"));
});

socket.on("server:play-test", async ({ serverStartAt, pattern }) => {
  if (!audioUnlocked) {
    elements.connectionStatus.textContent = "Tap Unlock audio before playing.";
    log("Cannot play: audio is locked by browser policy.");
    return;
  }

  if (!Number.isFinite(clockOffsetMs)) {
    await runClockSync();
  }

  const estimatedLocalStartPerfMs = serverStartAt - clockOffsetMs - playbackCalibrationMs;
  const delaySeconds = Math.max(0.08, (estimatedLocalStartPerfMs - performance.now()) / 1000);
  const audioStartTime = ensureAudioContext().currentTime + delaySeconds;

  playPatternAt(audioStartTime, pattern);
  log(`Scheduled test in ${Math.round(delaySeconds * 1000)} ms.`);
});

socket.on("server:asset-loaded", async (asset) => {
  try {
    loadedAudioBuffer = await ensureAudioContext().decodeAudioData(asset.data.slice(0));
    loadedAsset = asset;
    socket.emit("client:asset-ready", { assetId: asset.id, ready: true });
    log(`Decoded ${asset.name}.`);
  } catch {
    socket.emit("client:asset-ready", { assetId: asset.id, ready: false });
    log(`Could not decode ${asset.name}.`);
  }
});

socket.on("server:play-asset", ({ assetId, serverStartAt }) => {
  if (!audioUnlocked || !loadedAudioBuffer || loadedAsset?.id !== assetId) return;
  const delay = Math.max(0.08, (serverStartAt - clockOffsetMs - playbackCalibrationMs - performance.now()) / 1000);
  clearActiveNodes();
  const source = ensureAudioContext().createBufferSource();
  source.buffer = loadedAudioBuffer;
  source.connect(ensureAudioContext().destination);
  source.start(ensureAudioContext().currentTime + delay);
  activeNodes.push(source);
});

socket.on("server:stop", () => {
  clearActiveNodes();
  log("Stopped.");
});

socket.on("server:kicked", () => {
  socket.disconnect();
  elements.connectionStatus.textContent = "Removed by the host.";
  log("Removed by the host.");
});

loadConfig().catch((error) => {
  log(`Config error: ${error.message}`);
});

updateCalibration(playbackCalibrationMs);
elements.deviceNameInput.value = getDeviceLabel();

setInterval(() => {
  if (audioUnlocked && socket.connected) runClockSync(5);
}, 30_000);
