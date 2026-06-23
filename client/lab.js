const elements = {
  phoneCount: document.querySelector("#phoneCount"),
  createButton: document.querySelector("#createButton"),
  readyButton: document.querySelector("#readyButton"),
  syncButton: document.querySelector("#syncButton"),
  playButton: document.querySelector("#playButton"),
  stopButton: document.querySelector("#stopButton"),
  disconnectButton: document.querySelector("#disconnectButton"),
  status: document.querySelector("#labStatus"),
  phones: document.querySelector("#phones"),
  log: document.querySelector("#log")
};

const hostSocket = io();
let phones = [];

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  elements.log.textContent = `${line}\n${elements.log.textContent}`.slice(0, 6000);
}

function render() {
  elements.status.textContent = `${phones.length} simulated phone${phones.length === 1 ? "" : "s"}.`;
  elements.phones.innerHTML = phones.length
    ? phones.map((phone) => `
      <article class="phone-card">
        <strong>${phone.label}</strong>
        <span class="badge ${phone.connected ? "ok" : "warn"}">${phone.connected ? "connected" : "disconnected"}</span>
        <p>Ready/audio: ${phone.ready ? "ready / unlocked" : "waiting"}</p>
        <p>Latency: ${phone.latencyMs ?? "—"} ms</p>
        <p>Clock offset: ${phone.clockOffsetMs ?? "—"} ms</p>
        <p>Last event: ${phone.lastEvent}</p>
        <p>Scheduled play: ${phone.scheduledPlayAt || "—"}</p>
      </article>`).join("")
    : "<p class='small'>Create simulated phones to begin.</p>";
}

function syncPhone(phone) {
  const sentAt = performance.now();
  phone.socket.emit("client:sync-ping", { seq: phone.index, clientSentAt: sentAt });
  phone.lastEvent = "sync ping";
  phone.socket.once("server:sync-pong", () => {
    const measuredLatency = Math.max(1, Math.round((performance.now() - sentAt) / 2));
    phone.latencyMs = measuredLatency;
    phone.clockOffsetMs = phone.fakeOffsetMs;
    phone.lastEvent = "sync report";
    phone.socket.emit("client:sync-report", {
      latencyMs: phone.latencyMs,
      clockOffsetMs: phone.clockOffsetMs
    });
    render();
  });
}

function createPhone(index) {
  const phone = {
    index,
    label: `Lab phone ${index + 1}`,
    socket: io(),
    connected: false,
    ready: false,
    latencyMs: null,
    clockOffsetMs: null,
    fakeOffsetMs: ((index + 1) * 7) % 25 - 12,
    lastEvent: "created",
    scheduledPlayAt: ""
  };

  phone.socket.on("connect", () => {
    phone.connected = true;
    phone.lastEvent = "connected";
    phone.socket.emit("client:profile", {
      label: phone.label,
      userAgent: "Bardo browser lab",
      clientType: "simulator"
    });
    log(`${phone.label} connected.`);
    render();
  });
  phone.socket.on("disconnect", () => {
    phone.connected = false;
    phone.lastEvent = "disconnected";
    render();
  });
  phone.socket.on("server:play-test", ({ serverStartAt }) => {
    phone.lastEvent = "play-test";
    phone.scheduledPlayAt = new Date(serverStartAt).toLocaleTimeString();
    phone.socket.emit("client:play-test-received", { serverStartAt });
    log(`${phone.label} scheduled playback for ${phone.scheduledPlayAt}.`);
    render();
  });
  phone.socket.on("server:stop", () => {
    phone.lastEvent = "stop";
    phone.scheduledPlayAt = "";
    phone.socket.emit("client:stop-received");
    render();
  });
  return phone;
}

elements.createButton.addEventListener("click", () => {
  phones.forEach((phone) => phone.socket.disconnect());
  const count = Math.min(50, Math.max(1, Number.parseInt(elements.phoneCount.value, 10) || 5));
  phones = Array.from({ length: count }, (_, index) => createPhone(index));
  log(`Creating ${count} simulated phones.`);
  render();
});

elements.readyButton.addEventListener("click", () => {
  phones.forEach((phone) => {
    phone.ready = true;
    phone.lastEvent = "ready";
    phone.socket.emit("client:ready", { ready: true, audioUnlocked: true });
  });
  log("Marked all simulated phones ready.");
  render();
});

elements.syncButton.addEventListener("click", () => {
  phones.filter((phone) => phone.connected).forEach(syncPhone);
  log("Clock sync requested for simulated phones.");
  render();
});

elements.playButton.addEventListener("click", () => {
  hostSocket.emit("host:play-test");
  log("Sync test broadcast.");
});

elements.stopButton.addEventListener("click", () => {
  hostSocket.emit("host:stop");
  log("Stop broadcast.");
});

elements.disconnectButton.addEventListener("click", () => {
  phones.forEach((phone) => phone.socket.disconnect());
  log("Disconnected all simulated phones.");
  render();
});

hostSocket.on("connect", () => log("Lab host controls connected."));
render();
