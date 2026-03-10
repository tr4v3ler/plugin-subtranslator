const { core, event, http, mpv, overlay, preferences, console: iinaConsole } = iina;

const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat"]
  },
  zhipu: {
    label: "Zhipu AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-5", "glm-4.7"]
  }
};

const SYSTEM_PROMPT =
  "Translate the current subtitle line to Simplified Chinese only.";

const MAX_CACHE_ENTRIES = 200;
const overlayStyleBase = `
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
  }
  #subtranslator {
    position: absolute;
    left: 6%;
    right: 6%;
    pointer-events: none;
  }
`;

let lastOriginal = "";
let lastContext = "";
let lastRequestId = 0;
let cache = new Map();
let missingKeyNotified = false;
let pollTimer = null;
let lastErrorNotifyAt = 0;
let overlayReady = false;
let pendingTranslation = "";
let lastRenderedAt = 0;
let lastRenderedText = "";
const HIDE_GRACE_MS = 1500;
let config = {
  provider: "deepseek",
  model: PROVIDERS.deepseek.models[0],
  apiKey: "",
  baseUrl: PROVIDERS.deepseek.baseUrl,
  debug: false
};
let lastDebugAt = 0;

function debugLog(message) {
  if (!config.debug) return;
  lastDebugAt = Date.now();
  try {
    if (iinaConsole && typeof iinaConsole.log === "function") {
      iinaConsole.log(`[SubTranslator] ${message}`);
    }
  } catch (error) {
    // ignore
  }
  try {
    if (typeof console !== "undefined" && console.log) {
      console.log(`[SubTranslator] ${message}`);
    }
  } catch (error) {
    // ignore
  }
}

function getMpvNumber(name, fallback) {
  const raw = mpv.getString(name);
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num : fallback;
}

function parseColor(raw, fallback) {
  if (!raw || typeof raw !== "string") return fallback;
  const parts = raw.split("/").map((v) => parseFloat(v));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return fallback;
  const [r, g, b, a] = parts;
  const rr = Math.round(r * 255);
  const gg = Math.round(g * 255);
  const bb = Math.round(b * 255);
  return `rgba(${rr}, ${gg}, ${bb}, ${a})`;
}

function buildOverlayStyle(lineCount) {
  const fontFamily = mpv.getString("sub-font") || "sans-serif";
  const fontSize = getMpvNumber("sub-font-size", 22);
  const marginY = getMpvNumber("sub-margin-y", 22);
  const subPos = getMpvNumber("sub-pos", 100);
  const alignX = mpv.getString("sub-align-x") || "center";
  const color = parseColor(mpv.getString("sub-color"), "rgba(255,255,255,1)");
  const borderSize = getMpvNumber("sub-border-size", 2);
  const borderColor = parseColor(mpv.getString("sub-border-color"), "rgba(0,0,0,1)");
  const shadowOffset = getMpvNumber("sub-shadow-offset", 0);
  const shadowColor = parseColor(mpv.getString("sub-shadow-color"), "rgba(0,0,0,0.8)");
  const bold = mpv.getString("sub-bold") === "yes" ? "700" : "400";
  const italic = mpv.getString("sub-italic") === "yes" ? "italic" : "normal";
  const lines = Math.max(1, lineCount || 1);
  const bottomOffset = marginY + Math.round(fontSize * 1.4 * lines) + Math.round(fontSize * 0.2);
  const bottom = `calc(${100 - subPos}% + ${bottomOffset}px)`;
  const textShadow = [
    `0 0 ${borderSize}px ${borderColor}`,
    `${shadowOffset}px ${shadowOffset}px ${Math.max(1, borderSize)}px ${shadowColor}`
  ].join(", ");

  return `
    ${overlayStyleBase}
    #subtranslator {
      bottom: ${bottom};
      text-align: ${alignX};
      color: ${color};
      font-family: ${fontFamily};
      font-size: ${fontSize}px;
      line-height: 1.35;
      font-weight: ${bold};
      font-style: ${italic};
      text-shadow: ${textShadow};
    }
  `;
}

