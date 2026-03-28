const fs = require("fs");
const path = require("path");

const AUTH_CACHE_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || "", ".config"),
  "SucatasBot",
);
const AUTH_CACHE_FILE = path.join(AUTH_CACHE_DIR, "twitch-auth.json");

function ensureAuthCacheDir() {
  if (!fs.existsSync(AUTH_CACHE_DIR)) {
    fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true });
  }
}

function loadCachedConfig() {
  try {
    if (!fs.existsSync(AUTH_CACHE_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(AUTH_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function hasClientCredentialsInCache() {
  const cached = loadCachedConfig();
  return Boolean(
    String(cached.clientId || "").trim() &&
    String(cached.clientSecret || "").trim(),
  );
}

module.exports = {
  AUTH_CACHE_DIR,
  AUTH_CACHE_FILE,
  ensureAuthCacheDir,
  loadCachedConfig,
  hasClientCredentialsInCache,
};
