import http from "node:http";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const storePath = path.join(dataDir, "store.json");
const accessCodePath = path.join(dataDir, "access-code.txt");
const port = Number(process.env.PORT || 4173);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "https://nolanbradberrysportfolio.github.io")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const defaultStore = {
  alerts: [],
  hits: [],
  notifications: [],
  runs: [],
  createdAt: new Date().toISOString()
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

let schedulerBusy = false;

async function ensureStore() {
  await mkdir(dataDir, { recursive: true });
  try {
    await stat(storePath);
  } catch {
    await writeJson(storePath, defaultStore);
  }
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

async function readStore() {
  await ensureStore();
  const store = await readJson(storePath, defaultStore);
  return {
    ...defaultStore,
    ...store,
    alerts: Array.isArray(store?.alerts) ? store.alerts : [],
    hits: Array.isArray(store?.hits) ? store.hits : [],
    notifications: Array.isArray(store?.notifications) ? store.notifications : [],
    runs: Array.isArray(store?.runs) ? store.runs : []
  };
}

async function writeStore(store) {
  await writeJson(storePath, store);
}

async function getAccessCode() {
  if (process.env.APP_ACCESS_CODE) return process.env.APP_ACCESS_CODE.trim();
  try {
    return (await readFile(accessCodePath, "utf8")).trim();
  } catch {
    return "";
  }
}

async function isAuthorized(req) {
  const code = await getAccessCode();
  if (!code) return true;
  const headerCode = String(req.headers["x-app-code"] || "").trim();
  return crypto.timingSafeEqual(Buffer.from(headerCode), Buffer.from(code));
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function textResponse(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || (!allowedOrigins.has("*") && !allowedOrigins.has(origin))) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-App-Code");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) {
      throw new Error("Request body is too large.");
    }
  }
  return body ? JSON.parse(body) : {};
}

function normalizeDate(date) {
  if (!date) return "";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function currentTripYear() {
  const now = new Date();
  const year = now.getFullYear();
  const julyFourth = new Date(`${year}-07-04T00:00:00`);
  return now > julyFourth ? year + 1 : year;
}

function julyFourthWeekend(year = currentTripYear(), prompt = "") {
  const julyFourth = new Date(`${year}-07-04T00:00:00`);
  const day = julyFourth.getDay();
  const thursday = new Date(julyFourth);
  thursday.setDate(julyFourth.getDate() - ((day + 3) % 7));
  const friday = new Date(julyFourth);
  friday.setDate(julyFourth.getDate() - ((day + 2) % 7));
  const sunday = new Date(julyFourth);
  sunday.setDate(julyFourth.getDate() + ((7 - day) % 7 || 7));
  const wantsThursday = /\b(thursday|thu|thurs)\b/i.test(prompt);
  const arrival = wantsThursday ? thursday : friday;
  return {
    arrivalDate: arrival.toISOString().slice(0, 10),
    checkoutDate: sunday.toISOString().slice(0, 10)
  };
}

function parseMonthDay(prompt) {
  const months = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
    sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
    dec: 11, december: 11
  };
  const match = prompt.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s*[-–]\s*(?:(\w+)\s*)?(\d{1,2}))?/i);
  if (!match) return null;
  const year = currentTripYear();
  const startMonth = months[match[1].toLowerCase()];
  const startDay = Number(match[2]);
  const endMonth = match[3] ? months[match[3].toLowerCase()] ?? startMonth : startMonth;
  const endDay = match[4] ? Number(match[4]) : startDay + 2;
  const start = new Date(year, startMonth, startDay);
  const end = new Date(year, endMonth, endDay);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  end.setDate(end.getDate() + 1);
  return {
    arrivalDate: start.toISOString().slice(0, 10),
    checkoutDate: end.toISOString().slice(0, 10)
  };
}

function parseIsoDates(prompt) {
  const dates = [...prompt.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((m) => normalizeDate(m[1]));
  if (dates.length >= 2) return { arrivalDate: dates[0], checkoutDate: dates[1] };
  return null;
}

function keywordList(prompt, keywords) {
  const lower = prompt.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword));
}

