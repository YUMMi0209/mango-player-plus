/* 芒着拉片 · 侧边栏（上下堆叠 + 自动刷新） */
'use strict';

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
    btnReload: '#btn-reload',
    btnSettings: '#btn-settings',
    settingsMenu: '#settings-menu',
    btnMode: '#btn-mode',
    modeMenu: '#mode-menu',
    togShot: '#tog-shot',
    togAvoid: '#tog-avoid',
    togBar: '#tog-bar',
    togDanmu: '#tog-danmu',
    togNote: '#tog-note',
    togTitle: '#tog-title',
    togAll: '#tog-all',
    togTheme: '#tog-theme',
    setRowAll: '#set-row-all',
    btnWebFs: '#btn-webfs',
    btnHelp: '#btn-help',
    sumSep: '#sum-sep',
    err: '#err',
    wrap: '#wrap',
    footer: 'footer',
    pageTitle: '#page-title',
    btnHistory: '#btn-history',
    historyMenu: '#history-menu',
    histList: '#hist-list',
    histImport: '#hist-import',
    histAll: '#hist-all',
    histClear: '#hist-clear'
  });

  MPP.load(true);
  setInterval(() => MPP.load(false), 1000);
})();
