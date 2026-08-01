/* 芒着拉片 · 后台
   - 设置（插件开关 / 应用于所有网页）经 executeScript 注入页面为 window.__mgpSettings
   - 图标点击：不记忆模式，每次默认弹窗；会话内切到分屏（popup 被清空）后点击则打开侧边栏 */
'use strict';

const SETTINGS_KEY = 'mpp_settings';
const DEFAULT_SETTINGS = { enabled: true, activeHosts: [], theme: 'dark' };

async function getSettings() {
  const s = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULT_SETTINGS, s[SETTINGS_KEY] || {});
}

function pushSettings(tabId) {
  return getSettings().then(settings => {
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: s => {
        window.__mgpSettings = s;
        window.dispatchEvent(new CustomEvent('mgp-settings', { detail: s }));
      },
      args: [settings]
    }).catch(() => { });
  });
}

// 页面加载完成后，若该页面适用（芒果TV 或 已开启所有网页），推送设置
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url || '';
  if (!/^https?:/.test(url)) return;
  const settings = await getSettings();
  if (!/mgtv\.com/.test(url) && !(settings.activeHosts || []).some(h => url.indexOf(h) !== -1)) return;
  pushSettings(tabId);
});

// 设置变化时，即时推送到当前活动标签页
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) pushSettings(tabs[0].id);
  });
});

// 面板打开时请求同步一次设置到当前页
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'pushSettings') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]) pushSettings(tabs[0].id);
      sendResponse({ ok: true });
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => chrome.action.setPopup({ popup: 'popup.html' }).catch(() => { }));
chrome.runtime.onStartup.addListener(() => chrome.action.setPopup({ popup: 'popup.html' }).catch(() => { }));

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => { });
});
