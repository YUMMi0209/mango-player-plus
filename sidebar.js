/* 芒着拉片 · 分屏侧边栏（上下堆叠 + 自动刷新） */
'use strict';

const $ = s => document.querySelector(s);

(async function setup() {
  MPP.init({
    mkList: '#mk-list',
    ioList: '#io-list',
    cntMk: '#cnt-mk',
    cntIo: '#cnt-io',
    sumIo: '#sum-io',
    selCount: '#sel-count',
    btnAll: '#btn-all',
    btnClear: '#btn-clear',
    btnExport: '#btn-export',
    btnRefresh: '#btn-refresh',
    btnSettings: '#btn-settings',
    settingsMenu: '#settings-menu',
    togEnabled: '#tog-enabled',
    togAll: '#tog-all',
    togTheme: '#tog-theme',
    setRowAll: '#set-row-all',
    btnClearAll: '#btn-clearall',
    err: '#err',
    wrap: '#wrap',
    footer: 'footer'
  });

  $('#btn-back').addEventListener('click', async () => {
    await chrome.action.setPopup({ popup: 'popup.html' }).catch(() => { });
    try { await chrome.action.openPopup(); } catch (e) { }
    window.close();
  });

  MPP.load(true);
  setInterval(() => MPP.load(false), 1000);
})();
