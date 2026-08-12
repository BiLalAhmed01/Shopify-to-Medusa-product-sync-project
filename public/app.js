const $ = (id) => document.getElementById(id);

const els = {
  connectionSummary: $("connection-summary"),
  checksList: $("checks-list"),
  checkBtn: $("check-btn"),
  syncForm: $("sync-form"),
  syncBtn: $("sync-btn"),
  busyBadge: $("busy-badge"),
  lastRun: $("last-run"),
  trackedProducts: $("tracked-products"),
  summary: $("summary"),
  logConsole: $("log-console"),
  clearLogBtn: $("clear-log-btn"),
};

function fmtTime(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString();
}

async function refreshStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();

  els.connectionSummary.textContent = `${data.shop}  ·  ${data.medusaUrl}  ·  ${data.currency.toUpperCase()}`;
  els.lastRun.textContent = fmtTime(data.lastRunAt);
  els.trackedProducts.textContent = data.trackedProducts;
  setBusy(data.busy);

  if (data.lastSummary) showSummary(data.lastSummary);
  if (data.lastError) appendLog({ time: new Date().toISOString(), level: "error", message: data.lastError });

  return data;
}

function setBusy(busy) {
  els.busyBadge.classList.toggle("hidden", !busy);
  els.syncBtn.disabled = busy;
  els.syncBtn.textContent = busy ? "Running…" : "Run sync";
}

function showSummary(summary) {
  els.summary.classList.remove("hidden");
  $("sum-scanned").textContent = summary.scanned;
  $("sum-created").textContent = summary.created;
  $("sum-updated").textContent = summary.updated;
  $("sum-skipped").textContent = summary.skipped;
  $("sum-failed").textContent = summary.failed;
}

async function runCheck() {
  els.checkBtn.disabled = true;
  els.checkBtn.textContent = "Checking…";
  els.checksList.innerHTML = "";

  try {
    const res = await fetch("/api/check");
    const data = await res.json();
    const labels = {
      shopify: "Shopify",
      medusa: "Medusa",
      salesChannel: "Sales channel",
      stockLocation: "Stock location",
    };

    for (const [key, label] of Object.entries(labels)) {
      const entry = data[key];
      const li = document.createElement("li");
      li.innerHTML = `<span class="dot ${entry.ok ? "ok" : "err"}"></span><strong>${label}:</strong> ${entry.detail}`;
      els.checksList.appendChild(li);
    }
  } catch (error) {
    els.checksList.innerHTML = `<li class="muted">Check failed: ${error}</li>`;
  } finally {
    els.checkBtn.disabled = false;
    els.checkBtn.textContent = "Test connection";
  }
}

async function submitSync(event) {
  event.preventDefault();
  const body = {
    full: $("opt-full").checked,
    dryRun: $("opt-dry-run").checked,
    force: $("opt-force").checked,
    limit: Number($("opt-limit").value) || null,
  };

  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    appendLog({ time: new Date().toISOString(), level: "warn", message: "A sync is already running." });
    return;
  }

  setBusy(true);
  els.summary.classList.add("hidden");
  pollUntilIdle();
}

async function pollUntilIdle() {
  const data = await refreshStatus();
  if (data.busy) setTimeout(pollUntilIdle, 1200);
}

function appendLog(line) {
  const div = document.createElement("div");
  div.className = `log-line ${line.level}`;
  div.textContent = `${new Date(line.time).toLocaleTimeString()}  ${line.level.toUpperCase().padEnd(5)}  ${line.message}`;
  els.logConsole.appendChild(div);
  els.logConsole.scrollTop = els.logConsole.scrollHeight;
}

function connectLogStream() {
  fetch("/api/logs")
    .then((res) => res.json())
    .then((lines) => lines.forEach(appendLog));

  const source = new EventSource("/api/logs/stream");
  source.onmessage = (event) => {
    if (!event.data) return;
    appendLog(JSON.parse(event.data));
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectLogStream, 3000);
  };
}

els.checkBtn.addEventListener("click", runCheck);
els.syncForm.addEventListener("submit", submitSync);
els.clearLogBtn.addEventListener("click", () => (els.logConsole.innerHTML = ""));

refreshStatus();
connectLogStream();
setInterval(refreshStatus, 5000);
