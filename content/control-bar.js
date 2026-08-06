/**
 * MG Player+ v2.0 — Video control bar
 */
(function () {
  let FPS = 25;
  const BTN = '36px';
  const MARK_COLORS = { red: '#e74c3c', orange: '#ff7a1a', blue: '#3498db', green: '#2ecc71', gray: '#9aa0a6' };

  // 网页标题：直接读取 <title> 字段完整文本
  function pageTitle() {
    return (document.title || '').trim();
  }

  const STORAGE_KEY = 'mpp_state';

  let state = {
    inPoint: null, outPoint: null, markTime: null,
    tcMode: 'live',
    recordingStart: null
  };

  // ─── Persistence（状态与记录均按视频独立）──────
  function videoKey() {
    // 芒果TV 播放页 /项目ID/分期ID.html → id:项目ID_分期ID（两个 ID 都取）
    const m = location.pathname.match(/(\d+)\/(\d+)\.html$/);
    if (m) return 'id:' + m[1] + '_' + m[2];
    const m1 = location.pathname.match(/(\d+)\.html$/);
    if (m1) return 'id:' + m1[1];
    // 其他站点：video 元素上的 id/vid 等
    const v = window.__mgp_video && window.__mgp_video.dataset;
    if (v) { const d = v.id || v.vid || v.mgpid; if (d) return 'id:' + d; }
    return location.origin + location.pathname;
  }

  function readStateMap() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { }
    let map = {};
    try { map = JSON.parse(raw || '{}') || {}; } catch (e) { }
    // 迁移旧版全局状态到当前视频
    if (map && ('inPoint' in map)) map = { [videoKey()]: map };
    return map;
  }

  function saveState() {
    try {
      const map = readStateMap();
      map[videoKey()] = {
        inPoint: state.inPoint, outPoint: state.outPoint,
        markTime: state.markTime, tcMode: state.tcMode
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (e) { /* quota exceeded, ignore */ }
  }

  function loadState() {
    try {
      const saved = readStateMap()[videoKey()] || {};
      if (saved.inPoint != null) state.inPoint = saved.inPoint;
      if (saved.outPoint != null) state.outPoint = saved.outPoint;
      if (saved.markTime != null) state.markTime = saved.markTime;
      if (saved.tcMode && saved.tcMode !== 'rec') state.tcMode = saved.tcMode;
    } catch (e) { /* ignore corrupt data */ }
  }

  // ─── Logs (in/out units & marks) · 按视频独立 ──
  const LOGS_KEY = 'mpp_logs';
  let logs = { inOut: [], marks: [] };
  let lastLogOutTime = null;

  function readLogsMap() {
    let raw = null;
    try { raw = localStorage.getItem(LOGS_KEY); } catch (e) { }
    let map = {};
    try { map = JSON.parse(raw || '{}') || {}; } catch (e) { }
    // 迁移旧版全局记录到当前视频
    if (map && Array.isArray(map.inOut) && Array.isArray(map.marks)) {
      map = { [videoKey()]: { inOut: map.inOut, marks: map.marks } };
    }
    return map;
  }

  function loadLogs() {
    const e = readLogsMap()[videoKey()];
    logs = (e && Array.isArray(e.inOut) && Array.isArray(e.marks))
      ? { inOut: e.inOut, marks: e.marks } : { inOut: [], marks: [] };
    window.__mgp_logs = logs;
  }

  function saveLogs() {
    window.__mgp_logs = logs;
    try {
      const map = readLogsMap();
      map[videoKey()] = { inOut: logs.inOut, marks: logs.marks };
      localStorage.setItem(LOGS_KEY, JSON.stringify(map));
    } catch (e) { }
    // 标题索引：供面板「历史」列出所有有标记记录的视频（标题 + 链接）
    // 面板重命名过的标题（custom 标记）在保存记录时保留，不被网页 <title> 覆盖
    let titleTxt = '';
    try {
      const titles = JSON.parse(localStorage.getItem('mpp_titles') || '{}') || {};
      const cur = titles[videoKey()];
      if (cur && cur.custom === true) {
        titleTxt = cur.title || pageTitle();
        titles[videoKey()] = { title: titleTxt, url: location.href, custom: true };
      } else {
        titleTxt = pageTitle();
        titles[videoKey()] = { title: titleTxt, url: location.href };
      }
      localStorage.setItem('mpp_titles', JSON.stringify(titles));
    } catch (e) { }
    // 全局历史索引：跨网站汇总（经 content 脚本桥接写入扩展存储）
    try {
      window.postMessage({
        __mgp: 'history',
        key: videoKey(),
        title: titleTxt,
        url: location.href,
        marks: logs.marks.length,
        inOut: logs.inOut.length
      }, '*');
    } catch (e) { }
  }

  loadLogs();

  function fmtTC(sec, frames) {
    if (frames === undefined) frames = true;
    if (isNaN(sec) || sec < 0) sec = 0;
    const tf = Math.floor(sec * FPS);
    const fph = FPS * 3600, fpm = FPS * 60;
    const h = Math.floor(tf / fph), m = Math.floor((tf % fph) / fpm);
    const s = Math.floor((tf % fpm) / FPS), f = tf % FPS;
    const hms = String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    return frames ? hms+':'+String(f).padStart(2,'0') : hms;
  }
  function fmtTCPlain(sec) { return fmtTC(sec, false).replace(/:/g, '-'); }
  // v2.0 导出文件时间：mmddhhmmss（如 08011200）
  function fmtNow() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  const CSS = `
:host{all:initial;display:block;width:100%!important;contain:layout style}
/* v2.0：顶部只留居中时间码；截屏 / 录制分别置于画面垂直中间左、右侧 */
#mgp-bar{
  position:absolute;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;
  display:flex;align-items:center;justify-content:center;
  height:46px;padding:0 8px;
  color:#ccc;font-size:12px;user-select:none;
}
.mgp-side-btn{
  position:absolute;top:50%;transform:translateY(-50%);z-index:2147483647;
  background:rgba(0,0,0,.55);
  border:1px solid rgba(255,255,255,.1);color:#ccc;cursor:pointer;
  border-radius:6px;font-size:12px;font-family:inherit;
  transition:opacity .3s,background .15s,color .15s,border-color .15s;
  display:inline-flex;align-items:center;justify-content:center;
  flex-shrink:0;padding:8px;opacity:0;pointer-events:none;
}
/* hover 显隐：靠近按钮区域时显示，其余时间隐藏；录制中常显 */
#mgp-bar.show-btns ~ .mgp-side-btn,
#mgp-bar.recording ~ .mgp-side-btn{opacity:1;pointer-events:auto}
/* 距视频边框边距统一为视频宽度的 1% */
#mgp-btn-ss{left:1%}
#mgp-btn-rec{right:1%}
.mgp-side-btn:hover{background:rgba(255,95,0,.35);color:#fff;border-color:rgba(255,95,0,.5)}
.mgp-side-btn.active{background:rgba(255,95,0,.45);color:#fff;border-color:#ff5f00}
/* hover 提示：视觉样式与时间码气泡一致；截图在左向右弹、录制在右向左弹 */
.mgp-side-btn::after{
  content:attr(data-tip);position:absolute;top:50%;transform:translateY(-50%);
  background:rgba(0,0,0,.88);color:#fff;padding:8px;border-radius:4px;
  font-size:11px;line-height:1;font-family:"PingFang SC","Microsoft YaHei",sans-serif;
  white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .2s;
  border:1px solid rgba(255,255,255,.12);letter-spacing:0;
}
.mgp-side-btn:hover::after{opacity:1}
#mgp-btn-ss::after{left:calc(100% + 8px)}
#mgp-btn-rec::after{right:calc(100% + 8px)}
.mgp-icon{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
#mgp-tc{
  display:flex;align-items:center;gap:5px;
  background:rgba(0,0,0,.55);
  border:1px solid rgba(255,255,255,.08);
  padding:6px 8px;border-radius:6px;cursor:pointer;
  font-family:"JetBrains Mono","Cascadia Code","Consolas",monospace;
  font-size:18px;color:#fff;letter-spacing:1px;line-height:1;
  flex-shrink:0;pointer-events:auto;white-space:nowrap;
  /* 悬浮画面时右移动画：位移由 JS 计算写入 transform；全屏无操作 5s 淡出 */
  transition:transform .2s ease,opacity .3s ease;
}
#mgp-tc.tc-hidden{opacity:0;pointer-events:none}
#mgp-tc:hover{background:rgba(255,95,0,.3);color:#fff;border-color:rgba(255,95,0,.4)}
#mgp-tc-frames{color:#ff5f00;font-size:14px;opacity:.85}
#mgp-tc-badge{
  font-size:11px;font-weight:700;padding:2px 6px;border-radius:2px;
  letter-spacing:.5px;
}
.b-pl{background:#ff5f00;color:#fff}
.b-st{background:#555;color:#ddd}
.b-rec{background:#e74c3c;color:#fff}
.b-in{background:#3498db;color:#fff}
.b-ot{background:#2ecc71;color:#fff}
.b-mk{background:#f39c12;color:#000}
#mgp-rec-dot{display:none;width:5px;height:5px;background:#e74c3c;border-radius:50%;animation:pulse 1s infinite;position:absolute;top:3px;right:3px}
	/* Timecode custom tooltip */
	#mgp-tc{position:relative}
	#mgp-tc::after{
	  content:'复制当前时间码';position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);
	  background:rgba(0,0,0,.88);color:#fff;padding:8px;border-radius:4px;
	  font-size:11px;line-height:1;font-family:"PingFang SC","Microsoft YaHei",sans-serif;
	  white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .2s;
	  border:1px solid rgba(255,255,255,.12);letter-spacing:0;
	}
	#mgp-tc:hover::after{opacity:1}
	/* 右键时间码：输入跳转弹窗（输入时隐藏“复制”提示气泡） */
	#mgp-tc.seek-open::after{display:none}
	#mgp-seek{
	  position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);
	  z-index:2147483647;display:flex;align-items:center;gap:6px;
	  background:rgba(20,20,26,.96);
	  border:1px solid rgba(255,255,255,.15);border-radius:6px;
	  padding:6px 8px;box-shadow:0 8px 24px rgba(0,0,0,.5);
	  pointer-events:auto;white-space:nowrap;
	}
	#mgp-seek-in{
	  width:168px;height:24px;padding:0 8px;
	  background:#14141a;border:1px solid rgba(255,255,255,.2);border-radius:4px;
	  color:#fff;font-size:11px;font-family:"JetBrains Mono","Cascadia Code","Consolas",monospace;
	  outline:none;
	}
	#mgp-seek-in:focus{border-color:#ff5f00}
	#mgp-seek-in::placeholder{color:#777;font-family:"PingFang SC","Microsoft YaHei",sans-serif}
	#mgp-seek-go{
	  height:24px;padding:0 10px;
	  background:#ff5f00;border:none;border-radius:4px;color:#fff;
	  font-size:12px;font-family:inherit;cursor:pointer;
	}
	#mgp-seek-go:hover{background:#ff6a1a}
@keyframes pulse{50%{opacity:.25;transform:scale(.85)}}
`;

  // 弹幕容器类名统一含 danmu / danmaku，属性选择器兜底匹配（屏蔽弹幕开关与设置一并隐藏）
  const DANMU_CSS = '[class*="danmu"],[class*="danmaku"],[id*="danmu"],[id*="danmaku"]{display:none!important}';

  const HTML = `
<div id="mgp-bar">
  <span id="mgp-tc">
    <span id="mgp-tc-badge" class="b-pl">PLAY</span>
    <span id="mgp-tc-text">00:00:00<span id="mgp-tc-frames">:00</span></span>
  </span>
</div>
<button id="mgp-btn-ss" class="mgp-side-btn" data-tip="截图 (S)">
  <svg class="mgp-icon"><rect x="1" y="4" width="14" height="10" rx="2"/><circle cx="8" cy="9" r="2.5"/></svg>
</button>
<button id="mgp-btn-rec" class="mgp-side-btn" data-tip="录制 (R)">
  <svg class="mgp-icon" id="mgp-rec-icon"><circle cx="8" cy="8" r="6"/></svg>
  <span id="mgp-rec-dot"></span>
</button>
`;

  let shadow, wrapper, video, videoContainer,
      recMediaRecorder, recChunks, recCanvas, recCtx, recStream, recRaf,
      toastTimer, stateTimer;
  let recordingInternal = false;
  let recAutoStop = false;   // 是否正好从入点开始录制 → 到出点自动停止
  let recStopTime = null;    // 本次录制的停止时间（独立于预设出点）
  let hashSeekDone = false;

  function qs(s) { return shadow ? shadow.querySelector(s) : null; }

  // v2.0：总开关拆分为「日志记录」与「视频控制栏」两个独立开关，互不影响
  function hostOk() {
    const s = window.__mgpSettings || {};
    if (s.enabled === false) return false; // 兼容旧版总开关
    if (/mgtv\.com$/.test(location.hostname)) return true;
    return Array.isArray(s.activeHosts) && s.activeHosts.includes(location.hostname);
  }
  // 控制栏 UI（画面内控制栏与按钮）是否显示
  function barActive() {
    const s = window.__mgpSettings || {};
    if (s.barEnabled === false) return false;
    return hostOk();
  }
  // 打点是否写入日志记录
  function loggingActive() {
    const s = window.__mgpSettings || {};
    if (s.logEnabled === false) return false;
    return hostOk();
  }

  function getSeekableStart() {
    if (!video || !video.seekable || video.seekable.length === 0) return 0;
    return video.seekable.start(0);
  }

  function detectFrameRate(video) {
    if (!video.requestVideoFrameCallback) return;
    let count = 0, lastTime = 0;
    const intervals = [];
    function cb(now, meta) {
      if (meta.presentationTime && lastTime > 0) {
        const iv = meta.presentationTime - lastTime;
        if (iv > 0.001 && iv < 0.2) intervals.push(iv);
      }
      lastTime = meta.presentationTime;
      count++;
      if (count < 20) { video.requestVideoFrameCallback(cb); }
      else if (intervals.length >= 5) {
        intervals.sort((a, b) => a - b);
        const m = intervals[Math.floor(intervals.length / 2)];
        const detected = Math.round(1 / m / 5) * 5;
        if (detected >= 20 && detected <= 120) { FPS = detected; lastTCFrame = -1; }
      }
    }
    video.requestVideoFrameCallback(cb);
  }

  function inject(v) {
    if (wrapper) remove();
    video = v;
    if (!video || !video.parentElement) return;
    videoContainer = video.parentElement;
    if (getComputedStyle(videoContainer).position === 'static') videoContainer.style.position = 'relative';
    wrapper = document.createElement('div');
    // bottom:0 使 wrapper 铺满视频容器，侧边按钮才能以 top:50% 定位到画面垂直中间
    wrapper.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;';
    videoContainer.insertBefore(wrapper, videoContainer.firstChild);
    shadow = wrapper.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = CSS;
    shadow.appendChild(style);
    shadow.innerHTML += HTML;
    // Reset transient state for the new video, then restore its persisted state
    if (!recordingInternal) {
      state.inPoint = null; state.outPoint = null; state.markTime = null; state.tcMode = 'live';
    }
    loadState();
    if (state.markTime !== null || state.inPoint !== null) {
      updateTC();
    }
    // Inject document-level recording border style (must be in document, not shadow DOM)
    if (!document.getElementById('mpp-doc-style')) {
      const ds = document.createElement('style');
      ds.id = 'mpp-doc-style';
      ds.textContent = '.mgp-rec-border{outline:12px solid #e74c3c!important;outline-offset:-6px;animation:mpp-rec-pulse .8s ease-in-out infinite}@keyframes mpp-rec-pulse{0%,100%{outline-color:#e74c3c}50%{outline-color:#ff2222}}';
      document.head.appendChild(ds);
    }
    detectFrameRate(video);
    video.addEventListener('ended', onVideoEnded);
    bindEvents();
    startLoop();
  }

  function onVideoEnded() { if (recordingInternal) stopRecording(); }

  function onBarMouseLeave() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    const bar = qs('#mgp-bar');
    const tc = qs('#mgp-tc');
    if (tc) tc.style.transform = '';   // 时间码滑回居中
    if (bar && !recordingInternal) bar.classList.remove('show-btns');
  }

  function bindEvents() {
    qs('#mgp-tc').addEventListener('click', onTC);
    qs('#mgp-tc').addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      openSeek();
    });
    qs('#mgp-btn-ss').addEventListener('click', captureScreenshot);
    qs('#mgp-btn-rec').addEventListener('click', toggleRecording);
    // 侧边按钮 hover 显隐：靠近左右两侧按钮区域时显示，离开后隐藏
    videoContainer.addEventListener('mousemove', onBarHover);
    videoContainer.addEventListener('mouseleave', onBarMouseLeave);
  }

  // ─── 侧边按钮 hover 显隐（按钮位于画面垂直中间左、右两侧）──
  let hoverTimer = null;
  // 全屏无操作 5s 自动隐藏时间码；任一鼠标移动即恢复显示并重置计时
  let fsIdleTimer = null;
  function showTC() {
    const tc = qs('#mgp-tc');
    if (tc) tc.classList.remove('tc-hidden');
  }
  function scheduleFsHide() {
    if (!document.fullscreenElement) return;
    clearTimeout(fsIdleTimer);
    fsIdleTimer = setTimeout(() => {
      const tc = qs('#mgp-tc');
      if (tc) tc.classList.add('tc-hidden');
    }, 5000);
  }
  // 时间码下移：常规下移量为视频宽度的 2.5%（平滑动画）；全屏固定下移 0.5%、不做移动动画
  function moveTCDown() {
    const tc = qs('#mgp-tc');
    if (!tc || !videoContainer) return;
    const r = videoContainer.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const fs = !!document.fullscreenElement;
    tc.style.transition = fs ? 'none' : '';
    tc.style.transform = 'translateY(' + (r.width * (fs ? 0.005 : 0.025)) + 'px)';
  }
  function onBarHover(e) {
    if (!videoContainer) return;
    const r = videoContainer.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const bar = qs('#mgp-bar');
    moveTCDown();
    showTC();
    scheduleFsHide();
    // 热区：距左/右边缘 70px 内，且位于垂直中间 ±130px 带
    const nearSide = Math.min(x, r.width - x) < 70;
    const nearMid = Math.abs(y - r.height / 2) < 130;
    if (bar && nearSide && nearMid) {
      bar.classList.add('show-btns');
      clearTimeout(hoverTimer);
      hoverTimer = null;
    } else if (!hoverTimer) {
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        if (bar && !recordingInternal) bar.classList.remove('show-btns');
      }, 500);
    }
  }

  function onTC() {
    if (!video) return;
    if (state.tcMode === 'in' || state.tcMode === 'ot' || state.tcMode === 'mk') {
      state.tcMode = 'live';
      clearTimeout(stateTimer);
      saveState();
    }
    const c = fmtTC(video.currentTime, true).replace(/:/g, '');
    navigator.clipboard.writeText(c).then(() => {
      mgpToast('已复制当前时间码 ( ' + c + ' )');
    }).catch(() => mgpToast('已复制当前时间码'));
  }

  // ─── 右键时间码：输入时间码跳转 ───────────────
  // 兼容 hh:mm:ss:ff / mm:ss:ff / mm:ss / hhmmssff / mmssff / mmss
  function parseTCInput(raw) {
    const s = String(raw || '').trim();
    if (!s || !/^[0-9:]+$/.test(s)) return null;
    if (s.indexOf(':') !== -1) {
      const parts = s.split(':');
      if (parts.length < 2 || parts.length > 4) return null;
      const n = parts.map(Number);
      if (n.some(isNaN)) return null;
      if (parts.length === 2) {
        // mm:ss
        if (n[1] >= 60) return null;
        return n[0] * 60 + n[1];
      }
      // 3 段：mm:ss:ff；4 段：hh:mm:ss:ff（末段为帧）
      const ff = n[n.length - 1], ss = n[n.length - 2];
      if (ss >= 60 || ff >= FPS) return null;
      if (parts.length === 3) return n[0] * 60 + ss + ff / FPS;
      const hh = n[0], mm = n[1];
      if (mm >= 60) return null;
      return hh * 3600 + mm * 60 + ss + ff / FPS;
    }
    const d = s.length;
    if (d === 4) {
      const mm = Number(s.slice(0, 2)), ss = Number(s.slice(2, 4));
      return ss < 60 ? mm * 60 + ss : null;
    }
    if (d === 6) {
      const mm = Number(s.slice(0, 2)), ss = Number(s.slice(2, 4)), ff = Number(s.slice(4, 6));
      return (ss < 60 && ff < FPS) ? mm * 60 + ss + ff / FPS : null;
    }
    if (d === 8) {
      const hh = Number(s.slice(0, 2)), mm = Number(s.slice(2, 4)), ss = Number(s.slice(4, 6)), ff = Number(s.slice(6, 8));
      return (mm < 60 && ss < 60 && ff < FPS) ? hh * 3600 + mm * 60 + ss + ff / FPS : null;
    }
    return null;
  }

  function openSeek() {
    const tcEl = qs('#mgp-tc');
    if (!tcEl || !video) return;
    const old = tcEl.querySelector('#mgp-seek');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'mgp-seek';
    box.innerHTML =
      '<input id="mgp-seek-in" spellcheck="false" placeholder="输入时间码，任意格式均可">' +
      '<button id="mgp-seek-go" type="button">跳转</button>';
    tcEl.appendChild(box);
    tcEl.classList.add('seek-open');
    const input = box.querySelector('#mgp-seek-in');
    const go = box.querySelector('#mgp-seek-go');
    const close = () => {
      box.remove();
      tcEl.classList.remove('seek-open');
    };
    const jump = () => {
      const t = parseTCInput(input.value);
      if (t == null) { mgpToast('无法识别的时间码', true); input.focus(); input.select(); return; }
      if (!video) return;
      try { video.currentTime = Math.max(0, Math.min(t, video.duration || t)); } catch (e) { }
      mgpToast('已跳转 ' + fmtTC(video.currentTime));
      close();
    };
    input.addEventListener('keydown', e => {
      // 阻止事件冒泡到页面：输入框在 Shadow DOM 内，页面按键监听会把宿主当目标
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); jump(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    input.addEventListener('blur', () => setTimeout(() => {
      if (box.isConnected) close();
    }, 150));
    go.addEventListener('click', jump);
    input.focus();
  }

  let lastTCFrame = -1;
  let loopRaf = null, loopTimer = null;
  function startLoop() {
    function tick() {
      if (!video) return requestAnimationFrame(tick);
      enforceSpeed();
      const cf = Math.floor(video.currentTime * FPS);
      if (cf !== lastTCFrame) { lastTCFrame = cf; updateTC(); }
      loopRaf = requestAnimationFrame(tick);
    }
    loopRaf = requestAnimationFrame(tick);
    clearInterval(loopTimer);
    loopTimer = setInterval(updateTC, 500);
  }
  // 控制栏移除时停止循环，避免换集/开关控制栏后僵尸 rAF 与 setInterval 累积
  function stopLoop() {
    if (loopRaf) { cancelAnimationFrame(loopRaf); loopRaf = null; }
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  }

  function markColorFor(t) {
    if (t == null) return null;
    const m = logs.marks.find(x => x.time != null && Math.abs(x.time - t) < 0.01);
    return (m && m.color) || null;
  }
  function badgeTextColor(bg) {
    const dark = ['#9aa0a6', '#f39c12', '#f1c40f', '#f2c94c'];
    return dark.indexOf(bg) !== -1 ? '#1b1b1f' : '#ffffff';
  }

  function updateTC() {
    const txt = qs('#mgp-tc-text'), badge = qs('#mgp-tc-badge');
    if (!txt || !badge || !video) return;
    let dt, bl, bc;
    if (state.tcMode === 'rec' || recordingInternal) {
      dt = Math.max(0, video.currentTime - (state.recordingStart || 0));
      bl = 'REC'; bc = 'b-rec';
    } else if (state.tcMode === 'in') {
      dt = state.inPoint !== null ? Math.max(0, video.currentTime - state.inPoint) : 0;
      bl = 'IN'; bc = 'b-in';
    } else if (state.tcMode === 'ot') {
      dt = recStopTime !== null
        ? Math.max(0, recStopTime - (state.recordingStart || 0))
        : (state.inPoint !== null && state.outPoint !== null) ? Math.max(0, state.outPoint - state.inPoint) : 0;
      bl = 'OUT'; bc = 'b-ot';
    } else if (state.tcMode === 'mk') {
      dt = state.markTime !== null ? state.markTime : video.currentTime;
      bl = 'MARK'; bc = 'b-mk';
    } else if (video.paused) {
      dt = video.currentTime; bl = 'STOP'; bc = 'b-st';
    } else if (curSpeed > 1 || curSpeed < 1) {
      dt = video.currentTime; bl = curSpeed + 'X'; bc = 'b-pl';
    } else {
      dt = video.currentTime; bl = 'PLAY'; bc = 'b-pl';
    }
    const p = fmtTC(dt, true).split(':');
    if (p.length === 4) txt.innerHTML = p.slice(0,3).join(':') + '<span id="mgp-tc-frames">:' + p[3] + '</span>';
    badge.textContent = bl; badge.className = bc;
    if (state.tcMode === 'mk') {
      const c = markColorFor(state.markTime);
      if (c) { badge.style.background = c; badge.style.color = badgeTextColor(c); }
      else { badge.style.background = ''; badge.style.color = ''; }
    } else {
      badge.style.background = ''; badge.style.color = '';
    }
  }

  // 备注进入文件名（可开关）：截图/录制时若当前时刻恰好命中带备注的标记点/入点/出点则附加备注
  function noteForFile(t) {
    const s = window.__mgpSettings || {};
    if (s.noteFileName === false) return '';
    for (const m of logs.marks) {
      if (m.note && m.time != null && Math.abs(m.time - t) < 0.02) return m.note;
    }
    for (const u of logs.inOut) {
      if (u.note) {
        if (u.inTime != null && Math.abs(u.inTime - t) < 0.02) return u.note;
        if (u.outTime != null && Math.abs(u.outTime - t) < 0.02) return u.note;
      }
    }
    return '';
  }
  function noteFileName(t) {
    const n = noteForFile(t);
    if (!n) return '';
    const clean = String(n).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
    return clean ? clean.slice(0, 30) + '_' : '';
  }
  // 标题进入文件名（可开关）：取 "_" 或 "-" 前的节目名，如「乘风2026」
  function titleForFile() {
    const s = window.__mgpSettings || {};
    if (s.titleFileName === false) return '';
    const t = pageTitle();
    if (!t) return '';
    const clean = String(t).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
    return clean ? clean.slice(0, 24) + '_' : '';
  }

  function captureScreenshot() {
    if (!video || !video.videoWidth) { mgpToast('无画面'); return; }
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    try {
      c.getContext('2d').drawImage(video, 0, 0);
      c.toBlob(b => {
        if (!b) { mgpToast('截图失败'); return; }
        downloadBlob(b, 'S_' + titleForFile() + noteFileName(video.currentTime) + fmtTCPlain(video.currentTime) + '_' + fmtNow() + '.png');
        mgpToast('截图保存');
      }, 'image/png');
    } catch(e) { mgpToast('截图失败: 内容保护'); }
  }

  // ─── Recording (improved quality) ───────────
  let lastExpectedTime = 0, lastWallClock = 0;

  function onSeekBlock(e) {
    if (!recordingInternal || !video) return;
    e.preventDefault(); e.stopPropagation();
    // 扩展自身回跳入点触发的 seek 放行，其余 seek 一律锁回期望时间
    if (Math.abs(video.currentTime - lastExpectedTime) > 0.01) {
      video.currentTime = lastExpectedTime;
      mgpToast('录制中无法跳转', true);
    }
  }

  function toggleRecording() {
    if (recordingInternal) { stopRecording(); return; }
    if (!video || !video.videoWidth) { mgpToast('无画面'); return; }
    // 录制始终从当前位置开始，不改变已打好的入点/出点；
    // 仅当“正好从入点开始”且存在有效出点时，播放到出点自动停止
    const hasRange = state.inPoint !== null && state.outPoint !== null && state.outPoint > state.inPoint;
    const atIn = hasRange && Math.abs(video.currentTime - state.inPoint) <= 1 / FPS;
    recordingInternal = true;
    recAutoStop = atIn;
    recStopTime = null;
    state.recordingStart = video.currentTime;
    state.tcMode = 'rec'; resetSpeed();
    saveState();
    lastExpectedTime = video.currentTime;
    lastWallClock = performance.now() / 1000;
    const btn = qs('#mgp-btn-rec'), dot = qs('#mgp-rec-dot'), icon = qs('#mgp-rec-icon');
    if (btn) btn.classList.add('active');
    if (dot) dot.style.display = 'block';
    if (icon) icon.innerHTML = '<rect x="5" y="5" width="6" height="6" rx="1.5" fill="currentColor" stroke="none"/>';
    // Show buttons during recording
    const bar = qs('#mgp-bar'); if (bar) bar.classList.add('recording');
    // Add red border around video
    if (video) video.classList.add('mgp-rec-border');
    mgpToast(atIn ? '从入点录制 → 到出点自动停止' : '录制开始', true);
    if (video.paused) video.play().catch(()=>{});
    video.addEventListener('seeking', onSeekBlock, true);

    recCanvas = document.createElement('canvas');
    recCanvas.width = video.videoWidth; recCanvas.height = video.videoHeight;
    recCtx = recCanvas.getContext('2d');
    // 立即绘制首帧，避免录制开头输出空白帧
    paintRecFrame();
    // 采集帧率取源帧率 2 倍（30~60 封顶）：captureStream 定时采样与视频帧绘制同频时相位随机，
    // 采样点常落在两次绘制之间导致丢帧；加倍采样后每次绘制必被采到，输出顺滑不卡顿
    const capFps = Math.min(60, Math.max(FPS * 2, 30));
    recStream = recCanvas.captureStream(capFps);

    // Add audio track from video element
    try {
      const videoStream = video.captureStream();
      const audioTracks = videoStream.getAudioTracks();
      if (audioTracks.length > 0) recStream.addTrack(audioTracks[0]);
    } catch (e) { /* audio capture may not be supported */ }

    const mt = (() => {
      const candidates = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01E,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ];
      for (const t of candidates)
        if (MediaRecorder.isTypeSupported(t)) return t;
    })();
    // 尽量贴近视频原始码率：直链播放时用资源加载统计估算源码率（以分辨率档位为下限），
    // 分片流（HLS/DASH）估算不到时退回分辨率档位。MediaRecorder 必然重编码，只能逼近原码率。
    const recPx = video.videoWidth * video.videoHeight;
    const tierBits = recPx >= 3840 * 2160 ? 50000000
      : recPx >= 1920 * 1080 ? 20000000
      : recPx >= 1280 * 720 ? 12000000
      : 8000000;
    const srcBits = (() => {
      try {
        const url = video.currentSrc || video.src || '';
        const dur = video.duration;
        if (!url || !(dur > 0)) return 0;
        const entries = performance.getEntriesByType('resource') || [];
        for (const e of entries) {
          if ((e.name === url) && e.transferSize > 0) {
            const bps = Math.round((e.transferSize * 8) / dur);
            if (bps > 0) return bps;
          }
        }
      } catch (e) { }
      return 0;
    })();
    const videoBits = srcBits > 0 ? Math.max(srcBits, tierBits) : tierBits;
    recMediaRecorder = new MediaRecorder(recStream, {
      mimeType: mt,
      videoBitsPerSecond: videoBits,
      audioBitsPerSecond: 128000
    });
    recChunks = [];
    recMediaRecorder.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data); };
    recMediaRecorder.onstop = () => finishRecording();
    // Use shorter timeslice (250ms) for finer chunking — reduces data loss on crash
    recMediaRecorder.start(250);

    // Render loop：按视频帧节奏绘制（requestVideoFrameCallback），输出帧率与源一致、顺滑不卡顿
    const useFrameCb = typeof video.requestVideoFrameCallback === 'function';
    let lastMedia = -1;
    function paintRecFrame() {
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          recCtx.drawImage(video, 0, 0, recCanvas.width, recCanvas.height);
        }
      } catch (e) { /* protected content or hidden video */ }
    }
    if (useFrameCb) {
      (function frameDraw() {
        if (!recordingInternal) return;
        video.requestVideoFrameCallback((now, meta) => {
          const mt = meta && meta.mediaTime != null ? meta.mediaTime : -1;
          if (mt !== lastMedia) { lastMedia = mt; paintRecFrame(); }
          frameDraw();
        });
      })();
    } else {
      (function rafDraw() {
        if (!recordingInternal) return;
        recRaf = requestAnimationFrame(() => { paintRecFrame(); rafDraw(); });
      })();
    }
    // 独立 rAF 轻量 tick：持续维护录制期望时间（跳转锁定），暂停时也保持时钟新鲜
    (function tickExpected() {
      if (!recordingInternal) return;
      const now = performance.now() / 1000;
      const elapsed = now - lastWallClock;
      if (!video.paused && video.readyState >= 2) {
        lastExpectedTime += elapsed * video.playbackRate;
      }
      lastWallClock = now;
      // 正好从入点开始录制：播放到出点自动停止
      if (recAutoStop && state.outPoint !== null && video.currentTime >= state.outPoint) {
        stopRecording();
        return;
      }
      recRaf = requestAnimationFrame(tickExpected);
    })();
  }

  function stopRecording() {
    recordingInternal = false;
    if (recRaf) cancelAnimationFrame(recRaf);
    video.removeEventListener('seeking', onSeekBlock, true);
    recStopTime = video ? video.currentTime : (state.recordingStart || 0);
    state.tcMode = 'ot';
    saveState();
    if (video) video.pause(); resetSpeed();
    // Remove recording UI state
    const bar = qs('#mgp-bar'); if (bar) bar.classList.remove('recording');
    if (video) video.classList.remove('mgp-rec-border');
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000);
    if (recMediaRecorder && recMediaRecorder.state !== 'inactive') recMediaRecorder.stop();
    else finishRecording();
  }

  function finishRecording() {
    const mimeType = recMediaRecorder ? recMediaRecorder.mimeType : '';
    if (recStream) { recStream.getTracks().forEach(t=>t.stop()); recStream = null; }
    recMediaRecorder = null; recCanvas = null; recCtx = null;
    const btn = qs('#mgp-btn-rec'), dot = qs('#mgp-rec-dot'), icon = qs('#mgp-rec-icon');
    if (btn) btn.classList.remove('active'); if (dot) dot.style.display = 'none';
    if (icon) icon.innerHTML = '<circle cx="8" cy="8" r="6"/>';
    mgpHideToast();
    if (recChunks.length === 0) { mgpToast('录制为空'); recChunks = []; state.tcMode = 'live'; return; }
    const ext = /^video\/mp4/.test(mimeType) ? 'mp4' : 'webm';
    const blob = new Blob(recChunks, { type: mimeType || 'video/' + ext });
    // 从入点开始录制时用入点备注，否则用出点时刻的备注
    const recNote = noteFileName(state.recordingStart || 0) || (recStopTime != null ? noteFileName(recStopTime) : '');
    downloadBlob(blob, 'R_' + titleForFile() + recNote + fmtTCPlain(state.recordingStart||0) + '_' + fmtNow() + '.' + ext);
    const dur = recStopTime !== null ? Math.max(0, recStopTime - (state.recordingStart || 0)) : 0;
    const sec = Math.round(dur * 2) / 2;
    navigator.clipboard.writeText(String(sec)).catch(()=>{});
    mgpToast('录制结束 — '+sec+'s', true);
    recChunks = [];
  }

  function markIn() {
    if (recordingInternal || !video) return;
    recStopTime = null;
    // 新入点重置出点去重标记：否则在相同出点时刻二次打出点会被误判重复而漏记
    lastLogOutTime = null;
    state.inPoint = video.currentTime; state.outPoint = null;
    state.tcMode = 'in'; saveState();
    if (video.paused) video.play().catch(()=>{});
    mgpToast('入点 ( ' + fmtTC(video.currentTime) + ' | 0s )');
  }

  function markOut() {
    if (recordingInternal || state.inPoint === null || !video) return;
    recStopTime = null;
    const outTime = video.currentTime;
    // 出点早于入点无意义（时长为 0 的垃圾记录），拒绝并保持入点状态
    if (outTime < state.inPoint) { mgpToast('出点早于入点，未记录'); return; }
    state.outPoint = outTime; state.tcMode = 'ot';
    video.pause(); resetSpeed();
    if (lastLogOutTime === null || Math.abs(outTime - lastLogOutTime) > 0.001) {
      logs.inOut.push({
        inTime: state.inPoint, inTC: fmtTC(state.inPoint),
        outTime, outTC: fmtTC(outTime),
        dur: Math.max(0, outTime - state.inPoint),
        url: location.href,
        title: pageTitle()
      });
      lastLogOutTime = outTime;
      saveLogs();
    }
    const dur = state.outPoint - state.inPoint, sec = Math.round(dur*2)/2;
    navigator.clipboard.writeText(String(sec)).catch(()=>{});
    saveState();
    mgpToast('出点 ( ' + fmtTC(state.outPoint) + ' | ' + sec + 's )', true);
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000);
  }

  let toastEl = null;
  function mgpToast(msg, sticky) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'mgp-toast-ext';
      toastEl.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:8px 20px;background:rgba(0,0,0,.85);color:#fff;border:1px solid #ff5f00;border-radius:4px;font-size:13px;pointer-events:none;opacity:0;transition:opacity .3s;font-family:"PingFang SC","Microsoft YaHei",sans-serif;';
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = msg; toastEl.style.opacity = '1';
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 5000);
  }
  function mgpHideToast() { if (toastEl) toastEl.style.opacity = '0'; }

  function downloadBlob(blob, name) {
    const u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(u);
  }

  function remove() {
    // 录制中移除控制栏（关闭控制栏 / 换集重建）：必须停止录制，否则 R 键失效后将无法停止
    if (recordingInternal) stopRecording();
    if (video) video.removeEventListener('ended', onVideoEnded);
    if (videoContainer) {
      videoContainer.removeEventListener('mousemove', onBarHover);
      videoContainer.removeEventListener('mouseleave', onBarMouseLeave);
    }
    stopLoop();
    if (wrapper && wrapper.parentElement) wrapper.parentElement.removeChild(wrapper);
    wrapper = null; shadow = null; video = null; videoContainer = null;
  }

  // 插件启用期间（当前站点适用且「禁用弹幕」开启）屏蔽弹幕：注入 document 级样式，设置变化 / 换集时同步
  function syncDanmuBlock() {
    const s = window.__mgpSettings || {};
    const on = hostOk() && s.danmuBlock !== false;
    const st = document.getElementById('mpp-danmu-style');
    if (on && !st) {
      const el = document.createElement('style');
      el.id = 'mpp-danmu-style';
      el.textContent = DANMU_CSS;
      document.head.appendChild(el);
    } else if (!on && st) {
      st.remove();
    }
  }

  function syncBar() {
    loadLogs();
    syncDanmuBlock();
    const on = barActive();
    if (window.__mgp_video) applyHashSeek(window.__mgp_video);
    if (on && window.__mgp_video) {
      // 换集后旧容器可能被整体重建：wrapper 虽存在但已脱离 DOM（isConnected=false）时同样需要重建
      if (!wrapper || !wrapper.isConnected || video !== window.__mgp_video) inject(window.__mgp_video);
    } else if (!on && wrapper) remove();
  }

  function mark() {
    if (!video || recordingInternal) return;
    state.markTime = video.currentTime;
    state.tcMode = 'mk'; saveState();
    logs.marks.push({ time: state.markTime, tc: fmtTC(state.markTime), url: location.href, title: pageTitle() });
    saveLogs();
    const c = fmtTC(state.markTime, true).replace(/:/g, '');
    navigator.clipboard.writeText(c).catch(()=>{});
    mgpToast('已标记 ( ' + fmtTC(state.markTime) + ' )', true);
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000);
  }

  // ─── Speed helpers ──────────────────────────
  let curSpeed = 1;

  function setSpeed(s) { if (!video) return; curSpeed = Math.max(0.25, Math.min(16, s)); video.playbackRate = curSpeed; if (curSpeed !== 1) mgpToast(curSpeed + 'X'); }
  function speedUp() { if (!video) return; setSpeed(Math.min(16, curSpeed * 2)); if (video.paused) video.play().catch(()=>{}); }
  function speedDown() { if (!video) return; setSpeed(Math.max(0.25, curSpeed / 2)); if (video.paused) video.play().catch(()=>{}); }
  function resetSpeed() { curSpeed = 1; if (video) video.playbackRate = 1; }
  // 网络波动/播放器重建可能把 playbackRate 重置为 1，但状态仍应保持设定倍速：
  // 每帧校验实际倍速，偏离时按 curSpeed 重新应用，避免"标签显示 8X 实际却 1X"
  function enforceSpeed() { if (!video) return; if (curSpeed !== 1 && Math.abs(video.playbackRate - curSpeed) > 0.01) video.playbackRate = curSpeed; }
  function jumpIn() { if (state.inPoint === null || !video) return; recStopTime = null; video.currentTime = state.inPoint; video.pause(); resetSpeed(); state.tcMode = 'in'; mgpToast('入点 ( ' + fmtTC(state.inPoint) + ' | 0s )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); }
  function jumpOut() { if (state.outPoint === null || !video) return; recStopTime = null; video.currentTime = state.outPoint; video.pause(); resetSpeed(); const dur = state.outPoint - (state.inPoint||0); const sec = Math.round(dur*2)/2; state.tcMode = 'ot'; mgpToast('出点 ( ' + fmtTC(state.outPoint) + ' | ' + sec + 's )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); }

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (!hostOk()) return;
    if (!video) return;

    // JKL navigation
    if (!e.shiftKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); if (video.paused) video.play().catch(()=>{}); speedDown(); return; }
    if (!e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); video.paused ? video.play().catch(()=>{}) : video.pause(); resetSpeed(); return; }
    if (!e.shiftKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); if (video.paused) video.play().catch(()=>{}); speedUp(); return; }
    if (!e.shiftKey && e.key === ' ') { e.preventDefault(); resetSpeed(); return; }

    // Shift combos
    if (e.shiftKey && (e.key === 'I' || e.key === 'i')) { e.preventDefault(); jumpIn(); return; }
    if (e.shiftKey && (e.key === 'O' || e.key === 'o')) { e.preventDefault(); jumpOut(); return; }
    if (e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); if (state.markTime !== null) { video.currentTime = state.markTime; video.pause(); resetSpeed(); state.tcMode = 'mk'; mgpToast('标记点 ( ' + fmtTC(state.markTime) + ' )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); } return; }
    if (e.shiftKey) return;

    switch (e.key) {
      case ',': e.preventDefault(); video.currentTime = Math.max(getSeekableStart(), video.currentTime - 1/FPS); mgpToast('前一帧 ( ' + fmtTC(video.currentTime) + ' )'); break;
      case '.': e.preventDefault(); video.currentTime = Math.min(video.duration||Infinity, video.currentTime + 1/FPS); mgpToast('后一帧 ( ' + fmtTC(video.currentTime) + ' )'); break;
      case 'i': case 'I': if (!recordingInternal) { if (loggingActive()) { e.preventDefault(); markIn(); } else { e.preventDefault(); mgpToast('日志记录已关闭'); } } break;
      case 'o': case 'O': if (!recordingInternal && state.inPoint !== null) { if (loggingActive()) { e.preventDefault(); markOut(); } else { e.preventDefault(); mgpToast('日志记录已关闭'); } } break;
      case 'm': case 'M': if (!recordingInternal) { if (loggingActive()) { e.preventDefault(); mark(); } else { e.preventDefault(); mgpToast('日志记录已关闭'); } } break;
      case 'r': case 'R': e.preventDefault(); toggleRecording(); break;
      case 's': case 'S': e.preventDefault(); captureScreenshot(); break;
    }
  });

  window.addEventListener('mgp-video-found', syncBar);
  window.addEventListener('mgp-settings', syncBar);

  // 全屏切换：进入时时间码下移并启动无操作计时，退出时回到原位并停止计时
  document.addEventListener('fullscreenchange', () => {
    showTC();
    if (document.fullscreenElement) {
      moveTCDown();
      scheduleFsHide();
    } else {
      const tc = qs('#mgp-tc');
      if (tc) tc.style.transform = '';
      clearTimeout(fsIdleTimer);
    }
  });

  // 面板「刷新」：不关闭弹窗/侧边栏，仅重启页面端服务——重建控制栏并重载记录
  window.addEventListener('mgp-reload', () => {
    if (recordingInternal) stopRecording();
    if (wrapper) remove();
    syncBar();
  });

  syncBar();

  // ─── SPA 换集：URL 变化时重载记录与状态条 ─────
  let lastUrlKey = videoKey();
  let resyncTimer = null;
  function onUrlChange() {
    const k = videoKey();
    if (k !== lastUrlKey) {
      lastUrlKey = k;
      if (!recordingInternal) {
        state.inPoint = null; state.outPoint = null; state.markTime = null; state.tcMode = 'live';
      }
      // 换集后重置：出点去重标记与新分集无关；#mpp= 定位需对新分集重新生效
      lastLogOutTime = null;
      hashSeekDone = false;
      loadState();
      loadLogs();
      syncBar();
      // 换集后播放器容器可能被重建：待播放器就位后再校准一次控制栏
      clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => {
        if (video && !document.contains(video)) {
          const fresh = document.querySelector('video');
          if (fresh) window.__mgp_video = fresh;
        }
        syncBar();
      }, 500);
    }
  }
  try {
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        onUrlChange();
        return r;
      };
    });
    window.addEventListener('popstate', onUrlChange);
  } catch (e) { }

  // ─── Hash seek: links like #mpp=123.4 seek once on page open ──
  function applyHashSeek(v) {
    if (hashSeekDone || !v) return;
    hashSeekDone = true;
    try {
      const m = (location.hash || '').match(/mpp=([\d.]+)/);
      if (m) {
        const t = parseFloat(m[1]);
        if (!isNaN(t) && isFinite(t)) v.currentTime = t;
      }
    } catch (e) { }
  }

  // ─── Log API (used by popup via executeScript) ───
  window.__mgpToast = mgpToast;
  window.__mgpAPI = {
    getLogs() { return JSON.parse(JSON.stringify(logs)); },
    jumpTo(t) {
      if (!video) return false;
      video.currentTime = t;
      video.pause();
      resetSpeed();
      try { mgpToast('已跳转 ' + fmtTC(t)); } catch (e) { }
      return true;
    },
    removeLogs(selObj) {
      let removed = 0;
      if (selObj && Array.isArray(selObj.inOut)) {
        [...selObj.inOut].sort((a, b) => b - a).forEach(i => {
          if (i >= 0 && i < logs.inOut.length) { logs.inOut.splice(i, 1); removed++; }
        });
      }
      if (selObj && Array.isArray(selObj.marks)) {
        [...selObj.marks].sort((a, b) => b - a).forEach(i => {
          if (i >= 0 && i < logs.marks.length) { logs.marks.splice(i, 1); removed++; }
        });
      }
      saveLogs();
      try { mgpToast('已清除 ' + removed + ' 条记录', true); } catch (e) { }
      return removed;
    },
    setMarkColor(i, color) {
      if (!logs.marks[i]) return false;
      if (color === null || color === undefined) {
        delete logs.marks[i].color;
        saveLogs();
        try { mgpToast('已清除标记颜色'); } catch (e) { }
        return true;
      }
      if (typeof color !== 'string') return false;
      logs.marks[i].color = color;
      saveLogs();
      const name = Object.keys(MARK_COLORS).find(k => MARK_COLORS[k] === color);
      try { mgpToast('标记点已设为 ' + (name || '自定义色')); } catch (e) { }
      return true;
    },
    // v2.0 打点备注：type 为 'mk'（标记点）或 'io'（入点到出点）；note 为空则删除备注
    setNote(type, idx, note) {
      const arr = type === 'io' ? logs.inOut : logs.marks;
      if (!arr[idx]) return false;
      if (note === undefined || note === null || String(note).trim() === '') delete arr[idx].note;
      else arr[idx].note = String(note);
      saveLogs();
      return true;
    },
    // v2.0 标题重命名：写入 mpp_titles（custom 标记），并同步更新已有记录的标题字段
    setTitle(t) {
      const clean = String(t || '').trim();
      let titles = {};
      try { titles = JSON.parse(localStorage.getItem('mpp_titles') || '{}') || {}; } catch (e) { }
      const key = videoKey();
      if (!clean) {
        const cur = titles[key];
        if (cur) { delete cur.custom; cur.title = pageTitle(); }
        localStorage.setItem('mpp_titles', JSON.stringify(titles));
      } else {
        titles[key] = { title: clean, url: location.href, custom: true };
        localStorage.setItem('mpp_titles', JSON.stringify(titles));
        logs.marks.forEach(m => { m.title = clean; });
        logs.inOut.forEach(u => { u.title = clean; });
        saveLogs();
      }
      return true;
    },
    copyTC(t) {
      const c = fmtTC(t, true).replace(/:/g, '');
      navigator.clipboard.writeText(c).then(() => mgpToast('已复制时间码 ( ' + c + ' )')).catch(() => mgpToast('已复制时间码'));
      return true;
    },
    copyLink(link) {
      navigator.clipboard.writeText(link).then(() => mgpToast('已复制链接')).catch(() => mgpToast('已复制链接'));
      return true;
    },
    clearAll() {
      try {
        localStorage.removeItem(LOGS_KEY);
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem('mpp_titles');
        logs = { inOut: [], marks: [] };
        lastLogOutTime = null;
        state.inPoint = null; state.outPoint = null; state.markTime = null;
        window.__mgp_logs = logs;
        try { mgpToast('已清除所有记录', true); } catch (e) { }
        return true;
      } catch (e) { return false; }
    }
  };

})();
