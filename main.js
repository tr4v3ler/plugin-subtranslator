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
  "You are a professional subtitle translator. Translate ONLY the current line into Simplified Chinese. " +
  "Use the previous line as context if provided. Return only the translation text, no extra notes.";

const MAX_CACHE_ENTRIES = 200;
const overlayStyle = `
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
    bottom: 12%;
    text-align: center;
    color: #fff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    font-size: 22px;
    line-height: 1.35;
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

function ensureOverlay() {
  overlay.simpleMode();
  overlay.setStyle(overlayStyle);
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
  const body = JSON.stringify(payload);
  if (typeof http.request === "function") {
    try {
      return http.request({
        method: "POST",
        url,
        headers,
        body,
        data: body,
        timeout: 30000
      });
    } catch (error) {
      debugLog(`http exception ${String(error)}`);
      throw error;
    }
  }
  if (typeof http.post === "function") {
    try {
      return http.post(url, {
        headers,
        body,
        data: body,
        timeout: 30000
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
        `Previous line (context): ${context || "(none)"}\n` +
        `Current line: ${text}\n` +
        "Return only the Chinese translation of the current line."
    }
  ];

  const response = await postJson(`${baseUrl}/chat/completions`, {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  }, {
    model,
    messages,
    temperature: 1.3
  });

  if (!response) {
    debugLog("http response empty");
    return "";
  }
  const status = response?.status ?? response?.statusCode;
  debugLog(`http response status=${status ?? "n/a"}`);
  if (status && status >= 400) {
    const now = Date.now();
    if (now - lastErrorNotifyAt > 8000) {
      lastErrorNotifyAt = now;
    }
    debugLog(`http status ${status}`);
    return "";
  }

  const payload = response?.data ?? response?.body ?? response;
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (data?.error?.message) {
    const now = Date.now();
    if (now - lastErrorNotifyAt > 8000) {
      lastErrorNotifyAt = now;
    }
    debugLog(`api error ${data.error.message}`);
    return "";
  }
  const translated = (data?.choices?.[0]?.message?.content || "").trim();
  debugLog(`translate ok length=${translated.length}`);

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
    return;
  }
  ensureOverlay();
  const html = `<div id="subtranslator">${escapeHtml(text).replace(/\n/g, "<br/>")}</div>`;
  overlay.setContent(html);
  overlay.show();
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
    renderTranslation("");
    return;
  }

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
    debugLog(`translate exception ${error?.message || "unknown"}`);
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
  handleSubtitleChange();
});

event.on("iina.plugin-overlay-loaded", () => {
  ensureOverlay();
  if (pendingTranslation) {
    renderTranslation(pendingTranslation);
    pendingTranslation = "";
  }
});

event.on("iina.window-loaded", () => {
  refreshConfig();
  ensureOverlay();
  handleSubtitleChange();
  if (!pollTimer) {
    pollTimer = setInterval(handleSubtitleChange, 500);
  }
});
