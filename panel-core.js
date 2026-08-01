/* 芒着拉片 · 面板核心（popup 与分屏侧边栏共用） */
'use strict';

const MPP = (() => {
  // ─── 注入页面 MAIN world 执行（自包含）──────
  function findTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs && tabs[0]);
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
    let data;
    // 旧版本页面残留的 __mgpAPI 缺少 clearAll，清除所有记录后其内存缓存仍返回旧数据，
    // 此时回退读 localStorage（fnClearAll 已将其清空），避免记录“删不掉”的假象。
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
    return { logs: data, host: location.hostname, baseURL: location.origin + location.pathname };
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
  function fnClearAll() {
    let cleared = 0;
    // 先走页面 API（重置当前页内存状态），再无条件清除本地存储，确保所有网页/分集记录都被清空
    try {
      if (window.__mgpAPI && typeof window.__mgpAPI.clearAll === 'function') {
        if (window.__mgpAPI.clearAll() === true) cleared = 1;
      }
    } catch (e) { }
    try {
      const raw = localStorage.getItem('mpp_logs') || '{}';
      try {
        const n = Object.keys(JSON.parse(raw)).length;
        if (n) cleared = n;
      } catch (e) { if (!cleared) cleared = 1; }
      localStorage.removeItem('mpp_logs');
      localStorage.removeItem('mpp_state');
    } catch (e) { }
    return cleared;
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
      Object.assign({ enabled: true, activeHosts: [], theme: 'dark' }, s[SETTINGS_KEY] || {}));
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
    els.btnRefresh = $(cfg.btnRefresh);
    els.btnSettings = $(cfg.btnSettings);
    els.settingsMenu = $(cfg.settingsMenu);
    els.togEnabled = $(cfg.togEnabled);
    els.togAll = $(cfg.togAll);
    els.togTheme = $(cfg.togTheme);
    els.setRowAll = $(cfg.setRowAll);
    els.btnClearAll = $(cfg.btnClearAll);
    els.err = $(cfg.err);
    els.wrap = $(cfg.wrap);
    els.footer = $(cfg.footer);
    bindList(els.mkList);
    if (els.ioList !== els.mkList) bindList(els.ioList);
    els.btnAll.addEventListener('click', toggleAll);
    els.btnClear.addEventListener('click', clearSel);
    els.btnExport.addEventListener('click', exportExcel);
    els.btnRefresh.addEventListener('click', refresh);
    if (els.btnClearAll) els.btnClearAll.addEventListener('click', clearAll);
    bindSettings();
    bindCollapse();
    bindSelectAll();
  }

  // ─── 数据加载 ───────────────────────────────
  // 刷新按钮：不关闭弹窗/侧边栏，仅重启页面端服务——重扫视频、重建控制栏、重载记录
  function fnReload() {
    try { window.dispatchEvent(new CustomEvent('mgp-reload')); return true; }
    catch (e) { return false; }
  }
  function refresh() {
    execInPage(fnReload).catch(() => { });
    return load(true);
  }

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
    const valid = !!(res && res.host) && settings.enabled !== false && (onMgtv || active);
    if (els.togAll) els.togAll.checked = !onMgtv && active;
    if (els.setRowAll) els.setRowAll.hidden = onMgtv;
    if (els.err) {
      els.err.innerHTML = settings.enabled === false
        ? '插件已关闭<br>点击右上角设置按钮重新开启'
        : '请在芒果TV视频页面打开此面板<br>或开启「应用于当前网页」';
    }
    setVisible(valid);
    if (!valid) return false;
    const sig = JSON.stringify(res.logs);
    if (!force && sig === lastSig) return true;
    lastSig = sig;
    logs = res.logs || { inOut: [], marks: [] };
    baseURL = res.baseURL || '';
    sel.io.clear();
    sel.mk.clear();
    render();
    return true;
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
    if (els.sumIo) {
      if (logs.inOut.length) {
        const total = logs.inOut.reduce((a, u) => a + (u.outTime - u.inTime), 0);
        els.sumIo.textContent = fmtDur(total) + 's';
      } else {
        els.sumIo.textContent = '';
      }
      const tag = els.sumIo.closest('.tag');
      if (tag) tag.classList.toggle('no-sum', !logs.inOut.length);
    }
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

  function renderMarks(list) {
    if (!logs.marks.length) { list.innerHTML = '<div class="empty">暂无标记点记录</div>'; return; }
    list.innerHTML = '';
    logs.marks.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (sel.mk.has(i) ? ' sel' : '');
      row.dataset.mk = i;
      row.title = '点击时间码跳转 · 色点设标记色 · 空白处复制';
      row.innerHTML =
        '<input type="checkbox" class="chk"' + (sel.mk.has(i) ? ' checked' : '') + '>' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="tc mk">' + m.tc + '</span>' +
        '<span class="mk-colors">' + MARK_COLORS.map(([name, v]) =>
          '<span class="mc-dot' + (m.color === v ? ' on' : '') + '" data-c="' + v + '" data-n="' + name + '" style="--dc:' + v + '" title="设为' + name + '色"></span>'
        ).join('') + '</span>';
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
      row.title = '点击时间码跳转 · 空白处复制';
      row.innerHTML =
        '<input type="checkbox" class="chk"' + (sel.io.has(i) ? ' checked' : '') + '>' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<span class="tc in">' + u.inTC + '</span>' +
        '<span class="sep">&rarr;</span>' +
        '<span class="tc out">' + u.outTC + '</span>' +
        '<span class="dur">' + fmtDur(u.dur) + 's</span>';
      list.appendChild(row);
    });
  }

  function updateSel() {
    const n = sel.mk.size + sel.io.size;
    if (els.selCount) els.selCount.textContent = '已选' + n + '条记录';
    if (els.btnClear) els.btnClear.disabled = n === 0;
    if (els.btnExport) els.btnExport.disabled = n === 0;
    document.querySelectorAll('.sec-head .tag').forEach(tag => {
      const key = tag.dataset.set === 'io' ? 'io' : 'mk';
      const total = key === 'io' ? logs.inOut.length : logs.marks.length;
      tag.classList.toggle('all-sel', total > 0 && sel[key].size === total);
    });
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

  async function clearAll() {
    const ok = await confirmDlg('确认清除所有网页的标记点与入点到出点记录？此操作不可恢复。', '清除');
    if (!ok) return;
    try { await execInPage(fnClearAll); } catch (e) { }
    logs = { inOut: [], marks: [] };
    sel.io.clear();
    sel.mk.clear();
    if (els.settingsMenu) els.settingsMenu.hidden = true;
    await load(true);
    execInPage(fnToast, ['已清除所有记录']).catch(() => { });
  }

  async function exportExcel() {
    const ioIdx = [...sel.io].sort((a, b) => a - b);
    const mkIdx = [...sel.mk].sort((a, b) => a - b);
    if (!ioIdx.length && !mkIdx.length) return;
    const ioRows = [['序号', '入点时间码', '出点时间码', '时长', '入点链接']];
    ioIdx.forEach((i, n) => {
      const u = logs.inOut[i];
      ioRows.push([String(n + 1), u.inTC, u.outTC, fmtDur(u.dur), linkFor(u.inTime, u.url)]);
    });
    const mkRows = [['序号', '时间码', '颜色', '链接']];
    mkIdx.forEach((i, n) => {
      const m = logs.marks[i];
      const hex = markColor(m);
      mkRows.push([String(n + 1), m.tc, hex ? colorName(hex) : '无', linkFor(m.time, m.url)]);
    });
    const blob = new Blob([XlsxWriter.build(mkRows, ioRows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName();
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    try { await execInPage(fnToast, ['已导出记录']); } catch (e) { }
  }

  function fileName() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return 'MPP_logs_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.xlsx';
  }

  // ─── 设置菜单 ───────────────────────────────
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  }

  function bindSettings() {
    if (!els.btnSettings || !els.settingsMenu) return;
    els.btnSettings.addEventListener('click', e => {
      e.stopPropagation();
      els.settingsMenu.hidden = !els.settingsMenu.hidden;
    });
    document.addEventListener('click', e => {
      if (els.settingsMenu.hidden) return;
      if (!e.target.closest('#settings-menu') && !e.target.closest('#btn-settings')) {
        els.settingsMenu.hidden = true;
      }
    });
    getSettings().then(s => {
      if (els.togEnabled) els.togEnabled.checked = s.enabled !== false;
      if (els.togTheme) els.togTheme.checked = s.theme === 'light';
      applyTheme(s.theme);
    });
    if (els.togEnabled) els.togEnabled.addEventListener('change', async e => {
      const s = await getSettings();
      s.enabled = e.target.checked;
      await chrome.storage.local.set({ mpp_settings: s });
      load(true);
    });
    if (els.togAll) els.togAll.addEventListener('change', async e => {
      const enable = e.target.checked;
      if (enable) {
        if (!curHost) { e.target.checked = false; return; }
        const granted = await chrome.permissions.request({ origins: [curOrigin + '/*'] }).catch(() => false);
        if (!granted) { e.target.checked = false; return; }
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

  return { init, refresh, load, setTab };
})();
