const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { exec } = require("child_process");
const WebSocket = require("ws");
require("dotenv").config();

const PORT = 49382;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const TWITCH_BOT_ACCESS_TOKEN = process.env.TWITCH_BOT_ACCESS_TOKEN || "";
const TWITCH_BOT_USER_ID = process.env.TWITCH_BOT_USER_ID || "";
const TWITCH_BOT_LOGIN = process.env.TWITCH_BOT_LOGIN || "SucatasBot";
const DEFAULT_REDEMPTION_NAME = "Abrir Carta de Pelucia";
const DEFAULT_REWARD_COST = 1;
const DEFAULT_REWARD_COLOR = "#9147FF";
const DEFAULT_REWARD_ENABLED = true;
const TWITCH_POLL_INTERVAL_MS = 2000;
const TWITCH_REDIRECT_URI =
  process.env.TWITCH_REDIRECT_URI ||
  `http://localhost:${PORT}/api/twitch/callback`;
const PROJECT_ROOT_DIR = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT_DIR, "public");
const PUBLIC_COMPONENTS_DIR = path.join(PUBLIC_DIR, "components");
const PUBLIC_STYLES_DIR = path.join(PUBLIC_DIR, "styles");

// Usar caminho persistente no AppData para funcionar tanto em dev quanto no build Electron
const AUTH_CACHE_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || "", ".config"),
  "SucatasBot",
);
const AUTH_CACHE_FILE = path.join(AUTH_CACHE_DIR, "twitch-auth.json");
const RUNTIME_DATA_DIR = path.join(AUTH_CACHE_DIR, "runtime");
const RUNTIME_IMGS_DIR = path.join(RUNTIME_DATA_DIR, "imgs");
const RUNTIME_AUDIO_DIR = path.join(RUNTIME_DATA_DIR, "audio");
const CARD_STYLE_FILE = path.join(RUNTIME_DATA_DIR, "card-style.json");
const REDEMPTIONS_LOG_FILE = path.join(RUNTIME_DATA_DIR, "redems.txt");
const LEGACY_REDEMPTIONS_LOG_FILE = path.join(RUNTIME_DATA_DIR, "resgates.txt");
const IMPORTED_ITEMS_FILE = path.join(RUNTIME_DATA_DIR, "importedItems.json");
const LEGACY_IMPORTED_ITEMS_FILE = path.join(
  RUNTIME_DATA_DIR,
  "importedItems.txt",
);
const CREATED_REWARDS_FILE = path.join(RUNTIME_DATA_DIR, "createdRewards.json");
const COMMANDS_FILE = path.join(RUNTIME_DATA_DIR, "commands.json");
const ITEMS_UPLOAD_DIR = path.join(RUNTIME_IMGS_DIR, "items");
const LEGACY_PLUSHIES_UPLOAD_DIR = path.join(RUNTIME_IMGS_DIR, "plushies");
const SOUND_EFFECTS_UPLOAD_DIR = path.join(RUNTIME_AUDIO_DIR, "effects");
const BUNDLED_IMGS_DIR = path.join(PROJECT_ROOT_DIR, "imgs");
const GACHAPON_REWARD_TYPE = "gachapon";
const SOUND_EFFECT_REWARD_TYPE = "soundEffect";
const SOUND_EFFECT_TAG = "[soundEffect]";
const PUBLIC_FILES = new Set([
  "commands.html",
  "importItems.html",
  "cardCustomization.html",
  "controlPanel.html",
  "overlay.html",
  "cardReward.html",
  "soundEffects.html",
  "twitchCallback.html",
]);

const twitchState = {
  running: false,
  config: null,
  intervalId: null,
  lastError: null,
  lastRewardFound: null,
  lastTriggerAt: null,
  seenRedemptions: new Set(),
  oauthState: null,
  rewardId: null,
  monitorStartedAt: null,
};

const pendingChatByDrawId = new Map();

const chatListenerState = {
  desired: false,
  socket: null,
  reconnectTimeoutId: null,
  channelLogin: "",
  nickLogin: "",
};

const DEFAULT_CARD_STYLE_CONFIG = {
  "--pack-main": "#1f356d",
  "--pack-accent": "#4b73f9",
  "--pack-edge": "#8ca3ff",
  "--pack-label": "#f5f8ff",
  "--card-main": "#211e31",
  "--card-accent": "#465de0",
  "--card-edge": "#9fb4ff",
  "--card-text": "#ffffff",
  packLabel: "SUCATAS PACK",
  packImageData: "",
  cardImageData: "",
  packSwingCount: 2,
  packRevealDelayMs: 1800,
  cardVisibleMs: 4000,
};

function ensureAuthCacheDir() {
  if (!fs.existsSync(AUTH_CACHE_DIR)) {
    fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true });
  }
}

function ensureRuntimeDirs() {
  const requiredDirs = [
    AUTH_CACHE_DIR,
    RUNTIME_DATA_DIR,
    RUNTIME_IMGS_DIR,
    RUNTIME_AUDIO_DIR,
    ITEMS_UPLOAD_DIR,
    LEGACY_PLUSHIES_UPLOAD_DIR,
    SOUND_EFFECTS_UPLOAD_DIR,
  ];

  for (const dirPath of requiredDirs) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}

function ensureUploadDir() {
  ensureRuntimeDirs();
}

