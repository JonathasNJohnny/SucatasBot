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

    const activeTheme =
      document.documentElement.getAttribute("data-theme") ||
      resolveStoredTheme();
    applyTheme(activeTheme);
    updateThemeToggleIcon(mount, activeTheme);
    setupThemeToggle(mount);

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

window.loadSharedNavbar = loadSharedNavbar;

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(resolveStoredTheme());
  loadSharedNavbar();
});
