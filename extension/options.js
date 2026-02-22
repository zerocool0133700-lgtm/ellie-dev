const serverUrlInput = document.getElementById("server-url");
const apiKeyInput = document.getElementById("api-key");
const saveBtn = document.getElementById("save-btn");
const statusEl = document.getElementById("status");

// Load saved settings
chrome.storage.local.get(["serverUrl", "apiKey"], (settings) => {
  if (settings.serverUrl) serverUrlInput.value = settings.serverUrl;
  if (settings.apiKey) apiKeyInput.value = settings.apiKey;
});

saveBtn.addEventListener("click", () => {
  const serverUrl = serverUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!serverUrl || !apiKey) {
    statusEl.textContent = "Both fields are required.";
    statusEl.style.color = "#f87171";
    return;
  }

  chrome.storage.local.set({ serverUrl, apiKey }, () => {
    statusEl.textContent = "Saved! Open the side panel to connect.";
    statusEl.style.color = "#4ade80";
  });
});