function loadCachedAuth() {
  try {
    if (!fs.existsSync(AUTH_CACHE_FILE)) return null;
    const raw = fs.readFileSync(AUTH_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.accessToken || !parsed.broadcasterId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function loadCachedRawConfig() {
  try {
    if (!fs.existsSync(AUTH_CACHE_FILE)) return null;
    const raw = fs.readFileSync(AUTH_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getClientCredentials() {
  const cached = loadCachedRawConfig();
  const clientId = String(TWITCH_CLIENT_ID || cached?.clientId || "").trim();
  const clientSecret = String(
    TWITCH_CLIENT_SECRET || cached?.clientSecret || "",
  ).trim();
  return { clientId, clientSecret };
}

function saveCachedAuth(authData) {
  ensureAuthCacheDir();
  const existing = loadCachedRawConfig() || {};
  fs.writeFileSync(
    AUTH_CACHE_FILE,
    JSON.stringify({ ...existing, ...authData }, null, 2),
    "utf8",
  );
}

function clearCachedAuth() {
  if (fs.existsSync(AUTH_CACHE_FILE)) {
    fs.unlinkSync(AUTH_CACHE_FILE);
  }
}

function clearCachedTwitchSession() {
  ensureAuthCacheDir();
  const cached = loadCachedRawConfig() || {};

  const next = {
    ...cached,
    broadcasterId: "",
    login: "",
    displayName: "",
    profileImageUrl: "",
    accessToken: "",
    refreshToken: "",
    connectedAt: "",
    expiresIn: 0,
    scope: [],
    tokenType: "",
  };

  fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify(next, null, 2), "utf8");
}

function saveRewardConfig(rewardConfig) {
  ensureAuthCacheDir();
  const existing = loadCachedRawConfig() || {};
  fs.writeFileSync(
    AUTH_CACHE_FILE,
    JSON.stringify(
      {
        ...existing,
        rewardName: String(rewardConfig.rewardName || "").trim(),
        rewardCost: parseRewardCost(rewardConfig.rewardCost),
        rewardColor: parseRewardColor(rewardConfig.rewardColor),
        rewardEnabled: parseRewardEnabled(rewardConfig.rewardEnabled),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function loadRewardConfigFromCache() {
  try {
    const cached = loadCachedRawConfig();
    if (!cached || typeof cached !== "object") return null;

    const rewardName = String(cached.rewardName || "").trim();
    const rewardCost = parseRewardCost(cached.rewardCost);
    const rewardColor = parseRewardColor(cached.rewardColor);
    const rewardEnabled = parseRewardEnabled(cached.rewardEnabled);

    if (!rewardName) return null;

    return {
      rewardName,
      rewardCost,
      rewardColor,
      rewardEnabled,
    };
  } catch {
    return null;
  }
}

function toNumberPercent(value) {
  const n = parseFloat(String(value).replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

function parseRewardCost(value, fallback = DEFAULT_REWARD_COST) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000000);
}

function parseRewardColor(value, fallback = DEFAULT_REWARD_COLOR) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(raw)) {
    return raw;
  }
  return fallback;
}

function parseRewardEnabled(value, fallback = DEFAULT_REWARD_ENABLED) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "on", "enabled"].includes(normalized)) return true;
    if (["false", "0", "off", "disabled"].includes(normalized)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function parseVolume(value, fallback = 0.8) {
  const numeric = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(Math.max(numeric, 0), 1);
}

function sanitizeHex(value, fallback) {
  const normalized = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : fallback;
}

function sanitizeImageData(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!normalized.startsWith("data:image/")) return "";
  return normalized.length <= 8_000_000 ? normalized : "";
}

function sanitizeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function normalizeCardStyleConfig(raw) {
  const parsed = raw && typeof raw === "object" ? raw : {};

  return {
    "--pack-main": sanitizeHex(
      parsed["--pack-main"],
      DEFAULT_CARD_STYLE_CONFIG["--pack-main"],
    ),
    "--pack-accent": sanitizeHex(
      parsed["--pack-accent"],
      DEFAULT_CARD_STYLE_CONFIG["--pack-accent"],
    ),
    "--pack-edge": sanitizeHex(
      parsed["--pack-edge"],
      DEFAULT_CARD_STYLE_CONFIG["--pack-edge"],
    ),
    "--pack-label": sanitizeHex(
      parsed["--pack-label"],
      DEFAULT_CARD_STYLE_CONFIG["--pack-label"],
    ),
    "--card-main": sanitizeHex(
      parsed["--card-main"],
      DEFAULT_CARD_STYLE_CONFIG["--card-main"],
    ),
    "--card-accent": sanitizeHex(
      parsed["--card-accent"],
      DEFAULT_CARD_STYLE_CONFIG["--card-accent"],
    ),
    "--card-edge": sanitizeHex(
      parsed["--card-edge"],
      DEFAULT_CARD_STYLE_CONFIG["--card-edge"],
    ),
    "--card-text": sanitizeHex(
      parsed["--card-text"],
      DEFAULT_CARD_STYLE_CONFIG["--card-text"],
    ),
    packLabel: String(
      parsed.packLabel || DEFAULT_CARD_STYLE_CONFIG.packLabel,
    ).slice(0, 80),
    packImageData: sanitizeImageData(parsed.packImageData),
    cardImageData: sanitizeImageData(parsed.cardImageData),
    packSwingCount: sanitizeInteger(
      parsed.packSwingCount,
      DEFAULT_CARD_STYLE_CONFIG.packSwingCount,
      1,
      12,
    ),
    packRevealDelayMs: sanitizeInteger(
      parsed.packRevealDelayMs,
      DEFAULT_CARD_STYLE_CONFIG.packRevealDelayMs,
      200,
      15000,
    ),
    cardVisibleMs: sanitizeInteger(
      parsed.cardVisibleMs,
      DEFAULT_CARD_STYLE_CONFIG.cardVisibleMs,
      400,
      30000,
    ),
  };
}

function loadCardStyleConfig() {
  try {
    ensureRuntimeDirs();
    if (!fs.existsSync(CARD_STYLE_FILE)) {
      return { ...DEFAULT_CARD_STYLE_CONFIG };
    }

    const raw = fs.readFileSync(CARD_STYLE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeCardStyleConfig(parsed);
  } catch {
    return { ...DEFAULT_CARD_STYLE_CONFIG };
  }
}

function saveCardStyleConfig(config) {
  ensureRuntimeDirs();
  const normalized = normalizeCardStyleConfig(config);
  fs.writeFileSync(
    CARD_STYLE_FILE,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

function createItemId() {
  return `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDrawId(prefix = "draw") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function migrateRuntimeDataFiles() {
  ensureRuntimeDirs();

  if (
    !fs.existsSync(REDEMPTIONS_LOG_FILE) &&
    fs.existsSync(LEGACY_REDEMPTIONS_LOG_FILE)
  ) {
    try {
      fs.renameSync(LEGACY_REDEMPTIONS_LOG_FILE, REDEMPTIONS_LOG_FILE);
    } catch {
      const legacyLog = fs.readFileSync(LEGACY_REDEMPTIONS_LOG_FILE, "utf8");
      fs.writeFileSync(REDEMPTIONS_LOG_FILE, legacyLog, "utf8");
    }
  }

  if (fs.existsSync(LEGACY_IMPORTED_ITEMS_FILE)) {
    try {
      const legacyRaw = fs.readFileSync(LEGACY_IMPORTED_ITEMS_FILE, "utf8");
      const legacyParsed = JSON.parse(legacyRaw);
      const legacyNormalized = normalizeImportedItems(legacyParsed);

      // So migra quando o legado realmente contem itens validos.
      if (!legacyNormalized.length) {
        return;
      }

      let currentNormalized = [];
      if (fs.existsSync(IMPORTED_ITEMS_FILE)) {
        try {
          const currentRaw = fs.readFileSync(IMPORTED_ITEMS_FILE, "utf8");
          const currentParsed = JSON.parse(currentRaw);
          currentNormalized = normalizeImportedItems(currentParsed);
        } catch {
          currentNormalized = [];
        }
      }

      if (!currentNormalized.length) {
        fs.writeFileSync(
          IMPORTED_ITEMS_FILE,
          `${JSON.stringify(legacyNormalized, null, 2)}\n`,
          "utf8",
        );
      }

      fs.unlinkSync(LEGACY_IMPORTED_ITEMS_FILE);
    } catch (err) {
      console.error(
        `[ITEMS] erro ao migrar importedItems.txt para importedItems.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function normalizeSingleItem(rawItem, fallback = {}) {
  return {
    id: String(rawItem?.id || fallback.id || createItemId()).trim(),
    name: String(rawItem?.name || fallback.name || "").trim(),
    chance: toNumberPercent(rawItem?.chance ?? fallback.chance ?? 0),
    image: String(rawItem?.image || fallback.image || "").trim(),
  };
}

function isValidItem(item) {
  return Boolean(item.id && item.name && item.image);
}

function loadImportedItemsFromFile() {
  try {
    migrateRuntimeDataFiles();

    if (!fs.existsSync(IMPORTED_ITEMS_FILE)) {
      fs.writeFileSync(IMPORTED_ITEMS_FILE, "[]\n", "utf8");
      return [];
    }

    const raw = fs.readFileSync(IMPORTED_ITEMS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizeImportedItems(parsed);

    // Backfill de IDs para itens antigos sem id.
    if (Array.isArray(parsed) && normalized.length === parsed.length) {
      const hasMissingId = parsed.some(
        (item) => !String(item?.id || "").trim(),
      );
      if (hasMissingId) {
        saveImportedItemsToFile(normalized);
      }
    }

    return normalized;
  } catch (err) {
    console.error(
      `[ITEMS] erro ao carregar importedItems.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function saveImportedItemsToFile(items) {
  fs.writeFileSync(
    IMPORTED_ITEMS_FILE,
    `${JSON.stringify(items, null, 2)}\n`,
    "utf8",
  );
}

let importedItems = loadImportedItemsFromFile();

ensureRuntimeDirs();
migrateRuntimeDataFiles();

function normalizeImportedItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];

  return rawItems
    .map((item) => normalizeSingleItem(item))
    .filter((item) => isValidItem(item))
    .map((item) => ({
      ...item,
      chance: Number.isFinite(item.chance) && item.chance > 0 ? item.chance : 0,
    }));
}

function tryDeleteUploadedImage(imagePath) {
  const relativePath = String(imagePath || "").trim();
  const isItemsPath = relativePath.startsWith("/imgs/items/");
  const isLegacyPlushiesPath = relativePath.startsWith("/imgs/plushies/");
  if (!isItemsPath && !isLegacyPlushiesPath) return;

  const relativeInsideImgs = relativePath.slice("/imgs/".length);
  const absolutePath = path.resolve(RUNTIME_IMGS_DIR, relativeInsideImgs);
  const itemsRoot = path.resolve(ITEMS_UPLOAD_DIR);
  const plushiesRoot = path.resolve(LEGACY_PLUSHIES_UPLOAD_DIR);
  if (
    !absolutePath.startsWith(itemsRoot) &&
    !absolutePath.startsWith(plushiesRoot)
  ) {
    return;
  }

  if (fs.existsSync(absolutePath)) {
    fs.unlink(absolutePath, () => {});
  }
}

function parseDataUrlImage(imageDataUrl) {
  const match =
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(
      String(imageDataUrl || ""),
    );

  if (!match) {
    throw new Error("Imagem invalida. Selecione uma foto valida.");
  }

  const rawExt = match[1].toLowerCase();
  const ext = rawExt === "jpeg" ? "jpg" : rawExt;
  const base64 = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");

  if (!buffer.length) {
    throw new Error("Imagem vazia.");
  }

  return { ext, buffer };
}

function parseDataUrlAudio(audioDataUrl) {
  const match =
    /^data:audio\/(mpeg|mp3|wav|x-wav|ogg|webm|mp4|aac);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(
      String(audioDataUrl || ""),
    );

  if (!match) {
    throw new Error("Audio invalido. Selecione um arquivo de audio valido.");
  }

  const rawExt = match[1].toLowerCase();
  const extByType = {
    mpeg: "mp3",
    mp3: "mp3",
    wav: "wav",
    "x-wav": "wav",
    ogg: "ogg",
    webm: "webm",
    mp4: "m4a",
    aac: "aac",
  };
  const ext = extByType[rawExt] || "mp3";
  const base64 = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");

  if (!buffer.length) {
    throw new Error("Audio vazio.");
  }

  return { ext, buffer };
}

function pickRandomWeightedItem(items) {
  if (!items || items.length === 0) return null;

  const total = items.reduce((acc, item) => acc + (item.chance || 0), 0);
  if (total <= 0) {
    return items[Math.floor(Math.random() * items.length)];
  }

  const rand = Math.random() * total;
  let acc = 0;
  for (const item of items) {
    acc += item.chance || 0;
    if (rand <= acc) return item;
  }

  return items[items.length - 1];
}

function broadcastJson(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function triggerOverlayFromPlushies(source = "manual", options = {}) {
  const item = pickRandomWeightedItem(importedItems);
  if (!item) {
    throw new Error("Nenhum plushie disponivel para disparar");
  }

  const drawId = String(options.drawId || "").trim() || createDrawId("overlay");

  broadcastJson({
    type: "gacha",
    drawId,
    item,
    source,
  });

  twitchState.lastTriggerAt = new Date().toISOString();
  return { item, drawId };
}

function formatTimestampUtcMinus3Parts(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return { datePart: "", timePart: "" };
  }

  // UTC-3 sem depender do timezone local da maquina.
  const utcMinus3Ms = date.getTime() - 3 * 60 * 60 * 1000;
  const shifted = new Date(utcMinus3Ms);
  const iso = shifted.toISOString();

  return {
    datePart: iso.slice(0, 10),
    timePart: iso.slice(11, 19),
  };
}

function formatTimestampUtcMinus3(dateInput) {
  const { datePart, timePart } = formatTimestampUtcMinus3Parts(dateInput);
  if (!datePart || !timePart) {
    return "";
  }
  return `${datePart} ${timePart}`;
}

function appendRedemptionLogLine(userName, plushieName) {
  const timestamp = formatTimestampUtcMinus3(new Date());
  const safeUser = String(userName || "desconhecido").trim() || "desconhecido";
  const safePlushie =
    String(plushieName || "desconhecida").trim() || "desconhecida";
  const line = `${timestamp} | ${safeUser} | ${safePlushie}\n`;

  fs.appendFile(REDEMPTIONS_LOG_FILE, line, (err) => {
    if (err) {
      console.error(`[TWITCH] erro ao gravar log de resgate: ${err.message}`);
    }
  });
}

function appendSoundEffectRedemptionLogLine(userName, rewardName) {
  const timestamp = formatTimestampUtcMinus3(new Date());
  const safeUser = String(userName || "desconhecido").trim() || "desconhecido";
  const safeReward = String(rewardName || "efeito").trim() || "efeito";
  const line = `${timestamp} | ${safeUser} | ${SOUND_EFFECT_TAG} ${safeReward}\n`;

  fs.appendFile(REDEMPTIONS_LOG_FILE, line, (err) => {
    if (err) {
      console.error(
        `[TWITCH] erro ao gravar log de sound effect: ${err.message}`,
      );
    }
  });
}

function parseRedemptionLogLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;

  const parts = trimmed.split("|").map((part) => part.trim());
  if (parts.length < 3) return null;

  const [rawTimestamp, userName, itemNameRaw] = parts;
  const isSoundEffect = String(itemNameRaw || "").startsWith(
    `${SOUND_EFFECT_TAG} `,
  );
  const itemName = isSoundEffect
    ? String(itemNameRaw || "")
        .slice(`${SOUND_EFFECT_TAG} `.length)
        .trim()
    : itemNameRaw;

  let datePart = "";
  let timePart = "";

  const plainMatch = String(rawTimestamp || "")
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);

  if (plainMatch) {
    datePart = plainMatch[1];
    timePart = plainMatch[2];
  } else {
    const parsed = formatTimestampUtcMinus3Parts(rawTimestamp);
    datePart = parsed.datePart;
    timePart = parsed.timePart;
  }

  if (!datePart || !timePart) {
    datePart = String(rawTimestamp || "").slice(0, 10);
    timePart = String(rawTimestamp || "").slice(11, 19);
  }

  return {
    timestamp: rawTimestamp,
    date: datePart,
    time: timePart,
    user: userName,
    item: itemName,
    type: isSoundEffect ? SOUND_EFFECT_REWARD_TYPE : GACHAPON_REWARD_TYPE,
    display: `${datePart} ${timePart} ${userName} - ${itemName}`,
  };
}

function loadRedemptionsLogEntries(filterType = null) {
  try {
    migrateRuntimeDataFiles();
    if (!fs.existsSync(REDEMPTIONS_LOG_FILE)) {
      return [];
    }

    const raw = fs.readFileSync(REDEMPTIONS_LOG_FILE, "utf8");
    const entries = raw
      .split(/\r?\n/)
      .map(parseRedemptionLogLine)
      .filter(Boolean)
      .reverse();

    if (!filterType) {
      return entries;
    }

    return entries.filter((entry) => entry.type === filterType);
  } catch (err) {
    console.error(
      `[TWITCH] erro ao ler redems.txt: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8_000_000) {
        reject(new Error("Payload muito grande"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON invalido"));
      }
    });
    req.on("error", reject);
  });
}

function getSafeTwitchStatus() {
  const credentials = getClientCredentials();
  const config = twitchState.config
    ? {
        ...twitchState.config,
        accessToken: twitchState.config.accessToken
          ? `${twitchState.config.accessToken.slice(0, 6)}...`
          : "",
      }
    : null;

  const cached = loadCachedAuth();
  const auth = cached
    ? {
        broadcasterId: cached.broadcasterId,
        login: cached.login,
        displayName: cached.displayName,
        profileImageUrl: String(
          cached.profileImageUrl || cached.profile_image_url || "",
        ).trim(),
        connectedAt: cached.connectedAt,
      }
    : null;

  const cachedRewardConfig = loadRewardConfigFromCache();

  return {
    running: twitchState.running,
    config,
    envConfigured: Boolean(credentials.clientId && credentials.clientSecret),
    redemptionName:
      twitchState.config?.rewardName ||
      cachedRewardConfig?.rewardName ||
      twitchState.lastRewardFound ||
      DEFAULT_REDEMPTION_NAME,
    rewardCost:
      (twitchState.config?.rewardCost && twitchState.config.rewardCost > 0
        ? twitchState.config.rewardCost
        : 0) ||
      (cachedRewardConfig?.rewardCost && cachedRewardConfig.rewardCost > 0
        ? cachedRewardConfig.rewardCost
        : 0) ||
      DEFAULT_REWARD_COST,
    rewardColor:
      twitchState.config?.rewardColor ||
      cachedRewardConfig?.rewardColor ||
      DEFAULT_REWARD_COLOR,
    rewardEnabled:
      typeof twitchState.config?.rewardEnabled === "boolean"
        ? twitchState.config.rewardEnabled
        : typeof cachedRewardConfig?.rewardEnabled === "boolean"
          ? cachedRewardConfig.rewardEnabled
          : DEFAULT_REWARD_ENABLED,
    pollIntervalMs: TWITCH_POLL_INTERVAL_MS,
    chatSender: TWITCH_BOT_USER_ID
      ? {
          mode: "bot",
          login: TWITCH_BOT_LOGIN,
          userId: TWITCH_BOT_USER_ID,
        }
      : {
          mode: "broadcaster",
          login: auth?.login || "",
          userId: auth?.broadcasterId || "",
        },
    auth,
    queueSize: twitchState.seenRedemptions.size,
    lastRewardFound: twitchState.lastRewardFound,
    lastTriggerAt: twitchState.lastTriggerAt,
    lastError: twitchState.lastError,
  };
}

function createTwitchAuthorizeUrl() {
  const credentials = getClientCredentials();
  const state = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  twitchState.oauthState = state;

  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", TWITCH_REDIRECT_URI);
  url.searchParams.set(
    "scope",
    "channel:read:redemptions channel:manage:redemptions user:write:chat chat:read",
  );
  url.searchParams.set("state", state);
  url.searchParams.set("force_verify", "true");
  return url.toString();
}

async function exchangeCodeForToken(code) {
  const credentials = getClientCredentials();
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: TWITCH_REDIRECT_URI,
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Falha no token Twitch: ${JSON.stringify(data)}`);
  }

  return data;
}

async function fetchAuthenticatedUser(clientId, accessToken) {
  const res = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      "Client-Id": clientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await res.json();
  if (!res.ok || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error(`Falha ao ler usuario Twitch: ${JSON.stringify(data)}`);
  }

  return data.data[0];
}

async function handleTwitchOAuthCallback(req, res) {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  const code = requestUrl.searchParams.get("code") || "";
  const state = requestUrl.searchParams.get("state") || "";
  const error = requestUrl.searchParams.get("error");

  if (error) {
    res.writeHead(302, {
      Location: "/twitchCallback.html?status=error&message=login_cancelado",
    });
    res.end();
    return;
  }

  if (!code || !state || state !== twitchState.oauthState) {
    res.writeHead(302, {
      Location: "/twitchCallback.html?status=error&message=state_invalido",
    });
    res.end();
    return;
  }

  try {
    const credentials = getClientCredentials();
    const tokenData = await exchangeCodeForToken(code);
    const user = await fetchAuthenticatedUser(
      credentials.clientId,
      tokenData.access_token,
    );

    saveCachedAuth({
      clientId: credentials.clientId,
      broadcasterId: user.id,
      login: user.login,
      displayName: user.display_name,
      profileImageUrl: user.profile_image_url,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      connectedAt: new Date().toISOString(),
      expiresIn: tokenData.expires_in,
      scope: tokenData.scope,
      tokenType: tokenData.token_type,
    });

    res.writeHead(302, {
      Location:
        "/twitchCallback.html?status=success&message=conectado_com_sucesso",
    });
    res.end();
  } catch {
    res.writeHead(302, {
      Location: "/twitchCallback.html?status=error&message=falha_no_callback",
    });
    res.end();
  }
}

async function twitchApiRequest(url, config, options = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Client-Id": config.clientId,
      Authorization: `Bearer ${config.accessToken}`,
      ...(options.body
        ? { "Content-Type": "application/json; charset=utf-8" }
        : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`Twitch API ${res.status}: ${text}`);
    error.status = res.status;

    if (res.status === 401) {
      invalidateTwitchSession(error.message);
    }

    throw error;
  }

  return res.json();
}

async function sendChatMessage(config, message) {
  const senderId = String(
    config.chatSenderId || config.broadcasterId || "",
  ).trim();
  const senderToken = String(
    config.chatAccessToken || config.accessToken || "",
  ).trim();

  if (!senderId || !senderToken) {
    throw new Error("Sender do chat nao configurado (id/token)");
  }

  const res = await fetch("https://api.twitch.tv/helix/chat/messages", {
    method: "POST",
    headers: {
      "Client-Id": config.clientId,
      Authorization: `Bearer ${senderToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      broadcaster_id: config.broadcasterId,
      sender_id: senderId,
      message: String(message || "").trim(),
    }),
  });

  const response = await res.json();

  if (!res.ok) {
    throw new Error(
      `Falha ao enviar mensagem no chat: ${JSON.stringify(response)}`,
    );
  }

  if (response?.data?.[0]?.is_sent === false) {
    const dropReason =
      response.data[0].drop_reason?.message || "mensagem nao enviada";
    throw new Error(`Falha ao enviar mensagem no chat: ${dropReason}`);
  }
}

function sendIrcChatMessage(rawMessage) {
  const socket = chatListenerState.socket;
  const channelLogin = String(chatListenerState.channelLogin || "").trim();
  const message = String(rawMessage || "").trim();

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  if (!channelLogin || !message) {
    return false;
  }

  socket.send(`PRIVMSG #${channelLogin} :${message}`);
  return true;
}

async function sendChatCommandMessage(config, rawCommand) {
  const command = String(rawCommand || "").trim();
  if (!command) {
    return;
  }

  if (!command.startsWith("/")) {
    await sendChatMessage(config, command);
    return;
  }

  const sentByIrc = sendIrcChatMessage(command);
  if (sentByIrc) {
    return;
  }

  // Fallback: Twitch usually recognizes dot-commands in regular chat flow.
  await sendChatMessage(config, `.${command.slice(1)}`);
}

async function sendRedemptionMessageToChat(config, userName, itemName) {
  const safeUser = String(userName || "viewer").trim() || "viewer";
  const safeItem =
    String(itemName || "item surpresa").trim() || "item surpresa";
  const message = `@${safeUser} resgatou e tirou: ${safeItem}!`;

  await sendChatMessage(config, message);
}

async function ensureRewardExists(config) {
  const rewardsUrl = new URL(
    "https://api.twitch.tv/helix/channel_points/custom_rewards",
  );
  rewardsUrl.searchParams.set("broadcaster_id", config.broadcasterId);

  const rewardsData = await twitchApiRequest(rewardsUrl.toString(), config);
  const rewards = Array.isArray(rewardsData.data) ? rewardsData.data : [];
  logRewardsList(rewards, config.rewardName);

  const existingReward = rewards.find(
    (r) =>
      normalizeRewardName(r.title) === normalizeRewardName(config.rewardName),
  );

  if (existingReward) {
    console.log(
      `[TWITCH] reward encontrado: id=${existingReward.id} title="${existingReward.title}"`,
    );
    twitchState.lastRewardFound = existingReward.title;
    twitchState.rewardId = existingReward.id;
    return existingReward;
  }

  console.log(
    `[TWITCH] reward nao encontrado para "${config.rewardName}". Tentando criar...`,
  );

  const createdData = await twitchApiRequest(rewardsUrl.toString(), config, {
    method: "POST",
    body: {
      title: config.rewardName,
      prompt: "Dispara uma carta de pelucia no overlay",
      cost: parseRewardCost(config.rewardCost),
      background_color: parseRewardColor(config.rewardColor),
      is_enabled: parseRewardEnabled(config.rewardEnabled),
      is_user_input_required: false,
    },
  });

  const created = Array.isArray(createdData.data) ? createdData.data[0] : null;
  if (!created || !created.id) {
    throw new Error("Nao foi possivel criar o resgate configurado");
  }

  console.log(
    `[TWITCH] reward criado: id=${created.id} title="${created.title}"`,
  );

  twitchState.lastRewardFound = created.title;
  twitchState.rewardId = created.id;
  return created;
}

async function deleteRewardById(config, rewardId) {
  const id = String(rewardId || "").trim();
  if (!id) return;

  const deleteUrl = new URL(
    "https://api.twitch.tv/helix/channel_points/custom_rewards",
  );
  deleteUrl.searchParams.set("broadcaster_id", config.broadcasterId);
  deleteUrl.searchParams.set("id", id);

  const res = await fetch(deleteUrl.toString(), {
    method: "DELETE",
    headers: {
      "Client-Id": config.clientId,
      Authorization: `Bearer ${config.accessToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao apagar reward anterior (${res.status}): ${text}`);
  }
}

async function createReward(
  config,
  rewardName,
  rewardCost,
  rewardColor,
  rewardEnabled,
) {
  const title = String(rewardName || "").trim();
  if (!title) {
    throw new Error("Informe um nome de resgate valido");
  }

  const rewardsUrl = new URL(
    "https://api.twitch.tv/helix/channel_points/custom_rewards",
  );
  rewardsUrl.searchParams.set("broadcaster_id", config.broadcasterId);

  const createdData = await twitchApiRequest(rewardsUrl.toString(), config, {
    method: "POST",
    body: {
      title,
      prompt: "Dispara uma carta de pelucia no overlay",
      cost: parseRewardCost(rewardCost),
      background_color: parseRewardColor(rewardColor),
      is_enabled: parseRewardEnabled(rewardEnabled, config.rewardEnabled),
      is_user_input_required: false,
    },
  });

  const created = Array.isArray(createdData.data) ? createdData.data[0] : null;
  if (!created || !created.id) {
    throw new Error("Nao foi possivel criar o novo resgate");
  }

  return created;
}

async function replaceReward(
  config,
  nextRewardName,
  nextRewardCost,
  nextRewardColor,
  nextRewardEnabled,
) {
  const newName = String(nextRewardName || "").trim();
  if (!newName) {
    throw new Error("Informe um nome de resgate valido");
  }

  const rewardsUrl = new URL(
    "https://api.twitch.tv/helix/channel_points/custom_rewards",
  );
  rewardsUrl.searchParams.set("broadcaster_id", config.broadcasterId);

  const rewardsData = await twitchApiRequest(rewardsUrl.toString(), config);
  const rewards = Array.isArray(rewardsData.data) ? rewardsData.data : [];

  const oldById = twitchState.rewardId
    ? rewards.find((r) => r.id === twitchState.rewardId)
    : null;
  const oldByName = rewards.find(
    (r) =>
      normalizeRewardName(r.title) === normalizeRewardName(config.rewardName),
  );
  const oldReward = oldById || oldByName;

  if (oldReward?.id) {
    await deleteRewardById(config, oldReward.id);
    console.log(
      `[TWITCH] reward removido: id=${oldReward.id} title="${oldReward.title}"`,
    );
  }

  const created = await createReward(
    config,
    newName,
    parseRewardCost(nextRewardCost, config.rewardCost),
    parseRewardColor(nextRewardColor, config.rewardColor),
    parseRewardEnabled(nextRewardEnabled, config.rewardEnabled),
  );
  console.log(
    `[TWITCH] reward criado apos alteracao: id=${created.id} title="${created.title}"`,
  );

  config.rewardName = created.title;
  config.rewardCost = parseRewardCost(nextRewardCost, config.rewardCost);
  config.rewardColor = parseRewardColor(nextRewardColor, config.rewardColor);
  config.rewardEnabled = parseRewardEnabled(
    nextRewardEnabled,
    config.rewardEnabled,
  );
  twitchState.rewardId = created.id;
  twitchState.lastRewardFound = created.title;
  return created;
}

async function updateRewardEnabled(config, enabled) {
  const reward = await ensureRewardExists(config);

  const updateUrl = new URL(
    "https://api.twitch.tv/helix/channel_points/custom_rewards",
  );
  updateUrl.searchParams.set("broadcaster_id", config.broadcasterId);
  updateUrl.searchParams.set("id", reward.id);

  await twitchApiRequest(updateUrl.toString(), config, {
    method: "PATCH",
    body: {
      is_enabled: parseRewardEnabled(enabled, DEFAULT_REWARD_ENABLED),
    },
  });

  config.rewardEnabled = parseRewardEnabled(enabled, DEFAULT_REWARD_ENABLED);
}

async function listAllRewards(config) {
  const rewardsUrl = new URL(
    "https://api.twitch.tv/helix/channel_points/custom_rewards",
  );
  rewardsUrl.searchParams.set("broadcaster_id", config.broadcasterId);

  const rewardsData = await twitchApiRequest(rewardsUrl.toString(), config);
  return Array.isArray(rewardsData.data) ? rewardsData.data : [];
}

async function updateRewardById(config, rewardId, nextData) {
  const id = String(rewardId || "").trim();
  if (!id) {
    throw new Error("Reward invalido");
  }

  const updateUrl = new URL(
    "https://api.twitch.tv/helix/channel_points/custom_rewards",
  );
  updateUrl.searchParams.set("broadcaster_id", config.broadcasterId);
  updateUrl.searchParams.set("id", id);

  const response = await twitchApiRequest(updateUrl.toString(), config, {
    method: "PATCH",
    body: {
      title: String(nextData?.title || "").trim(),
      cost: parseRewardCost(nextData?.cost, DEFAULT_REWARD_COST),
      background_color: parseRewardColor(nextData?.color, DEFAULT_REWARD_COLOR),
      is_enabled: parseRewardEnabled(
        nextData?.isEnabled,
        DEFAULT_REWARD_ENABLED,
      ),
    },
  });

  const updated = Array.isArray(response.data) ? response.data[0] : null;
  if (!updated || !updated.id) {
    throw new Error("Nao foi possivel atualizar o sound effect");
  }

  return updated;
}

function normalizeRewardName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeCommandName(name) {
  return String(name || "")
    .replace(/^!+/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

const SYSTEM_COMMAND_DEFINITIONS = [
  {
    key: "cmd",
    name: "cmd",
    responsePreview:
      "Gerencia comandos personalizados: add, remove, edit e alias.",
    allowCustomText: false,
    defaultText: "",
  },
  {
    key: "s2",
    name: "s2",
    responsePreview:
      "Mensagem configuravel para divulgar outro streamer informado em ${user}.",
    allowCustomText: true,
    defaultText:
      "Acompanhe também o Streamer ${user}, que estará ao vivo em https://www.twitch.tv/${user}",
  },
];

function getSystemCommandDefinitionByKey(key) {
  const normalizedKey = String(key || "").trim();
  return (
    SYSTEM_COMMAND_DEFINITIONS.find((entry) => entry.key === normalizedKey) ||
    null
  );
}

function getSystemCommandDefinitionByToken(token) {
  const normalized = sanitizeCommandToken(token);
  return (
    SYSTEM_COMMAND_DEFINITIONS.find(
      (entry) => sanitizeCommandToken(entry.name) === normalized,
    ) || null
  );
}

function sanitizeCommandToken(token) {
  return normalizeCommandName(token).replace(/[^a-z0-9_]+/g, "");
}

function parseAliasTokens(rawAliases) {
  if (Array.isArray(rawAliases)) {
    return rawAliases;
  }

  return String(rawAliases || "")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeCommandAliases(rawAliases, commandName) {
  const normalizedName = sanitizeCommandToken(commandName);
  const seen = new Set([normalizedName]);

  return parseAliasTokens(rawAliases)
    .map((alias) => sanitizeCommandToken(alias))
    .filter(Boolean)
    .filter((alias) => {
      if (seen.has(alias)) {
        return false;
      }
      seen.add(alias);
      return true;
    });
}

function getCommandTokens(command) {
  const normalized = normalizeCommandEntry(command);
  return [normalized.name, ...normalized.aliases];
}

function normalizeSystemCommandEntry(rawEntry, definition) {
  const base = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  const commandName = sanitizeCommandToken(definition?.name || "");
  const allowCustomText = Boolean(definition?.allowCustomText);
  const defaultText = String(definition?.defaultText || "").trim();

  return {
    key: String(definition?.key || "").trim(),
    name: commandName,
    aliases: normalizeCommandAliases(base.aliases, commandName),
    enabled:
      typeof base.enabled === "boolean"
        ? base.enabled
        : parseRewardEnabled(base.enabled, true),
    allowCustomText,
    text: allowCustomText
      ? String(base.text || defaultText).trim() || defaultText
      : "",
    defaultText,
    responsePreview: String(definition?.responsePreview || "").trim(),
  };
}

function getSystemCommandTokens(command) {
  const name = sanitizeCommandToken(command?.name || "");
  const aliases = normalizeCommandAliases(command?.aliases, name);
  return [name, ...aliases].filter(Boolean);
}

function buildDefaultSystemCommands() {
  return SYSTEM_COMMAND_DEFINITIONS.map((definition) =>
    normalizeSystemCommandEntry({}, definition),
  );
}

function ensureUniqueSystemAliases(commands, blockedTokens = new Set()) {
  const used = new Set(blockedTokens);
  for (const command of commands) {
    const name = sanitizeCommandToken(command.name);
    used.add(name);

    const uniqueAliases = [];
    for (const alias of normalizeCommandAliases(command.aliases, name)) {
      if (used.has(alias)) {
        continue;
      }
      used.add(alias);
      uniqueAliases.push(alias);
    }
    command.aliases = uniqueAliases;
  }
  return commands;
}

function normalizeCommandVariables(rawVariables) {
  const base =
    rawVariables && typeof rawVariables === "object" ? rawVariables : {};
  const count = Number.parseInt(String(base.count ?? 0), 10);
  return {
    ...base,
    count: Number.isFinite(count) && count >= 0 ? count : 0,
  };
}

function normalizeCommandEntry(entry, fallback = {}) {
  const base = entry && typeof entry === "object" ? entry : {};
  const fallbackBase = fallback && typeof fallback === "object" ? fallback : {};

  const rawName = String(base.name || fallbackBase.name || "").trim();
  const normalizedName = sanitizeCommandToken(rawName);

  return {
    id: String(
      base.id ||
        fallbackBase.id ||
        `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ).trim(),
    name: normalizedName,
    aliases: normalizeCommandAliases(
      base.aliases != null ? base.aliases : fallbackBase.aliases,
      normalizedName,
    ),
    text: String(base.text || fallbackBase.text || "").trim(),
    enabled:
      typeof base.enabled === "boolean"
        ? base.enabled
        : typeof fallbackBase.enabled === "boolean"
          ? fallbackBase.enabled
          : true,
    variables: normalizeCommandVariables(
      base.variables || fallbackBase.variables,
    ),
  };
}

function isValidCommandEntry(entry) {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    String(entry.id || "").trim() &&
    String(entry.name || "").trim(),
  );
}

function normalizeCommandsRegistry(rawPayload) {
  const rawCommands = Array.isArray(rawPayload?.commands)
    ? rawPayload.commands
    : Array.isArray(rawPayload)
      ? rawPayload
      : [];

  const seenTokens = new Set();
  const commands = [];

  for (const rawEntry of rawCommands) {
    const normalized = normalizeCommandEntry(rawEntry);
    if (!isValidCommandEntry(normalized)) {
      continue;
    }

    if (seenTokens.has(normalized.name)) {
      continue;
    }

    const uniqueAliases = normalized.aliases.filter(
      (alias) => !seenTokens.has(alias),
    );
    normalized.aliases = uniqueAliases;

    seenTokens.add(normalized.name);
    uniqueAliases.forEach((alias) => seenTokens.add(alias));
    commands.push(normalized);
  }

  const rawSystemSource =
    rawPayload && typeof rawPayload === "object"
      ? rawPayload.systemCommands
      : null;

  const rawSystemByKey = Array.isArray(rawSystemSource)
    ? Object.fromEntries(
        rawSystemSource
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => [String(entry.key || "").trim(), entry]),
      )
    : rawSystemSource && typeof rawSystemSource === "object"
      ? rawSystemSource
      : null;

  let systemCommands = SYSTEM_COMMAND_DEFINITIONS.map((definition) => {
    const rawEntry = rawSystemByKey ? rawSystemByKey[definition.key] : null;
    return normalizeSystemCommandEntry(rawEntry, definition);
  });

  systemCommands = ensureUniqueSystemAliases(systemCommands, seenTokens);

  return {
    kind: "commands",
    updatedAt: String(rawPayload?.updatedAt || ""),
    commands,
    systemCommands,
  };
}

function loadCommandsRegistry() {
  ensureRuntimeDirs();

  if (!fs.existsSync(COMMANDS_FILE)) {
    return {
      kind: "commands",
      updatedAt: "",
      commands: [],
      systemCommands: buildDefaultSystemCommands(),
    };
  }

  try {
    const raw = fs.readFileSync(COMMANDS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeCommandsRegistry(parsed);
  } catch {
    return {
      kind: "commands",
      updatedAt: "",
      commands: [],
      systemCommands: buildDefaultSystemCommands(),
    };
  }
}

function saveCommandsRegistry(payload) {
  ensureRuntimeDirs();

  const normalized = normalizeCommandsRegistry(payload);
  const next = {
    kind: "commands",
    updatedAt: new Date().toISOString(),
    commands: normalized.commands,
    systemCommands: Object.fromEntries(
      normalized.systemCommands.map((entry) => [entry.key, entry]),
    ),
  };

  fs.writeFileSync(COMMANDS_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function listCommands() {
  return loadCommandsRegistry().commands;
}

function listSystemCommands() {
  return loadCommandsRegistry().systemCommands;
}

function upsertSystemCommandConfig(entry) {
  const registry = loadCommandsRegistry();
  const definition = getSystemCommandDefinitionByKey(entry?.key);
  if (!definition) {
    throw new Error("Comando padrao invalido");
  }

  const currentSystem = registry.systemCommands.find(
    (command) => command.key === definition.key,
  );

  const normalized = normalizeSystemCommandEntry(
    {
      ...currentSystem,
      ...entry,
      text: definition?.allowCustomText
        ? String(
            entry?.text || currentSystem?.text || definition?.defaultText || "",
          ).trim()
        : "",
    },
    definition,
  );

  const customTokenSet = new Set();
  registry.commands.forEach((command) => {
    getCommandTokens(command).forEach((token) => customTokenSet.add(token));
  });

  const requestedTokens = new Set(getSystemCommandTokens(normalized));
  const conflictWithCustom = [...requestedTokens].some((token) =>
    customTokenSet.has(token),
  );

  if (conflictWithCustom) {
    throw new Error(
      "Alias de comando padrao conflita com comando personalizado",
    );
  }

  const conflictWithOtherSystem = registry.systemCommands.some((command) => {
    if (command.key === normalized.key) {
      return false;
    }
    return getSystemCommandTokens(command).some((token) =>
      requestedTokens.has(token),
    );
  });

  if (conflictWithOtherSystem) {
    throw new Error(
      "Alias de comando padrao conflita com outro comando padrao",
    );
  }

  const index = registry.systemCommands.findIndex(
    (command) => command.key === normalized.key,
  );
  if (index >= 0) {
    registry.systemCommands[index] = normalized;
  } else {
    registry.systemCommands.push(normalized);
  }

  return saveCommandsRegistry(registry);
}

function upsertCommandEntry(entry) {
  const registry = loadCommandsRegistry();
  const normalized = normalizeCommandEntry(entry);

  if (!isValidCommandEntry(normalized)) {
    throw new Error("Comando invalido");
  }

  const normalizedId = String(normalized.id || "").trim();
  const requestedTokens = new Set(getCommandTokens(normalized));

  const conflictWithSystem = registry.systemCommands.some((command) =>
    getSystemCommandTokens(command).some((token) => requestedTokens.has(token)),
  );

  if (conflictWithSystem) {
    throw new Error("Nome ou alias conflita com comando padrao");
  }

  const duplicateByToken = registry.commands.find((command) => {
    const commandId = String(command.id || "").trim();
    if (commandId === normalizedId) {
      return false;
    }

    return getCommandTokens(command).some((token) =>
      requestedTokens.has(token),
    );
  });

  if (duplicateByToken) {
    throw new Error("Nome ou alias ja esta em uso por outro comando");
  }

  const index = registry.commands.findIndex(
    (command) => String(command.id || "").trim() === normalized.id,
  );

  if (index >= 0) {
    registry.commands[index] = normalized;
  } else {
    registry.commands.push(normalized);
  }

  return saveCommandsRegistry(registry);
}

function removeCommandEntry(commandId) {
  const id = String(commandId || "").trim();
  if (!id) {
    throw new Error("Informe o id do comando");
  }

  const registry = loadCommandsRegistry();
  registry.commands = registry.commands.filter(
    (command) => String(command.id || "").trim() !== id,
  );
  return saveCommandsRegistry(registry);
}

function decodeTemplateScriptSource(encodedScript) {
  const raw = String(encodedScript || "");
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function decodeTemplateLiteralContent(rawLiteral, quoteChar) {
  const raw = String(rawLiteral || "");

  if (quoteChar === '"') {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }

  return raw.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function applyTemplateScopeValue(rawText, scope) {
  return String(rawText || "").replace(
    /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
    (_match, key) => {
      const value = scope[key];
      if (value == null) return "";
      return String(value);
    },
  );
}

function resolveUserVariableFromChat(sender, fullMessage, argsText) {
  const rawSender = String(sender || "").trim() || "viewer";
  const message = String(fullMessage || "");
  const args = String(argsText || "").trim();

  // 1) Se houver @algumNome em qualquer parte da mensagem, prioriza esse nome.
  const atMatch = message.match(/@([a-zA-Z0-9_]+)/);
  if (atMatch && atMatch[1]) {
    return atMatch[1];
  }

  // 2) Sem @, pega o primeiro token depois do comando.
  if (args) {
    const firstArg = args.split(/\s+/).find(Boolean) || "";
    const cleaned = String(firstArg)
      .replace(/^[^a-zA-Z0-9_]+/, "")
      .replace(/[^a-zA-Z0-9_]+$/, "");
    if (cleaned) {
      return cleaned;
    }
  }

  // 3) Se foi só o comando, usa o sender.
  return rawSender;
}

async function asyncReplace(inputText, regex, asyncReplacer) {
  const text = String(inputText || "");
  const matches = [];

  text.replace(regex, (...args) => {
    const match = args[0];
    const offset = args[args.length - 2];
    const groups = args.slice(1, -2);
    matches.push({ match, offset, groups });
    return match;
  });

  if (!matches.length) {
    return text;
  }

  const replacements = await Promise.all(
    matches.map((entry) => asyncReplacer(entry.match, ...entry.groups)),
  );

  let cursor = 0;
  let output = "";
  matches.forEach((entry, index) => {
    output += text.slice(cursor, entry.offset);
    output += replacements[index] == null ? "" : String(replacements[index]);
    cursor = entry.offset + entry.match.length;
  });
  output += text.slice(cursor);

  return output;
}

async function executeTemplateApiGet(rawUrlLiteral, quoteChar, scope) {
  const decodedUrl = decodeTemplateLiteralContent(rawUrlLiteral, quoteChar);
  const interpolatedUrl = applyTemplateScopeValue(decodedUrl, scope).trim();

  if (!interpolatedUrl) {
    throw new Error("url vazia");
  }

  let parsed;
  try {
    parsed = new URL(interpolatedUrl);
  } catch {
    throw new Error("url invalida");
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("protocolo nao permitido");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(parsed.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = String(
      response.headers.get("content-type") || "",
    ).toLowerCase();
    const isJson = contentType.includes("application/json");

    if (isJson) {
      const data = await response.json();
      if (data == null) return "";
      if (["string", "number", "boolean"].includes(typeof data)) {
        return String(data).slice(0, 500);
      }
      return JSON.stringify(data).slice(0, 500);
    }

    const text = await response.text();
    return String(text || "")
      .trim()
      .slice(0, 500);
  } finally {
    clearTimeout(timeoutId);
  }
}

function sanitizeScriptVariableValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;

  const valueType = typeof value;
  if (["string", "number", "boolean"].includes(valueType)) {
    return value;
  }

  try {
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length > 32_000) {
      return null;
    }
    return JSON.parse(encoded);
  } catch {
    return null;
  }
}

function executeTemplateScript(rawScript, context) {
  const scriptSource = decodeTemplateScriptSource(rawScript);
  const variables = normalizeCommandVariables(context.variables);

  const sandbox = {
    ...variables,
    streamer: context.streamer,
    sender: context.sender,
    user: context.user,
    count: variables.count,
    args: context.args,
    message: context.message,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
  };

  const reservedKeys = new Set([
    "streamer",
    "sender",
    "user",
    "args",
    "message",
    "Math",
    "Date",
    "Number",
    "String",
    "Boolean",
    "Array",
    "Object",
    "JSON",
    "parseInt",
    "parseFloat",
    "isFinite",
    "isNaN",
  ]);

  vm.createContext(sandbox);
  const wrapped = `(function(){\n${scriptSource}\n})()`;
  const result = new vm.Script(wrapped).runInContext(sandbox, { timeout: 250 });

  const nextVariables = {
    ...variables,
  };

  for (const [key, value] of Object.entries(sandbox)) {
    if (reservedKeys.has(key)) {
      continue;
    }

    const sanitized = sanitizeScriptVariableValue(value);
    if (sanitized !== null) {
      nextVariables[key] = sanitized;
    }
  }

  nextVariables.count = Number.parseInt(String(nextVariables.count ?? 0), 10);
  if (!Number.isFinite(nextVariables.count) || nextVariables.count < 0) {
    nextVariables.count = 0;
  }

  return {
    result,
    variables: nextVariables,
  };
}

async function renderCommandText(command, renderContext) {
  let variables = normalizeCommandVariables(command.variables);
  let text = String(command.text || "");

  text = text.replace(
    /\$\{script:\s*"((?:\\.|[^"\\])*)"\s*\}/g,
    (_match, rawScript) => {
      try {
        const scriptResult = executeTemplateScript(rawScript, {
          ...renderContext,
          variables,
        });
        variables = scriptResult.variables;
        return scriptResult.result == null ? "" : String(scriptResult.result);
      } catch (err) {
        return `[erro script: ${err instanceof Error ? err.message : String(err)}]`;
      }
    },
  );

  const scope = {
    ...variables,
    streamer: renderContext.streamer,
    sender: renderContext.sender,
    user: renderContext.user,
    count: Number.parseInt(String(variables.count ?? 0), 10) || 0,
  };

  text = await asyncReplace(
    text,
    /\$\{api:\s*(['"])((?:\\.|(?!\1).)*)\1\s*\}/g,
    async (_match, quoteChar, rawUrl) => {
      try {
        return await executeTemplateApiGet(rawUrl, quoteChar, scope);
      } catch (err) {
        return `[erro api: ${err instanceof Error ? err.message : String(err)}]`;
      }
    },
  );

  text = applyTemplateScopeValue(text, scope);

  return {
    text: text.trim(),
    variables,
  };
}

async function executeCommandFromChat(config, command, chatContext) {
  const normalized = normalizeCommandEntry(command);
  const baseVariables = normalizeCommandVariables(normalized.variables);
  const shouldIncrementCount = /\$\{\s*count\s*\}/.test(
    String(normalized.text || ""),
  );
  const nextVariables = {
    ...baseVariables,
    count: shouldIncrementCount ? baseVariables.count + 1 : baseVariables.count,
  };

  const rendered = await renderCommandText(
    {
      ...normalized,
      variables: nextVariables,
    },
    {
      streamer: chatContext.streamer,
      sender: chatContext.sender,
      user: chatContext.user,
      args: chatContext.args,
      message: chatContext.message,
    },
  );

  upsertCommandEntry({
    ...normalized,
    variables: rendered.variables,
  });

  if (!rendered.text) {
    return;
  }

  await sendChatMessage(config, rendered.text.slice(0, 500));
}

function findCustomCommandByToken(commands, token) {
  const normalized = sanitizeCommandToken(token);
  if (!normalized) return null;

  return (
    commands.find((command) => {
      const tokens = getCommandTokens(command);
      return tokens.includes(normalized);
    }) || null
  );
}

function parseCmdTargetAndText(rawInput) {
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(String(rawInput || "").trim());
  if (!match) return null;
  return {
    target: sanitizeCommandToken(match[1]),
    text: String(match[2] || "").trim(),
  };
}

async function executeCmdSystemCommand(config, chatContext) {
  const argsInput = String(chatContext.args || "").trim();
  if (!argsInput) {
    await sendChatMessage(
      config,
      "Uso: !cmd add/remove/edit/alias <nomeComando> ...",
    );
    return;
  }

  const actionMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argsInput);
  if (!actionMatch) {
    await sendChatMessage(
      config,
      "Uso: !cmd add/remove/edit/alias <nomeComando> ...",
    );
    return;
  }

  const action = String(actionMatch[1] || "")
    .trim()
    .toLowerCase();
  const payload = String(actionMatch[2] || "").trim();

  try {
    if (action === "add") {
      const parsed = parseCmdTargetAndText(payload);
      if (!parsed?.target || !parsed.text) {
        await sendChatMessage(config, "Uso: !cmd add <nomeComando> <texto>");
        return;
      }

      const existing = findCustomCommandByToken(listCommands(), parsed.target);
      if (existing) {
        await sendChatMessage(config, `Comando !${parsed.target} ja existe.`);
        return;
      }

      upsertCommandEntry({
        name: parsed.target,
        aliases: [],
        text: parsed.text,
        enabled: true,
        variables: { count: 0 },
      });
      await sendChatMessage(config, `Comando !${parsed.target} criado.`);
      return;
    }

    if (action === "remove") {
      const target = sanitizeCommandToken(payload);
      if (!target) {
        await sendChatMessage(config, "Uso: !cmd remove <nomeComando>");
        return;
      }

      const existing = findCustomCommandByToken(listCommands(), target);
      if (!existing) {
        await sendChatMessage(config, `Comando !${target} nao encontrado.`);
        return;
      }

      removeCommandEntry(existing.id);
      await sendChatMessage(config, `Comando !${existing.name} removido.`);
      return;
    }

    if (action === "edit") {
      const parsed = parseCmdTargetAndText(payload);
      if (!parsed?.target || !parsed.text) {
        await sendChatMessage(config, "Uso: !cmd edit <nomeComando> <texto>");
        return;
      }

      const existing = findCustomCommandByToken(listCommands(), parsed.target);
      if (!existing) {
        await sendChatMessage(
          config,
          `Comando !${parsed.target} nao encontrado.`,
        );
        return;
      }

      upsertCommandEntry({
        ...existing,
        text: parsed.text,
      });
      await sendChatMessage(config, `Comando !${existing.name} atualizado.`);
      return;
    }

    if (action === "alias") {
      const parsed = parseCmdTargetAndText(payload);
      if (!parsed?.target) {
        await sendChatMessage(
          config,
          "Uso: !cmd alias <nomeComando> <alias1> <alias2> ...",
        );
        return;
      }

      const existing = findCustomCommandByToken(listCommands(), parsed.target);
      if (!existing) {
        await sendChatMessage(
          config,
          `Comando !${parsed.target} nao encontrado.`,
        );
        return;
      }

      const nextAliases = [
        ...normalizeCommandAliases(existing.aliases, existing.name),
        ...normalizeCommandAliases(parsed.text, existing.name),
      ];

      upsertCommandEntry({
        ...existing,
        aliases: nextAliases,
      });

      const updated = findCustomCommandByToken(listCommands(), existing.name);
      const aliasesLabel = normalizeCommandAliases(
        updated?.aliases || [],
        existing.name,
      )
        .map((alias) => `!${alias}`)
        .join(", ");

      await sendChatMessage(
        config,
        aliasesLabel
          ? `Aliases de !${existing.name}: ${aliasesLabel}`
          : `Comando !${existing.name} sem aliases.`,
      );
      return;
    }

    await sendChatMessage(config, "Acoes validas: add, remove, edit, alias");
  } catch (err) {
    await sendChatMessage(
      config,
      `Erro no !cmd: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function executeTextSystemCommand(config, systemCommand, chatContext) {
  const rendered = await renderCommandText(
    {
      name: systemCommand.name,
      text: String(systemCommand.text || "").trim(),
      variables: { count: 0 },
    },
    {
      streamer: chatContext.streamer,
      sender: chatContext.sender,
      user: chatContext.user,
      args: chatContext.args,
      message: chatContext.message,
    },
  );

  const message = String(rendered.text || "").trim();
  if (message) {
    await sendChatMessage(config, message.slice(0, 500));
  }

  const isS2Command =
    String(systemCommand?.key || "").trim() === "s2" ||
    sanitizeCommandToken(systemCommand?.name || "") === "s2";

  if (!isS2Command) {
    return;
  }

  const shoutoutTarget =
    sanitizeCommandToken(chatContext?.user || "") ||
    sanitizeCommandToken(chatContext?.sender || "") ||
    "viewer";

  await sendChatCommandMessage(config, `/shoutout ${shoutoutTarget}`);
}

async function tryHandleChatCommand(config, senderName, messageText) {
  const message = String(messageText || "").trim();
  if (!message.startsWith("!")) {
    return;
  }

  const match = /^!(\S+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match) {
    return;
  }

  const requestedName = sanitizeCommandToken(match[1]);
  if (!requestedName) {
    return;
  }

  const registry = loadCommandsRegistry();

  const systemCommand = registry.systemCommands.find((entry) => {
    if (!entry.enabled) {
      return false;
    }

    return getSystemCommandTokens(entry).includes(requestedName);
  });

  if (systemCommand) {
    const definition = getSystemCommandDefinitionByToken(systemCommand.name);
    const cached = loadCachedAuth();
    const streamer = String(
      cached?.displayName || cached?.login || "streamer",
    ).trim();
    const sender = String(senderName || "viewer").trim() || "viewer";
    const args = String(match[2] || "").trim();
    const user = resolveUserVariableFromChat(sender, message, args);

    if (definition?.key === "cmd") {
      await executeCmdSystemCommand(config, {
        streamer,
        sender,
        user,
        args,
        message,
      });
      return;
    }

    if (definition?.allowCustomText) {
      await executeTextSystemCommand(config, systemCommand, {
        streamer,
        sender,
        user,
        args,
        message,
      });
      return;
    }

    return;
  }

  const command = registry.commands.find((entry) => {
    if (!entry.enabled) {
      return false;
    }

    const tokens = getCommandTokens(entry);
    return tokens.includes(requestedName);
  });

  if (!command) {
    return;
  }

  const cached = loadCachedAuth();
  const streamer = String(
    cached?.displayName || cached?.login || "streamer",
  ).trim();
  const sender = String(senderName || "viewer").trim() || "viewer";
  const args = String(match[2] || "").trim();
  const user = resolveUserVariableFromChat(sender, message, args);

  await executeCommandFromChat(config, command, {
    streamer,
    sender,
    user,
    args,
    message,
  });
}

function logRewardsList(rewards, targetName) {
  const titleList = rewards.map((r) => r.title);
  console.log(
    `[TWITCH] rewards (${rewards.length}) alvo="${targetName}": ${JSON.stringify(titleList)}`,
  );
}

function loadCreatedRewardsRegistry() {
  ensureRuntimeDirs();

  if (!fs.existsSync(CREATED_REWARDS_FILE)) {
    return { kind: "createdRewards", updatedAt: "", rewards: [] };
  }

  try {
    const raw = fs.readFileSync(CREATED_REWARDS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const rewards = Array.isArray(parsed?.rewards) ? parsed.rewards : [];
    return {
      kind: "createdRewards",
      updatedAt: String(parsed?.updatedAt || ""),
      rewards,
    };
  } catch {
    return { kind: "createdRewards", updatedAt: "", rewards: [] };
  }
}

function saveCreatedRewardsRegistryPayload(payload) {
  ensureRuntimeDirs();
  const normalized = {
    kind: "createdRewards",
    updatedAt: new Date().toISOString(),
    rewards: Array.isArray(payload?.rewards) ? payload.rewards : [],
  };

  fs.writeFileSync(
    CREATED_REWARDS_FILE,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
}

function upsertCreatedRewardEntry(entry) {
  const registry = loadCreatedRewardsRegistry();
  const id = String(entry?.id || "").trim();
  if (!id) {
    return;
  }

  const nextEntry = {
    ...entry,
    id,
    title: String(entry?.title || "").trim(),
    type: String(entry?.type || GACHAPON_REWARD_TYPE).trim(),
    updatedAt: new Date().toISOString(),
  };

  const index = registry.rewards.findIndex((reward) => reward.id === id);
  if (index >= 0) {
    registry.rewards[index] = {
      ...registry.rewards[index],
      ...nextEntry,
    };
  } else {
    registry.rewards.push(nextEntry);
  }

  saveCreatedRewardsRegistryPayload(registry);
}

function removeCreatedRewardEntryById(rewardId) {
  const id = String(rewardId || "").trim();
  if (!id) return;

  const registry = loadCreatedRewardsRegistry();
  registry.rewards = registry.rewards.filter((reward) => reward.id !== id);
  saveCreatedRewardsRegistryPayload(registry);
}

function getCreatedRewardsByType(type) {
  const normalizedType = String(type || "").trim();
  if (!normalizedType) return [];

  const registry = loadCreatedRewardsRegistry();
  return registry.rewards.filter(
    (reward) => String(reward?.type || "").trim() === normalizedType,
  );
}

function normalizeSoundEffectEntry(entry) {
  return {
    id: String(entry?.id || "").trim(),
    title: String(entry?.title || "").trim(),
    type: SOUND_EFFECT_REWARD_TYPE,
    managedBy: "system",
    broadcasterId: String(entry?.broadcasterId || "").trim(),
    cost: parseRewardCost(entry?.cost, DEFAULT_REWARD_COST),
    color: parseRewardColor(entry?.color, DEFAULT_REWARD_COLOR),
    isEnabled: parseRewardEnabled(entry?.isEnabled, DEFAULT_REWARD_ENABLED),
    prompt: String(entry?.prompt || "Dispara um efeito sonoro no overlay"),
    audioPath: String(entry?.audioPath || "").trim(),
    volume: parseVolume(entry?.volume, 0.8),
    updatedAt: String(entry?.updatedAt || ""),
  };
}

function buildTwitchConfigFromCache() {
  const cached = loadCachedAuth();
  const credentials = getClientCredentials();
  const rewardConfig = loadRewardConfigFromCache();

  return {
    clientId: String(credentials.clientId || "").trim(),
    broadcasterId: String(cached?.broadcasterId || "").trim(),
    accessToken: String(cached?.accessToken || "").trim(),
    chatSenderId: String(
      TWITCH_BOT_USER_ID || cached?.broadcasterId || "",
    ).trim(),
    chatAccessToken: String(
      TWITCH_BOT_ACCESS_TOKEN || cached?.accessToken || "",
    ).trim(),
    rewardName: String(
      rewardConfig?.rewardName || DEFAULT_REDEMPTION_NAME,
    ).trim(),
    rewardCost: parseRewardCost(rewardConfig?.rewardCost, DEFAULT_REWARD_COST),
    rewardColor: parseRewardColor(
      rewardConfig?.rewardColor,
      DEFAULT_REWARD_COLOR,
    ),
    rewardEnabled: parseRewardEnabled(
      rewardConfig?.rewardEnabled,
      DEFAULT_REWARD_ENABLED,
    ),
    pollIntervalMs: TWITCH_POLL_INTERVAL_MS,
  };
}

async function syncCreatedRewardsForConfig(config) {
  if (!config?.clientId || !config?.broadcasterId || !config?.accessToken) {
    return;
  }

  const trackedReward = await ensureRewardExists(config);
  upsertCreatedRewardEntry({
    id: String(trackedReward.id || "").trim(),
    title: String(trackedReward.title || "").trim(),
    type: GACHAPON_REWARD_TYPE,
    managedBy: "system",
    broadcasterId: String(config.broadcasterId || "").trim(),
    cost: Number.parseInt(String(trackedReward.cost ?? 0), 10) || 0,
    color: parseRewardColor(
      trackedReward.background_color,
      DEFAULT_REWARD_COLOR,
    ),
    isEnabled: Boolean(trackedReward.is_enabled),
    prompt: String(trackedReward.prompt || ""),
  });
}

function syncCreatedRewardsAtStartup() {
  const startupConfig = buildTwitchConfigFromCache();
  if (
    !startupConfig.clientId ||
    !startupConfig.broadcasterId ||
    !startupConfig.accessToken
  ) {
    return;
  }

  syncCreatedRewardsForConfig(startupConfig).catch((err) => {
    console.error(
      `[TWITCH] falha ao sincronizar createdRewards no startup: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

function trimSeenRedemptions(maxSize = 2000) {
  if (twitchState.seenRedemptions.size <= maxSize) return;
  const overflow = twitchState.seenRedemptions.size - maxSize;
  const iterator = twitchState.seenRedemptions.values();
  for (let i = 0; i < overflow; i += 1) {
    const next = iterator.next();
    if (next.done) break;
    twitchState.seenRedemptions.delete(next.value);
  }
}

async function processSoundEffectRedemptions(config) {
  const soundRewards = getCreatedRewardsByType(SOUND_EFFECT_REWARD_TYPE).map(
    normalizeSoundEffectEntry,
  );

  for (const soundReward of soundRewards) {
    if (!soundReward.id || !soundReward.audioPath) {
      continue;
    }

    const redemptionsUrl = new URL(
      "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions",
    );
    redemptionsUrl.searchParams.set("broadcaster_id", config.broadcasterId);
    redemptionsUrl.searchParams.set("reward_id", soundReward.id);
    redemptionsUrl.searchParams.set("status", "UNFULFILLED");
    redemptionsUrl.searchParams.set("first", "25");

    const redemptionsData = await twitchApiRequest(
      redemptionsUrl.toString(),
      config,
    );
    const redemptions = Array.isArray(redemptionsData.data)
      ? redemptionsData.data
      : [];

    redemptions.sort(
      (a, b) =>
        new Date(a.redeemed_at).getTime() - new Date(b.redeemed_at).getTime(),
    );

    for (const redemption of redemptions) {
      if (twitchState.seenRedemptions.has(redemption.id)) {
        continue;
      }

      const redemptionTime = new Date(redemption.redeemed_at);
      if (
        twitchState.monitorStartedAt &&
        redemptionTime < twitchState.monitorStartedAt
      ) {
        twitchState.seenRedemptions.add(redemption.id);
        trimSeenRedemptions();
        continue;
      }

      twitchState.seenRedemptions.add(redemption.id);
      trimSeenRedemptions();

      appendSoundEffectRedemptionLogLine(
        redemption.user_name,
        soundReward.title,
      );
      broadcastJson({
        type: "sound_effect",
        rewardId: soundReward.id,
        rewardName: soundReward.title,
        userName: redemption.user_name,
        audioUrl: soundReward.audioPath,
        volume: parseVolume(soundReward.volume, 0.8),
      });
    }
  }
}

function clearChatReconnectTimer() {
  if (chatListenerState.reconnectTimeoutId) {
    clearTimeout(chatListenerState.reconnectTimeoutId);
    chatListenerState.reconnectTimeoutId = null;
  }
}

function parseIrcTags(rawTags) {
  const map = {};
  const source = String(rawTags || "").trim();
  if (!source) return map;

  source.split(";").forEach((pair) => {
    const [key, value] = pair.split("=");
    if (!key) return;
    map[key] = value || "";
  });

  return map;
}

async function handleIncomingIrcPrivMsg(config, ircLine) {
  const match =
    /^(?:@([^ ]+) )?:([^!]+)![^ ]+ PRIVMSG #([^ ]+) :([\s\S]*)$/.exec(ircLine);
  if (!match) {
    return;
  }

  const tags = parseIrcTags(match[1]);
  const login = String(match[2] || "").trim();
  const message = String(match[4] || "");
  const displayName = String(tags["display-name"] || login || "").trim();
  const senderName = displayName || login;

  if (!senderName || !message) {
    return;
  }

  const hasDedicatedBotIdentity = Boolean(
    String(TWITCH_BOT_ACCESS_TOKEN || "").trim() &&
    String(TWITCH_BOT_USER_ID || "").trim(),
  );

  if (
    hasDedicatedBotIdentity &&
    chatListenerState.nickLogin &&
    login.toLowerCase() === chatListenerState.nickLogin
  ) {
    return;
  }

  try {
    await tryHandleChatCommand(config, senderName, message);
  } catch (err) {
    console.error(
      `[TWITCH] falha ao processar comando de chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function scheduleChatReconnect(config) {
  if (!chatListenerState.desired) {
    return;
  }

  clearChatReconnectTimer();
  chatListenerState.reconnectTimeoutId = setTimeout(() => {
    startChatListener(config);
  }, 5000);
}

function stopChatListener() {
  chatListenerState.desired = false;
  clearChatReconnectTimer();

  const socket = chatListenerState.socket;
  chatListenerState.socket = null;
  chatListenerState.channelLogin = "";
  chatListenerState.nickLogin = "";

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close(1000, "monitor-stopped");
  }
}

function startChatListener(config) {
  chatListenerState.desired = true;
  clearChatReconnectTimer();

  const cached = loadCachedAuth();
  const channelLogin = String(cached?.login || "")
    .trim()
    .toLowerCase();
  const token = String(
    config?.chatAccessToken || config?.accessToken || "",
  ).trim();
  const nick = String(
    TWITCH_BOT_ACCESS_TOKEN
      ? TWITCH_BOT_LOGIN
      : cached?.login || TWITCH_BOT_LOGIN || "sucatasbot",
  )
    .trim()
    .toLowerCase();

  if (!token || !channelLogin || !nick) {
    console.warn("[TWITCH] listener de chat nao iniciado: token/login ausente");
    return;
  }

  if (chatListenerState.socket) {
    try {
      chatListenerState.socket.close(1000, "restarting-chat-listener");
    } catch {
      // Ignora erro de close forçado.
    }
  }

  const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  chatListenerState.socket = socket;
  chatListenerState.channelLogin = channelLogin;
  chatListenerState.nickLogin = nick;

  socket.on("open", () => {
    const oauthToken = token.toLowerCase().startsWith("oauth:")
      ? token
      : `oauth:${token}`;

    socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    socket.send(`PASS ${oauthToken}`);
    socket.send(`NICK ${nick}`);
    socket.send(`JOIN #${channelLogin}`);
    console.log(`[TWITCH] listener de chat conectado em #${channelLogin}`);
  });

  socket.on("message", (data) => {
    const payload = String(data || "");
    const lines = payload.split("\r\n").filter(Boolean);

    for (const line of lines) {
      if (line.startsWith("PING ")) {
        socket.send(line.replace("PING", "PONG"));
        continue;
      }

      if (line.includes(" PRIVMSG ")) {
        handleIncomingIrcPrivMsg(config, line).catch(() => {});
      }
    }
  });

  socket.on("close", () => {
    if (chatListenerState.socket === socket) {
      chatListenerState.socket = null;
    }

    if (chatListenerState.desired) {
      scheduleChatReconnect(config);
    }
  });

  socket.on("error", (err) => {
    console.error(
      `[TWITCH] erro no listener de chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function pollTwitchRedemptions() {
  if (!twitchState.running || !twitchState.config) return;

  const config = twitchState.config;
  twitchState.lastError = null;

  try {
    let rewardId = String(twitchState.rewardId || "").trim();
    let rewardTitle = String(
      twitchState.lastRewardFound ||
        config.rewardName ||
        DEFAULT_REDEMPTION_NAME,
    ).trim();

    // Resolve reward apenas quando necessario (inicio/reconfiguracao).
    if (!rewardId) {
      const reward = await ensureRewardExists(config);
      rewardId = String(reward?.id || "").trim();
      rewardTitle = String(reward?.title || rewardTitle).trim();
    }

    if (!rewardId) {
      throw new Error("Reward de monitor nao encontrado");
    }

    const redemptionsUrl = new URL(
      "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions",
    );
    redemptionsUrl.searchParams.set("broadcaster_id", config.broadcasterId);
    redemptionsUrl.searchParams.set("reward_id", rewardId);
    redemptionsUrl.searchParams.set("status", "UNFULFILLED");
    redemptionsUrl.searchParams.set("first", "50");

    const redemptionsData = await twitchApiRequest(
      redemptionsUrl.toString(),
      config,
    );
    const redemptions = Array.isArray(redemptionsData.data)
      ? redemptionsData.data
      : [];
    redemptions.sort(
      (a, b) =>
        new Date(a.redeemed_at).getTime() - new Date(b.redeemed_at).getTime(),
    );

    for (const redemption of redemptions) {
      if (twitchState.seenRedemptions.has(redemption.id)) {
        continue;
      }

      // Ignorar resgates feitos antes do monitor iniciar
      const redemptionTime = new Date(redemption.redeemed_at);
      if (
        twitchState.monitorStartedAt &&
        redemptionTime < twitchState.monitorStartedAt
      ) {
        twitchState.seenRedemptions.add(redemption.id);
        trimSeenRedemptions();
        console.log(
          `[TWITCH] ignorando resgate antigo (antes do monitor iniciar): id=${redemption.id} user=${redemption.user_name}`,
        );
        continue;
      }

      twitchState.seenRedemptions.add(redemption.id);
      trimSeenRedemptions();
      console.log(
        `[TWITCH] disparando overlay para redemption id=${redemption.id} user=${redemption.user_name}`,
      );
      const { item: drawnItem, drawId } = triggerOverlayFromPlushies(
        "twitch-pelucia",
        { drawId: `redemption_${redemption.id}` },
      );
      appendRedemptionLogLine(redemption.user_name, drawnItem?.name);

      pendingChatByDrawId.set(drawId, {
        config,
        userName: redemption.user_name,
        itemName: drawnItem?.name,
      });
    }

    await processSoundEffectRedemptions(config);
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    // Se o reward id atual ficou invalido (ex.: reward removido externamente),
    // limpa cache para resolver novamente no proximo ciclo.
    if (/reward_id|custom_rewards|404|400/i.test(errMessage)) {
      twitchState.rewardId = null;
      twitchState.lastRewardFound = null;
    }
    twitchState.lastError = errMessage;
    console.error(`[TWITCH] erro no polling: ${twitchState.lastError}`);
  }
}

function stopTwitchMonitor() {
  if (twitchState.intervalId) {
    clearInterval(twitchState.intervalId);
  }

  stopChatListener();

  twitchState.running = false;
  twitchState.intervalId = null;
  twitchState.rewardId = null;
}

function resetTwitchSessionState(options = {}) {
  stopTwitchMonitor();
  twitchState.config = null;
  if (!options.preserveLastError) {
    twitchState.lastError = null;
  }
  twitchState.lastRewardFound = null;
  twitchState.lastTriggerAt = null;
  twitchState.oauthState = null;
  twitchState.monitorStartedAt = null;
  twitchState.seenRedemptions.clear();
  pendingChatByDrawId.clear();
}

function invalidateTwitchSession(reason = "Twitch API 401") {
  resetTwitchSessionState({ preserveLastError: true });
  clearCachedTwitchSession();
  twitchState.lastError = reason;
}

function startTwitchMonitor(config) {
  stopTwitchMonitor();

  twitchState.running = true;
  twitchState.config = config;
  saveRewardConfig(config);
  twitchState.lastError = null;
  twitchState.lastRewardFound = null;
  twitchState.rewardId = null;
  twitchState.monitorStartedAt = new Date();

  twitchState.intervalId = setInterval(
    pollTwitchRedemptions,
    TWITCH_POLL_INTERVAL_MS,
  );

  startChatListener(config);
  pollTwitchRedemptions();
}

function buildApiTwitchConfig() {
  const cached = loadCachedAuth();
  const credentials = getClientCredentials();

  return {
    clientId: String(credentials.clientId || "").trim(),
    broadcasterId: String(cached?.broadcasterId || "").trim(),
    accessToken: String(cached?.accessToken || "").trim(),
    chatSenderId: String(
      TWITCH_BOT_USER_ID || cached?.broadcasterId || "",
    ).trim(),
    chatAccessToken: String(
      TWITCH_BOT_ACCESS_TOKEN || cached?.accessToken || "",
    ).trim(),
  };
}

async function handleApiRoutes(req, res, cleanPath) {
  if (cleanPath === "/api/card-style" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      config: loadCardStyleConfig(),
    });
    return true;
  }

  if (cleanPath === "/api/card-style" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const config = saveCardStyleConfig(body);
      sendJson(res, 200, {
        ok: true,
        config,
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message:
          err instanceof Error ? err.message : "Erro ao salvar personalizacao",
      });
      return true;
    }
  }

  if (cleanPath === "/api/items" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      count: importedItems.length,
      items: importedItems,
    });
    return true;
  }

  if (cleanPath === "/api/items/add" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || "").trim();
      const chance = toNumberPercent(body.chance);

      if (!name) {
        sendJson(res, 400, { ok: false, message: "Informe o nome do item" });
        return true;
      }

      if (!(chance > 0)) {
        sendJson(res, 400, {
          ok: false,
          message: "Informe uma porcentagem maior que zero",
        });
        return true;
      }

      const { ext, buffer } = parseDataUrlImage(body.imageDataUrl);
      ensureUploadDir();

      const safeBaseName =
        name
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-zA-Z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase() || "item";

      const fileName = `${Date.now()}-${safeBaseName}.${ext}`;
      const absoluteImagePath = path.join(ITEMS_UPLOAD_DIR, fileName);
      fs.writeFileSync(absoluteImagePath, buffer);

      const item = {
        id: createItemId(),
        name,
        chance,
        image: `/imgs/items/${fileName}`,
      };

      importedItems = [...importedItems, item];
      saveImportedItemsToFile(importedItems);

      sendJson(res, 200, {
        ok: true,
        item,
        count: importedItems.length,
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err instanceof Error ? err.message : "Erro ao adicionar item",
      });
      return true;
    }
  }

  if (cleanPath === "/api/items/import" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const parsed = normalizeImportedItems(body.items);

      if (!parsed.length) {
        sendJson(res, 400, {
          ok: false,
          message: "Nenhum item valido recebido para importacao",
        });
        return true;
      }

      ensureRuntimeDirs();
      importedItems = parsed;
      saveImportedItemsToFile(importedItems);
      sendJson(res, 200, {
        ok: true,
        count: importedItems.length,
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err instanceof Error ? err.message : "Erro ao importar itens",
      });
      return true;
    }
  }

  if (cleanPath === "/api/items/update" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const itemId = String(body.id || "").trim();

      if (!itemId) {
        sendJson(res, 400, { ok: false, message: "Informe o id do item" });
        return true;
      }

      const index = importedItems.findIndex((item) => item.id === itemId);
      if (index < 0) {
        sendJson(res, 404, { ok: false, message: "Item nao encontrado" });
        return true;
      }

      const current = importedItems[index];
      const next = normalizeSingleItem(body, current);

      if (!(next.chance > 0)) {
        sendJson(res, 400, {
          ok: false,
          message: "Informe uma porcentagem maior que zero",
        });
        return true;
      }

      if (body.imageDataUrl) {
        const { ext, buffer } = parseDataUrlImage(body.imageDataUrl);
        ensureUploadDir();

        const safeBaseName =
          next.name
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-zA-Z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase() || "item";

        const fileName = `${Date.now()}-${safeBaseName}.${ext}`;
        const absoluteImagePath = path.join(ITEMS_UPLOAD_DIR, fileName);
        fs.writeFileSync(absoluteImagePath, buffer);

        tryDeleteUploadedImage(current.image);
        next.image = `/imgs/items/${fileName}`;
      }

      if (!isValidItem(next)) {
        sendJson(res, 400, {
          ok: false,
          message: "Dados invalidos para atualizar item",
        });
        return true;
      }

      importedItems[index] = next;
      saveImportedItemsToFile(importedItems);

      sendJson(res, 200, {
        ok: true,
        item: next,
        count: importedItems.length,
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err instanceof Error ? err.message : "Erro ao atualizar item",
      });
      return true;
    }
  }

  if (cleanPath === "/api/items/delete" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const itemId = String(body.id || "").trim();

      if (!itemId) {
        sendJson(res, 400, { ok: false, message: "Informe o id do item" });
        return true;
      }

      const index = importedItems.findIndex((item) => item.id === itemId);
      if (index < 0) {
        sendJson(res, 404, { ok: false, message: "Item nao encontrado" });
        return true;
      }

      const [removedItem] = importedItems.splice(index, 1);
      tryDeleteUploadedImage(removedItem?.image);
      saveImportedItemsToFile(importedItems);

      sendJson(res, 200, {
        ok: true,
        count: importedItems.length,
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err instanceof Error ? err.message : "Erro ao excluir item",
      });
      return true;
    }
  }

  if (cleanPath === "/api/sound-effects" && req.method === "GET") {
    const effects = getCreatedRewardsByType(SOUND_EFFECT_REWARD_TYPE).map(
      normalizeSoundEffectEntry,
    );
    const redemptions = loadRedemptionsLogEntries(SOUND_EFFECT_REWARD_TYPE);

    sendJson(res, 200, {
      ok: true,
      effects,
      redemptions,
      volume:
        effects.length > 0
          ? parseVolume(effects[0].volume, 0.8)
          : parseVolume(0.8, 0.8),
    });
    return true;
  }

  if (
    cleanPath === "/api/sound-effects/redemptions-log" &&
    req.method === "GET"
  ) {
    sendJson(res, 200, {
      ok: true,
      entries: loadRedemptionsLogEntries(SOUND_EFFECT_REWARD_TYPE),
    });
    return true;
  }

  if (cleanPath === "/api/sound-effects/add" && req.method === "POST") {
    try {
      const config = buildApiTwitchConfig();
      if (!config.clientId || !config.broadcasterId || !config.accessToken) {
        sendJson(res, 400, {
          ok: false,
          message: "Conecte com a Twitch antes de criar efeito sonoro",
        });
        return true;
      }

      const body = await readJsonBody(req);
      const title = String(body?.title || "Novo Efeito Sonoro").trim();
      const rewardsUrl = new URL(
        "https://api.twitch.tv/helix/channel_points/custom_rewards",
      );
      rewardsUrl.searchParams.set("broadcaster_id", config.broadcasterId);

      const createdData = await twitchApiRequest(
        rewardsUrl.toString(),
        config,
        {
          method: "POST",
          body: {
            title,
            prompt: "Toca um efeito sonoro no overlay",
            cost: parseRewardCost(body?.cost, DEFAULT_REWARD_COST),
            background_color: parseRewardColor(
              body?.color,
              DEFAULT_REWARD_COLOR,
            ),
            is_enabled: parseRewardEnabled(
              body?.isEnabled,
              DEFAULT_REWARD_ENABLED,
            ),
            is_user_input_required: false,
          },
        },
      );

      const created = Array.isArray(createdData.data)
        ? createdData.data[0]
        : null;
      if (!created || !created.id) {
        throw new Error("Nao foi possivel criar o sound effect");
      }

      upsertCreatedRewardEntry({
        id: created.id,
        title: created.title,
        type: SOUND_EFFECT_REWARD_TYPE,
        managedBy: "system",
        broadcasterId: config.broadcasterId,
        cost: parseRewardCost(created.cost, DEFAULT_REWARD_COST),
        color: parseRewardColor(created.background_color, DEFAULT_REWARD_COLOR),
        isEnabled: parseRewardEnabled(
          created.is_enabled,
          DEFAULT_REWARD_ENABLED,
        ),
        prompt: String(created.prompt || "Toca um efeito sonoro no overlay"),
        audioPath: "",
        volume: parseVolume(body?.volume, 0.8),
      });

      sendJson(res, 200, {
        ok: true,
        effect: normalizeSoundEffectEntry({
          id: created.id,
          title: created.title,
          type: SOUND_EFFECT_REWARD_TYPE,
          managedBy: "system",
          broadcasterId: config.broadcasterId,
          cost: created.cost,
          color: created.background_color,
          isEnabled: created.is_enabled,
          prompt: created.prompt,
          audioPath: "",
          volume: parseVolume(body?.volume, 0.8),
        }),
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message:
          err instanceof Error ? err.message : "Erro ao criar sound effect",
      });
      return true;
    }
  }

  if (cleanPath === "/api/sound-effects/update" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const effectId = String(body?.id || "").trim();
      if (!effectId) {
        sendJson(res, 400, { ok: false, message: "Informe o id do efeito" });
        return true;
      }

      const config = buildApiTwitchConfig();
      if (!config.clientId || !config.broadcasterId || !config.accessToken) {
        sendJson(res, 400, {
          ok: false,
          message: "Conecte com a Twitch antes de atualizar efeito sonoro",
        });
        return true;
      }

      const existing = normalizeSoundEffectEntry(
        getCreatedRewardsByType(SOUND_EFFECT_REWARD_TYPE).find(
          (effect) => String(effect?.id || "").trim() === effectId,
        ),
      );

      if (!existing.id) {
        sendJson(res, 404, { ok: false, message: "Efeito nao encontrado" });
        return true;
      }

      const updatedReward = await updateRewardById(config, effectId, {
        title: String(body?.title || existing.title || "").trim(),
        cost: parseRewardCost(body?.cost, existing.cost),
        color: parseRewardColor(body?.color, existing.color),
        isEnabled: parseRewardEnabled(body?.isEnabled, existing.isEnabled),
      });

      const updatedEntry = {
        ...existing,
        id: updatedReward.id,
        title: updatedReward.title,
        cost: parseRewardCost(updatedReward.cost, existing.cost),
        color: parseRewardColor(updatedReward.background_color, existing.color),
        isEnabled: parseRewardEnabled(
          updatedReward.is_enabled,
          existing.isEnabled,
        ),
        volume: parseVolume(body?.volume, existing.volume),
      };
      upsertCreatedRewardEntry(updatedEntry);

      sendJson(res, 200, {
        ok: true,
        effect: normalizeSoundEffectEntry(updatedEntry),
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message:
          err instanceof Error ? err.message : "Erro ao atualizar sound effect",
      });
      return true;
    }
  }

  if (cleanPath === "/api/sound-effects/upload" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const effectId = String(body?.id || "").trim();
      if (!effectId) {
        sendJson(res, 400, { ok: false, message: "Informe o id do efeito" });
        return true;
      }

      const effect = normalizeSoundEffectEntry(
        getCreatedRewardsByType(SOUND_EFFECT_REWARD_TYPE).find(
          (entry) => String(entry?.id || "").trim() === effectId,
        ),
      );
      if (!effect.id) {
        sendJson(res, 404, { ok: false, message: "Efeito nao encontrado" });
        return true;
      }

      const { ext, buffer } = parseDataUrlAudio(body?.audioDataUrl);
      ensureRuntimeDirs();

      const safeName =
        effect.title
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-zA-Z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase() || "sound-effect";

      const fileName = `${Date.now()}-${safeName}.${ext}`;
      const absolutePath = path.join(SOUND_EFFECTS_UPLOAD_DIR, fileName);
      fs.writeFileSync(absolutePath, buffer);

      const relativePath = `/audio/effects/${fileName}`;
      const next = {
        ...effect,
        audioPath: relativePath,
      };
      upsertCreatedRewardEntry(next);

      sendJson(res, 200, {
        ok: true,
        effect: normalizeSoundEffectEntry(next),
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err instanceof Error ? err.message : "Erro ao importar audio",
      });
      return true;
    }
  }

  if (cleanPath === "/api/sound-effects/volume" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const volume = parseVolume(body?.volume, 0.8);
      const current = getCreatedRewardsByType(SOUND_EFFECT_REWARD_TYPE).map(
        normalizeSoundEffectEntry,
      );

      current.forEach((effect) => {
        upsertCreatedRewardEntry({ ...effect, volume });
      });

      sendJson(res, 200, { ok: true, volume });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message:
          err instanceof Error ? err.message : "Erro ao atualizar volume",
      });
      return true;
    }
  }

  if (cleanPath === "/api/sound-effects/delete" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const effectId = String(body?.id || "").trim();
      if (!effectId) {
        sendJson(res, 400, { ok: false, message: "Informe o id do efeito" });
        return true;
      }

      const effect = normalizeSoundEffectEntry(
        getCreatedRewardsByType(SOUND_EFFECT_REWARD_TYPE).find(
          (entry) => String(entry?.id || "").trim() === effectId,
        ),
      );

      const config = buildApiTwitchConfig();
      if (
        effect.id &&
        config.clientId &&
        config.broadcasterId &&
        config.accessToken
      ) {
        await deleteRewardById(config, effect.id);
      }

      if (effect.audioPath && effect.audioPath.startsWith("/audio/effects/")) {
        const absolutePath = path.resolve(
          SOUND_EFFECTS_UPLOAD_DIR,
          effect.audioPath.slice("/audio/effects/".length),
        );
        if (
          absolutePath.startsWith(path.resolve(SOUND_EFFECTS_UPLOAD_DIR)) &&
          fs.existsSync(absolutePath)
        ) {
          fs.unlinkSync(absolutePath);
        }
      }

      removeCreatedRewardEntryById(effectId);

      sendJson(res, 200, { ok: true });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message:
          err instanceof Error ? err.message : "Erro ao excluir sound effect",
      });
      return true;
    }
  }

  if (cleanPath === "/api/commands" && req.method === "GET") {
    const registry = loadCommandsRegistry();
    const commands = registry.commands;
    sendJson(res, 200, {
      ok: true,
      personalizedCommands: commands,
      systemCommands: registry.systemCommands,
      commands,
      count: commands.length,
    });
    return true;
  }

  if (cleanPath === "/api/commands/system/update" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const saved = upsertSystemCommandConfig({
        key: body?.key,
        aliases: body?.aliases,
        text: body?.text,
        enabled:
          typeof body?.enabled === "boolean"
            ? body.enabled
            : parseRewardEnabled(body?.enabled, true),
      });

      sendJson(res, 200, {
        ok: true,
        personalizedCommands: saved.commands,
        systemCommands: saved.systemCommands,
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : "Erro ao atualizar comando padrao",
      });
      return true;
    }
  }

  if (cleanPath === "/api/commands/upsert" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const saved = upsertCommandEntry({
        id: body?.id,
        name: body?.name,
        aliases: body?.aliases,
        text: body?.text,
        enabled:
          typeof body?.enabled === "boolean"
            ? body.enabled
            : parseRewardEnabled(body?.enabled, true),
        variables: body?.variables,
      });

      sendJson(res, 200, {
        ok: true,
        commands: saved.commands,
        count: saved.commands.length,
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err instanceof Error ? err.message : "Erro ao salvar comando",
      });
      return true;
    }
  }

  if (cleanPath === "/api/commands/delete" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const saved = removeCommandEntry(body?.id);

      sendJson(res, 200, {
        ok: true,
        commands: saved.commands,
        count: saved.commands.length,
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err instanceof Error ? err.message : "Erro ao remover comando",
      });
      return true;
    }
  }

  if (cleanPath === "/api/twitch/status" && req.method === "GET") {
    sendJson(res, 200, getSafeTwitchStatus());
    return true;
  }

  if (cleanPath === "/api/twitch/redemptions-log" && req.method === "GET") {
    const entries = loadRedemptionsLogEntries(GACHAPON_REWARD_TYPE);
    sendJson(res, 200, {
      ok: true,
      count: entries.length,
      entries,
    });
    return true;
  }

  if (cleanPath === "/api/twitch/connect" && req.method === "GET") {
    const credentials = getClientCredentials();
    if (!credentials.clientId || !credentials.clientSecret) {
      sendJson(res, 500, {
        ok: false,
        message:
          "Defina TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET no cache inicial",
      });
      return true;
    }

    res.writeHead(302, { Location: createTwitchAuthorizeUrl() });
    res.end();
    return true;
  }

  if (cleanPath === "/api/twitch/logout" && req.method === "POST") {
    resetTwitchSessionState();
    clearCachedTwitchSession();
    sendJson(res, 200, { ok: true, status: getSafeTwitchStatus() });
    return true;
  }

  if (cleanPath === "/api/twitch/reset-cache" && req.method === "POST") {
    resetTwitchSessionState();
    clearCachedAuth();
    sendJson(res, 200, {
      ok: true,
      message:
        "Cache da API/Twitch apagado. Reinicie o app para voltar para a tela de setup.",
      status: getSafeTwitchStatus(),
    });
    return true;
  }

  if (cleanPath === "/api/twitch/start" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const cached = loadCachedAuth();
      const credentials = getClientCredentials();
      const config = {
        clientId: String(body.clientId || "").trim() || credentials.clientId,
        broadcasterId: String(
          body.broadcasterId || cached?.broadcasterId || "",
        ).trim(),
        accessToken: String(
          body.accessToken || cached?.accessToken || "",
        ).trim(),
        chatSenderId: String(
          TWITCH_BOT_USER_ID ||
            body.chatSenderId ||
            cached?.broadcasterId ||
            "",
        ).trim(),
        chatAccessToken: String(
          TWITCH_BOT_ACCESS_TOKEN ||
            body.chatAccessToken ||
            cached?.accessToken ||
            "",
        ).trim(),
        rewardName:
          String(body.rewardName || "").trim() || DEFAULT_REDEMPTION_NAME,
        rewardCost: parseRewardCost(body.rewardCost, DEFAULT_REWARD_COST),
        rewardColor: parseRewardColor(body.rewardColor, DEFAULT_REWARD_COLOR),
        rewardEnabled: parseRewardEnabled(
          body.rewardEnabled,
          DEFAULT_REWARD_ENABLED,
        ),
        pollIntervalMs: TWITCH_POLL_INTERVAL_MS,
      };

      if (!config.clientId || !config.broadcasterId || !config.accessToken) {
        sendJson(res, 400, {
          ok: false,
          message: "Informe clientId, broadcasterId e accessToken",
        });
        return true;
      }

      startTwitchMonitor(config);
      await syncCreatedRewardsForConfig(config);
      sendJson(res, 200, { ok: true, status: getSafeTwitchStatus() });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err instanceof Error ? err.message : "Erro ao iniciar monitor",
      });
      return true;
    }
  }

  if (cleanPath === "/api/twitch/reward-config" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const nextRewardName = String(body.rewardName || "").trim();
      const nextRewardCost = parseRewardCost(
        body.rewardCost,
        DEFAULT_REWARD_COST,
      );
      const nextRewardColor = parseRewardColor(
        body.rewardColor,
        DEFAULT_REWARD_COLOR,
      );
      const nextRewardEnabled = parseRewardEnabled(
        body.rewardEnabled,
        DEFAULT_REWARD_ENABLED,
      );
      if (!nextRewardName) {
        sendJson(res, 400, {
          ok: false,
          message: "Informe um nome de resgate valido",
        });
        return true;
      }

      const cached = loadCachedAuth();
      const credentials = getClientCredentials();
      const config = twitchState.config || {
        clientId: credentials.clientId,
        broadcasterId: String(cached?.broadcasterId || "").trim(),
        accessToken: String(cached?.accessToken || "").trim(),
        chatSenderId: String(
          TWITCH_BOT_USER_ID || cached?.broadcasterId || "",
        ).trim(),
        chatAccessToken: String(
          TWITCH_BOT_ACCESS_TOKEN || cached?.accessToken || "",
        ).trim(),
        rewardName: DEFAULT_REDEMPTION_NAME,
        rewardCost: DEFAULT_REWARD_COST,
        rewardColor: DEFAULT_REWARD_COLOR,
        rewardEnabled: DEFAULT_REWARD_ENABLED,
        pollIntervalMs: TWITCH_POLL_INTERVAL_MS,
      };

      if (!config.clientId || !config.broadcasterId || !config.accessToken) {
        sendJson(res, 400, {
          ok: false,
          message: "Conecte com a Twitch antes de alterar o nome do resgate",
        });
        return true;
      }

      if (
        normalizeRewardName(config.rewardName) ===
          normalizeRewardName(nextRewardName) &&
        parseRewardCost(config.rewardCost, DEFAULT_REWARD_COST) ===
          nextRewardCost &&
        parseRewardColor(config.rewardColor, DEFAULT_REWARD_COLOR) ===
          nextRewardColor &&
        parseRewardEnabled(config.rewardEnabled, DEFAULT_REWARD_ENABLED) ===
          nextRewardEnabled
      ) {
        sendJson(res, 200, {
          ok: true,
          message: "Configuracao do resgate ja esta atualizada",
          status: getSafeTwitchStatus(),
        });
        return true;
      }

      await replaceReward(
        config,
        nextRewardName,
        nextRewardCost,
        nextRewardColor,
        nextRewardEnabled,
      );
      twitchState.config = config;
      saveRewardConfig(config);
      await syncCreatedRewardsForConfig(config);
      twitchState.seenRedemptions.clear();
      twitchState.monitorStartedAt = new Date();

      sendJson(res, 200, {
        ok: true,
        message: "Resgate atualizado com sucesso",
        status: getSafeTwitchStatus(),
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message:
          err instanceof Error ? err.message : "Erro ao atualizar resgate",
      });
      return true;
    }
  }

  if (cleanPath === "/api/twitch/reward-enabled" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const enabled = parseRewardEnabled(body.enabled, DEFAULT_REWARD_ENABLED);

      const cached = loadCachedAuth();
      const credentials = getClientCredentials();
      const config = twitchState.config || {
        clientId: credentials.clientId,
        broadcasterId: String(cached?.broadcasterId || "").trim(),
        accessToken: String(cached?.accessToken || "").trim(),
        chatSenderId: String(
          TWITCH_BOT_USER_ID || cached?.broadcasterId || "",
        ).trim(),
        chatAccessToken: String(
          TWITCH_BOT_ACCESS_TOKEN || cached?.accessToken || "",
        ).trim(),
        rewardName: DEFAULT_REDEMPTION_NAME,
        rewardCost: DEFAULT_REWARD_COST,
        rewardColor: DEFAULT_REWARD_COLOR,
        rewardEnabled: DEFAULT_REWARD_ENABLED,
        pollIntervalMs: TWITCH_POLL_INTERVAL_MS,
      };

      if (!config.clientId || !config.broadcasterId || !config.accessToken) {
        sendJson(res, 400, {
          ok: false,
          message: "Conecte com a Twitch antes de alterar o status do resgate",
        });
        return true;
      }

      await updateRewardEnabled(config, enabled);
      twitchState.config = config;
      saveRewardConfig(config);
      await syncCreatedRewardsForConfig(config);

      sendJson(res, 200, {
        ok: true,
        message: enabled ? "Resgate ativado" : "Resgate desativado",
        status: getSafeTwitchStatus(),
      });
      return true;
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : "Erro ao alternar status do resgate",
      });
      return true;
    }
  }

  if (cleanPath === "/api/twitch/stop" && req.method === "POST") {
    stopTwitchMonitor();
    sendJson(res, 200, { ok: true, status: getSafeTwitchStatus() });
    return true;
  }

  if (cleanPath === "/api/twitch/test-trigger" && req.method === "POST") {
    try {
      triggerOverlayFromPlushies("twitch-test");
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message:
          err instanceof Error ? err.message : "Erro ao disparar overlay",
      });
    }
    return true;
  }

  if (cleanPath === "/api/twitch/test-chat" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const cached = loadCachedAuth();
      const credentials = getClientCredentials();
      const config = twitchState.config || {
        clientId: credentials.clientId,
        broadcasterId: String(cached?.broadcasterId || "").trim(),
        accessToken: String(cached?.accessToken || "").trim(),
        chatSenderId: String(
          TWITCH_BOT_USER_ID || cached?.broadcasterId || "",
        ).trim(),
        chatAccessToken: String(
          TWITCH_BOT_ACCESS_TOKEN || cached?.accessToken || "",
        ).trim(),
      };

      if (!config.clientId || !config.broadcasterId || !config.accessToken) {
        sendJson(res, 400, {
          ok: false,
          message: "Conecte com a Twitch antes de verificar conexao",
        });
        return true;
      }

      const customMessage = String(body?.message || "").trim();
      const chatMessage = customMessage || "Conectado e Funcionando!";

      await sendChatMessage(config, chatMessage);
      sendJson(res, 200, { ok: true, message: "Mensagem enviada no chat" });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : "Erro ao enviar mensagem no chat",
      });
    }
    return true;
  }

  return false;
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg"))
    return "image/jpeg";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".gif")) return "image/gif";
  if (filePath.endsWith(".mp3")) return "audio/mpeg";
  if (filePath.endsWith(".wav")) return "audio/wav";
  if (filePath.endsWith(".ogg")) return "audio/ogg";
  if (filePath.endsWith(".webm")) return "audio/webm";
  if (filePath.endsWith(".m4a")) return "audio/mp4";
  if (filePath.endsWith(".aac")) return "audio/aac";
  return "text/plain; charset=utf-8";
}

const server = http.createServer((req, res) => {
  const urlPath = req.url;
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);

  if (
    cleanPath === "/auth/twitch/callback" ||
    cleanPath === "/api/twitch/callback"
  ) {
    handleTwitchOAuthCallback(req, res);
    return;
  }

  if (cleanPath.startsWith("/api/")) {
    handleApiRoutes(req, res, cleanPath).then((handled) => {
      if (!handled) {
        sendJson(res, 404, { ok: false, message: "Rota nao encontrada" });
      }
    });
    return;
  }

  if (cleanPath.startsWith("/imgs/")) {
    const relativeAssetPath = cleanPath.slice("/imgs/".length);
    const runtimeAssetPath = path.resolve(RUNTIME_IMGS_DIR, relativeAssetPath);
    const runtimeImgsRoot = path.resolve(RUNTIME_IMGS_DIR);
    const bundledAssetPath = path.resolve(BUNDLED_IMGS_DIR, relativeAssetPath);
    const bundledImgsRoot = path.resolve(BUNDLED_IMGS_DIR);

    if (!runtimeAssetPath.startsWith(runtimeImgsRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Acesso negado");
      return;
    }

    if (!bundledAssetPath.startsWith(bundledImgsRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Acesso negado");
      return;
    }

    const assetPath = fs.existsSync(runtimeAssetPath)
      ? runtimeAssetPath
      : bundledAssetPath;

    fs.readFile(assetPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Arquivo nao encontrado");
        return;
      }

      res.writeHead(200, { "Content-Type": getContentType(assetPath) });
      res.end(data);
    });
    return;
  }

  if (cleanPath.startsWith("/audio/")) {
    const relativeAssetPath = cleanPath.slice("/audio/".length);
    const runtimeAssetPath = path.resolve(RUNTIME_AUDIO_DIR, relativeAssetPath);
    const runtimeAudioRoot = path.resolve(RUNTIME_AUDIO_DIR);

    if (!runtimeAssetPath.startsWith(runtimeAudioRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Acesso negado");
      return;
    }

    fs.readFile(runtimeAssetPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Arquivo nao encontrado");
        return;
      }

      res.writeHead(200, { "Content-Type": getContentType(runtimeAssetPath) });
      res.end(data);
    });
    return;
  }

  if (cleanPath.startsWith("/components/")) {
    const relativeComponentPath = cleanPath.slice("/components/".length);
    const componentPath = path.resolve(
      PUBLIC_COMPONENTS_DIR,
      relativeComponentPath,
    );
    const componentsRoot = path.resolve(PUBLIC_COMPONENTS_DIR);

    if (!componentPath.startsWith(componentsRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Acesso negado");
      return;
    }

    fs.readFile(componentPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Arquivo nao encontrado");
        return;
      }

      res.writeHead(200, { "Content-Type": getContentType(componentPath) });
      res.end(data);
    });
    return;
  }

  if (cleanPath.startsWith("/card/")) {
    const relativeCardPath = cleanPath.slice("/card/".length);
    const cardPath = path.resolve(BUNDLED_IMGS_DIR, "card", relativeCardPath);
    const cardsRoot = path.resolve(BUNDLED_IMGS_DIR, "card");

    if (!cardPath.startsWith(cardsRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Acesso negado");
      return;
    }

    fs.readFile(cardPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Arquivo nao encontrado");
        return;
      }

      res.writeHead(200, { "Content-Type": getContentType(cardPath) });
      res.end(data);
    });
    return;
  }

  if (cleanPath.startsWith("/styles/")) {
    const relativeStylePath = cleanPath.slice("/styles/".length);
    const stylePath = path.resolve(PUBLIC_STYLES_DIR, relativeStylePath);
    const stylesRoot = path.resolve(PUBLIC_STYLES_DIR);

    if (!stylePath.startsWith(stylesRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Acesso negado");
      return;
    }

    fs.readFile(stylePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Arquivo nao encontrado");
        return;
      }

      res.writeHead(200, { "Content-Type": getContentType(stylePath) });
      res.end(data);
    });
    return;
  }

  const fileName = path.basename(cleanPath);

  if (!PUBLIC_FILES.has(fileName)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Arquivo nao encontrado");
    return;
  }

  const filePath = path.join(PUBLIC_DIR, fileName);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Erro ao ler arquivo");
      return;
    }

    res.writeHead(200, { "Content-Type": getContentType(filePath) });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    const rawMessage = message.toString();

    try {
      const parsed = JSON.parse(rawMessage);
      if (parsed?.type === "gacha_animation_finished") {
        const drawId = String(parsed.drawId || "").trim();
        if (!drawId) return;

        const pending = pendingChatByDrawId.get(drawId);
        if (!pending) return;

        pendingChatByDrawId.delete(drawId);
        sendRedemptionMessageToChat(
          pending.config,
          pending.userName,
          pending.itemName,
        ).catch((chatErr) => {
          console.error(
            `[TWITCH] falha ao enviar mensagem no chat: ${chatErr instanceof Error ? chatErr.message : String(chatErr)}`,
          );
        });
        return;
      }
    } catch {
      // Ignora parse e segue no broadcast normal para mensagens livres.
    }

    // envia pra todos conectados (overlay e controle)
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(rawMessage);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`HTTP + WebSocket rodando em http://localhost:${PORT}`);

  syncCreatedRewardsAtStartup();

  if (process.argv.includes("--open")) {
    exec(`start "" "http://localhost:${PORT}/overlay.html"`);
  }
});