function parseLocation(prompt, fallback = "") {
  if (fallback) return fallback.trim();
  const patterns = [
    /\b(?:near|around|in|by|within\s+\d+\s*(?:hours?|hrs?)\s+of)\s+([^,.]+?)(?:\s+(?:for|from|with|near|that|where)\b|[,.]|$)/i,
    /\b(?:find|show|watch)\s+(?:me\s+)?(?:campsites?|campgrounds?)\s+(?:near|around|in)\s+([^,.]+?)(?:\s+(?:for|from|with|near|that|where)\b|[,.]|$)/i
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  if (/eastern sierra|mammoth|bishop|june lake|inyo/i.test(prompt)) return "Eastern Sierra";
  if (/sierra/i.test(prompt)) return "Sierra Nevada California";
  if (/yosemite/i.test(prompt)) return "Yosemite";
  if (/sequoia|kings canyon/i.test(prompt)) return "Sequoia Kings Canyon";
  if (/tahoe|desolation/i.test(prompt)) return "Lake Tahoe";
  return "California";
}

function parseDriveHours(prompt) {
  const match = prompt.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i);
  return match ? Number(match[1]) : null;
}

function parseConstraints(input = {}) {
  const prompt = String(input.prompt || "");
  const explicit = input.constraints || {};
  let dates = null;
  if (/july\s*4|4th of july|independence day/i.test(prompt)) {
    dates = julyFourthWeekend(currentTripYear(), prompt);
  }
  dates = parseIsoDates(prompt) || parseMonthDay(prompt) || dates;

  const features = keywordList(prompt, [
    "high elevation", "alpine", "lake", "lakes", "water", "waterfall", "river",
    "creek", "trail", "trails", "wilderness", "granite", "cool", "shade",
    "quiet", "secluded", "walk-in", "waterfront"
  ]);
  const equipment = keywordList(prompt, ["tent", "rv", "trailer", "van", "camper"]);
  const channels = [];
  if (/telegram/i.test(prompt)) channels.push("telegram");
  if (/\b(text|sms|phone)\b/i.test(prompt)) channels.push("sms");
  if (/\bemail\b/i.test(prompt)) channels.push("email");

  return {
    arrivalDate: normalizeDate(explicit.arrivalDate || input.arrivalDate || dates?.arrivalDate),
    checkoutDate: normalizeDate(explicit.checkoutDate || input.checkoutDate || dates?.checkoutDate),
    location: parseLocation(prompt, explicit.location || input.location),
    maxDriveHours: explicit.maxDriveHours ?? parseDriveHours(prompt),
    mustHave: [...new Set([...(explicit.mustHave || []), ...features])],
    equipment: explicit.equipment?.length ? explicit.equipment : (equipment.length ? equipment : ["tent"]),
    includeGroupSites: Boolean(explicit.includeGroupSites || /group site|group camp/i.test(prompt)),
    channels: [...new Set([...(explicit.channels || []), ...(channels.length ? channels : ["telegram"])])],
    searchQuery: explicit.searchQuery || input.searchQuery || parseLocation(prompt, explicit.location || input.location),
    rawPrompt: prompt
  };
}

function targetScore(result, constraints) {
  const text = `${result.name || ""} ${result.description || ""} ${(result.activities || []).map((a) => a.activity_name).join(" ")}`.toLowerCase();
  const placeText = `${result.name || ""} ${result.parent_name || ""} ${result.city || ""} ${result.state_code || ""}`.toLowerCase();
  let score = 0;
  const reasons = [];
  const signals = [
    ["high elevation", ["high elevation", "alpine", "mountain", "sierra", "pass"]],
    ["water", ["lake", "river", "creek", "waterfall", "shore", "water"]],
    ["trails", ["trail", "hiking", "wilderness", "backpacking"]],
    ["cooler weather", ["shade", "forest", "pine", "elevation"]],
    ["scenery", ["granite", "meadow", "canyon", "peak", "view", "scenic"]]
  ];
  for (const [label, words] of signals) {
    if (words.some((word) => text.includes(word))) {
      score += 2;
      reasons.push(label);
    }
  }
  for (const must of constraints.mustHave || []) {
    const normalized = must.toLowerCase().replace(/s$/, "");
    if (normalized && text.includes(normalized)) score += 3;
  }
  for (const term of String(constraints.location || "").toLowerCase().split(/\s+/).filter((item) => item.length > 3)) {
    if (placeText.includes(term)) score += 2;
  }
  if (result.reservable) score += 4;
  if (result.campsites_count) score += Math.min(3, Math.ceil(Number(result.campsites_count) / 100));
  return { score, reasons: [...new Set(reasons)] };
}

