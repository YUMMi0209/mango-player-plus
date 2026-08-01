/* 芒着拉片 · 记录面板（左右选项卡模式） */
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
  btnRefresh: '#btn-refresh',
  btnSettings: '#btn-settings',
  settingsMenu: '#settings-menu',
  btnMode: '#btn-mode',
  modeMenu: '#mode-menu',
  togEnabled: '#tog-enabled',
  togAll: '#tog-all',
  togTheme: '#tog-theme',
  setRowAll: '#set-row-all',
  btnClearAll: '#btn-clearall',
  err: '#err',
  wrap: '#wrap',
  footer: 'footer'
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
