const state = {
  providers: null,
  targets: [],
  constraints: null,
  alerts: [],
  hits: [],
  runs: []
};

const $ = (selector) => document.querySelector(selector);
const API_BASE = String(window.EASY_CAMP_API_BASE || "").replace(/\/$/, "");
const ACCESS_CODE_KEY = "easyCampAccessCode";
let refreshTimer = null;

try {
  localStorage.removeItem("campsiteSignalAccessCode");
} catch {
  // Ignore storage access failures.
}

function apiUrl(path) {
  if (!API_BASE) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

function iconRefresh() {
  if (window.lucide) window.lucide.createIcons();
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("visible");
  window.clearTimeout(node._timer);
  node._timer = window.setTimeout(() => node.classList.remove("visible"), 3200);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const accessCode = sessionStorage.getItem(ACCESS_CODE_KEY);
  if (accessCode) headers["X-App-Code"] = accessCode;

  const response = await fetch(apiUrl(path), {
    headers,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (response.status === 401 && data.authRequired) {
    sessionStorage.removeItem(ACCESS_CODE_KEY);
    showAuthGate("Enter the access code to continue.");
  }
  if (!response.ok) {
    throw new Error(data.error || `Request failed with ${response.status}`);
  }
  return data;
}

function channelInputs() {
  return {
    telegram: { enabled: $("#telegramInput").checked },
    email: {
      enabled: $("#emailInput").checked,
      destination: $("#emailDestinationInput").value.trim()
    },
    sms: {
      enabled: $("#smsInput").checked,
      destination: $("#smsDestinationInput").value.trim()
    }
  };
}

function builderPayload() {
  const channels = Object.entries(channelInputs())
    .filter(([, value]) => value.enabled)
    .map(([key]) => key);

  return {
    prompt: $("#promptInput").value.trim(),
    constraints: {
      channels
    },
    intervalMinutes: 1
  };
}

function renderProviderStatus() {
  const providers = state.providers || {};
  const rows = [
    ["Telegram", providers.telegram?.enabled, providers.telegram?.source || "not connected"],
    ["Email", providers.email?.enabled, providers.email?.provider || "not configured"],
    ["SMS", providers.sms?.enabled, providers.sms?.provider || "not configured"]
  ];
  $("#providerStatus").innerHTML = rows.map(([label, enabled, detail]) => `
    <div class="provider-status">
      <span>${label}</span>
      <span class="status-pill ${enabled ? "enabled" : ""}">${enabled ? detail : "off"}</span>
    </div>
  `).join("");
}

function renderParsedSummary() {
  if (!state.constraints) {
    $("#parsedSummary").innerHTML = `
      <div class="empty-state compact">
        <i data-lucide="map"></i>
        <p>Parsed trip details and ranked targets will appear here.</p>
      </div>`;
    iconRefresh();
    return;
  }
  const c = state.constraints;
  const chips = [
    `${c.arrivalDate} to ${c.checkoutDate}`,
    c.location,
    ...(c.mustHave || []).slice(0, 7),
    ...(c.equipment || [])
  ].filter(Boolean);
  $("#parsedSummary").innerHTML = `
    <div class="summary-chip-list">
      ${chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join("")}
    </div>
      <p>${state.targets.length} candidate campgrounds generated from Recreation.gov search data.</p>
  `;
}

function renderTargets() {
  const grid = $("#targetsGrid");
  $("#createAlertButton").disabled = state.targets.length === 0;
  if (!state.targets.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <i data-lucide="trees"></i>
        <p>No target list yet.</p>
      </div>`;
    iconRefresh();
    return;
  }

  grid.innerHTML = state.targets.map((target, index) => `
    <article class="target-card">
      <div class="target-image">
        ${target.imageUrl ? `<img src="${escapeAttr(target.imageUrl)}" alt="${escapeAttr(target.name)}">` : ""}
        <span class="priority-badge">P${target.priority}</span>
      </div>
      <div class="target-body">
        <div class="target-title-row">
          <h3>${escapeHtml(target.name)}</h3>
          <input type="checkbox" class="target-checkbox" data-index="${index}" checked aria-label="Select ${escapeAttr(target.name)}">
        </div>
        <p>${escapeHtml(target.region || "Region unavailable")}</p>
        <p>${escapeHtml(target.why || "")}</p>
        <div class="meta-row">
          ${target.campsitesCount ? `<span class="meta">${target.campsitesCount} sites</span>` : ""}
          <a class="link" href="${escapeAttr(target.bookingUrl)}" target="_blank" rel="noreferrer">Recreation.gov</a>
        </div>
      </div>
    </article>
  `).join("");
}

function renderAlerts() {
  $("#activeAlertsMetric").textContent = String(state.alerts.filter((alert) => alert.status === "active").length);
  const list = $("#alertsList");
  if (!state.alerts.length) {
    list.innerHTML = `
      <div class="empty-state compact">
        <i data-lucide="bell"></i>
        <p>No saved alerts.</p>
      </div>`;
    iconRefresh();
    return;
  }

  list.innerHTML = state.alerts.map((alert) => `
    <article class="alert-card">
      <div class="alert-topline">
        <div>
          <h3>${escapeHtml(alert.name)}</h3>
          <p>${escapeHtml(alert.constraints.location)} | ${alert.constraints.arrivalDate} to ${alert.constraints.checkoutDate}</p>
        </div>
        <span class="status-pill ${alert.status === "active" ? "enabled" : ""}">${alert.status}</span>
      </div>
      <div class="meta-row">
        <span class="meta">${alert.targets.length} targets</span>
        <span class="meta">fast checks</span>
        <span class="meta">${alert.lastCheckedAt ? `checked ${timeAgo(alert.lastCheckedAt)}` : "not checked yet"}</span>
        <span class="meta">${alert.lastMatchCount || 0} latest matches</span>
      </div>
      <div class="alert-actions">
        <button class="secondary-button small" data-action="check" data-id="${alert.id}" type="button"><i data-lucide="radar"></i>Check now</button>
        <button class="secondary-button small" data-action="toggle" data-id="${alert.id}" data-status="${alert.status}" type="button">
          <i data-lucide="${alert.status === "active" ? "pause" : "play"}"></i>${alert.status === "active" ? "Pause" : "Resume"}
        </button>
        <button class="secondary-button small" data-action="delete" data-id="${alert.id}" type="button"><i data-lucide="trash-2"></i>Delete</button>
      </div>
    </article>
  `).join("");
  iconRefresh();
}

function renderHits() {
  $("#matchesMetric").textContent = String(state.hits.length);
  const list = $("#hitsList");
  if (!state.hits.length) {
    list.innerHTML = `
      <div class="empty-state compact">
        <i data-lucide="circle-dot"></i>
        <p>No availability matches logged.</p>
      </div>`;
    iconRefresh();
    return;
  }

  list.innerHTML = state.hits.map((hit) => `
    <article class="hit-card">
      <div class="hit-topline">
        <div>
          <h3>${escapeHtml(hit.campground)} - site ${escapeHtml(String(hit.site))}</h3>
          <p>${escapeHtml(hit.arrivalDate)} to ${escapeHtml(hit.checkoutDate)} | ${escapeHtml(hit.type || "Campsite")}</p>
        </div>
        <a class="secondary-button small" href="${escapeAttr(hit.link)}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i>Book</a>
      </div>
      <p>${escapeHtml(hit.why || "")}</p>
      <div class="meta-row">
        <span class="meta">${escapeHtml(hit.region || "Region unavailable")}</span>
        <span class="meta">seen ${timeAgo(hit.firstSeenAt)}</span>
      </div>
    </article>
  `).join("");
  iconRefresh();
}

function renderAll() {
  renderProviderStatus();
  renderParsedSummary();
  renderTargets();
  renderAlerts();
  renderHits();
  iconRefresh();
}

async function loadStatus() {
  const [status, alerts] = await Promise.all([
    api("/api/status"),
    api("/api/alerts")
  ]);
  state.providers = status.providers;
  state.alerts = alerts.alerts;
  state.hits = alerts.hits;
  state.runs = alerts.runs;
  renderAll();
}

function showAuthGate(message = "") {
  const gate = $("#authGate");
  gate.hidden = false;
  document.body.classList.add("auth-locked");
  $("#authError").textContent = message;
  window.setTimeout(() => $("#accessCodeInput")?.focus(), 0);
}

function hideAuthGate() {
  $("#authGate").hidden = true;
  document.body.classList.remove("auth-locked");
  $("#authError").textContent = "";
}

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = window.setInterval(() => loadStatus().catch(() => {}), 60_000);
}

async function unlockWithCode(code) {
  sessionStorage.setItem(ACCESS_CODE_KEY, code.trim());
  const status = await api("/api/status");
  if (status.authRequired && !status.authorized) {
    sessionStorage.removeItem(ACCESS_CODE_KEY);
    throw new Error("That access code did not work.");
  }
  hideAuthGate();
  await loadStatus();
  startRefreshTimer();
}

async function initialize() {
  updateDestinations();
  const status = await api("/api/status");
  if (status.authRequired && !status.authorized) {
    sessionStorage.removeItem(ACCESS_CODE_KEY);
    showAuthGate();
    return;
  }
  await loadStatus();
  startRefreshTimer();
}

async function parseOnly() {
  const data = await api("/api/parse", { method: "POST", body: builderPayload() });
  state.constraints = data.constraints;
  renderParsedSummary();
  toast("Parsed request.");
}

async function discover() {
  const button = $("#discoverButton");
  button.disabled = true;
  button.innerHTML = `<i data-lucide="loader"></i>Generating...`;
  iconRefresh();
  try {
    const data = await api("/api/discover", { method: "POST", body: { ...builderPayload(), limit: 24 } });
    state.constraints = data.constraints;
    state.targets = data.targets;
    renderParsedSummary();
    renderTargets();
    toast(`Generated ${data.targets.length} targets.`);
  } finally {
    button.disabled = false;
    button.innerHTML = `<i data-lucide="search"></i>Generate alert list`;
    iconRefresh();
  }
}

async function createAlert() {
  const selected = [...document.querySelectorAll(".target-checkbox")]
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => state.targets[Number(checkbox.dataset.index)])
    .filter(Boolean);
  if (!selected.length) {
    toast("Select at least one target.");
    return;
  }
  const payload = {
    ...builderPayload(),
    targets: selected,
    channels: channelInputs(),
    name: [state.constraints?.location, state.constraints?.arrivalDate].filter(Boolean).join(" ") || "EasyCamp alert"
  };
  const data = await api("/api/alerts", { method: "POST", body: payload });
  state.alerts.unshift(data.alert);
  renderAlerts();
  toast("Alert created and queued.");
}

async function checkAlert(id) {
  toast("Checking availability...");
  const data = await api(`/api/alerts/${id}/check`, { method: "POST", body: {} });
  await loadStatus();
  if (data.newHits.length) {
    toast(`Found ${data.newHits.length} new matching site(s).`);
  } else if (data.matches.length) {
    toast(`${data.matches.length} matching site(s) already logged.`);
  } else {
    toast("No matching availability right now.");
  }
}

async function toggleAlert(id, status) {
  const next = status === "active" ? "paused" : "active";
  await api(`/api/alerts/${id}`, { method: "PATCH", body: { status: next } });
  await loadStatus();
  toast(next === "active" ? "Alert resumed." : "Alert paused.");
}

async function deleteAlert(id) {
  await api(`/api/alerts/${id}`, { method: "DELETE" });
  await loadStatus();
  toast("Alert deleted.");
}

async function testTelegram() {
  await api("/api/notifications/test", {
    method: "POST",
    body: {
      channels: { telegram: { enabled: true } },
      message: "Test: EasyCamp Telegram alerts are connected. Manual booking only."
    }
  });
  toast("Telegram test sent.");
}

function updateDestinations() {
  const emailVisible = $("#emailInput").checked;
  const smsVisible = $("#smsInput").checked;
  document.querySelector(".hidden-destinations").classList.toggle("visible", emailVisible || smsVisible);
  document.querySelector('[data-channel="email"]').classList.toggle("visible", emailVisible);
  document.querySelector('[data-channel="sms"]').classList.toggle("visible", smsVisible);
}

function fillExample() {
  $("#promptInput").value = "Find high elevation campsites near Lake Tahoe and Desolation Wilderness for August 14-16, near lakes, granite, trailheads, and cooler weather. Send Telegram alerts and skip group sites.";
  $("#telegramInput").checked = true;
  $("#emailInput").checked = false;
  $("#smsInput").checked = false;
  updateDestinations();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function timeAgo(value) {
  if (!value) return "";
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.id === "parseButton") await parseOnly();
    if (button.id === "discoverButton") await discover();
    if (button.id === "createAlertButton") await createAlert();
    if (button.id === "refreshButton") await loadStatus();
    if (button.id === "testTelegramButton") await testTelegram();
    if (button.id === "fillExample") fillExample();
    if (button.id === "selectAllTargets") {
      document.querySelectorAll(".target-checkbox").forEach((checkbox) => { checkbox.checked = true; });
    }
    if (button.dataset.action === "check") await checkAlert(button.dataset.id);
    if (button.dataset.action === "toggle") await toggleAlert(button.dataset.id, button.dataset.status);
    if (button.dataset.action === "delete") await deleteAlert(button.dataset.id);
  } catch (error) {
    toast(error.message);
  }
});

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#authButton");
  button.disabled = true;
  $("#authError").textContent = "";
  try {
    await unlockWithCode($("#accessCodeInput").value);
    $("#accessCodeInput").value = "";
  } catch (error) {
    $("#authError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

["emailInput", "smsInput"].forEach((id) => {
  document.addEventListener("change", (event) => {
    if (event.target.id === id) updateDestinations();
  });
});

initialize().catch((error) => toast(error.message));
