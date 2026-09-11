"use strict";

const toggle = document.getElementById("show-floating-stats");
const status = document.getElementById("status");
let statusTimer;

async function loadSettings() {
  const stored = await chrome.storage.sync.get({ showFloatingStats: true });
  toggle.checked = stored.showFloatingStats;
}

toggle.addEventListener("change", async () => {
  await chrome.storage.sync.set({ showFloatingStats: toggle.checked });
  status.textContent = "Saved";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { status.textContent = ""; }, 1200);
});

loadSettings().catch(() => {
  status.textContent = "Settings could not be loaded.";
});
