const state = {
  providers: null,
  targets: [],
  constraints: null,
  currentAvailability: {
    status: "idle",
    matches: [],
    totalMatches: 0,
    warnings: [],
    checkedAt: null,
    error: ""
  },
  previewRequestId: 0,
  lastGeneratedPrompt: "",
  alerts: [],
  hits: [],
  runs: []
};

const $ = (selector) => document.querySelector(selector);
const API_BASE = String(window.EASY_CAMP_API_BASE || "").replace(/\/$/, "");
const ACCESS_CODE_KEY = "easyCampAccessCode";
let refreshTimer = null;
let targetMap = null;
let targetMapLayer = null;
let targetTileLayer = null;
const targetMarkers = new Map();

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

function resetCurrentAvailability(status = "idle") {
  state.currentAvailability = {
    status,
    matches: [],
    totalMatches: 0,
    warnings: [],
    checkedAt: null,
    error: ""
  };
}

function formatDisplayDate(value) {
  if (!value) return "";
  const parts = String(value).split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(parts[0], parts[1] - 1, parts[2]));
}

function formatDateRange(constraints = state.constraints) {
  if (!constraints?.arrivalDate || !constraints?.checkoutDate) return "Dates not resolved yet";
  return `${formatDisplayDate(constraints.arrivalDate)} to ${formatDisplayDate(constraints.checkoutDate)}`;
}

function targetStates() {
  const states = state.targets
    .map((target) => target.state || String(target.region || "").split("/").pop())
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(states)].sort((a, b) => a.localeCompare(b));
}

function selectedTargetCount() {
  const boxes = [...document.querySelectorAll(".target-checkbox")];
  if (!boxes.length) return state.targets.length;
  return boxes.filter((checkbox) => checkbox.checked).length;
}

function promptChangedSinceGeneration() {
  return Boolean(state.lastGeneratedPrompt && $("#promptInput")?.value.trim() !== state.lastGeneratedPrompt);
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
  const stale = promptChangedSinceGeneration();
  const chips = [
    stale ? "Previous generated result" : "",
    c.dateLabel || "Resolved dates",
    formatDateRange(c),
    `Area: ${c.location}`,
    targetStates().length ? `States: ${targetStates().join(", ")}` : "",
    ...(c.mustHave || []).slice(0, 7),
    ...(c.equipment || [])
  ].filter(Boolean);
  $("#parsedSummary").innerHTML = `
    <div class="summary-chip-list">
      ${chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join("")}
    </div>
      <p>${state.targets.length} candidate campgrounds generated for ${escapeHtml(formatDateRange(c))}.</p>
      ${stale ? `<p class="stale-note">Prompt changed since these results were generated. Generate again to update dates, states, map, and current openings.</p>` : ""}
  `;
}