function ensureOverlay(lineCount) {
  overlay.simpleMode();
  overlay.setStyle(buildOverlayStyle(lineCount));
  overlayReady = true;
  debugLog("overlay ready");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeText(text) {
  if (!text) return "";
  let cleaned = text.replace(/\{\\.*?\}/g, "");
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  return cleaned.trim();
}

function refreshConfig() {
  const provider = preferences.get("provider") || "deepseek";
  const model =
    preferences.get("model") ||
    PROVIDERS[provider]?.models?.[0] ||
    PROVIDERS.deepseek.models[0];
  const apiKey = preferences.get("apiKey") || "";
  const baseUrl = PROVIDERS[provider]?.baseUrl || PROVIDERS.deepseek.baseUrl;
  const debug = Boolean(preferences.get("debug"));
  config = { provider, model, apiKey, baseUrl, debug };
  debugLog(`config provider=${provider} model=${model} key=${apiKey ? "yes" : "no"}`);
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

async function postJson(url, headers, payload) {
  debugLog(`http post ${url}`);
  if (typeof http.post === "function") {
    try {
      return http.post(url, {
        headers,
        data: payload
      });
    } catch (error) {
      debugLog(`http exception ${String(error)}`);
      throw error;
    }
  }
  throw new Error("HTTP module does not support POST requests.");
}

async function translateText(text, context) {
  const { provider, model, apiKey, baseUrl } = config;
  if (typeof http === "undefined") {
    debugLog("http module missing");
  }
  debugLog(`http type request=${typeof http.request} post=${typeof http.post}`);

  if (!apiKey) {
    if (!missingKeyNotified) {
      debugLog("missing api key");
      missingKeyNotified = true;
    }
    return "";
  }
  missingKeyNotified = false;

  const cacheKey = `${provider}|${model}|${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    debugLog("translate cache hit");
    return cached;
  }
  debugLog(`translate request (${provider}/${model}) len=${text.length}`);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Prev: ${(context || "(none)").slice(0, 60)}\n` +
        `Now: ${text}\n` +
        "Only return the Chinese translation of the current line."
    }
  ];

  let response;
  try {
    response = await postJson(`${baseUrl}/chat/completions`, {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
  }, {
    model,
    messages,
    temperature: 1.3,
    max_tokens: 128
  });
  } catch (error) {
    debugLog(`http post failed: ${String(error)}`);
    return "";
  }

  if (!response) {
    debugLog("http response empty");
    return "";
  }
  const status = response?.statusCode ?? response?.status;
  debugLog(`http response status=${status ?? "n/a"} reason=${response?.reason || ""}`);
  if (status && status >= 400) {
    const now = Date.now();
    if (now - lastErrorNotifyAt > 8000) {
      lastErrorNotifyAt = now;
    }
    debugLog(`http status ${status}`);
    return "";
  }

  const payload = response?.data ?? response?.text ?? response;
  debugLog(`http payload type=${typeof payload}`);
  let data = payload;
  if (typeof payload === "string") {
    debugLog(`http payload length=${payload.length}`);
    try {
      data = JSON.parse(payload);
    } catch (error) {
      debugLog(`json parse error: ${String(error)}`);
      return "";
    }
  }
  if (data?.error?.message) {
    const now = Date.now();
    if (now - lastErrorNotifyAt > 8000) {
      lastErrorNotifyAt = now;
    }
    debugLog(`api error ${data.error.message}`);
    return "";
  }
  const translated = (data?.choices?.[0]?.message?.content || "").trim();
  debugLog(`translate ok length=${translated.length} text="${translated.slice(0, 120)}"`);

  if (translated) {
    cacheSet(cacheKey, translated);
  }
  return translated;
}

function renderTranslation(text) {
  if (!overlayReady) {
    pendingTranslation = text || "";
    debugLog("overlay not ready, queue render");
    return;
  }
  if (!text) {
    overlay.hide();
    lastRenderedText = "";
    return;
  }
  ensureOverlay(1);
  lastRenderedAt = Date.now();
  lastRenderedText = text;
  const html = `<div id="subtranslator">${escapeHtml(text).replace(/\n/g, "<br/>")}</div>`;
  overlay.setContent(html);
  overlay.show();
  debugLog(`render ok len=${text.length} snippet="${text.slice(0, 40)}"`);
}

async function handleSubtitleChange() {
  if (lastRequestId > 0 && lastRequestId % 5 === 0) {
    debugLog(`memory cache size=${cache.size}`);
  }
  const raw =
    mpv.getString("sub-text") ||
    mpv.getString("sub-text-ass") ||
    "";
  debugLog(`raw subtitle len=${raw.length} snippet="${raw.slice(0, 80)}"`);
  const normalized = normalizeText(raw);
  debugLog(`normalized len=${normalized.length} snippet="${normalized.slice(0, 80)}"`);
  if (!normalized) {
    debugLog("normalized empty, skip");
    lastOriginal = "";
    const since = Date.now() - lastRenderedAt;
    if (lastRenderedText && since < HIDE_GRACE_MS) {
      debugLog(`keep overlay (grace ${since}ms)`);
    } else {
      renderTranslation("");
    }
    return;
  }

  const lineCount = Math.max(1, normalized.split("\n").length);
  ensureOverlay(lineCount);
  if (normalized === lastOriginal) {
    debugLog("subtitle unchanged, skip");
    return;
  }
  lastOriginal = normalized;
  debugLog(`subtitle changed: ${normalized.slice(0, 60)}`);

  const requestId = ++lastRequestId;
  const context = lastContext;
  lastContext = normalized;

  try {
    const translated = await translateText(normalized, context);
    if (requestId !== lastRequestId) return;
    renderTranslation(translated);
  } catch (error) {
    if (requestId !== lastRequestId) return;
    renderTranslation("");
    debugLog(`translate exception ${String(error)}`);
  }
}

function resetState() {
  lastOriginal = "";
  lastContext = "";
  lastRequestId = 0;
  renderTranslation("");
}

event.on("iina.file-loaded", () => {
  refreshConfig();
  resetState();
});
event.on("iina.file-unloaded", resetState);
event.on("mpv.sub-text.changed", handleSubtitleChange);
event.on("mpv.sid.changed", () => {
  debugLog("subtitle track changed");
  lastOriginal = "";
  lastContext = "";
  ensureOverlay(1);
  handleSubtitleChange();
});

event.on("iina.plugin-overlay-loaded", () => {
  ensureOverlay(1);
  if (pendingTranslation) {
    renderTranslation(pendingTranslation);
    pendingTranslation = "";
  }
});

event.on("iina.window-loaded", () => {
  refreshConfig();
  ensureOverlay(1);
  handleSubtitleChange();
  if (!pollTimer) {
    pollTimer = setInterval(handleSubtitleChange, 500);
  }
});