function resultLooksUnavailable(result) {
  const text = `${result.name || ""} ${result.description || ""} ${(result.notices || []).map((notice) => notice.text || "").join(" ")}`.toLowerCase();
  return /\b(remains closed|closed until|closed due|will be closed|not currently accepting reservations|not accepting reservations|temporarily closed)\b/.test(text);
}

function resultIsExcludedSiteClass(result, constraints) {
  if (constraints.includeGroupSites) return false;
  const text = `${result.name || ""} ${result.description || ""}`.toLowerCase();
  return /\b(group camp|group campground|group site|horse camp|horse campsites|equestrian)\b/.test(text);
}

function buildWhy(result, reasons) {
  const base = reasons.length
    ? `Matches ${reasons.join(", ")}.`
    : "Matches the search area and is reservable on Recreation.gov.";
  const parent = result.parent_name ? ` ${result.parent_name}.` : "";
  const description = String(result.description || "").replace(/\s+/g, " ").slice(0, 150);
  return `${base}${parent}${description ? ` ${description}...` : ""}`;
}

async function recgovSearch(query, size = 40) {
  const params = new URLSearchParams({
    fq: "entity_type:campground",
    query,
    size: String(size)
  });
  const response = await fetch(`https://www.recreation.gov/api/search?${params}`, {
    headers: { "User-Agent": "Campsite alert app; manual booking only" }
  });
  if (!response.ok) throw new Error(`Recreation.gov search failed with ${response.status}`);
  const data = await response.json();
  return data.results || [];
}

async function discoverTargets(input) {
  const constraints = parseConstraints(input);
  if (!constraints.arrivalDate || !constraints.checkoutDate) {
    const fallback = julyFourthWeekend(currentTripYear(), constraints.rawPrompt || "");
    constraints.arrivalDate ||= fallback.arrivalDate;
    constraints.checkoutDate ||= fallback.checkoutDate;
  }

  const seedQueries = [
    constraints.searchQuery,
    `${constraints.searchQuery} campground`,
    `${constraints.searchQuery} lake trail campground`
  ].filter(Boolean);

  const seen = new Set();
  const targets = [];
  for (const query of seedQueries) {
    const results = await recgovSearch(query, 50);
    for (const result of results) {
      const id = String(result.entity_id || "").trim();
      if (!id || seen.has(id) || result.entity_type !== "campground") continue;
      if (result.reservable === false) continue;
      if (resultLooksUnavailable(result)) continue;
      if (resultIsExcludedSiteClass(result, constraints)) continue;
      seen.add(id);
      const scoring = targetScore(result, constraints);
      if (scoring.score < 4) continue;
      targets.push({
        id,
        name: result.name,
        region: [result.parent_name, result.city, result.state_code].filter(Boolean).join(" / "),
        priority: scoring.score >= 13 ? 1 : scoring.score >= 9 ? 2 : 3,
        score: scoring.score,
        why: buildWhy(result, scoring.reasons),
        latitude: Number(result.latitude) || null,
        longitude: Number(result.longitude) || null,
        imageUrl: result.preview_image_url || "",
        campsitesCount: Number(result.campsites_count) || null,
        bookingUrl: `https://www.recreation.gov/camping/campgrounds/${id}`
      });
    }
  }

  targets.sort((a, b) => a.priority - b.priority || b.score - a.score || a.name.localeCompare(b.name));
  return { constraints, targets: targets.slice(0, Number(input.limit || 24)) };
}

