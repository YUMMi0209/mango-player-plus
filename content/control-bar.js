/**
 * MG Player+ v2.0 — Video control bar
 */
(function () {
  let FPS = 25;
  window.__mgpFps = FPS;
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
  // 暴露统一 key 解析：面板注入脚本优先使用，避免 URL 结构正则在各处重复维护
  window.__mgpVkey = videoKey;

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
    // 标记 / 片段按时间码先后排列（兼容历史乱序数据）
    logs.marks.sort((a, b) => (a.time != null ? a.time : 0) - (b.time != null ? b.time : 0));
    logs.inOut.sort((a, b) => (a.inTime != null ? a.inTime : 0) - (b.inTime != null ? b.inTime : 0));
    window.__mgp_logs = logs;
  }
  // 按时间码有序插入（标记按 time，片段按 inTime），保持列表始终按时间先后排列
  function insertSorted(arr, item, keyFn) {
    let i = 0;
    while (i < arr.length && keyFn(arr[i]) <= keyFn(item)) i++;
    arr.splice(i, 0, item);
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
    // +1e-6：修正浮点边界（如 0.04*25=1.0000000000000002 会误进下一帧）
    const tf = Math.floor(sec * FPS + 1e-6);
    const fph = FPS * 3600, fpm = FPS * 60;
    const h = Math.floor(tf / fph), m = Math.floor((tf % fph) / fpm);
    const s = Math.floor((tf % fpm) / FPS), f = tf % FPS;
    const hms = String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    return frames ? hms+':'+String(f).padStart(2,'0') : hms;
  }
  function fmtTCPlain(sec) { return fmtTC(sec, false).replace(/:/g, '-'); }
  // 带帧号文件名时间码 HH-MM-SS-FF：截图文件名与打点记录时间码精确对应，便于截图管理匹配
  function fmtTCPlainF(sec) { return fmtTC(sec, true).replace(/:/g, '-'); }
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
  display:flex;align-items:flex-start;justify-content:center;
  height:46px;padding:8px 8px 0;
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
/* 网页全屏悬浮进度条：仅全屏时显示，底部居中，可拖动调整播放位置 */
/* 进度条容器：定位与拉长动画在容器上；input 占满容器，轨道视觉仅 4px。
   长度左右各缩短 8px（背景槽与进度条等宽，间距通过缩短进度条实现） */
#mgp-fs-wrap{
  position:absolute;bottom:24px;left:50%;transform:translateX(-50%);
  width:calc(min(72vw,680px) - 16px);height:16px;z-index:2147483647;
  display:none;pointer-events:none;
  transition:width .25s ease;
}
:host(.fs-on) #mgp-fs-wrap{display:block}
/* 深色背景槽：让进度条在明亮画面中也清晰可见（置于最底层，轨道显示在槽上方） */
#mgp-fs-wrap::before{
  content:'';position:absolute;top:50%;left:0;right:0;height:32px;transform:translateY(-50%);
  background:rgba(0,0,0,.55);border-radius:16px;border:1px solid rgba(255,255,255,.12);
  z-index:0;
}
/* 自绘轨道：绝对定位垂直居中（不受浏览器 input track 布局差异影响），左右与 input 对齐（各 16px 空隙） */
#mgp-fs-track{
  position:absolute;top:50%;left:16px;right:16px;height:4px;transform:translateY(-50%);
  border-radius:2px;z-index:0;pointer-events:none;
  background:linear-gradient(to right, #ff5f00 0%, #ff5f00 var(--fill), rgba(255,255,255,.22) var(--fill));
}
#mgp-fs-progress{
  position:relative;z-index:1;display:block;width:calc(100% - 32px);height:16px;pointer-events:auto;
  -webkit-appearance:none;appearance:none;cursor:pointer;
  background:transparent;outline:none;margin:0 auto;padding:0;--fill:0%;
}
/* 拖动时播放点上方的时间码气泡 */
#mgp-fs-tip{
  position:absolute;bottom:calc(100% + 8px);left:0;transform:translateX(-50%);
  background:rgba(0,0,0,.85);color:#fff;padding:3px 8px;border-radius:4px;
  font-size:12px;font-family:"JetBrains Mono","Cascadia Code","Consolas",monospace;
  letter-spacing:.5px;border:1px solid rgba(255,255,255,.15);white-space:nowrap;
  display:none;pointer-events:none;z-index:2147483647;
}
/* input 自带轨道透明化：轨道视觉由 #mgp-fs-track 绘制 */
#mgp-fs-progress::-webkit-slider-runnable-track{
  height:4px;border-radius:2px;background:transparent;
}
#mgp-fs-progress::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;
  background:#ff5f00;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);
  margin-top:-5px;
}
#mgp-fs-progress::-moz-range-track{
  height:4px;border-radius:2px;background:transparent;
}
#mgp-fs-progress::-moz-range-progress{
  height:4px;border-radius:2px;background:transparent;
}
#mgp-fs-progress::-moz-range-thumb{
  width:14px;height:14px;border-radius:50%;background:#ff5f00;border:2px solid #fff;cursor:pointer;
}
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
<div id="mgp-fs-wrap">
  <div id="mgp-fs-track"></div>
  <input id="mgp-fs-progress" type="range" min="0" max="0" value="0" step="0.01">
  <span id="mgp-fs-tip"></span>
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
  let recKeepTimer = null;   // captureStream 兜底重绘定时器（暂停 / 无新帧时保持录制流）
  let recordingInternal = false;
  let recAutoStop = false;   // 是否正好从入点开始录制 → 到出点自动停止
  let recStopTarget = null;  // 自动停止目标时间（日志片段记录匹配出点，独立于预设出点）
  let recStopTime = null;    // 本次录制的停止时间（独立于预设出点）
  let hashSeekDone = false;

  function qs(s) { return shadow ? shadow.querySelector(s) : null; }

  // v2.0：总开关拆分为「日志记录」与「视频控制栏」两个独立开关，互不影响
  function hostOk() {
    const s = window.__mgpSettings || {};
    if (s.enabled === false) return false; // 兼容旧版总开关
    // 默认白名单站点：芒果TV 与 百度网盘（无需「应用于当前网页」授权）
    if (/mgtv\.com$/.test(location.hostname) || location.hostname === 'pan.baidu.com') return true;
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

  // ─── 直播回退：本地缓存 600s + 禁用「落后直播边缘自动拉回」（方案 C 已验证）──
  const LIVE_BACKBUFFER = 600;
  let liveHlsSeen = null;   // 已注入配置的 hls 实例（切清晰度 / 播放器重建会被替换）
  function isLivePage() { return !!(window.hhls) && /mgtv\.com$/.test(location.hostname); }
  function applyLiveConfig() {
    const h = window.hhls;
    if (!h || !h.config || !isLivePage()) return;
    if (h !== liveHlsSeen) {
      // 实例重建（首次出现不提示）：旧缓存已清空，提示用户可重新回退
      if (liveHlsSeen !== null) mgpToast('回退缓存已重建，可重新回退', true);
      liveHlsSeen = h;
    }
    if (h.config.backBufferLength !== LIVE_BACKBUFFER) h.config.backBufferLength = LIVE_BACKBUFFER;
    if (h.config.liveMaxLatencyDuration !== Infinity) h.config.liveMaxLatencyDuration = Infinity;
  }
  // 轮询：覆盖 hls 实例延迟出现与清晰度切换重建（window.hhls 被替换）
  setInterval(applyLiveConfig, 500);

  function seekableRange() {
    if (!video || !video.seekable || video.seekable.length === 0) return null;
    return { start: video.seekable.start(0), end: video.seekable.end(video.seekable.length - 1) };
  }
  // 回退 / 前进（直播）：clamp 到可回退范围
  function seekRel(delta) {
    if (!video) return;
    const r = seekableRange();
    if (!r) { mgpToast('暂无回退缓存'); return; }
    const target = Math.min(r.end, Math.max(r.start, video.currentTime + delta));
    if (Math.abs(target - video.currentTime) < 0.001) { mgpToast('已到最新画面'); return; }
    video.currentTime = target;
    mgpToast((delta < 0 ? '回退 ' : '前进 ') + Math.abs(delta) + 's ( ' + fmtTC(dispTime()) + ' )');
  }

  function getSeekableStart() {
    if (!video || !video.seekable || video.seekable.length === 0) return 0;
    return video.seekable.start(0);
  }

  // 实际渲染帧的最新媒体时间（rVFC meta.mediaTime 与该帧一一对应）：
  // 掉帧/丢帧时 currentTime 仍按媒体时间轴前进，而画面实际显示的是跳变后的帧，
  // 因此时间码必须以 mediaTime 为准才能与画面内嵌时间码一致
  let lastFrameMediaTime = null;
  // 持续校准帧率：掉帧会让单帧间隔翻倍，取滑动窗口中位数抗噪；
  // 非整数帧率（23.976 / 29.97 / 59.94）四舍五入到整数（24 / 30 / 60），
  // 不再归整到 5 的倍数（否则 24fps 会被误判为 25fps 导致时间码逐帧漂移）
  function detectFrameRate(v) {
    if (!v.requestVideoFrameCallback) return;
    let lastMedia = 0;
    const intervals = [];
    function cb(now, meta) {
      if (v !== video) return;   // 换集/移除后终止
      const mt = meta.mediaTime;
      if (mt != null) lastFrameMediaTime = mt;
      if (mt != null && lastMedia > 0) {
        const iv = mt - lastMedia;
        if (iv > 0.001 && iv < 0.2) {
          intervals.push(iv);
          if (intervals.length > 60) intervals.shift();
          const sorted = intervals.slice().sort((a, b) => a - b);
          const m = sorted[Math.floor(sorted.length / 2)];
          const detected = Math.round(1 / m);
          if (detected >= 20 && detected <= 120 && detected !== FPS) {
            FPS = detected; lastTCFrame = -1;
            // 暴露校准帧率：日志导入按同一帧率换算时间码（避免导出/导入帧率不一致导致定位错位）
            window.__mgpFps = FPS;
          }
        }
      }
      lastMedia = mt;
      v.requestVideoFrameCallback(cb);
    }
    v.requestVideoFrameCallback(cb);
  }
  // 时间码基准：优先实际渲染帧的媒体时间（精确到帧），回退 video.currentTime
  function dispTime() {
    return lastFrameMediaTime != null ? lastFrameMediaTime : (video ? video.currentTime : 0);
  }
  // 跳转目标对齐到帧起点（+ 浮点 epsilon）：直接 seek 到帧边界间的连续值会渲染
  // mediaTime ≤ 目标 的最近帧，导致显示比标记时间码早一帧
  function alignToFrame(t) {
    return Math.round(t * FPS) / FPS + 1e-4;
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
    lastFrameMediaTime = null;   // 换 video 后清除旧渲染帧时间
    pendingShot = null;          // 换 video 后丢弃未保存的入点截图
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
    // 网页全屏：时间码保持当前位置，鼠标离开画面不回落
    if (webFsActive) { if (tc) moveTCDown(); }
    else if (tc) tc.style.transform = '';
    if (bar && !recordingInternal) bar.classList.remove('show-btns');
  }

  function bindEvents() {
    // 单击延迟执行复制（250ms），双击时间码则取消复制并切换网页全屏——两者不冲突
    let tcClickTimer = null;
    qs('#mgp-tc').addEventListener('click', () => {
      if (tcClickTimer) clearTimeout(tcClickTimer);
      tcClickTimer = setTimeout(() => { tcClickTimer = null; onTC(); }, 250);
    });
    qs('#mgp-tc').addEventListener('dblclick', e => {
      if (tcClickTimer) { clearTimeout(tcClickTimer); tcClickTimer = null; }
      e.preventDefault();
      e.stopPropagation();
      if (webFsActive) exitWebFs();
      else enterWebFs();
    });
    qs('#mgp-tc').addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      openSeek();
    });
    qs('#mgp-btn-ss').addEventListener('click', captureScreenshot);
    qs('#mgp-btn-rec').addEventListener('click', toggleRecording);
    // 网页全屏进度条：拖动实时同步跳转；按住不动 1 秒拉长进度条（撑满左右 1% 边距，±30s 精细调整），松开恢复
    // 鼠标拖动为手动实现（Chromium 自定义 appearance 的 range 鼠标原生拖动失效，触屏正常）
    const fp = qs('#mgp-fs-progress');
    if (fp) {
      const fpWrap = qs('#mgp-fs-wrap');
      const tip = qs('#mgp-fs-tip');
      const showTip = () => {
        if (!tip) return;
        const v = parseFloat(fp.value);
        if (isNaN(v)) return;
        const ratio = (parseFloat(fp.max) > parseFloat(fp.min)) ? (v - parseFloat(fp.min)) / (parseFloat(fp.max) - parseFloat(fp.min)) : 0;
        tip.style.left = (ratio * 100) + '%';
        // 气泡时间码只精确到时分秒（不显示帧号），避免与顶部帧级时间码的渲染帧差异
        tip.textContent = fmtTC(v, false);
        tip.style.display = 'block';
      };
      const fpToTime = e => {
        if (!video || !webFsActive) return;
        const rect = (fpWrap || fp).getBoundingClientRect();
        if (rect.width <= 0) return;
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const v = parseFloat(fp.min) + ratio * (parseFloat(fp.max) - parseFloat(fp.min));
        if (isNaN(v) || !isFinite(v)) return;
        if (Math.abs(parseFloat(fp.value) - v) > 0.001) fp.value = v;
        video.currentTime = v;
        showTip();
      };
      // 微调手势：分段线性映射（锚定进入微调时的鼠标位置与播放头位置）——
      // 鼠标不动则播放头不动（从中间位置开始移动，不跳变）；
      // 鼠标移到画面最左侧 → 播放头到进度条最左侧，最右侧同理；
      // 屏幕有限时也能到达两端（进入微调时鼠标位置即为两段映射的锚点）
      const fpGesture = e => {
        if (!video || !webFsActive || !fsDragState || !fsDragState.extended) return;
        const lo = parseFloat(fp.min), hi = parseFloat(fp.max);
        if (!(hi > lo)) return;
        const x = e.clientX, W = window.innerWidth, ent = fsDragState.startX;
        const a = fsDragState.anchor;
        let v;
        if (x <= ent) {
          v = ent > 0 ? lo + (x / ent) * (a - lo) : a;
        } else {
          v = W > ent ? a + ((x - ent) / (W - ent)) * (hi - a) : a;
        }
        v = Math.max(lo, Math.min(hi, v));
        if (Math.abs(parseFloat(fp.value) - v) > 0.001) fp.value = v;
        video.currentTime = v;
        showTip();
      };
      fp.addEventListener('input', () => {
        if (!video || !webFsActive) return;
        const v = parseFloat(fp.value);
        if (!isNaN(v) && isFinite(v)) video.currentTime = v;
      });
      // 拉长（进入微调）：任意操作后静止 1 秒触发（含先拖动调整再停住）；
      // 微调基准取触发时刻的播放位置（anchor）
      const extendFn = () => {
        if (!fsDragState || fsDragState.extended) return;
        fsDragState.extended = true;
        const a = video ? video.currentTime : fsDragState.anchor;
        fsDragState.anchor = a;
        const rr = fsDragState.range;
        const lo = Math.max(rr.start, a - 30), hi = Math.min(rr.end, a + 30);
        if (hi > lo) { fp.min = lo; fp.max = hi; }
        // 进度条拉长到与两侧截图/录制按钮对齐（容器宽度变化，带 transition 动画）
        if (fpWrap) fpWrap.style.width = 'calc(100% - 2%)';
        // 播放头从当前位置动画移动到进度条中间（anchor），再开始微调
        const from = parseFloat(fp.value);
        const t0 = performance.now();
        (function anim(now) {
          const p = Math.min(1, (now - t0) / 250);
          const eased = 1 - Math.pow(1 - p, 3);
          const v = from + (a - from) * eased;
          if (!isNaN(v) && isFinite(v)) { fp.value = v; if (video) video.currentTime = v; }
          if (p < 1) requestAnimationFrame(anim);
        })(performance.now());
      };
      fp.addEventListener('pointerdown', e => {
        if (!video || !webFsActive) return;
        const r = seekableRange();
        if (!r || r.end <= r.start) return;
        if (fsDragState) clearTimeout(fsDragState.timer);
        fsDragState = { anchor: video.currentTime, timer: null, extended: false, range: r, startX: e.clientX, lastAct: performance.now() };
        // 按住即定位到指针处并进入拖动
        fpToTime(e);
        try { if (fp.setPointerCapture) fp.setPointerCapture(e.pointerId); } catch (err) { }
        // 静止 1 秒触发拉长（任何指针移动都会重置计时——先拖动再停住同样触发）
        fsDragState.timer = setTimeout(extendFn, 1000);
      });
      fp.addEventListener('pointermove', e => {
        if (!fsDragState) return;
        fsDragState.lastAct = performance.now();
        // 松手兜底：鼠标已松开（残余 move 的 buttons=0，窗口外松手等场景无 pointerup）立即退出
        if (e.buttons === 0) { endDrag(); return; }
        if (fsDragState.extended) { fpGesture(e); return; }
        // 重置拉长计时：拖动中持续移动不触发；停住 1 秒后触发微调
        clearTimeout(fsDragState.timer);
        fsDragState.timer = setTimeout(extendFn, 1000);
        fpToTime(e);   // 普通拖动：播放点跟随指针，画面同步跳转
      });
      // 松开退出：window 级多重监听（pointerup / pointercancel / mouseup），
      // 覆盖指针捕获、拖出窗口、系统中断等 document 级监听可能漏收的场景；handler 幂等
      const endDrag = () => {
        if (!fsDragState) return;
        clearTimeout(fsDragState.timer);
        const wasExtended = fsDragState.extended;
        // 立即清空拖动状态：残留的 pointermove 不再触发定位 / 显示气泡（气泡松开即消失）
        fsDragState = null;
        if (tip) tip.style.display = 'none';
        if (fpWrap) fpWrap.style.width = '';   // 宽度收回（transition 动画）
        // 退出动画期间阻止 syncFsProgress 回写 value，播放头总是动画回到实际播放位置
        fsExitAnim = true;
        const r = seekableRange();
        if (r && r.end > r.start) { fp.min = r.start; fp.max = r.end; }
        const from = parseFloat(fp.value);
        const to = video ? video.currentTime : from;
        // 播放头始终动画移动（进入与退出微调、普通拖动松开均生效）
        if (Math.abs(from - to) > 0.005 || wasExtended) {
          const t0 = performance.now();
          (function anim(now) {
            const p = Math.min(1, (now - t0) / 250);
            const eased = 1 - Math.pow(1 - p, 3);
            const v = from + (to - from) * eased;
            if (!isNaN(v) && isFinite(v)) fp.value = v;
            if (p < 1) { requestAnimationFrame(anim); } else { fsExitAnim = false; syncFsProgress(); }
          })(performance.now());
        } else {
          fsExitAnim = false;
          syncFsProgress();
        }
      };
      // 先注销旧监听再注册：换集 / 开关控制栏多次注入不累积（窗口级监听器泄漏防护）
      if (activeEndDrag) {
        window.removeEventListener('pointerup', activeEndDrag);
        window.removeEventListener('pointercancel', activeEndDrag);
        window.removeEventListener('mouseup', activeEndDrag);
        window.removeEventListener('blur', activeEndDrag);
      }
      activeEndDrag = endDrag;
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      window.addEventListener('mouseup', endDrag);
      // 窗口失焦退出（微调中）
      window.addEventListener('blur', endDrag);
      // 全局兜底（仅注册一次）：微调中 3 秒无指针活动强制退出
      // （覆盖窗口外松手且指针静止、pointerup 完全丢失的场景）
      if (!window.__mppFsWatch) {
        window.__mppFsWatch = true;
        setInterval(() => {
          if (fsDragState && fsDragState.extended && performance.now() - (fsDragState.lastAct || 0) > 3000) activeEndDrag && activeEndDrag();
        }, 500);
      }
    }
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
  // 「时间码显示回避」关闭时不再向下移动；未手动设置过时按站点默认（芒果TV开、其他站点关）
  function avoidTimecodeOn() {
    const s = window.__mgpSettings || {};
    if (s.avoidTimecode === true) return true;
    if (s.avoidTimecode === false) return false;
    return /mgtv\.com$/.test(location.hostname);
  }
  function moveTCDown() {
    const tc = qs('#mgp-tc');
    if (!tc || !videoContainer) return;
    // 网页全屏：时间码位置参考浏览器全屏（从默认 8px 下移窗口宽 0.5%），不受回避开关影响
    if (webFsActive) {
      const r = rectForUI();
      tc.style.transform = 'translateY(' + (r.width * 0.005) + 'px)';
      return;
    }
    if (!avoidTimecodeOn()) { tc.style.transform = ''; return; }
    const r = rectForUI();
    if (r.width <= 0 || r.height <= 0) return;
    const fs = !!document.fullscreenElement;
    tc.style.transition = fs ? 'none' : '';
    tc.style.transform = 'translateY(' + (r.width * (fs ? 0.005 : 0.025)) + 'px)';
  }
  // 网页全屏时 video 脱离容器，热区/下移计算改用窗口尺寸
  function rectForUI() {
    if (webFsActive) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    return videoContainer.getBoundingClientRect();
  }
  function onBarHover(e) {
    if (!videoContainer) return;
    const r = rectForUI();
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
    const c = fmtTC(dispTime(), true).replace(/:/g, '');
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
    box.innerHTML = '<input id="mgp-seek-in" spellcheck="false" placeholder="输入时间码，按 Enter 跳转">';
    tcEl.appendChild(box);
    tcEl.classList.add('seek-open');
    const input = box.querySelector('#mgp-seek-in');
    const close = () => {
      box.remove();
      tcEl.classList.remove('seek-open');
    };
    const jump = () => {
      const t = parseTCInput(input.value);
      if (t == null) { mgpToast('无法识别的时间码', true); input.focus(); input.select(); return; }
      if (!video) return;
      try { video.currentTime = Math.max(0, Math.min(alignToFrame(t), video.duration || t)); } catch (e) { }
      mgpToast('已跳转 ' + fmtTC(dispTime()));
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
    input.focus();
  }

  let lastTCFrame = -1;
  let loopRaf = null, loopTimer = null;
  function startLoop() {
    function tick() {
      if (!video) return requestAnimationFrame(tick);
      enforceSpeed();
      const cf = Math.floor(dispTime() * FPS + 1e-6);
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
      dt = Math.max(0, dispTime() - (state.recordingStart || 0));
      bl = 'REC'; bc = 'b-rec';
    } else if (state.tcMode === 'in') {
      dt = state.inPoint !== null ? Math.max(0, dispTime() - state.inPoint) : 0;
      bl = 'IN'; bc = 'b-in';
    } else if (state.tcMode === 'ot') {
      dt = recStopTime !== null
        ? Math.max(0, recStopTime - (state.recordingStart || 0))
        : (state.inPoint !== null && state.outPoint !== null) ? Math.max(0, state.outPoint - state.inPoint) : 0;
      bl = 'OUT'; bc = 'b-ot';
    } else if (state.tcMode === 'mk') {
      dt = state.markTime !== null ? state.markTime : dispTime();
      bl = 'MARK'; bc = 'b-mk';
    } else if (video.paused) {
      dt = dispTime(); bl = 'STOP'; bc = 'b-st';
    } else if (curSpeed > 1 || curSpeed < 1) {
      dt = dispTime(); bl = curSpeed + 'X'; bc = 'b-pl';
    } else {
      dt = dispTime(); bl = 'PLAY'; bc = 'b-pl';
    }
    const p = fmtTC(dt, true).split(':');
    if (p.length === 4) txt.innerHTML = p.slice(0,3).join(':') + '<span id="mgp-tc-frames">:' + p[3] + '</span>';
    badge.textContent = bl; badge.className = bc;
    syncFsProgress();
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
  // 标题进入文件名（可开关）：取完整网页标题清洗非法字符并截断 24 字
  function titleForFile() {
    const s = window.__mgpSettings || {};
    if (s.titleFileName === false) return '';
    const t = pageTitle();
    if (!t) return '';
    const clean = String(t).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
    return clean ? clean.slice(0, 24) + '_' : '';
  }
  // 打点记录标题：优先取面板重命名过的自定义标题（mpp_titles custom），否则网页标题
  function titleForLog() {
    try {
      const titles = JSON.parse(localStorage.getItem('mpp_titles') || '{}') || {};
      const e = titles[videoKey()];
      if (e && e.custom === true && String(e.title || '').trim()) return String(e.title).trim();
    } catch (e) { }
    return pageTitle();
  }

  function captureScreenshot() {
    if (!video || !video.videoWidth) { mgpToast('无画面'); return; }
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    try {
      c.getContext('2d').drawImage(video, 0, 0);
      c.toBlob(b => {
        if (!b) { mgpToast('截图失败'); return; }
        downloadBlob(b, 'SCS_' + titleForFile() + noteFileName(video.currentTime) + fmtTCPlainF(dispTime()) + '_' + fmtNow() + '.png');
        mgpToast('截图保存');
      }, 'image/png');
    } catch(e) { mgpToast('截图失败: 内容保护'); }
  }

  // ─── 打点自动截图：M 打点立即保存；I 打入点暂存，O 打出点时保存最后一次 I 的截图 ──
  let pendingShot = null;   // { blob, tcPlain } 入点暂存截图
  // 未手动设置过时按站点默认：百度网盘开启，其他站点关闭
  function autoShot() {
    const s = window.__mgpSettings || {};
    if (s.autoShot === true) return true;
    if (s.autoShot === false) return false;
    return location.hostname === 'pan.baidu.com';
  }
  function shotToBlob(cb) {
    if (!video || !video.videoWidth) { cb(null); return; }
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    try {
      c.getContext('2d').drawImage(video, 0, 0);
      c.toBlob(cb, 'image/png');
    } catch (e) { cb(null); }
  }
  // 保存打点截图：前缀统一 SCS；t 为打点时刻视频时间（备注匹配）
  function saveShotBlob(b, t, toast) {
    if (!b) { mgpToast('截图失败', true); return; }
    downloadBlob(b, 'SCS_' + titleForFile() + noteFileName(t) + fmtTCPlainF(dispTime()) + '_' + fmtNow() + '.png');
    if (toast) mgpToast(toast, true);
  }

  // ─── Recording (improved quality) ───────────
  let lastExpectedTime = 0, lastWallClock = 0;

  function onSeekBlock(e) {
    if (!recordingInternal || !video) return;
    e.preventDefault(); e.stopPropagation();
    // 扩展自身回跳入点触发的 seek 放行，其余 seek 一律锁回期望时间；
    // 阈值 100ms：播放器缓冲 / 切清晰度 / 网络抖动导致的正常时间回跳不误锁
    if (Math.abs(video.currentTime - lastExpectedTime) > 0.1) {
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
    // 从日志列表跳转到入点开始录制：当前播放位置命中某条片段记录的入点时，
    // 以该记录的出点作为自动停止目标（页面打点状态可能未设置）
    recStopTarget = null;
    if (!atIn) {
      const rec = logs.inOut.find(u => u.inTime != null && u.outTime != null && u.outTime > u.inTime
        && Math.abs(u.inTime - video.currentTime) <= 1 / FPS);
      if (rec) recStopTarget = rec.outTime;
    }
    recordingInternal = true;
    recAutoStop = atIn || recStopTarget != null;
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

    // canvas 转绘方案（实测最稳）：canvas 捕获固定帧率流 + rVFC 按视频帧节奏绘制。
    // video.captureStream 直捕源流在部分播放器（芒果TV）会卡住画面，不使用
    recCanvas = document.createElement('canvas');
    recCanvas.width = video.videoWidth; recCanvas.height = video.videoHeight;
    recCtx = recCanvas.getContext('2d');
    // 立即绘制首帧，避免录制开头输出空白帧
    paintRecFrame();
    // 采集帧率取源帧率 2 倍（30~60 封顶）：captureStream 定时采样与视频帧绘制同频时相位随机，
    // 采样点常落在两次绘制之间导致丢帧；加倍采样后每次绘制必被采到，输出顺滑不卡顿
    const capFps = Math.min(60, Math.max(FPS * 2, 30));
    recStream = recCanvas.captureStream(capFps);
    // 音频：从 video 元素音轨拼入
    try {
      const videoStream = video.captureStream();
      const audioTracks = videoStream.getAudioTracks();
      if (audioTracks.length > 0) recStream.addTrack(audioTracks[0]);
    } catch (e) { /* audio capture may not be supported */ }
    if (!recStream.getVideoTracks().length) {
      recordingInternal = false;
      recAutoStop = false;
      mgpToast('无法采集视频流', true);
      return;
    }

    // 优先 MP4 + H.264/AAC（剪辑软件兼容性最好）；WebM 仅作回退
    const mt = (() => {
      const candidates = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2;profiles=fmp4',
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4',
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
    // captureStream 仅在 canvas 有新绘制时产生帧：启动后立即补绘一帧发出首帧，
    // 并周期性兜底重绘，避免视频暂停 / 无新帧时录制流中断卡在第一帧
    paintRecFrame();
    recKeepTimer = setInterval(() => {
      if (!recordingInternal) return;
      paintRecFrame();
    }, 200);

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
      if (recAutoStop && (recStopTarget != null ? video.currentTime >= recStopTarget : (state.outPoint !== null && video.currentTime >= state.outPoint))) {
        stopRecording();
        return;
      }
      recRaf = requestAnimationFrame(tickExpected);
    })();
  }

  function stopRecording() {
    recordingInternal = false;
    if (recRaf) cancelAnimationFrame(recRaf);
    if (recKeepTimer) { clearInterval(recKeepTimer); recKeepTimer = null; }
    video.removeEventListener('seeking', onSeekBlock, true);
    recStopTarget = null;
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
    downloadBlob(blob, 'REC_' + titleForFile() + recNote + fmtTCPlainF(dispTime()) + '_' + fmtNow() + '.' + ext);
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
    // 打点自动截图：暂存当前画面，待 O 打出点时保存（多次 I 只保留最后一次，与日志入点逻辑一致）
    if (autoShot()) {
      shotToBlob(b => { if (b) pendingShot = { blob: b, tcPlain: fmtTCPlainF(dispTime()) }; });
    }
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
      insertSorted(logs.inOut, {
        inTime: state.inPoint, inTC: fmtTC(state.inPoint),
        outTime, outTC: fmtTC(outTime),
        dur: Math.max(0, outTime - state.inPoint),
        url: location.href,
        title: titleForLog()
      }, u => u.inTime != null ? u.inTime : 0);
      lastLogOutTime = outTime;
      saveLogs();
    }
    const dur = state.outPoint - state.inPoint, sec = Math.round(dur*2)/2;
    navigator.clipboard.writeText(String(sec)).catch(()=>{});
    saveState();
    mgpToast('出点 ( ' + fmtTC(state.outPoint) + ' | ' + sec + 's )', true);
    // 保存最后一次 I 键时暂存的入点截图（记录已写入，备注可匹配）；文件名时间码用入点时刻
    if (autoShot() && pendingShot) {
      const ps = pendingShot; pendingShot = null;
      if (ps.blob) {
        downloadBlob(ps.blob, 'SCS_' + titleForFile() + noteFileName(state.inPoint) + ps.tcPlain + '_' + fmtNow() + '.png');
        mgpToast('出点 ( ' + fmtTC(state.outPoint) + ' | ' + sec + 's ) · 已截图', true);
      }
    }
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

  // ─── 网页全屏：视频铺满当前窗口（非浏览器全屏），ESC 退出 ──
  let webFsActive = false;
  let webFsSaved = null;
  let fsDragState = null;   // 进度条拖动状态：{ anchor, timer, extended, range, moved, startX }
  let fsExitAnim = false;   // 退出微调动画中：暂停进度条 value 回写
  let activeEndDrag = null; // 当前进度条退出处理（换集/重建时先注销旧监听，防泄漏）
  function enterWebFs() {
    // 使用独立视频引用：视频控制关闭后控制栏被移除（video 变量置空），
    // 此时回退到页面当前视频元素，网页全屏仍可用
    const v = video || window.__mgp_video || document.querySelector('video');
    if (!v || !v.videoWidth) { mgpToast('无画面'); return false; }
    if (webFsActive) return true;
    webFsSaved = {
      v: v, vStyle: v.getAttribute('style') || '',
      w: wrapper, wStyle: wrapper ? wrapper.getAttribute('style') : '',
      hidden: []
    };
    // 隐藏除视频与扩展控制栏外的所有页面元素：遍历整棵 DOM 树，
    // 含视频祖先链内的兄弟与任意嵌套层级的非视频元素（播放器 UI / 标题悬浮层 / 导航等）
    const hideTree = root => {
      const stack = [root];
      while (stack.length) {
        const el = stack.pop();
        if (!el || el.nodeType !== 1) continue;
        // 扩展控制栏、Toast 提示不隐藏（全屏中 Toast 正常显示）
        if (el === v || el === wrapper || el.id === 'mgp-toast-ext') continue;
        if (el.contains(v)) { [...el.children].forEach(c => stack.push(c)); continue; }
        webFsSaved.hidden.push({ t: el, orig: el.style.display });
        el.style.display = 'none';
      }
    };
    hideTree(document.body);
    // 兜底：全屏期间动态插入的非视频元素（如播放器标题悬浮层）自动隐藏
    webFsSaved.observer = new MutationObserver(muts => {
      muts.forEach(m => (m.addedNodes || []).forEach(n => { if (n.nodeType === 1) hideTree(n); }));
    });
    webFsSaved.observer.observe(document.body, { childList: true, subtree: true });
    v.style.cssText =
      'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;' +
      'width:100vw!important;height:100vh!important;object-fit:contain!important;' +
      'background:#000!important;z-index:2147483646!important;margin:0!important;' +
      'max-width:none!important;max-height:none!important;';
    if (wrapper) { wrapper.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;'; wrapper.classList.add('fs-on'); }
    webFsActive = true;
    moveTCDown();
    syncFsProgress();
    mgpToast('网页全屏（ESC 退出）', true);
    return true;
  }
  // 用保存的元素引用还原（换集/移除后 video/wrapper 可能已不是原对象）
  function exitWebFs() {
    if (!webFsActive) return false;
    if (webFsSaved) {
      if (webFsSaved.v) webFsSaved.v.setAttribute('style', webFsSaved.vStyle);
      if (webFsSaved.w) { webFsSaved.w.setAttribute('style', webFsSaved.wStyle); webFsSaved.w.classList.remove('fs-on'); }
      (webFsSaved.hidden || []).forEach(h => { if (h.t) h.t.style.display = h.orig; });
    }
    webFsActive = false;
    webFsSaved = null;
    if (fsDragState) { clearTimeout(fsDragState.timer); fsDragState = null; }
    const tc = qs('#mgp-tc');
    if (tc) tc.style.transform = '';
    mgpToast('已退出网页全屏', true);
    return false;
  }
  // 网页全屏悬浮进度条：按可回退/播放范围同步位置与已播放填充
  // 拖动中不回写 value（thumb 跟随鼠标，画面实时 seek）；长按拉长后保持 ±30s 范围
  function syncFsProgress() {
    const p = qs('#mgp-fs-progress');
    const trackEl = qs('#mgp-fs-track');
    if (!p || !trackEl || !video || !webFsActive) return;
    const setFill = pct => trackEl.style.setProperty('--fill', Math.max(0, Math.min(100, pct)) + '%');
    if (fsDragState && fsDragState.extended) {
      const v = parseFloat(p.value);
      const pct = p.max > p.min ? ((v - p.min) / (p.max - p.min)) * 100 : 0;
      setFill(pct);
      return;
    }
    const r = seekableRange();
    if (!r || r.end <= r.start) return;
    const ct = Math.max(r.start, Math.min(r.end, video.currentTime));
    // 非拖动状态才回写范围与值（拖动中 value 由用户控制，保证实时同步；退出动画期间同样不回写）
    if (!fsDragState && !fsExitAnim) {
      if (p.min !== r.start) p.min = r.start;
      if (p.max !== r.end) p.max = r.end;
      if (Math.abs(p.value - ct) > 0.001) p.value = ct;
    }
    setFill(((ct - r.start) / (r.end - r.start)) * 100);
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && webFsActive) exitWebFs();
  });
  // 网页全屏退出：双击视频画面或 ESC（document 级常驻监听，控制栏关闭时同样生效；
  // capture 阶段拦截，覆盖播放器自身的双击全屏操作）
  document.addEventListener('dblclick', e => {
    if (!webFsActive) return;
    if (e && e.target && e.target.tagName !== 'VIDEO') return;
    if (e) { e.preventDefault(); e.stopPropagation(); }
    exitWebFs();
  }, true);

  function remove() {
    // 录制中移除控制栏（关闭控制栏 / 换集重建）：必须停止录制，否则 R 键失效后将无法停止
    if (recordingInternal) stopRecording();
    if (video) video.removeEventListener('ended', onVideoEnded);
    if (videoContainer) {
      videoContainer.removeEventListener('mousemove', onBarHover);
      videoContainer.removeEventListener('mouseleave', onBarMouseLeave);
    }
    stopLoop();
    pendingShot = null;
    if (webFsActive) exitWebFs();
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
    insertSorted(logs.marks, { time: state.markTime, tc: fmtTC(state.markTime), url: location.href, title: titleForLog() }, m => m.time != null ? m.time : 0);
    saveLogs();
    const c = fmtTC(state.markTime, true).replace(/:/g, '');
    navigator.clipboard.writeText(c).catch(()=>{});
    mgpToast('已标记 ( ' + fmtTC(state.markTime) + ' )', true);
    // 打点自动截图：M 打点立即保存
    if (autoShot()) {
      shotToBlob(b => saveShotBlob(b, state.markTime, '已标记 ( ' + fmtTC(state.markTime) + ' ) · 已截图'));
    }
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
      case ',': e.preventDefault(); video.currentTime = Math.max(getSeekableStart(), video.currentTime - 1/FPS); mgpToast('前一帧 ( ' + fmtTC(dispTime()) + ' )'); break;
      case '.': e.preventDefault(); video.currentTime = Math.min(video.duration||Infinity, video.currentTime + 1/FPS); mgpToast('后一帧 ( ' + fmtTC(dispTime()) + ' )'); break;
      // PageUp / PageDown：后退 / 前进 1 秒；preventDefault 阻止浏览器默认翻页滚动
      case 'PageDown': e.preventDefault(); video.currentTime = Math.min(video.duration||Infinity, video.currentTime + 1); mgpToast('前进 1s ( ' + fmtTC(dispTime()) + ' )'); break;
      case 'PageUp': e.preventDefault(); video.currentTime = Math.max(getSeekableStart(), video.currentTime - 1); mgpToast('后退 1s ( ' + fmtTC(dispTime()) + ' )'); break;
      // 直播回退：← / → 回退 / 前进 30 秒
      case 'ArrowLeft': if (isLivePage()) { e.preventDefault(); seekRel(-30); } break;
      case 'ArrowRight': if (isLivePage()) { e.preventDefault(); seekRel(30); } break;
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
      pendingShot = null;
      hashSeekDone = false;
      // 清理旧分集的 #mpp= hash：防止用旧分集定位参数误 seek 新分集
      if (location.hash) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
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
      video.currentTime = alignToFrame(t);
      video.pause();
      resetSpeed();
      try { mgpToast('已跳转 ' + fmtTC(dispTime())); } catch (e) { }
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
    // 日志导入合并：按时间码去重后有序插入，返回新增条数（不弹 toast，反馈由面板显示）
    importLogs(marks, inOut) {
      let added = 0;
      (Array.isArray(marks) ? marks : []).forEach(m => {
        if (!m || !m.tc) return;
        if (logs.marks.some(x => x.tc === m.tc)) return;
        insertSorted(logs.marks, {
          time: m.time != null ? m.time : 0,
          tc: m.tc, color: m.color || null, note: m.note || null,
          url: location.href, title: titleForLog()
        }, x => x.time != null ? x.time : 0);
        added++;
      });
      (Array.isArray(inOut) ? inOut : []).forEach(u => {
        if (!u || !u.inTC || !u.outTC) return;
        if (logs.inOut.some(x => x.inTC === u.inTC && x.outTC === u.outTC)) return;
        insertSorted(logs.inOut, {
          inTime: u.inTime != null ? u.inTime : 0,
          inTC: u.inTC, outTime: u.outTime != null ? u.outTime : 0, outTC: u.outTC,
          dur: u.dur != null ? u.dur : Math.max(0, (u.outTime || 0) - (u.inTime || 0)),
          note: u.note || null, url: location.href, title: titleForLog()
        }, x => x.inTime != null ? x.inTime : 0);
        added++;
      });
      if (added) saveLogs();
      return added;
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
    },
    // 网页全屏切换：进入返回 true，退出返回 false
    toggleWebFs() {
      return webFsActive ? exitWebFs() : enterWebFs();
    }
  };

})();
