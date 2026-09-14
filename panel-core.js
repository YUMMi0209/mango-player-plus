/* 芒着拉片 · 日志面板核心（popup 与侧边栏共用）v2.0 */
'use strict';

const MPP = (() => {
  // ─── 注入页面 MAIN world 执行（自包含）──────
  // 弹窗/侧边栏：跟随当前窗口的激活标签页——切换网页后记录随之同步；
  // 独立窗口：当前窗口是扩展窗口，需回退到记忆的来源视频标签页。
  function findTab() {
    if (isWindowMode()) {
      return chrome.storage.session.get('mpp_src_tab').then(({ mpp_src_tab }) => {
        if (mpp_src_tab == null) return null;
        return chrome.tabs.get(mpp_src_tab).then(
          t => (t && t.id != null && t.url && /^https?:/.test(t.url)) ? t : null,
          () => { chrome.storage.session.remove('mpp_src_tab').catch(() => { }); return null; }
        );
      }).then(mem => {
        if (mem) return mem;
        return chrome.tabs.query({}).then(all => {
          const cands = all.filter(t => t.id != null && t.url && /^https?:/.test(t.url));
          cands.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          const mgtv = cands.find(t => /mgtv\.com/.test(t.url));
          return (mgtv || cands[0]) || null;
        });
      });
    }
    return chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      const t = tabs && tabs[0];
      if (t && t.id != null && t.url && /^https?:/.test(t.url)) return t;
      return null;
    });
  }

  function rememberSrcTab(tabId) {
    if (tabId != null) chrome.storage.session.set({ mpp_src_tab: tabId }).catch(() => { });
  }

  function execInPage(func, args) {
    return findTab().then(t => {
      const id = t && t.id;
      if (!id) throw new Error('no-tab');
      return chrome.scripting.executeScript({
        target: { tabId: id },
        world: 'MAIN',
        func,
        args: args || []
      });
    }).then(results => (results && results[0]) ? results[0].result : undefined);
  }

  function fnGetLogs() {
    function vkey() {
      if (window.__mgpVkey) { try { return window.__mgpVkey(); } catch (e) { } }
      const m = location.pathname.match(/(\d+)\/(\d+)\.html$/);
      if (m) return 'id:' + m[1] + '_' + m[2];
      const m1 = location.pathname.match(/(\d+)\.html$/);
      if (m1) return 'id:' + m1[1];
      const v = window.__mgp_video && window.__mgp_video.dataset;
      if (v) { const d = v.id || v.vid || v.mgpid; if (d) return 'id:' + d; }
      return location.origin + location.pathname;
    }
    // 网页标题：优先取自定义标题（mpp_titles 中 custom 标记），否则读 <title>
    function pgTitle() {
      try {
        const t = JSON.parse(localStorage.getItem('mpp_titles') || '{}') || {};
        const e = t[vkey()];
        if (e && String(e.title || '').trim()) return String(e.title).trim();
      } catch (e) { }
      return (document.title || '').trim();
    }
    let data;
    // 旧版本页面残留的 __mgpAPI 缺少 clearAll，其内存缓存可能与本地存储不一致，
    // 此时回退直接读 localStorage，避免记录“删不掉”的假象。
    if (window.__mgpAPI && typeof window.__mgpAPI.clearAll === 'function') {
      data = window.__mgpAPI.getLogs();
    } else {
      try {
        const raw = localStorage.getItem('mpp_logs');
        let map = JSON.parse(raw || '{}') || {};
        const key = vkey();
        if (map && Array.isArray(map.inOut) && Array.isArray(map.marks)) map = { [key]: map };
        const e = map[key] || { inOut: [], marks: [] };
        data = { inOut: e.inOut || [], marks: e.marks || [] };
      } catch (e) { data = { inOut: [], marks: [] }; }
    }
    return { logs: data, host: location.hostname, baseURL: location.origin + location.pathname, title: pgTitle() };
  }
  function fnRemove(selObj) {
    if (window.__mgpAPI) return window.__mgpAPI.removeLogs(selObj);
    return 0;
  }
  function fnToast(msg) {
    try { if (window.__mgpToast) window.__mgpToast(msg, true); } catch (e) { }
  }
  // 页面 videoKey（与 control-bar 一致）
  function fnPageKey() {
    const m = location.pathname.match(/(\d+)\/(\d+)\.html$/);
    if (m) return 'id:' + m[1] + '_' + m[2];
    const m1 = location.pathname.match(/(\d+)\.html$/);
    if (m1) return 'id:' + m1[1];
    const v = window.__mgp_video && window.__mgp_video.dataset;
    if (v) { const d = v.id || v.vid || v.mgpid; if (d) return 'id:' + d; }
    return location.origin + location.pathname;
  }
  // 日志导入合并到当前页面（control-bar __mgpAPI.importLogs），返回新增条数
  function fnImportLogs(marks, inOut) {
    try {
      if (window.__mgpAPI && typeof window.__mgpAPI.importLogs === 'function') {
        return window.__mgpAPI.importLogs(marks, inOut);
      }
    } catch (e) { }
    return 0;
  }
  // 网页全屏切换：进入返回 true，退出返回 false
  function fnToggleWebFs() {
    try {
      if (window.__mgpAPI && typeof window.__mgpAPI.toggleWebFs === 'function') {
        return window.__mgpAPI.toggleWebFs() === true;
      }
    } catch (e) { }
    return false;
  }
  function fnJump(time) {
    try {
      if (window.__mgpAPI && typeof window.__mgpAPI.jumpTo === 'function') {
        return window.__mgpAPI.jumpTo(time);
      }
    } catch (e) { }
    const v = window.__mgp_video || document.querySelector('video');
    if (!v || time == null || !isFinite(time) || time < 0) return false;
    try {
      v.currentTime = Math.min(time, v.duration || time);
      if (v.paused) v.play().catch(() => { });
      return true;
    } catch (e) { return false; }
  }
  // 编辑记录时间码（右键双击时间码）：type 'mk'|'io'，field 'time'|'in'|'out'
  function fnSetTime(type, idx, field, sec) {
    try {
      if (window.__mgpAPI && typeof window.__mgpAPI.setTime === 'function') {
        return window.__mgpAPI.setTime(type, idx, field, sec) === true;
      }
    } catch (e) { }
    return false;
  }
  // 批量截图 / 录制：items = [{type:'mk'|'io', time, start, end}]，mode 'shot'|'rec'
  function fnBatchRun(items, mode) {
    try {
      if (window.__mgpAPI && typeof window.__mgpAPI.batchRun === 'function') {
        return window.__mgpAPI.batchRun(items, mode);
      }
    } catch (e) { }
    return null;
  }
  // 取消批量任务（面板窗口按 Esc 时调用；页面焦点下由页面自身监听 Esc）
  function fnBatchCancel() {
    try {
      if (window.__mgpAPI && typeof window.__mgpAPI.batchCancel === 'function') {
        return window.__mgpAPI.batchCancel() === true;
      }
    } catch (e) { }
    return false;
  }
  // 页面端是否仍有批量任务在跑（面板据此判断任务是否结束）
  function fnBatchBusy() {
    try {
      if (window.__mgpAPI && typeof window.__mgpAPI.batchBusy === 'function') {
        return window.__mgpAPI.batchBusy() === true;
      }
    } catch (e) { }
    return false;
  }
  function fnSetMarkColor(idx, color) {
    function vkey() {
      if (window.__mgpVkey) { try { return window.__mgpVkey(); } catch (e) { } }
      const m = location.pathname.match(/(\d+)\/(\d+)\.html$/);
      if (m) return 'id:' + m[1] + '_' + m[2];
      const m1 = location.pathname.match(/(\d+)\.html$/);
      if (m1) return 'id:' + m1[1];
      const v = window.__mgp_video && window.__mgp_video.dataset;
      if (v) { const d = v.id || v.vid || v.mgpid; if (d) return 'id:' + d; }
      return location.origin + location.pathname;
    }
    let ok = false;
    if (window.__mgpAPI && typeof window.__mgpAPI.setMarkColor === 'function') {
      try { ok = window.__mgpAPI.setMarkColor(idx, color) === true; } catch (e) { }
    }
    if (!ok) {
      try {
        const raw = localStorage.getItem('mpp_logs');
        let map = JSON.parse(raw || '{}') || {};
        const key = vkey();
        if (map && Array.isArray(map.inOut) && Array.isArray(map.marks)) map = { [key]: map };
        const e = map[key] || { inOut: [], marks: [] };
        if (e.marks && e.marks[idx]) {
          if (color === null || color === undefined) delete e.marks[idx].color;
          else e.marks[idx].color = color;
          map[key] = e;
          localStorage.setItem('mpp_logs', JSON.stringify(map));
          ok = true;
        }
      } catch (e) { }
    }
    return ok;
  }
  // v2.0 打点备注：type 为 'mk' / 'io'
  function fnSetNote(type, idx, note) {
    if (window.__mgpAPI && typeof window.__mgpAPI.setNote === 'function') {
      try { return window.__mgpAPI.setNote(type, idx, note) === true; } catch (e) { }
    }
    return false;
  }
  // v2.0 标题重命名：写入 mpp_titles 并标记 custom，页面端保存记录时保留自定义标题
  function fnSetTitle(title) {
    const t = String(title || '').trim();
    if (window.__mgpAPI && typeof window.__mgpAPI.setTitle === 'function') {
      try { return window.__mgpAPI.setTitle(t) === true; } catch (e) { }
    }
    function vkey() {
      if (window.__mgpVkey) { try { return window.__mgpVkey(); } catch (e) { } }
      const m = location.pathname.match(/(\d+)\/(\d+)\.html$/);
      if (m) return 'id:' + m[1] + '_' + m[2];
      const m1 = location.pathname.match(/(\d+)\.html$/);
      if (m1) return 'id:' + m1[1];
      const v = window.__mgp_video && window.__mgp_video.dataset;
      if (v) { const d = v.id || v.vid || v.mgpid; if (d) return 'id:' + d; }
      return location.origin + location.pathname;
    }
    try {
      const titles = JSON.parse(localStorage.getItem('mpp_titles') || '{}') || {};
      const key = vkey();
      if (!t) {
        if (titles[key]) { delete titles[key].custom; delete titles[key].title; }
      } else {
        titles[key] = { title: t, url: location.href, custom: true };
      }
      localStorage.setItem('mpp_titles', JSON.stringify(titles));
      return true;
    } catch (e) { return false; }
  }
  // v2.0 历史：列出所有有标记记录的视频（标题 + 链接 + 记录数）；
  // 同时返回本页已知但已无记录的 key，供面板清除全局索引中的残留条目
  function fnGetHistory() {
    let map = {}, titles = {};
    try { map = JSON.parse(localStorage.getItem('mpp_logs') || '{}') || {}; } catch (e) { }
    try { titles = JSON.parse(localStorage.getItem('mpp_titles') || '{}') || {}; } catch (e) { }
    if (map && Array.isArray(map.inOut)) map = {};
    const out = [], zeroKeys = [];
    for (const k of Object.keys(map)) {
      const e = map[k] || {};
      const marks = Array.isArray(e.marks) ? e.marks.length : 0;
      const inOut = Array.isArray(e.inOut) ? e.inOut.length : 0;
      if (marks + inOut === 0) { zeroKeys.push(k); continue; }
      const t = titles[k] || {};
      out.push({ key: k, title: String(t.title || '').trim(), url: t.url || '', marks, inOut });
    }
    for (const k of Object.keys(titles)) {
      if (!(k in map) && zeroKeys.indexOf(k) === -1) zeroKeys.push(k);
    }
    out.sort((a, b) => (b.marks + b.inOut) - (a.marks + a.inOut));
    return { items: out, zeroKeys };
  }
  // v2.0 历史：按 videoKey 批量清除；若包含当前视频则同时重置页面端状态
  function fnRemoveHistory(keys) {
    function vkey() {
      if (window.__mgpVkey) { try { return window.__mgpVkey(); } catch (e) { } }
      const m = location.pathname.match(/(\d+)\/(\d+)\.html$/);
      if (m) return 'id:' + m[1] + '_' + m[2];
      const m1 = location.pathname.match(/(\d+)\.html$/);
      if (m1) return 'id:' + m1[1];
      const v = window.__mgp_video && window.__mgp_video.dataset;
      if (v) { const d = v.id || v.vid || v.mgpid; if (d) return 'id:' + d; }
      return location.origin + location.pathname;
    }
    let map = {}, titles = {};
    try { map = JSON.parse(localStorage.getItem('mpp_logs') || '{}') || {}; } catch (e) { }
    try { titles = JSON.parse(localStorage.getItem('mpp_titles') || '{}') || {}; } catch (e) { }
    let removed = 0;
    keys.forEach(k => { if (k in map || k in titles) removed++; delete map[k]; delete titles[k]; });
    localStorage.setItem('mpp_logs', JSON.stringify(map));
    localStorage.setItem('mpp_titles', JSON.stringify(titles));
    if (keys.indexOf(vkey()) !== -1) {
      try { window.dispatchEvent(new CustomEvent('mgp-reload')); } catch (e) { }
    }
    return removed;
  }
  // v2.0 历史：全选后清除 = 清除所有记录，直接清空整个存储（含未被列表列出的残留 key）
  function fnClearAll() {
    let removed = 0;
    try { removed = Object.keys(JSON.parse(localStorage.getItem('mpp_logs') || '{}') || {}).length; } catch (e) { }
    localStorage.removeItem('mpp_logs');
    localStorage.removeItem('mpp_titles');
    try { window.dispatchEvent(new CustomEvent('mgp-reload')); } catch (e) { }
    return removed;
  }

  // ─── 状态 ───────────────────────────────────
  let logs = { inOut: [], marks: [] };
  let baseURL = '';
  let curOrigin = '';
  let curHost = '';
  let sel = { io: new Set(), mk: new Set() };
  let lastSig = '';
  let show = 'mk';
  let els = {};
  let histItems = [];
  let histSel = new Set();

  const MARK_COLORS = [
    ['红', '#e74c3c'], ['橙', '#ff7a1a'], ['蓝', '#3498db'], ['绿', '#2ecc71'], ['灰', '#9aa0a6']
  ];
  function markColor(m) { return (m && m.color) || null; }
  function colorName(hex) {
    const c = MARK_COLORS.find(([, v]) => v === hex);
    return c ? c[0] : '';
  }
  const $ = s => document.querySelector(s);

  // ─── 工具 ───────────────────────────────────
  function fmtDur(s) { return String(Math.round(s * 2) / 2); }
  // 列表序号：固定两位（1 → 01），超过两位按实际位数（100 → 100）
  function seqNo(i) { const n = (Number(i) || 0) + 1; return n < 10 ? '0' + n : String(n); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function linkFor(time, url) {
    const base = (url || baseURL).split('#')[0];
    try {
      return /mgtv\.com$/.test(new URL(base).hostname) ? base + '#mpp=' + time : base;
    } catch (e) { return base; }
  }
  function copyText(text) {
    return navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { }
      document.body.removeChild(ta);
      if (!ok) throw new Error('copy-fail');
    });
  }

  const SETTINGS_KEY = 'mpp_settings';
  // 默认白名单站点：无需「应用于当前网页」授权即可打点（芒果TV 与百度网盘）
  function isMgtv(host) { return !!host && /mgtv\.com$/.test(host); }
  function isDefaultHost(host) { return isMgtv(host) || host === 'pan.baidu.com'; }
  // ─── 面板轻提示（导入 / 删除 / 导出等面板操作反馈）──
  let panelToastTimer = null;
  function panelToast(msg) {
    let t = document.getElementById('mpp-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mpp-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(panelToastTimer);
    panelToastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function getSettings() {
    return chrome.storage.local.get(SETTINGS_KEY).then(s =>
      Object.assign({ enabled: true, activeHosts: [], theme: 'dark', logEnabled: true, barEnabled: true, noteFileName: true }, s[SETTINGS_KEY] || {}));
  }

  // ─── 二次确认弹窗 ──────────────────────────
  // 键盘：← / → 在「取消 / 确认」之间切换焦点，Enter 触发当前聚焦按钮；
  // 默认聚焦主操作（确认），危险操作（danger）默认聚焦「取消」，避免误按 Enter 删除
  // opts.input = { label, value, maxLength, hint } → 弹窗里多一个可编辑输入框
  //   （批量截图 / 录制用它确认「标题」：标题会写进这次产出的文件名）
  let confirmResolve = null;
  function confirmDlgEx(message, okLabel, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      let m = document.getElementById('mpp-confirm');
      if (!m) {
        m = document.createElement('div');
        m.id = 'mpp-confirm';
        m.className = 'mpp-mask';
        m.innerHTML =
          '<div class="mpp-modal">' +
            '<div class="mpp-modal-title">确认操作</div>' +
            '<div class="mpp-modal-msg"></div>' +
            '<div class="mpp-modal-field" hidden>' +
              '<span class="mpp-modal-label"></span>' +
              '<input type="text" spellcheck="false">' +
              '<span class="mpp-modal-hint" hidden></span>' +
            '</div>' +
            '<div class="mpp-modal-actions">' +
              '<button type="button" class="mpp-cancel">取消</button>' +
              '<button type="button" class="mpp-ok danger">确认</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(m);
        const cancelEl = m.querySelector('.mpp-cancel');
        const okEl0 = m.querySelector('.mpp-ok');
        const fieldEl = m.querySelector('.mpp-modal-field');
        const inpEl = fieldEl.querySelector('input');
        cancelEl.addEventListener('click', () => finishConfirm(false));
        okEl0.addEventListener('click', () => finishConfirm(true));
        m.addEventListener('click', e => { if (e.target === m) finishConfirm(false); });
        document.addEventListener('keydown', e => {
          if (m.hidden) return;
          if (e.key === 'Escape') { e.preventDefault(); finishConfirm(false); return; }
          // 输入框里左右键要移光标，不抢去切按钮
          const inField = !fieldEl.hidden && document.activeElement === inpEl;
          if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !inField) {
            e.preventDefault();
            const to = document.activeElement === okEl0 ? cancelEl : okEl0;
            to.focus();
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            const cur = document.activeElement;
            (cur === cancelEl || cur === okEl0 ? cur : okEl0).click();
          }
        });
      }
      const msgEl = m.querySelector('.mpp-modal-msg');
      const okEl = m.querySelector('.mpp-ok');
      const cancelEl = m.querySelector('.mpp-cancel');
      const field = m.querySelector('.mpp-modal-field');
      const inp = field.querySelector('input');
      const cfgIn = opts.input;
      msgEl.textContent = message;
      okEl.textContent = okLabel || '确认';
      // 危险操作（删除类）主按钮用红色样式，且默认焦点落在「取消」，避免误按 Enter
      okEl.classList.toggle('danger', !!opts.danger);
      if (cfgIn) {
        field.hidden = false;
        field.querySelector('.mpp-modal-label').textContent = cfgIn.label || '';
        inp.value = cfgIn.value == null ? '' : String(cfgIn.value);
        inp.maxLength = cfgIn.maxLength || 80;
        const hintEl = field.querySelector('.mpp-modal-hint');
        hintEl.textContent = cfgIn.hint || '';
        hintEl.hidden = !cfgIn.hint;
      } else {
        field.hidden = true;
        inp.value = '';
      }
      confirmResolve = resolve;
      m.hidden = false;
      // 默认焦点：危险操作停在「取消」，其余停在主操作按钮（带输入框时停在输入框）
      setTimeout(() => {
        if (m.hidden) return;
        const target = okEl.classList.contains('danger') ? cancelEl : (cfgIn ? inp : okEl);
        target.focus();
        if (cfgIn && target === inp) { try { inp.select(); } catch (e) { } }
      }, 0);
    });
  }
  // 返回布尔（沿用旧调用方）：确认 / 取消；opts.danger 用于删除类操作
  function confirmDlg(message, okLabel, opts) {
    return confirmDlgEx(message, okLabel, opts).then(r => !!r.ok);
  }
  function finishConfirm(val) {
    const m = document.getElementById('mpp-confirm');
    const field = m ? m.querySelector('.mpp-modal-field') : null;
    const value = (field && !field.hidden) ? field.querySelector('input').value : '';
    if (m) m.hidden = true;
    if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r({ ok: val === true, value: value }); }
  }

  // ─── 初始化 ─────────────────────────────────
  function init(cfg) {
    els.mkList = $(cfg.mkList);
    els.ioList = $(cfg.ioList);
    els.cntMk = $(cfg.cntMk);
    els.cntIo = $(cfg.cntIo);
    els.sumIo = $(cfg.sumIo);
    els.selCount = $(cfg.selCount);
    els.btnAll = $(cfg.btnAll);
    els.btnClear = $(cfg.btnClear);
    els.btnExport = $(cfg.btnExport);
    els.btnReload = $(cfg.btnReload);
    els.btnSettings = $(cfg.btnSettings);
    els.settingsMenu = $(cfg.settingsMenu);
    els.btnMode = $(cfg.btnMode);
    els.modeMenu = $(cfg.modeMenu);
    els.togShot = $(cfg.togShot);
    els.togAvoid = $(cfg.togAvoid);
    els.togPip = $(cfg.togPip);
    els.selCodec = $(cfg.selCodec);
    els.togBar = $(cfg.togBar);
    els.togDanmu = $(cfg.togDanmu);
    els.togAll = $(cfg.togAll);
    els.togTheme = $(cfg.togTheme);
    els.setRowAll = $(cfg.setRowAll);
    els.btnWebFs = $(cfg.btnWebFs);
    els.btnHelp = $(cfg.btnHelp);
    els.sumSep = $(cfg.sumSep);
    els.btnSearch = $(cfg.btnSearch);
    els.searchBar = $(cfg.searchBar);
    els.searchIn = $(cfg.searchIn);
    els.searchHit = $(cfg.searchHit);
    els.searchClear = $(cfg.searchClear);
    els.searchColors = $(cfg.searchColors);
    els.err = $(cfg.err);
    els.wrap = $(cfg.wrap);
    els.footer = $(cfg.footer);
    els.pageTitle = $(cfg.pageTitle);
    els.btnHistory = $(cfg.btnHistory);
    els.historyMenu = $(cfg.historyMenu);
    els.histList = $(cfg.histList);
    els.histImport = $(cfg.histImport);
    els.histAll = $(cfg.histAll);
    els.histClear = $(cfg.histClear);
    if (isWindowMode()) document.title = '芒着拉片 | MG Player+';
    bindList(els.mkList);
    if (els.ioList !== els.mkList) bindList(els.ioList);
    els.btnAll.addEventListener('click', toggleAll);
    bindSearch();
    els.btnClear.addEventListener('click', clearSel);
    els.btnExport.addEventListener('click', exportExcel);
    if (els.btnReload) els.btnReload.addEventListener('click', () => {
      // v2.0：重新加载整个插件（改动代码后一键生效）
      chrome.runtime.reload();
    });
    bindSettings();
    bindModeMenu();
    bindCollapse();
    bindSelectAll();
    bindHistory();
    bindTitleEdit();
    bindBatchKeys();   // 面板内按 S / R 批量截图、录制
  }

  // ─── 数据加载 ───────────────────────────────
  async function load(force) {
    let res;
    try { res = await execInPage(fnGetLogs); } catch (e) { res = null; }
    const settings = await getSettings();
    if (res && res.baseURL) {
      try {
        const u = new URL(res.baseURL);
        if (/^https?:$/.test(u.protocol)) { curOrigin = u.origin; curHost = u.hostname; }
      } catch (e) { }
    }
    const onDefault = isDefaultHost(res && res.host);
    const active = !!(res && res.host) && Array.isArray(settings.activeHosts) && settings.activeHosts.indexOf(res.host) !== -1;
    // v2.0：面板是否可用取决于「日志记录」开关（与视频控制栏开关互不影响）
    const logOn = settings.logEnabled !== false;
    const valid = !!(res && res.host) && logOn && (onDefault || active);
    if (els.togAll) els.togAll.checked = !onDefault && active;
    if (els.setRowAll) els.setRowAll.hidden = onDefault;
    // 时间码显示回避：未手动设置过时按站点默认（芒果TV开、其他站点关）
    if (els.togAvoid) els.togAvoid.checked = settings.avoidTimecode === undefined ? isMgtv(res && res.host) : settings.avoidTimecode !== false;
    // 打点自动截图：未手动设置过时按站点默认（百度网盘开、其他站点关）
    if (els.togShot) els.togShot.checked = settings.autoShot === undefined ? (res && res.host === 'pan.baidu.com') : settings.autoShot === true;
    if (els.err) {
      els.err.innerHTML = settings.logEnabled === false
        ? '日志记录已关闭<br>点击右上角设置按钮重新开启'
        : '请在芒果TV视频页面打开此面板<br>或开启「应用于当前网页」';
    }
    setVisible(valid);
    pageValid = valid;
    // 标题始终跟随当前网页：未开启「应用于当前网页」的页面也显示网页名，而非残留上一页标题
    if (els.pageTitle) {
      const t = (res && res.title) || '';
      // 标题编辑中不打断显隐，避免输入框与标题同时出现
      if (document.querySelector('.pg-title-edit')) {
        els.pageTitle.textContent = t;
      } else if (t) {
        els.pageTitle.textContent = t;
        els.pageTitle.title = t;
        els.pageTitle.hidden = false;
      } else {
        els.pageTitle.hidden = true;
      }
    }
    if (!valid) return false;
    const sig = JSON.stringify(res.logs);
    if (!force && sig === lastSig) return true;
    // 备注 / 标题编辑中：跳过本轮刷新，避免重建列表销毁输入框打断编辑（保存后下一轮自动同步）
    if (!force && document.querySelector('.note-edit:not([hidden])')) return true;
    if (!force && document.querySelector('.pg-title-edit')) return true;
    lastSig = sig;
    // 数据变化时按记录指纹保留仍存在的选中项，避免轮询刷新打断勾选
    const prev = logs;
    logs = res.logs || { inOut: [], marks: [] };
    baseURL = res.baseURL || '';
    keepSelection(prev);
    render();
    // 历史菜单打开期间记录变化（打点 / 删除）时同步刷新列表
    if (els.historyMenu && !els.historyMenu.hidden) loadHistory();
    return true;
  }

  // 记录指纹：以时间码与时刻定位记录（备注 / 颜色等可变字段不参与匹配）
  function fpMark(m) {
    return m && m.tc != null ? 'mk:' + m.tc + ':' + (m.time != null ? m.time.toFixed(3) : '') : '';
  }
  function fpIO(u) {
    return u && u.inTC != null
      ? 'io:' + u.inTC + ':' + (u.inTime != null ? u.inTime.toFixed(3) : '') + ':' + (u.outTime != null ? u.outTime.toFixed(3) : '')
      : '';
  }
  function keepSelection(prev) {
    const oldIo = new Set([...sel.io].map(i => prev.inOut[i]).filter(Boolean).map(fpIO));
    const oldMk = new Set([...sel.mk].map(i => prev.marks[i]).filter(Boolean).map(fpMark));
    sel.io = new Set(logs.inOut.map((u, i) => (oldIo.has(fpIO(u)) ? i : -1)).filter(i => i >= 0));
    sel.mk = new Set(logs.marks.map((m, i) => (oldMk.has(fpMark(m)) ? i : -1)).filter(i => i >= 0));
  }

  function setVisible(valid) {
    if (els.wrap) els.wrap.hidden = !valid;
    if (els.footer) els.footer.hidden = !valid;
    if (els.searchBar) els.searchBar.hidden = !valid || (!searchOpen && !noteQuery);
    if (els.err) els.err.hidden = valid;
  }

  // ─── 渲染 ───────────────────────────────────
  // 备注搜索：仅按备注文本过滤列表（大小写不敏感），记录与勾选状态都不受影响
  let noteQuery = '';
  function noteMatch(note) {
    if (!noteQuery) return true;
    return String(note || '').toLowerCase().indexOf(noteQuery) !== -1;
  }
  // 颜色筛选只对标记点生效（片段没有颜色）
  function colorMatch(m) {
    if (!colorQuery.size) return true;
    return colorQuery.has((m && m.color) || '');
  }
  function filteredIdx(kind) {
    const arr = kind === 'io' ? logs.inOut : logs.marks;
    return arr.map((r, i) => {
      if (!r) return -1;
      if (kind === 'mk' && !colorMatch(r)) return -1;
      return noteMatch(r.note) ? i : -1;
    }).filter(i => i >= 0);
  }
  function matchCount() {
    return filteredIdx('mk').length + filteredIdx('io').length;
  }
  // 备注文本 → 可安全插入的 HTML：搜索命中的片段包进 <mark> 高亮（逐段转义，防 XSS）
  function noteHTML(text) {
    const src = String(text == null ? '' : text);
    if (!noteQuery) return esc(src);
    const lower = src.toLowerCase();
    let out = '', from = 0;
    for (let at = lower.indexOf(noteQuery); at >= 0; at = lower.indexOf(noteQuery, from)) {
      out += esc(src.slice(from, at)) + '<mark class="hl">' + esc(src.slice(at, at + noteQuery.length)) + '</mark>';
      from = at + noteQuery.length;
      if (!noteQuery.length) break;
    }
    return out + esc(src.slice(from));
  }

  // 列表滚动容器：弹窗只有一条列表（mkList === ioList），侧边栏两条
  function listScrollers() {
    const out = [];
    [els.mkList, els.ioList].forEach(el => { if (el && out.indexOf(el) < 0) out.push(el); });
    return out;
  }
  // 滚动位置快照 / 还原：render() 会整表重建（list.innerHTML = ''），重建过程会让滚动容器
  // 的滚动位置被浏览器重新计算 —— 表现为「保存备注后列表跳一下」（每秒轮询刷新即触发）。
  // 重建前后按像素还原，用户当前浏览的位置就不会动。
  function anchorScroll() {
    const snap = listScrollers().map(el => [el, el.scrollTop, el.scrollLeft]);
    return () => snap.forEach(s => {
      if (s[0].scrollTop !== s[1]) s[0].scrollTop = s[1];
      if (s[0].scrollLeft !== s[2]) s[0].scrollLeft = s[2];
    });
  }

  function render() {
    const restoreScroll = anchorScroll();
    updateSearchBar();
    els.mkList.classList.add('cards');
    if (els.ioList === els.mkList) {
      if (show === 'mk') renderMarks(els.mkList);
      else renderIO(els.ioList);
    } else {
      els.ioList.classList.add('cards');
      renderMarks(els.mkList);
      renderIO(els.ioList);
    }
    updateSel();
    restoreScroll();
  }

  function setTab(t) {
    show = t;
    render();
    // 切标签页要的是一个全新的列表：回到顶部（render 的滚动还原只服务于「刷新不跳动」）
    listScrollers().forEach(el => { el.scrollTop = 0; });
  }

  function noteLineHTML(hasNote) {
    return '<span class="note-line"' + (hasNote ? '' : ' hidden') + '>' +
      '<span class="note-text"></span>' +
      '<textarea class="note-edit" rows="1" spellcheck="false" hidden></textarea>' +
      '</span>';
  }

  function renderMarks(list) {
    if (!logs.marks.length) { list.innerHTML = '<div class="empty">暂无标记点记录</div>'; return; }
    const idxs = filteredIdx('mk');
    if (!idxs.length) { list.innerHTML = '<div class="empty">' + esc(noMatchText('标记点')) + '</div>'; return; }
    list.innerHTML = '';
    idxs.forEach(i => {
      const m = logs.marks[i];
      const row = document.createElement('div');
      row.className = 'row' + (sel.mk.has(i) ? ' sel' : '');
      row.dataset.mk = i;
      row.innerHTML =
        '<input type="checkbox" class="chk"' + (sel.mk.has(i) ? ' checked' : '') + '>' +
        '<span class="idx">' + seqNo(i) + '</span>' +
        // esc() 转义：tc 来自页面 localStorage（mpp_logs），恶意站点页面脚本可注入任意内容，
        // 未转义会在扩展面板上下文执行（存储型 XSS → 扩展权限提升）
        '<span class="tc mk">' + esc(m.tc) + '</span>' +
        '<span class="mk-colors">' + MARK_COLORS.map(([name, v]) =>
          '<span class="mc-dot' + (m.color === v ? ' on' : '') + '" data-c="' + v + '" data-n="' + name + '" style="--dc:' + v + '" title="设为' + name + '色"></span>'
        ).join('') + '</span>' +
        noteLineHTML(!!m.note);
      list.appendChild(row);
    });
  }

  function renderIO(list) {
    if (!logs.inOut.length) { list.innerHTML = '<div class="empty">暂无入点到出点记录</div>'; return; }
    const idxs = filteredIdx('io');
    if (!idxs.length) { list.innerHTML = '<div class="empty">' + esc(noMatchText('片段')) + '</div>'; return; }
    list.innerHTML = '';
    idxs.forEach(i => {
      const u = logs.inOut[i];
      const row = document.createElement('div');
      row.className = 'row' + (sel.io.has(i) ? ' sel' : '');
      row.dataset.io = i;
      row.innerHTML =
        '<input type="checkbox" class="chk"' + (sel.io.has(i) ? ' checked' : '') + '>' +
        '<span class="idx">' + seqNo(i) + '</span>' +
        // esc() 转义：时间码字段来自页面 localStorage，防存储型 XSS
        '<span class="tc in">' + esc(u.inTC) + '</span>' +
        '<span class="sep">&rarr;</span>' +
        '<span class="tc out">' + esc(u.outTC) + '</span>' +
        '<span class="dur">' + fmtDur(u.dur) + 's</span>' +
        noteLineHTML(!!u.note);
      list.appendChild(row);
    });
  }
  // 无匹配时的空列表文案：说清是按什么筛掉的（备注关键词 / 颜色）
  function noMatchText(kindName) {
    const bits = [];
    if (noteQuery) bits.push('备注含「' + noteQuery + '」');
    if (colorQuery.size) bits.push('颜色为' + [...colorQuery].map(colorName).filter(Boolean).join('/'));
    return bits.length ? '没有' + bits.join('且') + '的' + kindName : '没有匹配的' + kindName;
  }

  function updateSel() {
    const n = sel.mk.size + sel.io.size;
    if (els.selCount) els.selCount.textContent = '已选' + n + '条记录';
    if (els.btnClear) els.btnClear.disabled = n === 0;
    if (els.btnExport) els.btnExport.disabled = n === 0;
    // v2.0：计时器统计已选中的入点到出点记录；未选中任何入出点则不显示
    if (els.sumIo) {
      const selIo = logs.inOut.filter((u, i) => sel.io.has(i));
      els.sumIo.textContent = selIo.length
        ? fmtDur(selIo.reduce((a, u) => a + (u.outTime - u.inTime), 0)) + 's'
        : '';
      if (els.sumSep) els.sumSep.hidden = !selIo.length;
    }
    // 「全选」高亮按当前可见（搜索过滤后）的记录判断
    document.querySelectorAll('.sec-head .tag').forEach(tag => {
      const key = tag.dataset.set === 'io' ? 'io' : 'mk';
      const vis = filteredIdx(key);
      tag.classList.toggle('all-sel', vis.length > 0 && vis.every(i => sel[key].has(i)));
    });
    updateNoteLines();
  }

  // ─── 备注搜索（关键词 + 标记颜色筛选）────────
  let searchOpen = false;
  let colorQuery = new Set();          // 选中的颜色（hex）；空集 = 不按颜色筛
  function isFiltering() { return !!noteQuery || colorQuery.size > 0; }
  function filterSummary() {
    const bits = [];
    if (noteQuery) bits.push('备注「' + noteQuery + '」');
    if (colorQuery.size) bits.push([...colorQuery].map(colorName).filter(Boolean).join('/') + '色');
    return bits.join(' + ');
  }
  function updateSearchBar() {
    const on = isFiltering();
    if (els.searchBar) els.searchBar.hidden = !on && !searchOpen;
    if (els.searchHit) {
      const n = matchCount();
      els.searchHit.textContent = on ? (n ? '匹配 ' + n + ' 条' : '无匹配') : '';
    }
    if (els.btnSearch) els.btnSearch.classList.toggle('on', on);
    // 搜索时，标记 / 片段右侧「全选」上的数字改成搜索结果数（点击全选选中的就是这批）
    if (els.cntMk) els.cntMk.textContent = on ? filteredIdx('mk').length : logs.marks.length;
    if (els.cntIo) els.cntIo.textContent = on ? filteredIdx('io').length : logs.inOut.length;
  }
  // 颜色筛选圆点（在搜索输入框内部靠右）：按当前选中态刷新高亮
  function syncColorChips() {
    if (!els.searchColors) return;
    els.searchColors.querySelectorAll('.sc-dot').forEach(d => {
      d.classList.toggle('on', colorQuery.has(d.dataset.c));
    });
  }
  function openSearch(open) {
    searchOpen = open;
    if (els.searchBar) els.searchBar.hidden = !open && !noteQuery;
    if (open && els.searchIn) { els.searchIn.focus(); els.searchIn.select(); }
    if (!open && isFiltering()) {
      noteQuery = ''; colorQuery.clear();
      if (els.searchIn) els.searchIn.value = '';
      syncColorChips();
      render();
    } else if (!open) {
      syncColorChips();
      updateSearchBar();
    }
  }
  function clearSearch() {
    noteQuery = ''; colorQuery.clear();
    if (els.searchIn) els.searchIn.value = '';
    syncColorChips();
    render();
  }
  function bindSearch() {
    if (els.btnSearch) els.btnSearch.addEventListener('click', () => openSearch(els.searchBar ? els.searchBar.hidden : true));
    // 颜色筛选圆点（搜索输入框内部靠右）：按 MARK_COLORS 生成，避免两个页面各写一份
    // 再点一次即取消该颜色，因此不需要「清除」按钮
    if (els.searchColors && !els.searchColors.querySelector('.sc-dot')) {
      els.searchColors.innerHTML = MARK_COLORS.map(([name, v]) =>
        '<span class="sc-dot" data-c="' + v + '" style="--dc:' + v + '" title="只看' + name + '色标记点（再点取消）"></span>'
      ).join('');
      els.searchColors.addEventListener('click', e => {
        const dot = e.target.closest('.sc-dot');
        if (!dot) return;
        const c = dot.dataset.c;
        if (colorQuery.has(c)) colorQuery.delete(c); else colorQuery.add(c);
        syncColorChips();
        render();
      });
    }
    syncColorChips();
    if (els.searchIn) {
      els.searchIn.addEventListener('input', () => {
        noteQuery = els.searchIn.value.trim().toLowerCase();
        render();
      });
      els.searchIn.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); openSearch(false); }
        else if (e.key === 'Enter') { e.preventDefault(); els.searchIn.blur(); }
        if (e.isComposing) return;
      });
    }
    if (els.searchClear) els.searchClear.addEventListener('click', () => {
      // 搜索栏为空（也没选颜色）时，× 直接关掉搜索栏；有内容时先清空内容
      const empty = !els.searchIn || !els.searchIn.value.trim();
      if (empty && !colorQuery.size) { openSearch(false); return; }
      clearSearch();
      if (els.searchIn) els.searchIn.focus();
    });
  }

  // ─── 打点备注：有备注的记录始终展示；选中单条时显示其备注行（可编辑）──
  function updateNoteLines() {
    document.querySelectorAll('.note-line').forEach(el => {
      const row = el.closest('.row');
      if (!row) return;
      // 备注与时间码左对齐（序号宽度不定，需实测行内偏移）
      const tc = row.querySelector('.tc');
      if (tc) {
        const padL = parseFloat(getComputedStyle(row).paddingLeft) || 0;
        el.style.marginLeft = (tc.getBoundingClientRect().left - row.getBoundingClientRect().left - padL) + 'px';
      }
      const isMk = row.dataset.mk !== undefined;
      const idx = parseInt(isMk ? row.dataset.mk : row.dataset.io, 10);
      const rec = isMk ? logs.marks[idx] : logs.inOut[idx];
      const hasNote = !!(rec && rec.note);
      el.hidden = !hasNote;
      const text = el.querySelector('.note-text');
      if (text) {
        // 搜索命中处高亮（noteHTML 内部已逐段转义）
        text.innerHTML = hasNote ? noteHTML(rec.note) : '添加备注…';
        text.classList.toggle('empty', !hasNote);
      }
      const edit = el.querySelector('.note-edit');
      // 正在编辑的输入框不被覆写，避免选中态变化时清空已输入内容
      if (edit && edit !== document.activeElement) edit.value = rec ? (rec.note || '') : '';
    });
    if (sel.mk.size + sel.io.size !== 1) return;
    let idx = -1, type = '';
    if (sel.mk.size === 1) { idx = [...sel.mk][0]; type = 'mk'; }
    else if (sel.io.size === 1) { idx = [...sel.io][0]; type = 'io'; }
    else return;
    const target = type === 'mk' ? els.mkList : els.ioList;
    const row = target.querySelector('.row[data-' + type + '="' + idx + '"]');
    if (!row) return;
    const line = row.querySelector('.note-line');
    if (!line) return;
    const rec = type === 'mk' ? logs.marks[idx] : logs.inOut[idx];
    if (!rec) return;
    line.hidden = false;
    const text = line.querySelector('.note-text');
    if (text) {
      text.innerHTML = rec.note ? noteHTML(rec.note) : '添加备注…';
      text.classList.toggle('empty', !rec.note);
    }
    const edit = line.querySelector('.note-edit');
    if (edit) edit.value = rec.note || '';
  }

  // 多行备注：输入时按内容自动增高（保留手动拖拽改高的余地）。
  // scrollHeight 不含上下边框，需加上边框高度，否则内容溢出 2px 触发内部滚动条，
  // 滚动条挤窄文本宽度导致换行点变化，编辑与完成状态行数不一致。
  function growEdit(edit) {
    edit.style.height = 'auto';
    const extra = (edit.offsetHeight - edit.clientHeight) || 2;
    edit.style.height = Math.max(18, edit.scrollHeight + extra) + 'px';
  }
  function enterNoteEdit(edit) {
    const text = edit.parentElement.querySelector('.note-text');
    if (text) {
      // 进入编辑态时与展示文本同高，避免布局跳动（多行备注也不会塌缩成一行）
      edit.style.height = Math.max(18, text.getBoundingClientRect().height) + 'px';
      text.hidden = true;
    }
    delete edit.dataset.committing;
    edit.hidden = false;
    edit.focus();
    try { edit.setSelectionRange(edit.value.length, edit.value.length); } catch (e) { }
  }
  function cancelNoteEdit(edit) {
    const text = edit.parentElement.querySelector('.note-text');
    edit.hidden = true;
    if (text) text.hidden = false;
    // 编辑态曾把显示文本写成纯文本：取消 / 结束后恢复成带搜索高亮的样子
    updateNoteLines();
  }
  function commitNoteEdit(edit) {
    // 防重提交：Enter 后失焦会再触发一次 blur 保存，跳过避免用旧值覆盖已存内容
    if (edit.dataset.committing) return;
    edit.dataset.committing = '1';
    const line = edit.closest('.note-line');
    const row = line.closest('.row');
    if (!row) return;
    const isMk = row.dataset.mk !== undefined;
    const idx = parseInt(isMk ? row.dataset.mk : row.dataset.io, 10);
    const rec = isMk ? logs.marks[idx] : logs.inOut[idx];
    const val = edit.value.trim();
    if (!rec) return;
    execInPage(fnSetNote, [isMk ? 'mk' : 'io', idx, val]).then(ok => {
      if (!ok) { edit.value = val; delete edit.dataset.committing; return; } // 保存失败：恢复输入内容，停留编辑态
      if (val) rec.note = val; else delete rec.note;
      // 原地更新显示，不重建整表（避免打断勾选等其他交互）
      cancelNoteEdit(edit);
      updateNoteLines();
    }).catch(() => { edit.value = val; delete edit.dataset.committing; });
  }

  // ─── 侧边栏：折叠 + 标题点击全选 ─────────────
  function bindCollapse() {
    document.querySelectorAll('.collapse').forEach(btn => {
      btn.addEventListener('click', () => {
        const sec = btn.closest('.card') || btn.closest('section');
        if (!sec) return;
        sec.classList.toggle('collapsed');
        if (sec.classList.contains('collapsed')) {
          const other = sec.id === 'mk-sec'
            ? document.getElementById('io-sec')
            : document.getElementById('mk-sec');
          if (other) other.classList.remove('collapsed');
        }
      });
    });
  }

  function bindSelectAll() {
    document.querySelectorAll('.sec-head .tag').forEach(tag => {
      tag.addEventListener('click', () => {
        const key = tag.dataset.set === 'io' ? 'io' : 'mk';
        const total = key === 'io' ? logs.inOut.length : logs.marks.length;
        const allSel = total > 0 && sel[key].size === total;
        sel[key] = allSel ? new Set() : new Set(Array.from({ length: total }, (_, i) => i));
        render();
      });
    });
  }

  // 右键双击时间码：就地编辑（Enter 保存 / Esc 取消），保存后刷新列表
  function openTimeEdit(tcEl, isMk, idx, field) {
    if (!tcEl || tcEl.querySelector('.tc-edit')) return;
    const rec = isMk ? logs.marks[idx] : logs.inOut[idx];
    if (!rec) return;
    const cur = isMk ? rec.tc : (field === 'out' ? rec.outTC : rec.inTC);
    tcEl.style.position = 'relative';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'tc-edit';
    inp.spellcheck = false;
    inp.value = cur || '';
    inp.title = '修改时间码，Enter 保存，Esc 取消（支持 hh:mm:ss:ff / mm:ss:ff / mm:ss，或紧凑写法 hhmmssff / mmssff / mmss；中英文冒号、有无分隔符都可以）';
    tcEl.appendChild(inp);
    inp.focus();
    try { inp.select(); } catch (e) { }
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      const val = inp.value.trim();
      if (inp.parentElement) inp.parentElement.removeChild(inp);
      if (!save || !val) return;
      execInPage(fnGetFps).catch(() => 25).then(fps => {
        const sec = parseTcInput(val, fps || 25);
        if (sec == null) { panelToast('无法识别的时间码：' + val); return; }
        return execInPage(fnSetTime, [isMk ? 'mk' : 'io', idx, field, sec]).then(ok => {
          if (ok) { panelToast('已更新时间码'); load(true); }
          else panelToast('时间码更新失败');
        });
      }).catch(() => { });
    };
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.isComposing) return;   // 中文输入法组词中不拦截
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
  }

  // ─── 批量截图 / 录制：焦点在面板时按 S / R，对勾选的记录依次执行 ───
  let batchActive = false;   // 批量任务进行中（进行时面板内按 Esc 取消）
  let batchPoll = null;
  // 任务是否结束：优先用 batchRun 的返回结果，兜底轮询页面端 batchBusy
  // （executeScript 对 Promise 返回值是否等待由浏览器决定，轮询保证状态一定收敛）
  function batchEnded(isShot, r) {
    if (!batchActive) return;
    batchActive = false;
    if (batchPoll) { clearInterval(batchPoll); batchPoll = null; }
    if (r && r.reason === 'cancelled') {
      panelToast('已取消批量' + (isShot ? '截图' : '录制') + '（已完成 ' + (r.done || 0) + ' 条）');
    }
  }
  function startBatchWatch(isShot) {
    if (batchPoll) { clearInterval(batchPoll); batchPoll = null; }
    const startedAt = Date.now();
    batchPoll = setInterval(() => {
      // 起始 1.2s 内不判空：注入尚未落地时页面端 batchRunning 仍是 false
      if (Date.now() - startedAt < 1200) return;
      execInPage(fnBatchBusy, []).then(busy => { if (!busy) batchEnded(isShot, null); }).catch(() => { });
    }, 1000);
  }
  // 是否有「可见的」弹窗：确认弹窗元素常驻 DOM（关闭只是 hidden=true），
  // 必须过滤掉不可见元素——否则用过一次确认弹窗后，批量快捷键会永远被拦住
  function isDialogOpen() {
    const masks = document.querySelectorAll('.mpp-mask');
    for (let i = 0; i < masks.length; i++) if (!masks[i].hidden) return true;
    return false;
  }
  // 是否正在文本输入：只有文本类输入框 / 文本域 / 可编辑区域才让出快捷键。
  // 复选框、单选框（记录行勾选框）获得焦点时 S / R / Esc 仍应生效
  function isTextEntry(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = String(el.type || 'text').toLowerCase();
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
  }

  function bindBatchKeys() {
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // 放行浏览器组合键
      if (isTextEntry(e.target)) return;                // 输入框内（备注 / 时间码 / 搜索 / 粘贴）不抢键
      // 批量任务进行中：Esc 取消（焦点在面板窗口时页面收不到 Esc）
      if (e.key === 'Escape') {
        if (!batchActive) return;
        e.preventDefault();
        execInPage(fnBatchCancel, []).then(ok => {
          if (ok) panelToast('正在取消批量任务…');
        }).catch(() => { });
        return;
      }
      const k = String(e.key || '').toLowerCase();
      if (k !== 's' && k !== 'r') return;
      if (isDialogOpen()) return;   // 有可见弹窗时不触发批量快捷键
      const isShot = k === 's';
      // 批量截图只对标记点生效；批量录制只对片段生效（另一类勾选不参与）
      const kindName = isShot ? '标记点' : '片段';
      const idxs = isShot ? [...sel.mk].sort((a, b) => a - b) : [...sel.io].sort((a, b) => a - b);
      if (!idxs.length) {
        if (!sel.mk.size && !sel.io.size) return;   // 完全未勾选：不拦截按键
        e.preventDefault();
        panelToast('批量' + (isShot ? '截图' : '录制') + '只对' + kindName + '生效，请勾选' + kindName);
        return;
      }
      e.preventDefault();
      const n = idxs.length;
      // 批量前先确认标题：产出文件名取「标题_时间码_备注」，标题不对整批文件都要改名
      const curTitle = els.pageTitle ? String(els.pageTitle.textContent || '').trim() : '';
      confirmDlgEx('确认对选中的 ' + n + ' 条' + kindName + '依次自动' + (isShot ? '截图' : '录制') + '？', '开始', {
        input: {
          label: '标题（写入文件名）',
          value: curTitle,
          maxLength: 80,
          hint: '文件名格式：标题_时间码_备注；留空则用网页标题'
        }
      }).then(r => {
        if (!r.ok) return;
        const t = String(r.value || '').trim();
        if (t && t !== curTitle) {
          if (els.pageTitle) { els.pageTitle.textContent = t; els.pageTitle.title = t; els.pageTitle.hidden = false; }
          execInPage(fnSetTitle, [t]).catch(() => { });
        }
        const items = [];
        if (isShot) idxs.forEach(i => { const m = logs.marks[i]; if (m && m.time != null) items.push({ type: 'mk', time: m.time }); });
        else idxs.forEach(i => { const u = logs.inOut[i]; if (u && u.inTime != null && u.outTime != null) items.push({ type: 'io', start: u.inTime, end: u.outTime }); });
        items.sort((a, b) => ((a.type === 'mk' ? a.time : a.start) || 0) - ((b.type === 'mk' ? b.time : b.start) || 0));
        if (!items.length) { panelToast('选中的' + kindName + '没有可用时间码'); return; }
        panelToast('已开始批量' + (isShot ? '截图' : '录制') + '（' + items.length + ' 条）· 按 Esc 取消');
        batchActive = true;
        startBatchWatch(isShot);
        execInPage(fnBatchRun, [items, isShot ? 'shot' : 'rec']).then(r => {
          if (r && (r.ok === true || r.ok === false)) batchEnded(isShot, r);
        }).catch(() => { });
      });
    });
    // 面板重新打开时：页面端可能仍在跑批量任务，同步一次状态，使 Esc 仍可取消
    execInPage(fnBatchBusy, []).then(busy => {
      if (busy && !batchActive) { batchActive = true; startBatchWatch(false); }
    }).catch(() => { });
  }

  // ─── 列表交互 ───────────────────────────────
  function bindList(list) {
    if (!list) return;
    list.addEventListener('click', e => {
      const dot = e.target.closest('.mc-dot');
      if (dot) {
        const row = e.target.closest('.row');
        if (!row || row.dataset.mk === undefined) return;
        const idx = parseInt(row.dataset.mk, 10);
        const m = logs.marks[idx];
        if (!m) return;
        const color = dot.dataset.c;
        if (!color) return;
        const next = (m.color === color) ? null : color;
        execInPage(fnSetMarkColor, [idx, next]).then(ok => {
          if (!ok) return;
          if (next === null) delete m.color; else m.color = next;
          render();
          const name = dot.dataset.n || '';
          execInPage(fnToast, [next === null ? '已取消标记颜色' : '已设为' + name + '色']).catch(() => { });
        }).catch(() => { });
        return;
      }
      // 备注行：点击进入编辑；输入框区域不触发行的其他行为
      const noteText = e.target.closest('.note-text');
      if (noteText) {
        const edit = noteText.parentElement.querySelector('.note-edit');
        if (edit) enterNoteEdit(edit);
        return;
      }
      if (e.target.closest('.note-line')) return;
      if (e.target.closest('.chk')) return;
      const row = e.target.closest('.row');
      if (!row) return;
      const isMk = row.dataset.mk !== undefined;
      const idx = parseInt(isMk ? row.dataset.mk : row.dataset.io, 10);
      const rec = isMk ? logs.marks[idx] : logs.inOut[idx];
      if (!rec) return;
      const tcEl = e.target.closest('.tc');
      if (tcEl) {
        // 左键点击时间码：跳转到对应时刻
        let time;
        if (isMk) time = rec.time;
        else if (tcEl.classList.contains('out')) time = rec.outTime;
        else time = rec.inTime;
        if (time != null && isFinite(time)) execInPage(fnJump, [time]).catch(() => { });
        return;
      }
      // 点击记录行其他区域：为该条记录添加 / 编辑备注（原「点击行空白复制时间码」
      // 已改为右键时间码复制）
      const lineEl = row.querySelector('.note-line');
      if (lineEl) {
        lineEl.hidden = false;
        const textEl = lineEl.querySelector('.note-text');
        if (textEl) {
          textEl.textContent = rec.note || '添加备注…';
          textEl.classList.toggle('empty', !rec.note);
        }
        const editEl = lineEl.querySelector('.note-edit');
        if (editEl) {
          editEl.value = rec.note || '';
          enterNoteEdit(editEl);
        }
      }
    });
    // 右键点击时间码：单击复制紧凑时间码（如 00391214）；双击（同一条时间码
    // 400ms 内两次右键）进入时间码编辑，Enter 保存 / Esc 取消
    let ctxTimer = null, ctxKey = null;
    list.addEventListener('contextmenu', e => {
      const tcEl = e.target.closest('.tc');
      if (!tcEl) return;                 // 非时间码区域保留浏览器默认右键菜单
      e.preventDefault();
      const row = tcEl.closest('.row');
      if (!row) return;
      const isMk = row.dataset.mk !== undefined;
      const idx = parseInt(isMk ? row.dataset.mk : row.dataset.io, 10);
      const rec = isMk ? logs.marks[idx] : logs.inOut[idx];
      if (!rec) return;
      const field = isMk ? 'time' : (tcEl.classList.contains('out') ? 'out' : 'in');
      const key = (isMk ? 'mk' : 'io') + ':' + idx + ':' + field;
      // 右键双击 → 编辑该时间码
      if (ctxTimer && ctxKey === key) {
        clearTimeout(ctxTimer); ctxTimer = null; ctxKey = null;
        openTimeEdit(tcEl, isMk, idx, field);
        return;
      }
      ctxKey = key;
      clearTimeout(ctxTimer);
      ctxTimer = setTimeout(() => {
        ctxTimer = null; ctxKey = null;
        const raw = isMk ? rec.tc : (field === 'out' ? rec.outTC : rec.inTC);
        const compact = String(raw).replace(/:/g, '');
        copyText(compact)
          .then(() => execInPage(fnToast, ['已复制时间码 ( ' + compact + ' )']))
          .catch(() => { });
      }, 400);
    });
    list.addEventListener('change', e => {
      const chk = e.target.closest('.chk');
      if (!chk) return;
      const row = chk.closest('.row');
      const isMk = row.dataset.mk !== undefined;
      const idx = parseInt(isMk ? row.dataset.mk : row.dataset.io, 10);
      const set = isMk ? sel.mk : sel.io;
      if (chk.checked) set.add(idx); else set.delete(idx);
      row.classList.toggle('sel', chk.checked);
      updateSel();
    });
    // 备注输入：随内容自动增高
    list.addEventListener('input', e => {
      const edit = e.target.closest('.note-edit');
      if (edit) growEdit(edit);
    });
    // 备注编辑：Enter 保存 / Shift+Enter 换行 / Esc 取消 / 失焦保存
    // Enter 只结束编辑并保存，不改动勾选状态（选中项保持选中，便于接着批量截图 / 录制）
    list.addEventListener('keydown', e => {
      const edit = e.target.closest('.note-edit');
      if (!edit || edit.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); cancelNoteEdit(edit); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitNoteEdit(edit);
      }
    });
    list.addEventListener('focusout', e => {
      const edit = e.target.closest('.note-edit');
      if (!edit || edit.hidden) return;
      commitNoteEdit(edit);
    });
  }

  // ─── 底部按钮 ───────────────────────────────
  // 全选：搜索过滤生效时只选中「当前可见（备注匹配）」的记录
  function toggleAll() {
    const mkVis = filteredIdx('mk');
    const ioVis = filteredIdx('io');
    if (els.mkList === els.ioList) {
      // popup 单列表：全选只作用于当前选项卡
      const isMk = show === 'mk';
      const set = isMk ? sel.mk : sel.io;
      const vis = isMk ? mkVis : ioVis;
      if (vis.length && vis.every(i => set.has(i))) vis.forEach(i => set.delete(i));
      else vis.forEach(i => set.add(i));
    } else {
      // 侧边栏双列表：全选作用于两种记录
      const allOn = (mkVis.length > 0 || ioVis.length > 0)
        && mkVis.every(i => sel.mk.has(i)) && ioVis.every(i => sel.io.has(i));
      if (allOn) { mkVis.forEach(i => sel.mk.delete(i)); ioVis.forEach(i => sel.io.delete(i)); }
      else { mkVis.forEach(i => sel.mk.add(i)); ioVis.forEach(i => sel.io.add(i)); }
    }
    render();
  }

  async function clearSel() {
    const selObj = {
      inOut: [...sel.io].sort((a, b) => a - b),
      marks: [...sel.mk].sort((a, b) => a - b)
    };
    const n = selObj.inOut.length + selObj.marks.length;
    if (!n) return;
    const ok = await confirmDlg('确认删除选中的 ' + n + ' 条记录？此操作不可恢复。', '删除', { danger: true });
    if (!ok) return;
    try { await execInPage(fnRemove, [selObj]); } catch (e) { }
    sel.io.clear();
    sel.mk.clear();
    await load(true);
    // 历史菜单打开时同步刷新，避免删除后列表残留
    if (els.historyMenu && !els.historyMenu.hidden) loadHistory();
  }

  async function exportExcel() {
    const ioIdx = [...sel.io].sort((a, b) => a - b);
    const mkIdx = [...sel.mk].sort((a, b) => a - b);
    if (!ioIdx.length && !mkIdx.length) return;
    // v2.0：备注字段位于链接之前，标题位于链接之后
    const ioRows = [['序号', '入点时间码', '出点时间码', '时长', '备注', '入点链接', '标题']];
    ioIdx.forEach((i, n) => {
      const u = logs.inOut[i];
      ioRows.push([String(n + 1), u.inTC, u.outTC, fmtDur(u.dur), u.note || '', linkFor(u.inTime, u.url), u.title || '']);
    });
    const mkRows = [['序号', '时间码', '颜色', '备注', '链接', '标题']];
    mkIdx.forEach((i, n) => {
      const m = logs.marks[i];
      const hex = markColor(m);
      mkRows.push([String(n + 1), m.tc, hex ? colorName(hex) : '无', m.note || '', linkFor(m.time, m.url), m.title || '']);
    });
    const blob = new Blob([XlsxWriter.build(mkRows, ioRows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName();
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    panelToast('已导出记录');
  }

  // 导出文件命名：【标题_日志记录_导出时间】
  // 日志导出不写记录的时间码与备注（备注只存在于表格内容里）；
  // 标题取首条选中记录的标题 / 面板标题；导出时间为本地时间 YYYYMMDDHHMMSS
  function sanitizeName(s) {
    return String(s).replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function stampNow(d) {
    const p = n => String(n).padStart(2, '0');
    const t = d || new Date();
    return String(t.getFullYear()) + p(t.getMonth() + 1) + p(t.getDate())
      + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
  }
  function fileName() {
    const mkIdx = [...sel.mk].sort((a, b) => a - b);
    const ioIdx = [...sel.io].sort((a, b) => a - b);
    let rec = null;
    if (mkIdx.length) rec = logs.marks[mkIdx[0]];
    else if (ioIdx.length) rec = logs.inOut[ioIdx[0]];
    const fallback = els.pageTitle ? (els.pageTitle.textContent || '') : '';
    const title = sanitizeName((rec && rec.title) || fallback || '').replace(/\s+/g, '_').slice(0, 24);
    return (title ? title + '_' : '') + '日志记录_' + stampNow() + '.xlsx';
  }

  // ─── 显示模式切换（弹窗 / 侧边栏 / 独立窗口）────
  function isWindowMode() {
    try { return new URLSearchParams(location.search).get('win') === '1'; } catch (e) { return false; }
  }
  // 记忆上次使用的显示模式：浏览器重启后图标点击仍按该模式打开
  function saveLastMode(mode) {
    return getSettings().then(s => {
      s.lastMode = mode;
      return chrome.storage.local.set({ mpp_settings: s }).catch(() => { });
    });
  }
  function openSidebarMode() {
    chrome.action.setPopup({ popup: '' }).catch(() => { });
    // 点击图标由浏览器原生打开侧边栏，避免 onClicked 异步丢失手势
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
    saveLastMode('sidebar');
    return findTab().then(t => {
      if (t && t.id != null) {
        return chrome.sidePanel.open({ tabId: t.id }).catch(() => { });
      }
    });
  }
  function openWindowMode() {
    // 独立窗口：复用侧边栏布局，以紧凑 popup 窗口打开（无地址栏/标签栏，近似 QQ 登录小窗）
    chrome.action.setPopup({ popup: '' }).catch(() => { });
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => { });
    saveLastMode('window');
    return findTab().then(t => {
      if (t && t.id != null) rememberSrcTab(t.id);
      return chrome.windows.create({
        url: 'sidebar.html?win=1',
        type: 'popup',
        width: 430,
        height: 680,
        focused: true
      }).catch(() => { });
    });
  }
  function openPopupMode() {
    chrome.action.setPopup({ popup: 'popup.html' }).catch(() => { });
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => { });
    saveLastMode('popup');
    // 手势窗口内直接调用 openPopup（不 await 异步链，避免丢失手势）；
    // 失败时给出提示而非静默
    return chrome.action.openPopup().catch(() => { panelToast('请再次点击浏览器右上角插件图标'); });
  }
  function bindModeMenu() {
    if (!els.btnMode || !els.modeMenu) return;
    els.btnMode.addEventListener('click', e => {
      e.stopPropagation();
      if (els.settingsMenu) els.settingsMenu.hidden = true;
      if (els.historyMenu) els.historyMenu.hidden = true;
      els.modeMenu.hidden = !els.modeMenu.hidden;
    });
    document.addEventListener('click', e => {
      if (els.modeMenu.hidden) return;
      if (!e.target.closest('#mode-menu') && !e.target.closest('#btn-mode')) els.modeMenu.hidden = true;
    });
    const cur = isWindowMode() ? 'window'
      : document.body.classList.contains('pg-sidebar') ? 'sidebar' : 'popup';
    els.modeMenu.querySelectorAll('.mode-item').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === cur);
    });
    els.modeMenu.addEventListener('click', e => {
      const item = e.target.closest('.mode-item');
      if (!item || item.dataset.mode === cur) { els.modeMenu.hidden = true; return; }
      els.modeMenu.hidden = true;
      const mode = item.dataset.mode;
      const done = mode === 'sidebar' ? openSidebarMode() : mode === 'window' ? openWindowMode() : openPopupMode();
      done.finally(() => { try { window.close(); } catch (e) { } });
    });
  }

  // ─── 历史（有标记记录的视频列表）────────────
  // 选中状态持久化到会话存储：面板重开 / 历史菜单重开时恢复
  let histRestored = false;
  function saveHistSel() {
    chrome.storage.session.set({ mpp_hist_sel: [...histSel] }).catch(() => { });
  }
  function restoreHistSel() {
    if (histRestored) return;
    histRestored = true;
    chrome.storage.session.get('mpp_hist_sel').then(({ mpp_hist_sel }) => {
      if (!Array.isArray(mpp_hist_sel)) return;
      const valid = new Set(histItems.map(it => it.key));
      histSel = new Set(mpp_hist_sel.filter(k => valid.has(k)));
      renderHistory();
    }).catch(() => { });
  }
  function bindHistory() {
    if (!els.btnHistory || !els.historyMenu) return;
    els.btnHistory.addEventListener('click', e => {
      e.stopPropagation();
      if (els.settingsMenu) els.settingsMenu.hidden = true;
      if (els.modeMenu) els.modeMenu.hidden = true;
      els.historyMenu.hidden = !els.historyMenu.hidden;
      if (!els.historyMenu.hidden) loadHistory();
    });
    document.addEventListener('click', e => {
      if (els.historyMenu.hidden) return;
      if (!e.target.closest('#history-menu') && !e.target.closest('#btn-history')) els.historyMenu.hidden = true;
    });
    if (els.histList) {
      els.histList.addEventListener('click', e => {
        const item = e.target.closest('.hist-item');
        if (!item) return;
        const key = item.dataset.key;
        // 复选框：切换选中；其余区域：打开该视频
        if (e.target.closest('.chk')) {
          if (histSel.has(key)) histSel.delete(key); else histSel.add(key);
          // 仅更新当前行，不重建列表也不关闭菜单，便于连续勾选多项
          item.classList.toggle('sel', histSel.has(key));
          const chk = item.querySelector('.chk');
          if (chk) chk.checked = histSel.has(key);
          if (els.histClear) els.histClear.disabled = histSel.size === 0;
          saveHistSel();
          return;
        }
        const url = item.dataset.url;
        if (url) chrome.tabs.create({ url }).catch(() => { });
      });
    }
    // 导入：一个入口，弹窗里既能「从表格文件导入」也能「AI 导入」（非本插件导出的表格引导优先用 AI）
    if (els.histImport) els.histImport.addEventListener('click', () => { openQcImport({}).catch(() => { }); });
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
    document.addEventListener('drop', e => {
      e.preventDefault();
      const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter(f => /\.xlsx?$/i.test(f.name));
      if (files.length) importLogsFromFiles(files);
    });
    if (els.histAll) els.histAll.addEventListener('click', () => {
      const allSel = histItems.length > 0 && histSel.size === histItems.length;
      histSel = allSel ? new Set() : new Set(histItems.map(it => it.key));
      saveHistSel();
      renderHistory();
    });
    if (els.histClear) els.histClear.addEventListener('click', async () => {
      const keys = [...histSel];
      if (!keys.length) return;
      // 全选后清除 = 清除所有记录（直接清空整个存储）
      const all = histItems.length > 0 && histSel.size === histItems.length;
      const ok = await confirmDlg(
        all ? '确认清除所有历史记录？此操作不可恢复。'
            : '确认清除选中的 ' + keys.length + ' 个视频的标记记录？此操作不可恢复。',
        all ? '清除所有' : '清除',
        { danger: true }
      );
      if (!ok) return;
      try { await execInPage(all ? fnClearAll : fnRemoveHistory, all ? [] : [keys]); } catch (e) { }
      // 同步清除全局历史索引（跨网站）；务必等待写入完成后再刷新列表，
      // 否则 loadHistory 会读到旧索引并合并写回，被删条目“复活”
      await chrome.storage.local.get('mpp_history').then(({ mpp_history }) => {
        const map = (mpp_history && typeof mpp_history === 'object') ? mpp_history : {};
        if (all) Object.keys(map).forEach(k => delete map[k]);
        else keys.forEach(k => delete map[k]);
        return chrome.storage.local.set({ mpp_history: map });
      }).catch(() => { });
      // 同步清除导入日志明细（与历史索引保持一致）
      await chrome.storage.local.get('mpp_imported').then(({ mpp_imported }) => {
        const imp = (mpp_imported && typeof mpp_imported === 'object') ? mpp_imported : {};
        if (all) Object.keys(imp).forEach(k => delete imp[k]);
        else keys.forEach(k => delete imp[k]);
        return chrome.storage.local.set({ mpp_imported: imp });
      }).catch(() => { });
      histSel = new Set();
      saveHistSel();
      loadHistory();
      load(true);
      panelToast('已清除 ' + keys.length + ' 个视频的记录');
    });
  }

  // ─── 日志 Excel 导入（仅支持本插件导出的 xlsx）──
  function keyFromUrl(url) {
    try {
      const u = new URL(String(url || ''));
      const m = u.pathname.match(/(\d+)\/(\d+)\.html$/);
      if (m) return 'id:' + m[1] + '_' + m[2];
      const m1 = u.pathname.match(/(\d+)\.html$/);
      if (m1) return 'id:' + m1[1];
      return u.origin + u.pathname;
    } catch (e) { return null; }
  }
  // 时间码 → 秒（帧号按页面校准帧率 fps 换算，与导出时一致；链接含 #mpp= 时用精确值）
  function tcToSec(tc, fps) {
    const f = fps || 25;
    const p = String(tc || '').split(':').map(Number);
    if (p.length < 2 || p.some(isNaN)) return null;
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 3) return p[0] * 60 + p[1] + p[2] / f;
    if (p.length === 4) return p[0] * 3600 + p[1] * 60 + p[2] + p[3] / f;
    return null;
  }
  // 用户手动输入的时间码（面板就地编辑）：与页面控制栏右键输入完全同一套格式，
  // 支持 hh:mm:ss:ff / mm:ss:ff / mm:ss，以及无分隔的 hhmmssff / mmssff / mmss
  function parseTcInput(raw, fps) {
    const lib = window.MPGTcParse;
    if (lib && typeof lib.parseTCInput === 'function') return lib.parseTCInput(raw, fps);
    return tcToSec(raw, fps);
  }
  // 页面校准帧率（control-bar 暴露；导出/导入按同一帧率换算）
  function fnGetFps() {
    try { return window.__mgpFps || 25; } catch (e) { return 25; }
  }
  // 当前视频元信息：记录表导入需要时长判定时间码读法（分:秒:帧 / 时:分:秒）
  function fnVideoMeta() {
    try {
      const v = window.__mgp_video;
      const d = v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      return { duration: d, fps: window.__mgpFps || 25 };
    } catch (e) { return { duration: 0, fps: 25 }; }
  }
  function fmtSec(s) {
    const t = Math.max(0, Number(s) || 0);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = Math.floor(t % 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }
  // ─── 导入记录弹窗（三步：① 来源 → ② 工作表与方式 → ③ 确认清单）──────
  // ① 上传表格 或 粘贴时间码清单 → 下一步
  // ② 从表格导入时：选择要导入的工作表（单选）+ 导入方式（AI 导入推荐 / 直接导入）→ 下一步
  // ③ AI 导入：复制提示词 + 粘贴 AI 结果；直接导入：把解析结果以时间码清单呈现；
  //    两条路都在「确认导入」前亮出清单（所见即所导）；当前视频已有记录时再确认一次
  // ctx: { meta, files: [{name, sheets}], cands, sheets, sheetHint, aiFirst, notice }
  function qcDialog(ctx) {
    const meta = ctx.meta || { duration: 0, fps: 25 };
    return new Promise(resolve => {
      let m = document.getElementById('mpp-qc');
      if (m) m.remove();
      m = document.createElement('div');
      m.id = 'mpp-qc';
      m.className = 'mpp-mask';
      m.innerHTML =
        '<div class="mpp-modal wide qc-modal">' +
          '<div class="qc-title">导入记录</div>' +
          '<div class="qc-steps">' +
            '<span class="qc-stp" data-s="1">1 选择来源</span>' +
            '<span class="qc-stp" data-s="2">2 工作表与方式</span>' +
            '<span class="qc-stp" data-s="3">3 确认清单</span>' +
          '</div>' +
          '<div class="qc-notice" hidden></div>' +
          // ── 第一步：来源（表格 or 时间码清单）──
          '<div class="qc-stage" data-stage="1">' +
            '<div class="qc-drop">' +
              '<div class="qc-drop-main">把 .xlsx 表格拖到这里</div>' +
              '<div class="qc-drop-sub">或 <button type="button" class="qc-choose">点击选择文件</button></div>' +
              '<div class="qc-file" hidden></div>' +
            '</div>' +
            '<div class="qc-or">或直接粘贴时间码清单</div>' +
            '<textarea class="ai-input" spellcheck="false" placeholder="每行一条：时间码 + 说明，例如&#10;00:10:19:20 阿维塔 主持人口播&#10;101920 阿维塔 主持人口播（也兼容中文冒号 / 无冒号写法）"></textarea>' +
          '</div>' +
          // ── 第二步：工作表 + 导入方式（仅从表格导入）──
          '<div class="qc-stage" data-stage="2" hidden>' +
            '<div class="qc-step">选择要导入的工作表（一次一张）</div>' +
            '<div class="qc-pick-hint"></div>' +
            '<div class="qc-count"></div>' +
            '<div class="qc-list"></div>' +
            '<div class="qc-step">选择导入方式</div>' +
            '<div class="qc-way-row">' +
              '<label class="qc-way-opt"><input type="radio" name="qc-way" value="ai" checked><span>AI 导入<em>推荐</em></span></label>' +
              '<label class="qc-way-opt"><input type="radio" name="qc-way" value="direct"><span>直接导入</span></label>' +
            '</div>' +
            '<div class="qc-tip"></div>' +
          '</div>' +
          // ── 第三步：AI 提示词 / 清单确认 ──
          '<div class="qc-stage" data-stage="3" hidden>' +
            '<div class="qc-ai-box" hidden>' +
              '<div class="qc-step">用 AI 转换表格</div>' +
              '<div class="ai-bar">' +
                '<button type="button" class="ai-copy">复制提示词</button>' +
                '<span class="qc-tip2">把表格和提示词一起发给 AI，再把结果粘贴到下面</span>' +
              '</div>' +
              '<textarea class="ai-prompt" readonly hidden></textarea>' +
              '<textarea class="ai-input2" spellcheck="false" placeholder="粘贴 AI 输出的清单，例如&#10;00:10:19:20 阿维塔 主持人口播"></textarea>' +
            '</div>' +
            '<div class="qc-preview">' +
              '<div class="qc-preview-head"></div>' +
              '<div class="qc-preview-list"></div>' +
            '</div>' +
          '</div>' +
          '<div class="qc-foot">' +
            '<div class="ai-status"></div>' +
            '<button type="button" class="mpp-cancel">取消</button>' +
            '<button type="button" class="qc-prev" hidden>上一步</button>' +
            '<button type="button" class="mpp-ok">下一步</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(m);

      const noticeEl = m.querySelector('.qc-notice');
      const fileEl = m.querySelector('.qc-file');
      const dropEl = m.querySelector('.qc-drop');
      const stage1 = m.querySelector('.qc-stage[data-stage="1"]');
      const stage2 = m.querySelector('.qc-stage[data-stage="2"]');
      const stage3 = m.querySelector('.qc-stage[data-stage="3"]');
      const hintEl = m.querySelector('.qc-pick-hint');
      const listEl = m.querySelector('.qc-list');
      const countEl = m.querySelector('.qc-count');
      const tipEl = m.querySelector('.qc-tip');
      const input = m.querySelector('.ai-input');        // 第一步：粘贴时间码清单
      const aiInput = m.querySelector('.ai-input2');     // 第三步：粘贴 AI 结果
      const aiBox = m.querySelector('.qc-ai-box');
      const promptEl = m.querySelector('.ai-prompt');
      const previewHead = m.querySelector('.qc-preview-head');
      const previewList = m.querySelector('.qc-preview-list');
      const statusEl = m.querySelector('.ai-status');
      const okBtn = m.querySelector('.mpp-ok');
      const prevBtn = m.querySelector('.qc-prev');
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = '.xlsx'; picker.multiple = true; picker.hidden = true;
      m.appendChild(picker);

      let cands = (ctx.cands || []).slice();
      let sheets = (ctx.sheets || []).slice();
      let fileNames = (ctx.files || []).map(f => f && f.name).filter(Boolean);
      let sheetHint = ctx.sheetHint || '';
      let stage = 1;
      let source = 'file';        // 'file' | 'paste'：第一步点「下一步」时确定
      let way = 'ai';             // 'ai' | 'direct'

      const selectedCand = () => {
        const el = listEl.querySelector('.qc-item input:checked');
        return el ? cands[+el.closest('.qc-item').dataset.i] : null;
      };
      const parseList = text => {
        const t = String(text || '').trim();
        if (!t) return null;
        const r = aiParse(t, meta, 'auto');
        return (r && r.marks.length) ? r.marks : null;
      };
      // 当前这一步将要导入的清单（第三步预览与最终导入共用，所见即所导）
      const currentMarks = () => {
        if (stage !== 3) return [];
        if (source === 'paste') return parseList(input.value) || [];
        if (way === 'direct') { const c = selectedCand(); return c ? (c.marks || []) : []; }
        return parseList(aiInput.value) || [];
      };
      // 时间码展示统一写成 时:分:秒:帧（与 AI 输出一致，方便核对）
      const fmtMark = t => {
        const F = meta.fps > 0 ? meta.fps : 25;
        const total = Math.max(0, Math.round((Number(t) || 0) * F));
        const p = n => String(n).padStart(2, '0');
        return p(Math.floor(total / (3600 * F))) + ':' + p(Math.floor(total / (60 * F)) % 60) + ':' +
          p(Math.floor(total / F) % 60) + ':' + p(total % F);
      };
      const showFile = () => {
        fileEl.hidden = !fileNames.length;
        fileEl.textContent = fileNames.length ? '已选择：' + fileNames.join('、') : '';
        fileEl.title = fileNames.join('、');
        dropEl.classList.toggle('has-file', !!fileNames.length);
      };

      // 候选（工作表 / 分节）：单选；多个时默认不选，要求用户明确选一张
      function renderCands() {
        if (!cands.length) { listEl.innerHTML = ''; return; }
        listEl.innerHTML = cands.map((c, i) => {
          const hint = c.marks.slice(0, 2).map(x => fmtMark(x.time) + ' ' + (x.note || '（无备注）')).join(' · ');
          const pre = cands.length === 1 ? ' checked' : '';
          return '<label class="qc-item" data-i="' + i + '">' +
              '<input type="radio" name="qc-sheet" class="chk"' + pre + '>' +
              '<span class="qc-name" title="' + esc(c.label) + '">' + esc(c.label) + '</span>' +
              '<span class="qc-count">' + c.marks.length + ' 条</span>' +
            '</label>' +
            '<div class="qc-hint" title="' + esc(hint) + '">' + esc(hint) + '</div>';
        }).join('');
        hintEl.textContent = (cands.length > 1
            ? '检测到 ' + cands.length + ' 个工作表 / 分节，请选择要导入的那一张'
            : '已自动选中识别到的内容')
          + (sheetHint ? '　' + sheetHint : '');
      }

      // 第三步：把清单以「时间码 + 说明」的形式列出来，确认后再导入
      const refreshPreview = () => {
        const marks = currentMarks();
        previewList.innerHTML = marks.length
          ? marks.map(x => '<div class="qc-pline"><span class="qc-ptc">' + esc(fmtMark(x.time)) + '</span>' + esc(x.note || '') + '</div>').join('')
          : '<div class="qc-pempty">没有可导入的时间码</div>';
        previewHead.textContent = marks.length ? '将导入 ' + marks.length + ' 条：' : '';
        return marks.length;
      };

      const refresh = () => {
        [...m.querySelectorAll('.qc-stp')].forEach(el => {
          el.classList.toggle('on', +el.dataset.s === stage);
          el.classList.toggle('done', +el.dataset.s < stage);
        });
        stage1.hidden = stage !== 1;
        stage2.hidden = stage !== 2;
        stage3.hidden = stage !== 3;
        prevBtn.hidden = stage === 1;
        okBtn.textContent = stage === 3 ? '确认导入' : '下一步';
        aiBox.hidden = !(stage === 3 && source === 'file' && way === 'ai' && cands.length > 0);
        const sel = selectedCand();
        tipEl.textContent = way === 'ai'
          ? (sel ? 'AI 导入：下一步给出提示词（只针对「' + sel.sheet + '」），复制后交给 AI，再把结果粘贴回来'
                 : 'AI 导入：下一步给出提示词，复制后交给 AI，再把结果粘贴回来')
          : '直接导入：下一步把自动识别的结果以时间码清单列出，确认后导入';
        if (stage === 3) {
          const n = refreshPreview();
          countEl.textContent = '';
          statusEl.textContent = n ? '共 ' + n + ' 条' : '清单为空';
          okBtn.disabled = n === 0;
          return;
        }
        countEl.textContent = (stage === 2 && cands.length)
          ? '共 ' + cands.reduce((a, c) => a + c.marks.length, 0) + ' 条 / 已选 ' + (sel ? sel.marks.length : 0) + ' 条'
          : '';
        const pasted = parseList(input.value);
        statusEl.textContent = stage === 1
          ? (pasted ? '已粘贴清单 ' + pasted.length + ' 条' : (cands.length ? '已选择表格：' + cands.length + ' 个工作表 / 分节' : ''))
          : (sel ? '已选「' + sel.sheet + '」' + sel.marks.length + ' 条' : '请选择要导入的工作表');
        okBtn.disabled = false;
      };

      // 弹窗内选文件（与拖拽进来的文件走同一套读取 / 候选构建）
      const setFiles = async fileList => {
        if (!fileList || !fileList.length) return;
        const files = await readSheetFiles(fileList);
        const built = buildQcCands(files, meta);
        cands = built.cands;
        sheets = built.sheetNames;
        sheetHint = built.hint;
        fileNames = files.map(f => f.name);
        showFile();
        renderCands();
        refresh();
      };
      m.querySelector('.qc-choose').addEventListener('click', () => picker.click());
      picker.addEventListener('change', () => { setFiles([...picker.files]); picker.value = ''; });
      // 拖放区：把表格拖进来即读取（阻止冒泡，避免面板的全局 drop 再开一个弹窗）
      ['dragenter', 'dragover'].forEach(ev => dropEl.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        dropEl.classList.add('over');
      }));
      ['dragleave', 'dragend'].forEach(ev => dropEl.addEventListener(ev, e => {
        e.stopPropagation();
        dropEl.classList.remove('over');
      }));
      dropEl.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        dropEl.classList.remove('over');
        const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter(f => /\.xlsx?$/i.test(f.name));
        if (!files.length) { panelToast('请拖入 .xlsx 表格文件'); return; }
        setFiles(files);
      });

      // 非本插件导出的表格：引导优先用 AI（格式差异大，AI 比自动识别稳）
      const notice = ctx.notice || '';
      if (notice) { noticeEl.textContent = notice; noticeEl.hidden = false; m.classList.add('ai-first'); }
      showFile();

      // 两个粘贴框都随内容自动增高（上限 168px，超出才出现一条细滚动条）
      const grow = el => {
        el.style.height = 'auto';
        el.style.height = Math.min(168, Math.max(72, el.scrollHeight)) + 'px';
      };
      input.addEventListener('input', () => { grow(input); refresh(); });
      input.addEventListener('paste', () => setTimeout(() => grow(input), 0));
      input.addEventListener('keydown', e => e.stopPropagation());
      aiInput.addEventListener('input', () => { grow(aiInput); refresh(); });
      aiInput.addEventListener('paste', () => setTimeout(() => grow(aiInput), 0));
      aiInput.addEventListener('keydown', e => e.stopPropagation());
      listEl.addEventListener('change', refresh);
      m.querySelectorAll('input[name="qc-way"]').forEach(r => r.addEventListener('change', () => {
        way = m.querySelector('input[name="qc-way"]:checked').value === 'direct' ? 'direct' : 'ai';
        refresh();
      }));

      // AI 导入：复制提示词（只针对选中的表）
      const copyPrompt = () => {
        const c = selectedCand();
        const p = aiPrompt(sheets, c ? c.sheet : '');
        const fail = () => {
          promptEl.value = p;
          promptEl.hidden = false;
          promptEl.focus(); promptEl.select();
          panelToast('复制失败，请在提示词框内手动复制');
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(p).then(() => {
              panelToast(c ? '已复制提示词（只针对「' + c.sheet + '」）' : '已复制提示词，AI 会先问你要哪张表');
              aiInput.focus();
            }).catch(fail);
          } else fail();
        } catch (e) { fail(); }
        aiInput.focus();
      };
      m.querySelector('.ai-copy').addEventListener('click', copyPrompt);

      const finish = val => {
        document.removeEventListener('keydown', onKey);
        m.remove();
        resolve(val);
      };
      const onKey = e => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        if (!promptEl.hidden) { promptEl.hidden = true; return; }
        if (stage > 1) { goPrev(); return; }
        finish(null);
      };
      const goPrev = () => {
        if (stage === 3) { stage = (source === 'file') ? 2 : 1; }
        else if (stage === 2) stage = 1;
        refresh();
      };
      // 导入前：当前视频已有记录时先让用户确认是导到这个视频
      const confirmThenFinish = () => {
        const marks = currentMarks();
        if (!marks.length) { panelToast('没有可导入的时间码'); return; }
        const existing = (logs.marks ? logs.marks.length : 0) + (logs.inOut ? logs.inOut.length : 0);
        const go = () => finish({ marks: marks, mode: 'auto' });
        if (existing > 0) {
          confirmDlg('当前视频已有 ' + existing + ' 条记录，确认把 ' + marks.length + ' 条导入到当前视频？', '导入')
            .then(ok => { if (ok) go(); });
        } else go();
      };
      const goNext = () => {
        if (stage === 1) {
          const pasted = parseList(input.value);
          if (pasted) { source = 'paste'; stage = 3; refresh(); return; }   // 粘贴清单：直接看清单确认
          if (!fileNames.length) { panelToast('请先上传表格文件，或粘贴时间码清单'); return; }
          source = 'file';
          if (!cands.length) {
            // 表格里没识别到时间码：直接进 AI 那一步（提示词会让 AI 先问要哪张表）
            panelToast('表格里没识别到时间码，可改用 AI 导入');
          }
          stage = 2;
          refresh();
          return;
        }
        if (stage === 2) {
          if (cands.length && !selectedCand()) { panelToast('请先选择要导入的工作表'); return; }
          stage = 3;
          if (source === 'file' && way === 'ai' && cands.length) aiInput.focus();
          refresh();
          return;
        }
        confirmThenFinish();
      };
      m.querySelector('.mpp-cancel').addEventListener('click', () => finish(null));
      prevBtn.addEventListener('click', goPrev);
      okBtn.addEventListener('click', goNext);
      m.addEventListener('click', e => { if (e.target === m) finish(null); });
      document.addEventListener('keydown', onKey);
      renderCands();
      refresh();
    });
  }

  // 弹窗结果 → 标记点 → 导入当前视频
  // pick.marks：弹窗「确认清单」里展示的那批（所见即所导，优先用它）；
  // 兼容旧字段：pick.text（AI 粘贴原文）与 pick.items（表格候选）
  async function applyQcPick(pick, meta) {
    const byTime = new Map();
    let total = 0;
    const pushMark = (time, note) => {
      total++;
      const k = Math.round(time * 100) / 100;
      const prev = byTime.get(k);
      if (!prev) byTime.set(k, { time: k, note: note });
      else if (note && prev.note.indexOf(note) < 0) prev.note = (prev.note ? prev.note + ' / ' : '') + note;
    };
    if (pick.marks && pick.marks.length) {
      pick.marks.forEach(m => pushMark(m.time, m.note));
    } else if (pick.text && pick.text.trim()) {
      const r = aiParse(pick.text, meta, pick.mode) || { marks: [] };
      r.marks.forEach(m => pushMark(m.time, m.note));
    } else {
      const mode = (pick.mode && pick.mode !== 'auto') ? pick.mode : undefined;
      (pick.items || []).forEach(c => {
        const r = QcImport.parse([{ name: c.sheet, rows: c.rows }],
          { fps: meta.fps, duration: meta.duration, mode: mode });
        r.marks.forEach(m => pushMark(m.time, m.note));
      });
    }
    const marks = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (!marks.length) { panelToast('没有可导入的时间码'); return false; }
    let added = 0;
    try { added = (await execInPage(fnImportLogs, [marks, []])) || 0; } catch (e) { }
    if (!added) {
      panelToast('未导入：当前页面无法访问视频，或时间码与已有记录重复');
      return false;
    }
    panelToast('已导入 ' + added + ' 条记录'
      + (total > marks.length ? '（' + (total - marks.length) + ' 条同时刻已合并）' : '')
      + (added < marks.length ? '（' + (marks.length - added) + ' 条重复已跳过）' : ''));
    load(true);
    return true;
  }

  // File 列表 → { name, sheets, marks, inOut, plugin }：读不出来也返回（还能走 AI 提示词）
  async function readSheetFiles(fileList) {
    const out = [];
    for (const f of (fileList || [])) {
      let data = null;
      try {
        const buf = await f.arrayBuffer();
        data = window.XlsxReader ? XlsxReader.read(buf) : null;
      } catch (e) { data = null; }
      const marks = (data && data.marks) || [];
      const inOut = (data && data.inOut) || [];
      out.push({
        name: f.name || '导入.xlsx',
        sheets: (data && data.sheets) || [],
        marks: marks,
        inOut: inOut,
        // 本插件导出的日志（标记 / 片段两张表，表头固定）→ 直接合并，不用弹窗选表
        plugin: (marks.length > 1 || inOut.length > 1)
      });
    }
    return out;
  }

  // 表格文件 → 候选（每个可导入的工作表 / 分节一项）+ 工作表名与提示文案
  function buildQcCands(files, meta) {
    const cands = [];
    const sheetNames = [];
    const parsedSheets = new Set();
    (files || []).forEach(f => {
      let scanned = [];
      try { scanned = window.QcImport ? QcImport.scan(f.sheets || []) : []; } catch (e) { scanned = []; }
      (f.sheets || []).forEach(s => { if (s && s.name) sheetNames.push(s.name); });
      scanned.forEach((sh, si) => {
        const sheet = (f.sheets || [])[si] || { rows: [] };
        const secs = (sh.sections || []).filter(s => s.tokens > 0);
        const list = secs.length ? secs : [{ title: '', start: 0, end: (sheet.rows || []).length - 1 }];
        list.forEach(sec => {
          const rows = (sheet.rows || []).slice(sec.start, sec.end + 1);
          const extra = sec.title && sec.title.indexOf(sh.name) < 0 ? ' · ' + sec.title : '';
          const multi = (files.length > 1) ? f.name + ' — ' : '';
          const c = { file: f.name, sheet: sh.name, label: multi + (sh.name || 'Sheet') + extra, rows: rows };
          const r = QcImport.parse([{ name: c.sheet, rows: rows }], { fps: meta.fps, duration: meta.duration });
          c.marks = r.marks; c.mode = r.mode; c.has6 = r.has6;
          cands.push(c);
          if (c.marks.length) parsedSheets.add(sh.name);
        });
      });
    });
    const usable = cands.filter(c => c.marks.length);
    const missed = sheetNames.filter(n => !parsedSheets.has(n)).length;
    const bits = [];
    if (sheetNames.length > 1) bits.push('表格共 ' + sheetNames.length + ' 个工作表');
    if (missed) bits.push('另有 ' + missed + ' 个工作表没识别到时间码');
    return { cands: usable, sheetNames: sheetNames, hint: bits.join('，') };
  }

  // 打开导入弹窗（历史栏「导入」按钮 / 拖入表格文件 / 非本插件导出文件都走这里）
  // opts: { files:[{name,sheets,plugin}], aiFirst, notice }
  async function openQcImport(opts) {
    if (!window.QcImport) return false;
    opts = opts || {};
    let meta = { duration: 0, fps: 25 };
    try { meta = (await execInPage(fnVideoMeta)) || meta; } catch (e) { }
    const files = opts.files || [];
    const built = buildQcCands(files, meta);
    const pick = await qcDialog({
      meta: meta,
      files: files,
      cands: built.cands,
      sheets: built.sheetNames,
      sheetHint: built.hint,
      aiFirst: !!opts.aiFirst,
      notice: opts.notice || ''
    });
    if (!pick) return false;
    return applyQcPick(pick, meta);
  }

  // ─── AI 提示词 + 粘贴结果解析（导入弹窗内使用）────────
  // 记录表版本多、格式杂：把提示词连同表格交给第三方 AI，再把 AI 输出的清单粘贴回来。
  // 粘贴内容走与记录表相同的解析（时间码识别 / 备注规则 / 时长过滤），支持纯文本与 JSON
  // sheets：表格里的工作表名；sheet：用户已选定的那一张（两者都传时提示词会写明只提取这一张表）
  function aiPrompt(sheets, sheet) {
    if (window.QcImport && typeof QcImport.buildPrompt === 'function') {
      return QcImport.buildPrompt({ sheets: sheets || [], sheet: sheet || '' });
    }
    return '请把表格整理成每行「时间码 + 空格 + 项目说明」的纯文本，时间码写成规范格式。';
  }
  function aiParse(text, meta, mode) {
    if (!window.QcImport || typeof QcImport.parseText !== 'function') return null;
    return QcImport.parseText(text, {
      fps: meta.fps, duration: meta.duration,
      mode: (mode && mode !== 'auto') ? mode : undefined
    });
  }

  function timeFromUrl(url) {
    const m = String(url || '').match(/mpp=([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }
  async function importLogsFromFiles(fileList) {
    const files = await readSheetFiles(fileList);
    const recs = [];
    const qcFiles = [];        // 记录表格（非本插件导出）：交给导入记录流程，弹窗里选工作表 / 用 AI
    let filesOk = 0;
    for (const f of files) {
      if (!f.sheets.length && !f.marks.length && !f.inOut.length) {
        // 读不出来（或不是本插件的两张表）也交给导入弹窗：可用 AI 提示词转换后粘贴导入
        if (window.QcImport) qcFiles.push({ name: f.name, sheets: [] });
        continue;
      }
      filesOk++;
      let n = 0;
      (f.marks || []).slice(1).forEach(r => {
        if (!r[1]) return;
        n++;
        recs.push({ kind: 'marks', tc: r[1], color: r[2] || null, note: r[3] || null, url: r[4] || '', title: r[5] || '' });
      });
      (f.inOut || []).slice(1).forEach(r => {
        if (!r[1] || !r[2]) return;
        n++;
        recs.push({ kind: 'inOut', inTC: r[1], outTC: r[2], dur: parseFloat(r[3]) || 0, note: r[4] || null, url: r[5] || '', title: r[6] || '' });
      });
      // 不是本插件导出格式 → 按记录表处理（工作表 / 分节由用户在弹窗里选择）
      if (!n && window.QcImport) qcFiles.push({ name: f.name, sheets: f.sheets || [] });
    }
    if (!recs.length) {
      if (qcFiles.length) {
        // 非本插件导出的表格：弹窗里提示优先用 AI 导入（格式差异大，AI 比自动识别稳）
        try {
          await openQcImport({ files: qcFiles, aiFirst: true, notice: '这个表格不是本插件导出的格式，建议优先用上面的 AI 导入：复制提示词连同表格发给 AI，把结果粘贴回来最稳。' });
        } catch (e) { }
        loadHistory();
        load(true);
        return;
      }
      panelToast('无法解析 Excel（支持本插件导出的 xlsx 与记录表格，也可在导入弹窗里用 AI 提示词转换）');
      return;
    }
    // 页面校准帧率：时间码换算与导出时保持一致（FPS≠25 时避免秒数偏移）
    let importFps = 25;
    try { importFps = (await execInPage(fnGetFps)) || 25; } catch (e) { }
    const groups = {};
    recs.forEach(r => {
      const key = keyFromUrl(r.url) || 'unknown';
      (groups[key] = groups[key] || []).push(r);
    });
    // 与当前视频页匹配的记录 → 合并进页面日志（去重后追加，日志面板实时可见）
    let pageKey = null;
    try { pageKey = await execInPage(fnPageKey); } catch (e) { }
    const pageRecs = pageKey ? (groups[pageKey] || []) : [];
    let pageAdded = 0;
    if (pageRecs.length) {
      try {
        const mk = pageRecs.filter(r => r.kind === 'marks').map(r => ({
          time: timeFromUrl(r.url) != null ? timeFromUrl(r.url) : tcToSec(r.tc, importFps),
          tc: r.tc, color: r.color, note: r.note
        }));
        const io = pageRecs.filter(r => r.kind === 'inOut').map(r => ({
          inTime: timeFromUrl(r.url) != null ? timeFromUrl(r.url) : tcToSec(r.inTC, importFps),
          inTC: r.inTC, outTime: tcToSec(r.outTC, importFps), outTC: r.outTC, dur: r.dur, note: r.note
        }));
        pageAdded = (await execInPage(fnImportLogs, [mk, io])) || 0;
      } catch (e) { }
    }
    // 其他视频 → 导入明细合并（按时间码去重，历史记录显示计数）
    const cur = await chrome.storage.local.get('mpp_imported').catch(() => ({}));
    const base = (cur.mpp_imported && typeof cur.mpp_imported === 'object') ? cur.mpp_imported : {};
    let impAdded = 0;
    Object.keys(groups).forEach(key => {
      if (key === pageKey) return;
      const rs = groups[key];
      const first = rs[0];
      const entry = base[key] || { title: first.title || '', url: first.url || '', marks: [], inOut: [] };
      const mkTcs = new Set((entry.marks || []).map(m => m.tc));
      const ioTcs = new Set((entry.inOut || []).map(u => u.inTC + '|' + u.outTC));
      rs.forEach(r => {
        if (r.kind === 'marks') {
          if (mkTcs.has(r.tc)) return;
          entry.marks.push({ time: timeFromUrl(r.url) != null ? timeFromUrl(r.url) : tcToSec(r.tc, importFps), tc: r.tc, color: r.color, note: r.note });
          mkTcs.add(r.tc); impAdded++;
        } else {
          const k2 = r.inTC + '|' + r.outTC;
          if (ioTcs.has(k2)) return;
          entry.inOut.push({
            inTime: timeFromUrl(r.url) != null ? timeFromUrl(r.url) : tcToSec(r.inTC, importFps),
            inTC: r.inTC, outTime: tcToSec(r.outTC, importFps), outTC: r.outTC, dur: r.dur, note: r.note
          });
          ioTcs.add(k2); impAdded++;
        }
      });
      if (!entry.title && first.title) entry.title = first.title;
      if (!entry.url && first.url) entry.url = first.url;
      base[key] = entry;
    });
    if (impAdded) await chrome.storage.local.set({ mpp_imported: base }).catch(() => { });
    panelToast('已导入 ' + Object.keys(groups).length + ' 个视频 · ' + (pageAdded + impAdded) + ' 条记录');
    if (qcFiles.length) {
      try {
        await openQcImport({ files: qcFiles, aiFirst: true, notice: '这个表格不是本插件导出的格式，建议优先用上面的 AI 导入：复制提示词连同表格发给 AI，把结果粘贴回来最稳。' });
      } catch (e) { }
    }
    loadHistory();
    load(true);
  }

  function loadHistory() {
    // 历史记录全局生效：合并扩展级索引（跨网站汇总）+ 当前页面本地索引（兼容旧数据 / 未同步页面）+ 导入日志明细
    const pageP = execInPage(fnGetHistory).catch(() => null);
    const storeP = chrome.storage.local.get('mpp_history').then(({ mpp_history }) =>
      (mpp_history && typeof mpp_history === 'object') ? mpp_history : {}
    ).catch(() => ({}));
    const importedP = chrome.storage.local.get('mpp_imported').then(({ mpp_imported }) =>
      (mpp_imported && typeof mpp_imported === 'object') ? mpp_imported : {}
    ).catch(() => ({}));
    Promise.all([pageP, storeP, importedP]).then(([pageRes, storeMap, importedMap]) => {
      const map = {};
      Object.keys(storeMap).forEach(k => {
        const e = storeMap[k] || {};
        if ((e.marks || 0) + (e.inOut || 0) > 0) map[k] = e;
      });
      // 当前页面已无记录的 key：从全局索引清除（记录被删后历史列表不残留）
      if (pageRes && Array.isArray(pageRes.zeroKeys)) {
        pageRes.zeroKeys.forEach(k => delete map[k]);
      }
      const pageItems = pageRes && Array.isArray(pageRes.items) ? pageRes.items : [];
      pageItems.forEach(it => {
        if ((it.marks || 0) + (it.inOut || 0) > 0) {
          map[it.key] = { title: it.title || '', url: it.url || '', marks: it.marks, inOut: it.inOut };
        }
      });
      // 写回仅限本地索引（不包含导入计数，避免重复累积）
      chrome.storage.local.set({ mpp_history: map }).catch(() => { });
      // 显示层合并导入日志明细：与本地记录冲突时计数相加，标题 / 链接优先取已有
      Object.keys(importedMap).forEach(k => {
        const e = importedMap[k] || {};
        const mk = Array.isArray(e.marks) ? e.marks.length : 0;
        const io = Array.isArray(e.inOut) ? e.inOut.length : 0;
        if (mk + io === 0) return;
        if (map[k]) {
          map[k] = {
            title: map[k].title || e.title || '',
            url: map[k].url || e.url || '',
            marks: (map[k].marks || 0) + mk,
            inOut: (map[k].inOut || 0) + io
          };
        } else {
          map[k] = { title: e.title || '', url: e.url || '', marks: mk, inOut: io };
        }
      });
      histItems = Object.keys(map).map(k => ({
        key: k,
        title: map[k].title || '',
        url: map[k].url || '',
        marks: map[k].marks || 0,
        inOut: map[k].inOut || 0
      }));
      histItems.sort((a, b) => (b.marks + b.inOut) - (a.marks + a.inOut));
      renderHistory();
      restoreHistSel();
    }).catch(() => { histItems = []; renderHistory(); });
  }

  function renderHistory() {
    const list = els.histList;
    if (!list) return;
    list.innerHTML = '';
    if (els.histClear) els.histClear.disabled = histSel.size === 0;
    if (!histItems.length) {
      list.innerHTML = '<div class="hist-empty">暂无历史记录</div>';
      return;
    }
    histItems.forEach(it => {
      const row = document.createElement('div');
      row.className = 'hist-item' + (histSel.has(it.key) ? ' sel' : '');
      row.dataset.key = it.key;
      row.dataset.url = it.url || '';
      const titleTxt = it.title || it.key;
      row.innerHTML =
        '<input type="checkbox" class="chk"' + (histSel.has(it.key) ? ' checked' : '') + '>' +
        '<span class="hist-t" title="' + esc(titleTxt) + '">' + esc(titleTxt) + '</span>' +
        '<span class="hist-meta">' + it.marks + '标记·' + it.inOut + '片段</span>';
      list.appendChild(row);
    });
  }

  // ─── 标题编辑：点击面板下方标题就地改名，同步历史记录（仅有效打点页面可编辑）──
  let pageValid = false;
  function bindTitleEdit() {
    const el = els.pageTitle;
    if (!el) return;
    el.addEventListener('click', e => {
      if (!pageValid) return;   // 未开启「应用于当前网页」的普通网页仅展示，不可改名

      // 已在编辑态（如连点）时直接复用现有输入框，避免出现两个标题
      const wrap = el.parentElement;
      const existing = wrap && wrap.querySelector('.pg-title-edit');
      if (existing) { existing.focus(); return; }
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'pg-title-edit';
      input.value = el.textContent;
      input.maxLength = 80;
      input.title = '修改标题，Enter 保存，Esc 取消';
      // 输入框与标题同高：切换编辑态时布局不跳动
      input.style.height = el.getBoundingClientRect().height + 'px';
      el.hidden = true;
      wrap.appendChild(input);
      input.focus();
      // 光标与可视文本都从最左侧开始（不全选；等焦点定位稳定后再设一次）
      const caretAtStart = () => {
        try { input.setSelectionRange(0, 0); } catch (e) { }
        input.scrollLeft = 0;
      };
      caretAtStart();
      requestAnimationFrame(caretAtStart);
      let done = false;
      const finish = save => {
        if (done) return;
        done = true;
        if (input.parentElement) input.parentElement.removeChild(input);
        el.hidden = false;
        const val = save ? input.value.trim() : '';
        if (val) {
          el.textContent = val;
          execInPage(fnSetTitle, [val]).catch(() => { });
        }
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    });
  }

  // ─── 设置菜单 ───────────────────────────────
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  }

  function bindSettings() {
    if (!els.btnSettings || !els.settingsMenu) return;
    els.btnSettings.addEventListener('click', e => {
      e.stopPropagation();
      if (els.modeMenu) els.modeMenu.hidden = true;
      if (els.historyMenu) els.historyMenu.hidden = true;
      els.settingsMenu.hidden = !els.settingsMenu.hidden;
    });
    document.addEventListener('click', e => {
      if (els.settingsMenu.hidden) return;
      if (!e.target.closest('#settings-menu') && !e.target.closest('#btn-settings')) {
        els.settingsMenu.hidden = true;
      }
    });
    // 录制编码：新值 h264 / h264-low / vp8 / vp9（默认 h264）；兼容旧值（1080p-* / 720p-*）
    const LEGACY_CODEC = {
      '1080p-vp8': 'vp8', '720p-vp8': 'vp8',
      '1080p-vp9': 'vp9', '720p-vp9': 'vp9',
      '1080p-h264': 'h264', '720p-h264': 'h264-low'
    };
    const CODECS = ['h264', 'h264-low', 'vp8', 'vp9'];
    function normalizeCodec(v) {
      const raw = String(v || '');
      const mapped = LEGACY_CODEC[raw] || raw;
      return CODECS.indexOf(mapped) >= 0 ? mapped : 'h264';
    }
    getSettings().then(s => {
      if (els.togBar) els.togBar.checked = s.barEnabled !== false;
      if (els.togDanmu) els.togDanmu.checked = s.danmuBlock !== false;
      if (els.togPip) els.togPip.checked = s.pipRecord === true;
      if (els.selCodec) els.selCodec.value = normalizeCodec(s.recCodec);
      if (els.togTheme) els.togTheme.checked = s.theme === 'light';
      applyTheme(s.theme);
    });
    // 设置保存统一经 background 中转：面板（popup/侧边栏）关闭会中断未完成的
    // storage 异步链，切换后立即关闭面板会导致保存丢失；service worker 不随面板关闭
    const savePatch = patch => chrome.runtime.sendMessage({ type: 'saveSettings', patch }).catch(() => { });
    if (els.togShot) els.togShot.addEventListener('change', e => savePatch({ autoShot: e.target.checked }));
    if (els.togAvoid) els.togAvoid.addEventListener('change', e => savePatch({ avoidTimecode: e.target.checked }));
    if (els.togPip) els.togPip.addEventListener('change', e => savePatch({ pipRecord: e.target.checked }));
    if (els.selCodec) els.selCodec.addEventListener('change', e => savePatch({ recCodec: e.target.value }));
    if (els.togBar) els.togBar.addEventListener('change', e => savePatch({ barEnabled: e.target.checked }));
    if (els.togDanmu) els.togDanmu.addEventListener('change', e => savePatch({ danmuBlock: e.target.checked }));
    // 网页全屏按钮：视频铺满当前窗口（非浏览器全屏），ESC 退出；反馈提示统一显示在网页
    if (els.btnWebFs) els.btnWebFs.addEventListener('click', () => {
      execInPage(fnToggleWebFs).then(() => {
        if (els.settingsMenu) els.settingsMenu.hidden = true;
      }).catch(() => execInPage(fnToast, ['当前页面无视频']).catch(() => { }));
    });
    // v2.0：教程帮助按钮 → 新标签页打开 help.html
    if (els.btnHelp) els.btnHelp.addEventListener('click', () => {
      if (els.settingsMenu) els.settingsMenu.hidden = true;
      chrome.tabs.create({ url: chrome.runtime.getURL('help.html') }).catch(() => { });
    });
    if (els.togAll) els.togAll.addEventListener('change', async e => {
      const enable = e.target.checked;
      if (enable) {
        // 无页面数据时回退到当前活动标签页地址（activeTab 授权范围内可读）
        if (!curHost) {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.url) {
              const u = new URL(tab.url);
              if (u.protocol === 'http:' || u.protocol === 'https:') { curOrigin = u.origin; curHost = u.hostname; }
            }
          } catch (err) { }
        }
        if (!curHost) {
          e.target.checked = false;
          execInPage(fnToast, ['无法获取当前网页地址，请刷新页面后重试']).catch(() => { });
          return;
        }
        const granted = await chrome.permissions.request({ origins: [curOrigin + '/*'] }).catch(() => false);
        if (!granted) {
          e.target.checked = false;
          execInPage(fnToast, ['未获得网页授权，请在浏览器弹窗中点击允许']).catch(() => { });
          return;
        }
      } else if (curHost) {
        chrome.permissions.remove({ origins: [curOrigin + '/*'] }).catch(() => { });
      }
      const s = await getSettings();
      const hosts = Array.isArray(s.activeHosts) ? s.activeHosts.slice() : [];
      if (enable && curHost) {
        if (hosts.indexOf(curHost) === -1) hosts.push(curHost);
      } else if (curHost) {
        const i = hosts.indexOf(curHost);
        if (i !== -1) hosts.splice(i, 1);
      }
      s.activeHosts = hosts;
      await chrome.storage.local.set({ mpp_settings: s });
      load(true);
    });
    if (els.togTheme) els.togTheme.addEventListener('change', e => {
      const theme = e.target.checked ? 'light' : 'dark';
      applyTheme(theme);   // 立即应用，视觉即时反馈
      savePatch({ theme });
    });
    chrome.runtime.sendMessage({ type: 'pushSettings' }).catch(() => { });
  }

  // _test：仅供开发自检脚本调用（Material/qc-dev/test-panel-ui.js），扩展运行时不使用
  return { init, load, setTab, _test: { qcDialog, openQcImport, buildQcCands, aiPrompt } };
})();