function getNights(arrivalDate, checkoutDate) {
  const start = new Date(`${arrivalDate}T00:00:00Z`);
  const end = new Date(`${checkoutDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error("Checkout date must be after arrival date.");
  }
  const nights = [];
  for (const cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    nights.push(cursor.toISOString().slice(0, 10) + "T00:00:00Z");
  }
  return nights;
}

function monthStartsFor(nights) {
  return [...new Set(nights.map((night) => `${night.slice(0, 8)}01T00:00:00.000Z`))];
}

async function fetchAvailabilityMonth(facilityId, monthStart, attempt = 1) {
  const start = encodeURIComponent(monthStart);
  const url = `https://www.recreation.gov/api/camps/availability/campground/${facilityId}/month?start_date=${start}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Campsite alert app; manual booking only" }
  });
  if (response.status === 429 && attempt < 3) {
    await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
    return fetchAvailabilityMonth(facilityId, monthStart, attempt + 1);
  }
  if (!response.ok) throw new Error(`Availability failed with ${response.status}`);
  return response.json();
}

function siteAllowed(site, constraints) {
  if (site.type_of_use !== "Overnight") return false;
  if (constraints.includeGroupSites) return true;
  const type = String(site.campsite_type || "").toUpperCase();
  const capacity = String(site.capacity_rating || "").toUpperCase();
  return !["GROUP", "HORSE", "EQUESTRIAN"].some((word) => type.includes(word) || capacity.includes(word));
}

async function checkTargets(targets, constraints) {
  const nights = getNights(constraints.arrivalDate, constraints.checkoutDate);
  const monthStarts = monthStartsFor(nights);
  const matches = [];
  const warnings = [];

  for (const target of targets) {
    const sites = new Map();
    try {
      for (const monthStart of monthStarts) {
        const data = await fetchAvailabilityMonth(target.id, monthStart);
        for (const site of Object.values(data.campsites || {})) {
          const existing = sites.get(site.campsite_id) || site;
          existing.availabilities = {
            ...(existing.availabilities || {}),
            ...(site.availabilities || {})
          };
          sites.set(site.campsite_id, existing);
        }
      }

      for (const site of sites.values()) {
        if (!siteAllowed(site, constraints)) continue;
        const available = nights.every((night) => site.availabilities?.[night] === "Available");
        if (!available) continue;
        const link = `https://www.recreation.gov/camping/campgrounds/${target.id}?start_date=${constraints.arrivalDate}&end_date=${constraints.checkoutDate}`;
        matches.push({
          facilityId: target.id,
          campground: target.name,
          region: target.region,
          priority: target.priority,
          site: site.site,
          campsiteId: site.campsite_id,
          loop: site.loop,
          type: site.campsite_type,
          nights,
          arrivalDate: constraints.arrivalDate,
          checkoutDate: constraints.checkoutDate,
          link,
          why: target.why,
          fingerprint: `${target.id}|${site.campsite_id}|${constraints.arrivalDate}|${constraints.checkoutDate}`
        });
      }
    } catch (error) {
      warnings.push({ target: target.name, facilityId: target.id, message: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 650));
  }

  matches.sort((a, b) => a.priority - b.priority || a.campground.localeCompare(b.campground) || String(a.site).localeCompare(String(b.site)));
  return { matches, warnings };
}

async function getTelegramSettingsAsync() {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  const envChat = process.env.TELEGRAM_CHAT_ID;
  if (envToken && envChat) {
    return { token: envToken, chatId: envChat, source: "environment" };
  }
  const configPath = process.env.CODEX_ANYWHERE_CONFIG
    || path.join(os.homedir(), "AppData", "Roaming", "codex-anywhere", "config.json");
  const config = await readJson(configPath, null);
  const bot = Array.isArray(config?.bots) ? (config.bots.find((item) => item.id === "default") || config.bots[0]) : null;
  if (bot?.telegramBotToken && bot?.ownerUserId) {
    return { token: bot.telegramBotToken, chatId: String(bot.ownerUserId), source: "codex-anywhere" };
  }
  return null;
}

function providerStatus(settings = null) {
  return {
    telegram: {
      enabled: Boolean(settings),
      source: settings?.source || null
    },
    email: {
      enabled: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
      provider: "resend"
    },
    sms: {
      enabled: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER),
      provider: "twilio"
    }
  };
}

