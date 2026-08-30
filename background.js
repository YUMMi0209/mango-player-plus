/* 芒着拉片 · 后台
   - 设置（插件开关 / 应用于所有网页）经 executeScript 注入页面为 window.__mgpSettings
   - 图标点击：记忆上次使用的面板模式（弹窗 / 侧边栏 / 独立窗口），浏览器重启后依旧按该模式打开 */
'use strict';

const SETTINGS_KEY = 'mpp_settings';
// v2.0：总开关拆分为「日志记录 / 视频控制栏」两个独立开关，另含截图录制文件名备注/标题开关；lastMode 记忆上次的面板显示模式；annotateTimecode 标注截图嵌入时间码开关；recCodec 录制编码偏好（mp4/vp8/vp9）
const DEFAULT_SETTINGS = { enabled: true, activeHosts: [], theme: 'dark', logEnabled: true, barEnabled: true, danmuBlock: true, noteFileName: true, titleFileName: true, pipRecord: false, lastMode: 'sidebar', annotateTimecode: false, recCodec: '1080p-h264' };

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
  // 默认白名单站点（芒果TV / 百度网盘）或已授权站点才推送设置
  if (!/mgtv\.com|pan\.baidu\.com/.test(url) && !(settings.activeHosts || []).some(h => url.indexOf(h) !== -1)) return;
  pushSettings(tabId);
});

// 设置变化时，即时推送到所有已打开的网页（含独立窗口/侧边栏场景）；
// activeHosts 变化时同步动态注册/注销授权站点的 content scripts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const s = changes[SETTINGS_KEY].newValue || {};
  syncActiveScripts().catch(() => { });
  chrome.tabs.query({}).then(tabs => {
    tabs.forEach(t => {
      if (t.id != null && t.url && /^https?:/.test(t.url)) pushSettings(t.id);
    });
  });
});

// 面板打开时请求同步一次设置到当前页
// saveSettings：面板开关经后台保存（面板关闭后异步 set 会中断，由 service worker 完成）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'pushSettings') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]) pushSettings(tabs[0].id);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg && msg.type === 'saveSettings' && msg.patch && typeof msg.patch === 'object') {
    getSettings().then(s => {
      Object.assign(s, msg.patch);
      return chrome.storage.local.set({ mpp_settings: s });
    }).catch(() => { });
    sendResponse({ ok: true });
    return true;
  }
});

// 「应用于当前网页」授权站点：动态注册 content scripts（静态注入仅限默认白名单站点，
// 避免 <all_urls> 全站注入的性能与安全暴露面）
const ACTIVE_SCRIPTS_ID = 'mpp-active';
const ACTIVE_BRIDGE_ID = 'mpp-active-bridge';
async function syncActiveScripts() {
  const s = await getSettings();
  const hosts = Array.isArray(s.activeHosts) ? s.activeHosts.filter(h => /^[a-z0-9.-]+$/i.test(h)) : [];
  try {
    if (hosts.length) {
      const matches = hosts.map(h => 'https://' + h + '/*');
      await chrome.scripting.registerContentScripts([
        {
          id: ACTIVE_SCRIPTS_ID,
          matches, js: ['content/content.js', 'content/control-bar.js'],
          runAt: 'document_idle', world: 'MAIN'
        },
        {
          id: ACTIVE_BRIDGE_ID,
          matches, js: ['content/bridge.js'],
          runAt: 'document_idle', world: 'ISOLATED'
        }
      ]).catch(() => { });
    } else {
      await chrome.scripting.unregisterContentScripts({ ids: [ACTIVE_SCRIPTS_ID, ACTIVE_BRIDGE_ID] }).catch(() => { });
    }
  } catch (e) { }
}

// 按记忆的显示模式设置图标点击行为：
//   popup   → 保留 popup，点击弹出面板
//   sidebar → 清空 popup + panelBehavior 接管点击（浏览器原生打开侧边栏，
//             避免 sidePanel.open 需用户手势、重启后 onClicked 中异步调用会丢失手势的问题）
//   window  → 清空 popup，点击走 onClicked 打开独立窗口（windows.create 无需手势）
function applyLastMode(lastMode) {
  const isPopup = lastMode === 'popup';
  chrome.action.setPopup({ popup: isPopup ? 'popup.html' : '' }).catch(() => { });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: lastMode === 'sidebar' }).catch(() => { });
}

chrome.runtime.onInstalled.addListener(() => { getSettings().then(s => applyLastMode(s.lastMode)); syncActiveScripts().catch(() => { }); });
chrome.runtime.onStartup.addListener(() => { getSettings().then(s => applyLastMode(s.lastMode)); syncActiveScripts().catch(() => { }); });

chrome.action.onClicked.addListener(tab => {
  // 仅 window 模式会走到（popup 模式有 popup；sidebar 模式被 panelBehavior 接管）
  getSettings().then(s => {
    if (s.lastMode !== 'window') return;
    // 独立窗口：与面板切换行为一致，关联当前激活标签页
    if (tab.id != null) chrome.storage.session.set({ mpp_src_tab: tab.id }).catch(() => { });
    chrome.windows.create({
      url: 'sidebar.html?win=1',
      type: 'popup',
      width: 430,
      height: 680,
      focused: true
    }).catch(() => { });
  });
});
