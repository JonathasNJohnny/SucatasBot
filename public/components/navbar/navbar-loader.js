const THEME_STORAGE_KEY = "sucatasbot-theme";

function resolveStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") {
    return stored;
  }

  return "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function updateThemeToggleIcon(mount, theme) {
  const icon = mount.querySelector("[data-theme-icon]");
  if (!icon) return;

  icon.textContent = theme === "dark" ? "☀" : "☾";
}

function setupThemeToggle(mount) {
  const btn = mount.querySelector("[data-theme-toggle]");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const currentTheme =
      document.documentElement.getAttribute("data-theme") || "dark";
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    updateThemeToggleIcon(mount, nextTheme);
  });
}

let navbarTwitchMount = null;

function renderTwitchIdentity(mount, status, hasConnectionError = false) {
  const chip = mount.querySelector("[data-twitch-chip]");
  const icon = mount.querySelector("[data-user-icon]");
  if (!chip || !icon) return;

  chip.onclick = null;

  const displayName = String(status?.auth?.displayName || "").trim();
  const login = String(status?.auth?.login || "").trim();
  const profileImageUrl = String(status?.auth?.profileImageUrl || "").trim();
  const isConnected =
    Boolean(status?.auth?.broadcasterId) && !hasConnectionError;

  if (isConnected) {
    chip.classList.remove("disconnected", "connectable");
    chip.title = displayName || login || "Twitch conectado";
    chip.setAttribute("aria-label", displayName || login || "Twitch conectado");

    if (profileImageUrl) {
      icon.style.backgroundImage = `url("${profileImageUrl.replace(/"/g, "%22")}")`;
      icon.textContent = "";
    } else {
      icon.style.backgroundImage = "none";
      icon.textContent = (displayName || login || "T")
        .slice(0, 1)
        .toUpperCase();
    }
    return;
  }

  icon.style.backgroundImage = "none";
  icon.textContent = String.fromCodePoint(0x1f50c);
  chip.classList.add("disconnected", "connectable");
  chip.title = "Conectar Twitch";
  chip.setAttribute("aria-label", "Conectar Twitch");
  chip.onclick = () => {
    window.location.href = "/api/twitch/connect";
  };
}

async function setupTwitchIdentity(mount) {
  try {
    const res = await fetch("/api/twitch/status", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      renderTwitchIdentity(mount, null, true);
      return;
    }

    const status = await res.json();
    renderTwitchIdentity(mount, status, false);
  } catch {
    renderTwitchIdentity(mount, null, true);
  }
}

async function loadSharedNavbar(mountId = "navbarMount") {
  const mount = document.getElementById(mountId);
  if (!mount) return;

  try {
    const cssHref = "/components/navbar/navbar.css";
    const hasNavbarCss = Array.from(
      document.querySelectorAll('link[rel="stylesheet"]'),
    ).some((link) => link.getAttribute("href") === cssHref);

    if (!hasNavbarCss) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = cssHref;
      document.head.appendChild(link);
    }

    const res = await fetch("/components/navbar/navbar.html");
    if (!res.ok) return;

    const html = await res.text();
    mount.innerHTML = html;
    navbarTwitchMount = mount;

    const activeTheme =
      document.documentElement.getAttribute("data-theme") ||
      resolveStoredTheme();
    applyTheme(activeTheme);
    updateThemeToggleIcon(mount, activeTheme);
    setupThemeToggle(mount);
    await setupTwitchIdentity(mount);

    const currentFile = window.location.pathname.split("/").pop();

    mount.querySelectorAll("[data-nav]").forEach((link) => {
      const pages = link.dataset.nav.split(",").map((p) => p.trim());

      if (pages.includes(currentFile)) {
        link.classList.add("active");
      }
    });
  } catch {
    // Ignora falhas de carregamento da navbar compartilhada.
  }
}

async function refreshNavbarTwitchIdentity() {
  if (!navbarTwitchMount) {
    return;
  }

  await setupTwitchIdentity(navbarTwitchMount);
}

window.loadSharedNavbar = loadSharedNavbar;
window.refreshNavbarTwitchIdentity = refreshNavbarTwitchIdentity;

window.addEventListener("twitch-auth-changed", () => {
  refreshNavbarTwitchIdentity();
});

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(resolveStoredTheme());
  loadSharedNavbar();
});