function formatHitMessage(alert, hits) {
  const lines = [
    "Campsite availability alert",
    `${alert.constraints.arrivalDate} to ${alert.constraints.checkoutDate}`,
    ""
  ];
  for (const hit of hits.slice(0, 8)) {
    lines.push(`${hit.campground} - site ${hit.site}`);
    lines.push(`${hit.type || "Campsite"} | ${hit.region || "Region unavailable"}`);
    lines.push(hit.link);
    if (hit.why) lines.push(hit.why);
    lines.push("");
  }
  if (hits.length > 8) lines.push(`Plus ${hits.length - 8} more matching sites.`);
  lines.push("Manual booking only. Availability can disappear before checkout.");
  const message = lines.join("\n");
  return message.length > 3800 ? `${message.slice(0, 3800)}\n...` : message;
}

async function sendTelegram(text) {
  const settings = await getTelegramSettingsAsync();
  if (!settings) throw new Error("Telegram is not configured.");
  const response = await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: settings.chatId,
      text,
      disable_web_page_preview: false
    })
  });
  if (!response.ok) throw new Error(`Telegram send failed with ${response.status}`);
  return { provider: "telegram", source: settings.source };
}

async function sendEmail(destination, subject, text) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error("Email is not configured. Set RESEND_API_KEY and EMAIL_FROM.");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [destination],
      subject,
      text
    })
  });
  if (!response.ok) throw new Error(`Email send failed with ${response.status}`);
  return { provider: "resend" };
}

async function sendSms(destination, text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new Error("SMS is not configured. Set Twilio credentials.");
  }
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const body = new URLSearchParams({ From: from, To: destination, Body: text.slice(0, 1300) });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!response.ok) throw new Error(`SMS send failed with ${response.status}`);
  return { provider: "twilio" };
}

async function sendAlertNotifications(store, alert, newHits) {
  const channels = alert.channels || {};
  const message = formatHitMessage(alert, newHits);
  const sent = [];
  const skipped = [];

  if (channels.telegram?.enabled) {
    try {
      sent.push(await sendTelegram(message));
    } catch (error) {
      skipped.push({ provider: "telegram", error: error.message });
    }
  }

  if (channels.email?.enabled && channels.email.destination) {
    try {
      sent.push(await sendEmail(channels.email.destination, "Campsite available", message));
    } catch (error) {
      skipped.push({ provider: "email", error: error.message });
    }
  }

  if (channels.sms?.enabled && channels.sms.destination) {
    try {
      sent.push(await sendSms(channels.sms.destination, message));
    } catch (error) {
      skipped.push({ provider: "sms", error: error.message });
    }
  }

  store.notifications.push({
    id: crypto.randomUUID(),
    alertId: alert.id,
    hitIds: newHits.map((hit) => hit.id),
    sent,
    skipped,
    messagePreview: message.slice(0, 500),
    createdAt: new Date().toISOString()
  });
  return { sent, skipped };
}