function renderTargetingDetails() {
  const node = $("#targetingDetails");
  if (!node) return;
  if (!state.constraints) {
    node.innerHTML = `
      <div class="empty-state compact">
        <i data-lucide="map-pin"></i>
        <p>Target area, states, and dates will appear after generation.</p>
      </div>`;
    iconRefresh();
    return;
  }

  const c = state.constraints;
  const states = targetStates();
  const rows = [
    ["Result status", promptChangedSinceGeneration() ? "Previous result - regenerate to update" : "Current generated result"],
    ["Dates checked", formatDateRange(c)],
    ["Search area", c.location || "Area not resolved"],
    ["States targeted", states.length ? states.join(", ") : "No target states yet"],
    ["Targets", `${state.targets.length} generated, ${selectedTargetCount()} selected`],
    ["Site classes", c.includeGroupSites ? "Standard and group-capable sites" : "Standard overnight sites only"]
  ];

  node.innerHTML = `
    <div class="targeting-rows">
      ${rows.map(([label, value]) => `
        <div class="targeting-row">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function resetTargetMap() {
  targetMarkers.clear();
  if (targetMap) {
    targetMap.remove();
    targetMap = null;
    targetMapLayer = null;
    targetTileLayer = null;
  }
}

function renderTargetMap() {
  const node = $("#targetMap");
  if (!node) return;
  const mappableTargets = state.targets.filter((target) => Number.isFinite(target.latitude) && Number.isFinite(target.longitude));

  if (!mappableTargets.length) {
    resetTargetMap();
    node.innerHTML = `
      <div class="empty-state compact">
        <i data-lucide="map"></i>
        <p>Map pins will appear when generated targets include coordinates.</p>
      </div>`;
    iconRefresh();
    return;
  }

  if (!window.L) {
    resetTargetMap();
    node.innerHTML = `
      <div class="empty-state compact">
        <i data-lucide="map"></i>
        <p>Map library did not load. Campsite links are still available in the target cards.</p>
      </div>`;
    iconRefresh();
    return;
  }

  const leaflet = window.L;
  if (!targetMap) {
    node.innerHTML = "";
    targetMap = leaflet.map(node, { scrollWheelZoom: false });
    targetTileLayer = leaflet.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap"
    }).addTo(targetMap);
  }

  if (targetMapLayer) targetMapLayer.clearLayers();
  targetMapLayer = leaflet.layerGroup().addTo(targetMap);
  targetMarkers.clear();

  const bounds = [];
  mappableTargets.forEach((target) => {
    const targetIndex = state.targets.indexOf(target);
    const latLng = [target.latitude, target.longitude];
    bounds.push(latLng);
    const popupImage = target.imageUrl
      ? `<img class="map-popup-image" src="${escapeAttr(target.imageUrl)}" alt="${escapeAttr(target.name)}">`
      : "";
    const popupHtml = `
      <div class="map-popup">
        ${popupImage}
        <strong>${escapeHtml(target.name)}</strong>
        <span>${escapeHtml(target.region || "Region unavailable")}</span>
        <a href="${escapeAttr(target.bookingUrl)}" target="_blank" rel="noreferrer">Open Recreation.gov</a>
      </div>`;
    const marker = leaflet.marker(latLng, { title: target.name }).addTo(targetMapLayer).bindPopup(popupHtml);
    targetMarkers.set(targetIndex, marker);
  });

  if (bounds.length === 1) {
    targetMap.setView(bounds[0], 10);
  } else {
    targetMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 10 });
  }
  window.setTimeout(() => targetMap?.invalidateSize(), 0);
}

