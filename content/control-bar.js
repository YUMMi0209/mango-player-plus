/**
 * MG Player+ v1.0 — Video-top control bar
 */
(function () {
  let FPS = 25;
  const BTN = '36px';
  const MARK_COLORS = { red: '#e74c3c', orange: '#ff7a1a', blue: '#3498db', green: '#2ecc71', gray: '#9aa0a6' };

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
  function fmtNow() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  const CSS = `
:host{all:initial;display:block;width:100%!important;contain:layout style}
#mgp-bar{
  position:absolute;top:0;left:0;right:0;z-index:100;pointer-events:auto;
  display:flex;align-items:center;gap:6px;
  height:44px;padding:0 8px;
  color:#ccc;font-size:12px;user-select:none;
}
#mgp-bar button{
  background:rgba(0,0,0,.5);
  border:1px solid rgba(255,255,255,.08);color:#ccc;cursor:pointer;
  width:${BTN};height:${BTN};min-width:${BTN};min-height:${BTN};
  border-radius:4px;font-size:12px;font-family:inherit;
  transition:opacity .3s,background .15s,color .15s,border-color .15s;
  display:inline-flex;align-items:center;justify-content:center;
  flex-shrink:0;padding:0;
}
#mgp-bar button:hover{background:rgba(255,95,0,.3);color:#fff;border-color:rgba(255,95,0,.4)}
#mgp-bar button.active{background:rgba(255,95,0,.4);color:#fff;border-color:#ff5f00}
/* Hover show/hide: default hidden, show on bar hover */
.mgp-side-btn{opacity:0;pointer-events:none;transition:opacity .3s}
#mgp-bar.show-btns .mgp-side-btn{opacity:1;pointer-events:auto}
#mgp-bar.recording .mgp-side-btn{opacity:1;pointer-events:auto}
.mgp-icon{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
#mgp-btn-prev,#mgp-btn-next{font-size:16px;font-weight:700}
#mgp-tc{
  display:flex;align-items:center;gap:6px;
  background:rgba(0,0,0,.5);
  border:1px solid rgba(255,255,255,.08);
  height:${BTN};padding:0 12px;border-radius:4px;cursor:pointer;
  font-family:"JetBrains Mono","Cascadia Code","Consolas",monospace;
  font-size:18px;color:#fff;letter-spacing:1px;
  margin:0 auto;flex-shrink:0;
}
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
	/* Recording red border: injected into document.head, not shadow DOM */
	/* Timecode custom tooltip */
	#mgp-tc{position:relative}
	#mgp-tc::after{
	  content:'复制当前时间码';position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);
	  background:rgba(0,0,0,.88);color:#fff;padding:5px 12px;border-radius:4px;
	  font-size:11px;font-family:"PingFang SC","Microsoft YaHei",sans-serif;
	  white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .2s;
	  border:1px solid rgba(255,255,255,.12);letter-spacing:0;
	}
	#mgp-tc:hover::after{opacity:1}
@keyframes pulse{50%{opacity:.25;transform:scale(.85)}}
`;

  const HTML = `
<div id="mgp-bar">
  <button id="mgp-btn-prev" class="mgp-side-btn" title="前一帧 (,)">◀</button>
  <button id="mgp-btn-next" class="mgp-side-btn" title="后一帧 (.)">▶</button>
  <span id="mgp-tc">
    <span id="mgp-tc-badge" class="b-pl">PLAY</span>
    <span id="mgp-tc-text">00:00:00<span id="mgp-tc-frames">:00</span></span>
  </span>
  <button id="mgp-btn-ss" class="mgp-side-btn" title="截图 (S)">
    <svg class="mgp-icon"><rect x="1" y="4" width="14" height="10" rx="2"/><circle cx="8" cy="9" r="2.5"/></svg>
  </button>
  <button id="mgp-btn-rec" class="mgp-side-btn" title="录制 (R)" style="position:relative">
    <svg class="mgp-icon" id="mgp-rec-icon"><circle cx="8" cy="8" r="6"/></svg>
    <span id="mgp-rec-dot"></span>
  </button>
</div>
`;

  let shadow, wrapper, video, videoContainer,
      recMediaRecorder, recChunks, recCanvas, recCtx, recStream, recRaf,
      toastTimer, stateTimer;
  let recordingInternal = false;
  let recAutoStop = false;   // 是否正好从入点开始录制 → 到出点自动停止
  let recStopTime = null;    // 本次录制的停止时间（独立于预设出点）
  let hashSeekDone = false;

  function qs(s) { return shadow ? shadow.querySelector(s) : null; }

  function mppActive() {
    const s = window.__mgpSettings || {};
    if (s.enabled === false) return false;
    if (/mgtv\.com$/.test(location.hostname)) return true;
    return Array.isArray(s.activeHosts) && s.activeHosts.includes(location.hostname);
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

  // ─── Hover show/hide buttons ────────────────
  let hoverTimer = null;
  function onBarHover(e) {
    if (!videoContainer || recordingInternal) return;
    const bar = qs('#mgp-bar'); if (!bar) return;
    const rect = videoContainer.getBoundingClientRect();
    // Show buttons when mouse is within 60px of the top edge of video
    if (e.clientY < rect.top + 60 && e.clientY >= rect.top) {
      bar.classList.add('show-btns');
      clearTimeout(hoverTimer);
    } else if (e.clientY > rect.top + 60) {
      hoverTimer = setTimeout(() => bar.classList.remove('show-btns'), 500);
    }
  }

  function inject(v) {
    if (wrapper) remove();
    video = v;
    if (!video || !video.parentElement) return;
    videoContainer = video.parentElement;
    if (getComputedStyle(videoContainer).position === 'static') videoContainer.style.position = 'relative';
    wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:100;pointer-events:none;';
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
    video.addEventListener('ended', () => { if (recordingInternal) stopRecording(); });
    // Hover detection on the video container
    videoContainer.addEventListener('mousemove', onBarHover);
    videoContainer.addEventListener('mouseleave', () => {
      const bar = qs('#mgp-bar');
      if (bar && !recordingInternal) bar.classList.remove('show-btns');
    });
    bindEvents();
    startLoop();
  }

  function bindEvents() {
    qs('#mgp-btn-prev').addEventListener('click', () => {
      if (!video) return;
      video.currentTime = Math.max(getSeekableStart(), video.currentTime - 1/FPS);
      mgpToast('前一帧 ( ' + fmtTC(video.currentTime) + ' )');
    });
    qs('#mgp-btn-next').addEventListener('click', () => {
      if (!video) return;
      video.currentTime = Math.min(video.duration||Infinity, video.currentTime + 1/FPS);
      mgpToast('后一帧 ( ' + fmtTC(video.currentTime) + ' )');
    });
    qs('#mgp-tc').addEventListener('click', onTC);
    qs('#mgp-btn-ss').addEventListener('click', captureScreenshot);
    qs('#mgp-btn-rec').addEventListener('click', toggleRecording);
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        document.addEventListener('mousemove', onFsMouse);
        // Re-attach hover to fullscreen element
        const fsEl = document.fullscreenElement;
        fsEl.addEventListener('mousemove', onBarHover);
        fsEl.addEventListener('mouseleave', () => {
          const bar = qs('#mgp-bar');
          if (bar && !recordingInternal) bar.classList.remove('show-btns');
        });
      } else {
        document.removeEventListener('mousemove', onFsMouse);
        const bar = qs('#mgp-bar'); if (bar) bar.classList.remove('show-btns');
      }
    });
  }

  function onFsMouse(e) {
    const bar = qs('#mgp-bar'); if (!bar) return;
    if (e.clientY < 60) {
      bar.classList.add('show-btns');
    } else {
      bar.classList.remove('show-btns');
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

  let lastTCFrame = -1;
  function startLoop() {
    function tick() {
      if (!video) return requestAnimationFrame(tick);
      const cf = Math.floor(video.currentTime * FPS);
      if (cf !== lastTCFrame) { lastTCFrame = cf; updateTC(); }
      requestAnimationFrame(tick);
    }
    tick();
    setInterval(updateTC, 500);
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

  function captureScreenshot() {
    if (!video || !video.videoWidth) { mgpToast('无画面'); return; }
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    try {
      c.getContext('2d').drawImage(video, 0, 0);
      c.toBlob(b => {
        if (!b) { mgpToast('截图失败'); return; }
        downloadBlob(b, 'MG_'+fmtTCPlain(video.currentTime)+'_'+fmtNow()+'.png');
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

    // 无 fps 提示：捕获跟随画布更新逐帧输出，避免 captureStream(fps) 采样抖动导致录制卡顿
    recStream = recCanvas.captureStream();

    // Add audio track from video element
    try {
      const videoStream = video.captureStream();
      const audioTracks = videoStream.getAudioTracks();
      if (audioTracks.length > 0) recStream.addTrack(audioTracks[0]);
    } catch (e) { /* audio capture may not be supported */ }

    const mt = (() => {
      const candidates = [
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
    downloadBlob(blob, 'MG_rec_'+fmtTCPlain(state.recordingStart||0)+'_'+fmtNow()+'.'+ext);
    const dur = recStopTime !== null ? Math.max(0, recStopTime - (state.recordingStart || 0)) : 0;
    const sec = Math.round(dur * 2) / 2;
    navigator.clipboard.writeText(String(sec)).catch(()=>{});
    mgpToast('录制结束 — '+sec+'s', true);
    recChunks = [];
  }

  function markIn() {
    if (recordingInternal || !video) return;
    recStopTime = null;
    state.inPoint = video.currentTime; state.outPoint = null;
    state.tcMode = 'in'; saveState();
    if (video.paused) video.play().catch(()=>{});
    mgpToast('入点 ( ' + fmtTC(video.currentTime) + ' | 0s )');
  }

  function markOut() {
    if (recordingInternal || state.inPoint === null || !video) return;
    recStopTime = null;
    const outTime = video.currentTime;
    state.outPoint = outTime; state.tcMode = 'ot';
    video.pause(); resetSpeed();
    if (lastLogOutTime === null || Math.abs(outTime - lastLogOutTime) > 0.001) {
      logs.inOut.push({
        inTime: state.inPoint, inTC: fmtTC(state.inPoint),
        outTime, outTC: fmtTC(outTime),
        dur: Math.max(0, outTime - state.inPoint),
        url: location.href
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
    if (videoContainer) {
      videoContainer.removeEventListener('mousemove', onBarHover);
    }
    if (wrapper && wrapper.parentElement) wrapper.parentElement.removeChild(wrapper);
    wrapper = null; shadow = null; video = null; videoContainer = null;
  }

  function syncBar() {
    loadLogs();
    const on = mppActive();
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
    logs.marks.push({ time: state.markTime, tc: fmtTC(state.markTime), url: location.href });
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
  function jumpIn() { if (state.inPoint === null || !video) return; recStopTime = null; video.currentTime = state.inPoint; video.pause(); resetSpeed(); state.tcMode = 'in'; mgpToast('入点 ( ' + fmtTC(state.inPoint) + ' | 0s )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); }
  function jumpOut() { if (state.outPoint === null || !video) return; recStopTime = null; video.currentTime = state.outPoint; video.pause(); resetSpeed(); const dur = state.outPoint - (state.inPoint||0); const sec = Math.round(dur*2)/2; state.tcMode = 'ot'; mgpToast('出点 ( ' + fmtTC(state.outPoint) + ' | ' + sec + 's )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); }

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (!mppActive()) return;
    if (!video) return;

    // JKL navigation
    if (!e.shiftKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); if (video.paused) { video.play().catch(()=>{}); resetSpeed(); } speedDown(); return; }
    if (!e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); video.paused ? video.play().catch(()=>{}) : video.pause(); resetSpeed(); return; }
    if (!e.shiftKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); if (video.paused) { video.play().catch(()=>{}); resetSpeed(); } else { speedUp(); } return; }
    if (!e.shiftKey && e.key === ' ') { e.preventDefault(); resetSpeed(); return; }

    // Shift combos
    if (e.shiftKey && (e.key === 'I' || e.key === 'i')) { e.preventDefault(); jumpIn(); return; }
    if (e.shiftKey && (e.key === 'O' || e.key === 'o')) { e.preventDefault(); jumpOut(); return; }
    if (e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); if (state.markTime !== null) { video.currentTime = state.markTime; video.pause(); resetSpeed(); state.tcMode = 'mk'; mgpToast('标记点 ( ' + fmtTC(state.markTime) + ' )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); } return; }
    if (e.shiftKey) return;

    switch (e.key) {
      case ',': e.preventDefault(); video.currentTime = Math.max(getSeekableStart(), video.currentTime - 1/FPS); mgpToast('前一帧 ( ' + fmtTC(video.currentTime) + ' )'); break;
      case '.': e.preventDefault(); video.currentTime = Math.min(video.duration||Infinity, video.currentTime + 1/FPS); mgpToast('后一帧 ( ' + fmtTC(video.currentTime) + ' )'); break;
      case 'i': case 'I': if (!recordingInternal) { e.preventDefault(); markIn(); } break;
      case 'o': case 'O': if (!recordingInternal && state.inPoint !== null) { e.preventDefault(); markOut(); } break;
      case 'm': if (!recordingInternal) { e.preventDefault(); mark(); } break;
      case 'M': e.preventDefault(); if (state.markTime !== null) { video.currentTime = state.markTime; mgpToast('已跳转至标记点'); } break;
      case 'r': case 'R': e.preventDefault(); toggleRecording(); break;
      case 's': case 'S': e.preventDefault(); captureScreenshot(); break;
    }
  });

  window.addEventListener('mgp-video-found', syncBar);
  window.addEventListener('mgp-settings', syncBar);

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
