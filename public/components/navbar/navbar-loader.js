const THEME_STORAGE_KEY = "sucatasbot-theme";
const TWITCH_CONNECT_ICON_URL = "/imgs/connection.png";

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

function setupNestedInteractionMenus(mount) {
  const toggles = mount.querySelectorAll("[data-submenu-toggle]");
  if (!toggles.length) {
    return;
  }

  toggles.forEach((toggle) => {
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const item = toggle.closest(".submenu");
      if (!item) return;

      const isOpen = item.classList.contains("open");
      mount.querySelectorAll(".submenu.open").forEach((entry) => {
        entry.classList.remove("open");
      });

      if (!isOpen) {
        item.classList.add("open");
      }
    });
  });

  document.addEventListener("click", (event) => {
    if (!mount.contains(event.target)) {
      mount.querySelectorAll(".submenu.open").forEach((entry) => {
        entry.classList.remove("open");
      });
    }
  });
}

let navbarTwitchMount = null;
let navbarStatusPollingId = null;

function isAffiliateRestricted(status) {
  if (!status) return true;

  if (status.affiliateRequired === true) {
    return true;
  }

  const errorText = String(status.lastError || "").toLowerCase();
  return (
    errorText.includes("forbidden") &&
    errorText.includes("partner or affiliate status")
  );
}

function applyAffiliateFeatureVisibility(mount, status) {
  const isRestricted = isAffiliateRestricted(status);

  mount.querySelectorAll("[data-affiliate-required]").forEach((item) => {
    item.style.display = isRestricted ? "none" : "";
  });
}

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

  icon.style.backgroundImage = `url("${TWITCH_CONNECT_ICON_URL}")`;
  icon.style.backgroundSize = "contain";
  icon.textContent = "";
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
      applyAffiliateFeatureVisibility(mount, null);
      return;
    }

    const status = await res.json();
    renderTwitchIdentity(mount, status, false);
    applyAffiliateFeatureVisibility(mount, status);
  } catch {
    renderTwitchIdentity(mount, null, true);
    applyAffiliateFeatureVisibility(mount, null);
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
    setupNestedInteractionMenus(mount);
    await setupTwitchIdentity(mount);

    if (!navbarStatusPollingId) {
      navbarStatusPollingId = setInterval(() => {
        setupTwitchIdentity(mount).catch(() => {});
      }, 4000);
    }

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
