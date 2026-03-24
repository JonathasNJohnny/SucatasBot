const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const WebSocket = require("ws");
require("dotenv").config();

const PORT = 3001;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";
const TWITCH_BOT_ACCESS_TOKEN = process.env.TWITCH_BOT_ACCESS_TOKEN || "";
const TWITCH_BOT_USER_ID = process.env.TWITCH_BOT_USER_ID || "";
const TWITCH_BOT_LOGIN = process.env.TWITCH_BOT_LOGIN || "SucatasBot";
const REDEMPTION_NAME = String(process.env.REDEMPTION_NAME || "pelucia").trim();
const TWITCH_POLL_INTERVAL_MS = 4000;
const TWITCH_REDIRECT_URI =
  process.env.TWITCH_REDIRECT_URI ||
  `http://localhost:${PORT}/api/twitch/callback`;
const AUTH_CACHE_DIR = path.join(__dirname, ".cache");
const AUTH_CACHE_FILE = path.join(AUTH_CACHE_DIR, "twitch-auth.json");
const REDEMPTIONS_LOG_FILE = path.join(__dirname, "resgates.txt");
const IMPORTED_ITEMS_FILE = path.join(__dirname, "importedItems.txt");
const ITEMS_UPLOAD_DIR = path.join(__dirname, "imgs", "items");
const PUBLIC_FILES = new Set([
  "control.html",
  "importItems.html",
  "overlay.html",
  "twitchControl.html",
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
};

const pendingChatByDrawId = new Map();

function ensureAuthCacheDir() {
  if (!fs.existsSync(AUTH_CACHE_DIR)) {
    fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true });
  }
}

function ensureUploadDir() {
  if (!fs.existsSync(ITEMS_UPLOAD_DIR)) {
    fs.mkdirSync(ITEMS_UPLOAD_DIR, { recursive: true });
  }
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

function saveCachedAuth(authData) {
  ensureAuthCacheDir();
  fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify(authData, null, 2), "utf8");
}

function clearCachedAuth() {
  if (fs.existsSync(AUTH_CACHE_FILE)) {
    fs.unlinkSync(AUTH_CACHE_FILE);
  }
}

