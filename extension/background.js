/**
 * Ellie Relay Feed — Background Service Worker
 *
 * Minimal — just opens the side panel on icon click.
 * WebSocket lives in the side panel itself (MV3 service workers get suspended).
 */

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