async function runAlertCheck(alertId, options = {}) {
  const store = await readStore();
  const alert = store.alerts.find((item) => item.id === alertId);
  if (!alert) throw new Error("Alert not found.");
  const startedAt = new Date().toISOString();
  const existingFingerprints = new Set(store.hits.map((hit) => hit.fingerprint));
  const { matches, warnings } = await checkTargets(alert.targets, alert.constraints);
  const newHits = [];
  for (const match of matches) {
    if (existingFingerprints.has(`${alert.id}|${match.fingerprint}`)) continue;
    const hit = {
      id: crypto.randomUUID(),
      alertId: alert.id,
      ...match,
      fingerprint: `${alert.id}|${match.fingerprint}`,
      firstSeenAt: new Date().toISOString()
    };
    store.hits.push(hit);
    newHits.push(hit);
  }

  alert.lastCheckedAt = new Date().toISOString();
  alert.lastMatchCount = matches.length;
  alert.lastWarningCount = warnings.length;
  alert.nextCheckAt = new Date(Date.now() + (alert.intervalMinutes || 30) * 60_000).toISOString();
  alert.updatedAt = new Date().toISOString();

  let notificationResult = { sent: [], skipped: [] };
  if (newHits.length && options.notify !== false) {
    notificationResult = await sendAlertNotifications(store, alert, newHits);
  }

  store.runs.push({
    id: crypto.randomUUID(),
    alertId: alert.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: warnings.length ? "completed_with_warnings" : "completed",
    matchCount: matches.length,
    newHitCount: newHits.length,
    warnings: warnings.slice(0, 10),
    notificationResult
  });

  await writeStore(store);
  return { alert, matches, newHits, warnings, notificationResult };
}

async function schedulerTick() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const store = await readStore();
    const due = store.alerts
      .filter((alert) => alert.status === "active")
      .filter((alert) => !alert.nextCheckAt || new Date(alert.nextCheckAt).getTime() <= Date.now())
      .map((alert) => alert.id);
    for (const alertId of due) {
      await runAlertCheck(alertId);
    }
  } catch (error) {
    console.error("[scheduler]", error.message);
  } finally {
    schedulerBusy = false;
  }
}

function publicAlert(alert) {
  return {
    ...alert,
    channels: {
      telegram: { enabled: Boolean(alert.channels?.telegram?.enabled) },
      email: {
        enabled: Boolean(alert.channels?.email?.enabled),
        destination: alert.channels?.email?.destination || ""
      },
      sms: {
        enabled: Boolean(alert.channels?.sms?.enabled),
        destination: alert.channels?.sms?.destination || ""
      }
    }
  };
}

