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
  function fnSetMarkColor(idx, color) {
    function vkey() {
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
  // v2.0 历史：列出所有有标记记录的视频（标题 + 链接 + 记录数）
  function fnGetHistory() {
    let map = {}, titles = {};
    try { map = JSON.parse(localStorage.getItem('mpp_logs') || '{}') || {}; } catch (e) { }
    try { titles = JSON.parse(localStorage.getItem('mpp_titles') || '{}') || {}; } catch (e) { }
    if (map && Array.isArray(map.inOut)) map = {};
    const out = [];
    for (const k of Object.keys(map)) {
      const e = map[k] || {};
      const marks = Array.isArray(e.marks) ? e.marks.length : 0;
      const inOut = Array.isArray(e.inOut) ? e.inOut.length : 0;
      if (marks + inOut === 0) continue;
      const t = titles[k] || {};
      out.push({ key: k, title: String(t.title || '').trim(), url: t.url || '', marks, inOut });
    }
    out.sort((a, b) => (b.marks + b.inOut) - (a.marks + a.inOut));
    return out;
  }
  // v2.0 历史：按 videoKey 批量清除；若包含当前视频则同时重置页面端状态
  function fnRemoveHistory(keys) {
    function vkey() {
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
  function getSettings() {
    return chrome.storage.local.get(SETTINGS_KEY).then(s =>
      Object.assign({ enabled: true, activeHosts: [], theme: 'dark', logEnabled: true, barEnabled: true, noteFileName: true, titleFileName: true }, s[SETTINGS_KEY] || {}));
  }

  // ─── 轻提示（短暂反馈，用于开关失败等场景）──
  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('mpp-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mpp-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ─── 二次确认弹窗 ──────────────────────────
  let confirmResolve = null;
  function confirmDlg(message, okLabel) {
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
            '<div class="mpp-modal-actions">' +
              '<button type="button" class="mpp-cancel">取消</button>' +
              '<button type="button" class="mpp-ok danger">确认</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(m);
        m.querySelector('.mpp-cancel').addEventListener('click', () => finishConfirm(false));
        m.querySelector('.mpp-ok').addEventListener('click', () => finishConfirm(true));
        m.addEventListener('click', e => { if (e.target === m) finishConfirm(false); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) finishConfirm(false); });
      }
      const msgEl = m.querySelector('.mpp-modal-msg');
      const okEl = m.querySelector('.mpp-ok');
      msgEl.textContent = message;
      okEl.textContent = okLabel || '确认';
      confirmResolve = resolve;
      m.hidden = false;
    });
  }
  function finishConfirm(val) {
    const m = document.getElementById('mpp-confirm');
    if (m) m.hidden = true;
    if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(val); }
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
    els.togLog = $(cfg.togLog);
    els.togBar = $(cfg.togBar);
    els.togNote = $(cfg.togNote);
    els.togTitle = $(cfg.togTitle);
    els.togAll = $(cfg.togAll);
    els.togTheme = $(cfg.togTheme);
    els.setRowAll = $(cfg.setRowAll);
    els.btnHelp = $(cfg.btnHelp);
    els.sumSep = $(cfg.sumSep);
    els.err = $(cfg.err);
    els.wrap = $(cfg.wrap);
    els.footer = $(cfg.footer);
    els.pageTitle = $(cfg.pageTitle);
    els.btnHistory = $(cfg.btnHistory);
    els.historyMenu = $(cfg.historyMenu);
    els.histList = $(cfg.histList);
    els.histAll = $(cfg.histAll);
    els.histClear = $(cfg.histClear);
    if (isWindowMode()) document.title = '芒着拉片 | MG Player+';
    bindList(els.mkList);
    if (els.ioList !== els.mkList) bindList(els.ioList);
    els.btnAll.addEventListener('click', toggleAll);
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
    const onMgtv = !!(res && res.host && /mgtv\.com$/.test(res.host));
    const active = !!(res && res.host) && Array.isArray(settings.activeHosts) && settings.activeHosts.indexOf(res.host) !== -1;
    // v2.0：面板是否可用取决于「日志记录」开关（与视频控制栏开关互不影响）
    const logOn = settings.logEnabled !== false;
    const valid = !!(res && res.host) && logOn && (onMgtv || active);
    if (els.togAll) els.togAll.checked = !onMgtv && active;
    if (els.setRowAll) els.setRowAll.hidden = onMgtv;
    if (els.err) {
      els.err.innerHTML = settings.logEnabled === false
        ? '日志记录已关闭<br>点击右上角设置按钮重新开启'
        : '请在芒果TV视频页面打开此面板<br>或开启「应用于当前网页」';
    }
    setVisible(valid);
    if (!valid) return false;
    if (els.pageTitle) {
      const t = (res && res.title) || '';
      // 标题编辑中不打断显隐，避免输入框与标题同时出现
      if (document.querySelector('.pg-title-edit')) {
        els.pageTitle.textContent = t;
      } else if (t) {
        els.pageTitle.textContent = t;
        els.pageTitle.hidden = false;
      } else {
        els.pageTitle.hidden = true;
      }
    }
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
    if (els.err) els.err.hidden = valid;
  }

  // ─── 渲染 ───────────────────────────────────
  function render() {
    if (els.cntMk) els.cntMk.textContent = logs.marks.length;
    if (els.cntIo) els.cntIo.textContent = logs.inOut.length;
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
  }

  function setTab(t) {
    show = t;
    render();
  }

  function noteLineHTML(hasNote) {
    return '<span class="note-line"' + (hasNote ? '' : ' hidden') + '>' +
      '<span class="note-text"></span>' +
      '<textarea class="note-edit" rows="1" spellcheck="false" hidden></textarea>' +
      '</span>';
  }

  function renderMarks(list) {
    if (!logs.marks.length) { list.innerHTML = '<div class="empty">暂无标记点记录</div>'; return; }
    list.innerHTML = '';
    logs.marks.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (sel.mk.has(i) ? ' sel' : '');
      row.dataset.mk = i;
      row.innerHTML =
        '<input type="checkbox" class="chk"' + (sel.mk.has(i) ? ' checked' : '') + '>' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="tc mk">' + m.tc + '</span>' +
        '<span class="mk-colors">' + MARK_COLORS.map(([name, v]) =>
          '<span class="mc-dot' + (m.color === v ? ' on' : '') + '" data-c="' + v + '" data-n="' + name + '" style="--dc:' + v + '" title="设为' + name + '色"></span>'
        ).join('') + '</span>' +
        noteLineHTML(!!m.note);
      list.appendChild(row);
    });
  }

  function renderIO(list) {
    if (!logs.inOut.length) { list.innerHTML = '<div class="empty">暂无入点到出点记录</div>'; return; }
    list.innerHTML = '';
    logs.inOut.forEach((u, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (sel.io.has(i) ? ' sel' : '');
      row.dataset.io = i;
      row.innerHTML =
        '<input type="checkbox" class="chk"' + (sel.io.has(i) ? ' checked' : '') + '>' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="tc in">' + u.inTC + '</span>' +
        '<span class="sep">&rarr;</span>' +
        '<span class="tc out">' + u.outTC + '</span>' +
        '<span class="dur">' + fmtDur(u.dur) + 's</span>' +
        noteLineHTML(!!u.note);
      list.appendChild(row);
    });
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
    document.querySelectorAll('.sec-head .tag').forEach(tag => {
      const key = tag.dataset.set === 'io' ? 'io' : 'mk';
      const total = key === 'io' ? logs.inOut.length : logs.marks.length;
      tag.classList.toggle('all-sel', total > 0 && sel[key].size === total);
    });
    updateNoteLines();
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
        text.textContent = hasNote ? rec.note : '添加备注…';
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
      text.textContent = rec.note || '添加备注…';
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
        let time;
        if (isMk) time = rec.time;
        else if (tcEl.classList.contains('out')) time = rec.outTime;
        else time = rec.inTime;
        if (time != null && isFinite(time)) execInPage(fnJump, [time]).catch(() => { });
        return;
      }
      const raw = isMk ? rec.tc : rec.inTC;
      const compact = String(raw).replace(/:/g, '');
      copyText(compact)
        .then(() => execInPage(fnToast, ['已复制时间码 ( ' + compact + ' )']))
        .catch(() => { });
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
    // 备注编辑：Enter 保存并取消选中 / Shift+Enter 换行 / Esc 取消 / 失焦保存
    list.addEventListener('keydown', e => {
      const edit = e.target.closest('.note-edit');
      if (!edit || edit.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); cancelNoteEdit(edit); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // 先提交保存（同步读取输入值），再取消选中——updateSel 会重置备注输入框的值
        commitNoteEdit(edit);
        const row = edit.closest('.row');
        if (row) {
          const isMk = row.dataset.mk !== undefined;
          const idx = parseInt(isMk ? row.dataset.mk : row.dataset.io, 10);
          const set = isMk ? sel.mk : sel.io;
          if (set.has(idx)) {
            set.delete(idx);
            row.classList.remove('sel');
            const chk = row.querySelector('.chk');
            if (chk) chk.checked = false;
            updateSel();
          }
        }
      }
    });
    list.addEventListener('focusout', e => {
      const edit = e.target.closest('.note-edit');
      if (!edit || edit.hidden) return;
      commitNoteEdit(edit);
    });
  }

  // ─── 底部按钮 ───────────────────────────────
  function toggleAll() {
    if (els.mkList === els.ioList) {
      // popup 单列表：全选只作用于当前选项卡
      const isMk = show === 'mk';
      const set = isMk ? sel.mk : sel.io;
      const total = isMk ? logs.marks.length : logs.inOut.length;
      if (total > 0 && set.size === total) set.clear();
      else { set.clear(); for (let i = 0; i < total; i++) set.add(i); }
    } else {
      // 侧边栏双列表：全选作用于两种记录
      const allMk = sel.mk.size === logs.marks.length;
      const allIo = sel.io.size === logs.inOut.length;
      if (allMk && allIo) { sel.mk.clear(); sel.io.clear(); }
      else {
        sel.mk = new Set(logs.marks.map((_, i) => i));
        sel.io = new Set(logs.inOut.map((_, i) => i));
      }
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
    const ok = await confirmDlg('确认删除选中的 ' + n + ' 条记录？此操作不可恢复。', '删除');
    if (!ok) return;
    try { await execInPage(fnRemove, [selObj]); } catch (e) { }
    sel.io.clear();
    sel.mk.clear();
    await load(true);
  }

  async function exportExcel() {
    const ioIdx = [...sel.io].sort((a, b) => a - b);
    const mkIdx = [...sel.mk].sort((a, b) => a - b);
    if (!ioIdx.length && !mkIdx.length) return;
    const settings = await getSettings();
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
    a.href = url; a.download = fileName(settings);
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    try { await execInPage(fnToast, ['已导出记录']); } catch (e) { }
  }

  // 导出文件命名：R/S_标题_备注_时间码_时间（R=录制片段，S=截图关键帧；时间 mmddhhmmss）
  function sanitizeName(s) {
    return String(s).replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function fileName(s) {
    const mkIdx = [...sel.mk].sort((a, b) => a - b);
    const ioIdx = [...sel.io].sort((a, b) => a - b);
    let kind, rec, tc;
    if (mkIdx.length) { kind = 'S'; rec = logs.marks[mkIdx[0]]; tc = rec.tc; }
    else if (ioIdx.length) { kind = 'R'; rec = logs.inOut[ioIdx[0]]; tc = rec.inTC; }
    else return 'MPP_logs.xlsx';
    const parts = [kind];
    const fallback = els.pageTitle ? (els.pageTitle.textContent || '') : '';
    const title = (s.titleFileName !== false) ? sanitizeName(rec.title || fallback || '') : '';
    const note = (s.noteFileName !== false) ? sanitizeName(rec.note || '') : '';
    if (title) parts.push(title);
    if (note) parts.push(note);
    parts.push(String(tc).replace(/:/g, ''));
    const d = new Date(), p = n => String(n).padStart(2, '0');
    parts.push(p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()));
    return parts.join('_') + '.xlsx';
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
    return chrome.action.openPopup().catch(() => { });
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
        const jump = e.target.closest('.hist-jump');
        const item = e.target.closest('.hist-item');
        if (!item) return;
        const key = item.dataset.key;
        if (jump) {
          const url = item.dataset.url;
          if (url) chrome.tabs.create({ url }).catch(() => { });
          return;
        }
        if (histSel.has(key)) histSel.delete(key); else histSel.add(key);
        // 仅更新当前行，不重建列表也不关闭菜单，便于连续勾选多项
        item.classList.toggle('sel', histSel.has(key));
        const chk = item.querySelector('.chk');
        if (chk) chk.checked = histSel.has(key);
        if (els.histClear) els.histClear.disabled = histSel.size === 0;
      });
    }
    if (els.histAll) els.histAll.addEventListener('click', () => {
      const allSel = histItems.length > 0 && histSel.size === histItems.length;
      histSel = allSel ? new Set() : new Set(histItems.map(it => it.key));
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
        all ? '清除所有' : '清除'
      );
      if (!ok) return;
      try { await execInPage(all ? fnClearAll : fnRemoveHistory, all ? [] : [keys]); } catch (e) { }
      histSel = new Set();
      loadHistory();
      load(true);
    });
  }

  function loadHistory() {
    execInPage(fnGetHistory).then(items => {
      histItems = items || [];
      renderHistory();
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
      row.innerHTML =
        '<input type="checkbox" class="chk"' + (histSel.has(it.key) ? ' checked' : '') + '>' +
        '<span class="hist-t">' + esc(it.title || it.key) + '</span>' +
        '<span class="hist-meta">' + it.marks + '标记·' + it.inOut + '片段</span>' +
        '<button type="button" class="hist-jump" title="打开视频">' +
          '<svg viewBox="0 0 16 16"><path d="M6.5 3.5h-3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-3"/><path d="M8.5 2.5h5v5"/><path d="M13.5 2.5l-6 6"/></svg>' +
        '</button>';
      list.appendChild(row);
    });
  }

  // ─── 标题编辑：点击面板下方标题就地改名，同步历史记录 ──
  function bindTitleEdit() {
    const el = els.pageTitle;
    if (!el) return;
    el.addEventListener('click', e => {
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
      // 光标置于最左侧开始编辑（不全选）
      try { input.setSelectionRange(0, 0); } catch (e) { }
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
    getSettings().then(s => {
      if (els.togLog) els.togLog.checked = s.logEnabled !== false;
      if (els.togBar) els.togBar.checked = s.barEnabled !== false;
      if (els.togNote) els.togNote.checked = s.noteFileName !== false;
      if (els.togTitle) els.togTitle.checked = s.titleFileName !== false;
      if (els.togTheme) els.togTheme.checked = s.theme === 'light';
      applyTheme(s.theme);
    });
    if (els.togLog) els.togLog.addEventListener('change', async e => {
      const s = await getSettings();
      s.logEnabled = e.target.checked;
      await chrome.storage.local.set({ mpp_settings: s });
      load(true);
    });
    if (els.togBar) els.togBar.addEventListener('change', async e => {
      const s = await getSettings();
      s.barEnabled = e.target.checked;
      await chrome.storage.local.set({ mpp_settings: s });
    });
    if (els.togNote) els.togNote.addEventListener('change', async e => {
      const s = await getSettings();
      s.noteFileName = e.target.checked;
      await chrome.storage.local.set({ mpp_settings: s });
    });
    if (els.togTitle) els.togTitle.addEventListener('change', async e => {
      const s = await getSettings();
      s.titleFileName = e.target.checked;
      await chrome.storage.local.set({ mpp_settings: s });
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
          toast('无法获取当前网页地址，请刷新页面后重试');
          return;
        }
        const granted = await chrome.permissions.request({ origins: [curOrigin + '/*'] }).catch(() => false);
        if (!granted) {
          e.target.checked = false;
          toast('未获得网页授权，请在浏览器弹窗中点击允许');
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
    if (els.togTheme) els.togTheme.addEventListener('change', async e => {
      const s = await getSettings();
      s.theme = e.target.checked ? 'light' : 'dark';
      await chrome.storage.local.set({ mpp_settings: s });
      applyTheme(s.theme);
    });
    chrome.runtime.sendMessage({ type: 'pushSettings' }).catch(() => { });
  }

  return { init, load, setTab };
})();