function toNumberPercent(value) {
  const n = parseFloat(String(value).replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

function createItemId() {
  return `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDrawId(prefix = "draw") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
      `[ITEMS] erro ao carregar importedItems.txt: ${err instanceof Error ? err.message : String(err)}`,
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

  const absolutePath = path.resolve(__dirname, relativePath.slice(1));
  const itemsRoot = path.resolve(__dirname, "imgs", "items");
  const plushiesRoot = path.resolve(__dirname, "imgs", "plushies");
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

function appendRedemptionLogLine(userName, plushieName) {
  const timestamp = new Date().toISOString();
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
      if (raw.length > 1_000_000) {
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
        connectedAt: cached.connectedAt,
      }
    : null;

  return {
    running: twitchState.running,
    config,
    envConfigured: Boolean(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET),
    redemptionName: REDEMPTION_NAME,
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
  const state = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  twitchState.oauthState = state;

  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", TWITCH_CLIENT_ID);
  url.searchParams.set("redirect_uri", TWITCH_REDIRECT_URI);
  url.searchParams.set(
    "scope",
    "channel:read:redemptions channel:manage:redemptions user:write:chat",
  );
  url.searchParams.set("state", state);
  url.searchParams.set("force_verify", "true");
  return url.toString();
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
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
    const tokenData = await exchangeCodeForToken(code);
    const user = await fetchAuthenticatedUser(
      TWITCH_CLIENT_ID,
      tokenData.access_token,
    );

    saveCachedAuth({
      clientId: TWITCH_CLIENT_ID,
      broadcasterId: user.id,
      login: user.login,
      displayName: user.display_name,
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
    throw new Error(`Twitch API ${res.status}: ${text}`);
  }

  return res.json();
}

async function sendRedemptionMessageToChat(config, userName, itemName) {
  const safeUser = String(userName || "viewer").trim() || "viewer";
  const safeItem =
    String(itemName || "item surpresa").trim() || "item surpresa";
  const message = `@${safeUser} resgatou e tirou: ${safeItem}!`;

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
      message,
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
      cost: 1,
      is_enabled: true,
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

function normalizeRewardName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function logRewardsList(rewards, targetName) {
  const titleList = rewards.map((r) => r.title);
  console.log(
    `[TWITCH] rewards (${rewards.length}) alvo="${targetName}": ${JSON.stringify(titleList)}`,
  );
}

function logRedemptionsList(redemptions, rewardTitle) {
  const compact = redemptions.map((r) => ({
    id: r.id,
    user: r.user_name,
    status: r.status,
    redeemed_at: r.redeemed_at,
  }));
  console.log(
    `[TWITCH] redemptions "${rewardTitle}" (${redemptions.length}): ${JSON.stringify(compact)}`,
  );
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

async function pollTwitchRedemptions() {
  if (!twitchState.running || !twitchState.config) return;

  const config = twitchState.config;
  twitchState.lastError = null;

  try {
    const reward = await ensureRewardExists(config);

    const redemptionsUrl = new URL(
      "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions",
    );
    redemptionsUrl.searchParams.set("broadcaster_id", config.broadcasterId);
    redemptionsUrl.searchParams.set("reward_id", reward.id);
    redemptionsUrl.searchParams.set("status", "UNFULFILLED");
    redemptionsUrl.searchParams.set("first", "50");

    const redemptionsData = await twitchApiRequest(
      redemptionsUrl.toString(),
      config,
    );
    const redemptions = Array.isArray(redemptionsData.data)
      ? redemptionsData.data
      : [];
    logRedemptionsList(redemptions, reward.title);
    redemptions.sort(
      (a, b) =>
        new Date(a.redeemed_at).getTime() - new Date(b.redeemed_at).getTime(),
    );

    for (const redemption of redemptions) {
      if (twitchState.seenRedemptions.has(redemption.id)) {
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
  } catch (err) {
    twitchState.lastError = err instanceof Error ? err.message : String(err);
    console.error(`[TWITCH] erro no polling: ${twitchState.lastError}`);
  }
}

function stopTwitchMonitor() {
  if (twitchState.intervalId) {
    clearInterval(twitchState.intervalId);
  }

  twitchState.running = false;
  twitchState.intervalId = null;
  twitchState.rewardId = null;
}

function startTwitchMonitor(config) {
  stopTwitchMonitor();

  twitchState.running = true;
  twitchState.config = config;
  twitchState.lastError = null;
  twitchState.lastRewardFound = null;
  twitchState.rewardId = null;

  twitchState.intervalId = setInterval(
    pollTwitchRedemptions,
    TWITCH_POLL_INTERVAL_MS,
  );

  pollTwitchRedemptions();
}

async function handleApiRoutes(req, res, cleanPath) {
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

  if (cleanPath === "/api/twitch/status" && req.method === "GET") {
    sendJson(res, 200, getSafeTwitchStatus());
    return true;
  }

  if (cleanPath === "/api/twitch/connect" && req.method === "GET") {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
      sendJson(res, 500, {
        ok: false,
        message: "Defina TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET no .env",
      });
      return true;
    }

    res.writeHead(302, { Location: createTwitchAuthorizeUrl() });
    res.end();
    return true;
  }

  if (cleanPath === "/api/twitch/logout" && req.method === "POST") {
    stopTwitchMonitor();
    clearCachedAuth();
    sendJson(res, 200, { ok: true, status: getSafeTwitchStatus() });
    return true;
  }

  if (cleanPath === "/api/twitch/start" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const cached = loadCachedAuth();
      const config = {
        clientId: TWITCH_CLIENT_ID || String(body.clientId || "").trim(),
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
        rewardName: REDEMPTION_NAME,
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
  return "text/plain; charset=utf-8";
}

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/twitchControl.html" : req.url;
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
    const relativeAssetPath = cleanPath.slice(1);
    const assetPath = path.resolve(__dirname, relativeAssetPath);
    const imgsRoot = path.resolve(__dirname, "imgs");

    if (!assetPath.startsWith(imgsRoot)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Acesso negado");
      return;
    }

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

  const fileName = path.basename(cleanPath);

  if (!PUBLIC_FILES.has(fileName)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Arquivo nao encontrado");
    return;
  }

  const filePath = path.join(__dirname, fileName);
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

  if (process.argv.includes("--open")) {
    exec(`start "" "http://localhost:${PORT}/control.html"`);
    exec(`start "" "http://localhost:${PORT}/overlay.html"`);
  }
});
