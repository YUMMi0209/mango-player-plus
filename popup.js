/* 芒着拉片 · 日志面板（左右选项卡模式） */
'use strict';

const $ = s => document.querySelector(s);
const TAB_KEY = 'mpp_popup_tab';

MPP.init({
  mkList: '#mk-list',
  ioList: '#mk-list',      // 单列表：入点到出点复用同一列表
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

// ─── 选项卡切换 ─────────────────────────────
function setTab(t) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  MPP.setTab(t);
  localStorage.setItem(TAB_KEY, t);
}

$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
});

// ─── 启动 ───────────────────────────────────
setTab(localStorage.getItem(TAB_KEY) === 'io' ? 'io' : 'mk');
MPP.load(true);