function renderCurrentAvailability() {
  const node = $("#currentAvailability");
  if (!node) return;
  const current = state.currentAvailability;
  if (!state.targets.length) {
    node.innerHTML = `
      <div class="empty-state compact">
        <i data-lucide="radar"></i>
        <p>Current openings will appear after a target list is generated.</p>
      </div>`;
    iconRefresh();
    return;
  }

  if (current.status === "checking") {
    node.innerHTML = `
      <div class="availability-status">
        <i data-lucide="loader"></i>
        <div>
          <strong>Checking Recreation.gov now</strong>
          <p>${escapeHtml(formatDateRange())} across ${state.targets.length} generated targets.</p>
        </div>
      </div>`;
    iconRefresh();
    return;
  }

  if (current.status === "error") {
    node.innerHTML = `
      <div class="availability-status warning">
        <i data-lucide="triangle-alert"></i>
        <div>
          <strong>Current availability check failed</strong>
          <p>${escapeHtml(current.error || "Try again with a smaller target list or wait a minute.")}</p>
        </div>
      </div>`;
    iconRefresh();
    return;
  }

  if (current.status !== "done") {
    node.innerHTML = `
      <div class="empty-state compact">
        <i data-lucide="radar"></i>
        <p>Generate a target list to check current openings for the resolved dates.</p>
      </div>`;
    iconRefresh();
    return;
  }

  if (!current.matches.length) {
    node.innerHTML = `
      <div class="availability-status">
        <i data-lucide="circle-check"></i>
        <div>
          <strong>No matching openings right now</strong>
          <p>Checked ${state.targets.length} targets for ${escapeHtml(formatDateRange())}${current.checkedAt ? ` at ${escapeHtml(new Date(current.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}` : ""}.</p>
        </div>
      </div>
      ${current.warnings?.length ? `<p class="availability-warning">${escapeHtml(current.warnings.length)} campground checks returned warnings.</p>` : ""}`;
    iconRefresh();
    return;
  }

  const visibleMatches = current.matches.slice(0, 12);
  node.innerHTML = `
    <div class="availability-status success">
      <i data-lucide="circle-dot"></i>
      <div>
        <strong>${current.totalMatches || current.matches.length} matching site${(current.totalMatches || current.matches.length) === 1 ? "" : "s"} open right now</strong>
        <p>${escapeHtml(formatDateRange())}. Availability can disappear before checkout.</p>
      </div>
    </div>
    <div class="availability-grid">
      ${visibleMatches.map((hit) => `
        <article class="availability-card">
          <h3>${escapeHtml(hit.campground)} - site ${escapeHtml(String(hit.site))}</h3>
          <p>${escapeHtml(hit.type || "Campsite")} | ${escapeHtml(hit.region || "Region unavailable")}</p>
          <a class="link" href="${escapeAttr(hit.link)}" target="_blank" rel="noreferrer">Open Recreation.gov</a>
        </article>
      `).join("")}
    </div>
    ${(current.totalMatches || 0) > visibleMatches.length ? `<p class="availability-warning">Showing first ${visibleMatches.length} current openings.</p>` : ""}`;
  iconRefresh();
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
    renderTargetingDetails();
    renderTargetMap();
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
          ${target.state ? `<span class="meta">${escapeHtml(target.state)}</span>` : ""}
          ${target.campsitesCount ? `<span class="meta">${target.campsitesCount} sites</span>` : ""}
          ${Number.isFinite(target.latitude) && Number.isFinite(target.longitude) ? `<button class="link-button" data-action="focus-map" data-index="${index}" type="button">Map</button>` : ""}
          <a class="link" href="${escapeAttr(target.bookingUrl)}" target="_blank" rel="noreferrer">Recreation.gov</a>
        </div>
      </div>
    </article>
  `).join("");
  renderTargetingDetails();
  renderTargetMap();
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
  renderTargetingDetails();
  renderCurrentAvailability();
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
  renderTargetingDetails();
  toast("Parsed request.");
}

async function checkCurrentAvailability(targets, constraints) {
  const requestId = ++state.previewRequestId;
  resetCurrentAvailability("checking");
  renderCurrentAvailability();
  try {
    const data = await api("/api/availability/preview", {
      method: "POST",
      body: {
        ...builderPayload(),
        constraints,
        targets
      }
    });
    if (requestId !== state.previewRequestId) return;
    state.currentAvailability = {
      status: "done",
      matches: data.matches || [],
      totalMatches: data.totalMatches || 0,
      warnings: data.warnings || [],
      checkedAt: data.checkedAt || null,
      error: ""
    };
    renderCurrentAvailability();
  } catch (error) {
    if (requestId !== state.previewRequestId) return;
    state.currentAvailability = {
      status: "error",
      matches: [],
      totalMatches: 0,
      warnings: [],
      checkedAt: null,
      error: error.message
    };
    renderCurrentAvailability();
  }
}

async function discover() {
  const button = $("#discoverButton");
  button.disabled = true;
  button.innerHTML = `<i data-lucide="loader"></i>Generating...`;
  state.previewRequestId += 1;
  state.constraints = null;
  state.targets = [];
  resetCurrentAvailability("idle");
  renderParsedSummary();
  renderTargets();
  renderCurrentAvailability();
  iconRefresh();
  try {
    const data = await api("/api/discover", { method: "POST", body: { ...builderPayload(), limit: 24 } });
    state.constraints = data.constraints;
    state.targets = data.targets;
    state.lastGeneratedPrompt = builderPayload().prompt;
    resetCurrentAvailability(data.targets.length ? "checking" : "idle");
    renderParsedSummary();
    renderTargets();
    renderCurrentAvailability();
    toast(`Generated ${data.targets.length} targets.`);
    if (data.targets.length) {
      checkCurrentAvailability(data.targets, data.constraints);
    }
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
  $("#promptInput").value = "Find high elevation campsites in the High Sierra for Labor Day weekend, near lakes, rivers, trailheads, and cooler weather. Send Telegram alerts and skip group sites.";
  $("#telegramInput").checked = true;
  $("#emailInput").checked = false;
  $("#smsInput").checked = false;
  updateDestinations();
}

function focusMapTarget(index) {
  const marker = targetMarkers.get(Number(index));
  if (!marker || !targetMap) return;
  document.querySelector("#targeting")?.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => {
    targetMap.setView(marker.getLatLng(), Math.max(targetMap.getZoom(), 10));
    marker.openPopup();
  }, 240);
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
      renderTargetingDetails();
    }
    if (button.dataset.action === "focus-map") focusMapTarget(button.dataset.index);
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

document.addEventListener("change", (event) => {
  if (event.target.classList?.contains("target-checkbox")) renderTargetingDetails();
});

$("#promptInput").addEventListener("input", () => {
  if (!state.constraints) return;
  renderParsedSummary();
  renderTargetingDetails();
});

initialize().catch((error) => toast(error.message));