async function handleApi(req, res, pathname) {
  const accessCode = await getAccessCode();
  const authorized = await isAuthorized(req).catch(() => false);

  if (req.method === "GET" && pathname === "/api/status") {
    const telegramSettings = await getTelegramSettingsAsync();
    const store = await readStore();
    return jsonResponse(res, 200, {
      ok: true,
      authRequired: Boolean(accessCode),
      authorized,
      providers: providerStatus(telegramSettings),
      counts: {
        alerts: store.alerts.length,
        activeAlerts: store.alerts.filter((alert) => alert.status === "active").length,
        hits: store.hits.length,
        notifications: store.notifications.length
      }
    });
  }

  if (accessCode && !authorized) {
    return jsonResponse(res, 401, {
      error: "Access code required.",
      authRequired: true
    });
  }

  if (req.method === "POST" && pathname === "/api/parse") {
    const body = await readBody(req);
    return jsonResponse(res, 200, { constraints: parseConstraints(body) });
  }

  if (req.method === "POST" && pathname === "/api/discover") {
    const body = await readBody(req);
    const result = await discoverTargets(body);
    return jsonResponse(res, 200, result);
  }

  if (req.method === "GET" && pathname === "/api/alerts") {
    const store = await readStore();
    return jsonResponse(res, 200, {
      alerts: store.alerts.map(publicAlert),
      hits: store.hits.slice(-50).reverse(),
      runs: store.runs.slice(-20).reverse()
    });
  }

  if (req.method === "POST" && pathname === "/api/alerts") {
    const body = await readBody(req);
    const constraints = parseConstraints(body);
    if (!constraints.arrivalDate || !constraints.checkoutDate) {
      return jsonResponse(res, 400, { error: "Arrival and checkout dates are required." });
    }
    if (!Array.isArray(body.targets) || body.targets.length === 0) {
      return jsonResponse(res, 400, { error: "At least one target campground is required." });
    }

    const alert = {
      id: crypto.randomUUID(),
      name: body.name || `${constraints.location} ${constraints.arrivalDate}`,
      rawPrompt: body.prompt || constraints.rawPrompt || "",
      constraints,
      targets: body.targets.slice(0, 80),
      channels: {
        telegram: { enabled: Boolean(body.channels?.telegram?.enabled) },
        email: {
          enabled: Boolean(body.channels?.email?.enabled),
          destination: String(body.channels?.email?.destination || "").trim()
        },
        sms: {
          enabled: Boolean(body.channels?.sms?.enabled),
          destination: String(body.channels?.sms?.destination || "").trim()
        }
      },
      intervalMinutes: Math.max(10, Math.min(240, Number(body.intervalMinutes || 30))),
      status: body.startPaused ? "paused" : "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextCheckAt: new Date().toISOString(),
      lastCheckedAt: null,
      lastMatchCount: 0,
      lastWarningCount: 0
    };

    const store = await readStore();
    store.alerts.push(alert);
    await writeStore(store);
    return jsonResponse(res, 201, { alert: publicAlert(alert) });
  }

  const alertAction = pathname.match(/^\/api\/alerts\/([^/]+)(?:\/([^/]+))?$/);
  if (alertAction) {
    const [, alertId, action] = alertAction;

    if (req.method === "GET" && !action) {
      const store = await readStore();
      const alert = store.alerts.find((item) => item.id === alertId);
      if (!alert) return jsonResponse(res, 404, { error: "Alert not found." });
      return jsonResponse(res, 200, {
        alert: publicAlert(alert),
        hits: store.hits.filter((hit) => hit.alertId === alertId).reverse(),
        runs: store.runs.filter((run) => run.alertId === alertId).reverse()
      });
    }

    if (req.method === "POST" && action === "check") {
      const result = await runAlertCheck(alertId, { notify: true });
      return jsonResponse(res, 200, {
        alert: publicAlert(result.alert),
        matches: result.matches,
        newHits: result.newHits,
        warnings: result.warnings,
        notificationResult: result.notificationResult
      });
    }

    if (req.method === "PATCH" && !action) {
      const body = await readBody(req);
      const store = await readStore();
      const alert = store.alerts.find((item) => item.id === alertId);
      if (!alert) return jsonResponse(res, 404, { error: "Alert not found." });
      if (body.status && ["active", "paused"].includes(body.status)) alert.status = body.status;
      if (body.name) alert.name = body.name;
      if (body.intervalMinutes) alert.intervalMinutes = Math.max(10, Math.min(240, Number(body.intervalMinutes)));
      alert.updatedAt = new Date().toISOString();
      await writeStore(store);
      return jsonResponse(res, 200, { alert: publicAlert(alert) });
    }

    if (req.method === "DELETE" && !action) {
      const store = await readStore();
      store.alerts = store.alerts.filter((item) => item.id !== alertId);
      await writeStore(store);
      return jsonResponse(res, 200, { ok: true });
    }
  }

  if (req.method === "POST" && pathname === "/api/notifications/test") {
    const body = await readBody(req);
    const message = body.message || "Test: campsite alert notifications are connected. Manual booking only.";
    const results = [];
    if (body.channels?.telegram?.enabled) results.push(await sendTelegram(message));
    if (body.channels?.email?.enabled && body.channels.email.destination) {
      results.push(await sendEmail(body.channels.email.destination, "Campsite alert test", message));
    }
    if (body.channels?.sms?.enabled && body.channels.sms.destination) {
      results.push(await sendSms(body.channels.sms.destination, message));
    }
    return jsonResponse(res, 200, { ok: true, results });
  }

  return jsonResponse(res, 404, { error: "API route not found." });
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const requestedPath = path.normalize(path.join(publicDir, safePath));
  if (!requestedPath.startsWith(publicDir)) {
    return textResponse(res, 403, "Forbidden");
  }
  try {
    const data = await readFile(requestedPath);
    const ext = path.extname(requestedPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300"
    });
    res.end(data);
  } catch {
    textResponse(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    jsonResponse(res, 500, { error: error.message || "Internal server error." });
  }
});

await ensureStore();
server.listen(port, () => {
  console.log(`Campsite alert app running at http://localhost:${port}`);
});
setInterval(schedulerTick, 60_000).unref();
