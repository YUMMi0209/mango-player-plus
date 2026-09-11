/**
 * MG Player+ v2.0 — Video control bar
 */
(function () {
  let FPS = 25;
  window.__mgpFps = FPS;
  // 录制 remux（fMP4 → 经典 MP4）：IIFE 启动时捕获引用，防止页面脚本事后篡改 window.MPGRemux
  const MPGRemuxRef = (typeof window !== 'undefined' && window.MPGRemux) ? window.MPGRemux : null;
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
  let recPaintTimer = null;      // 固定节拍重绘定时器（已弃用：setInterval 间隔会被渲染节拍
                                 // 对齐，低间隔下实际触发频率骤降，与采样同频导致采旧帧）
  let recPaintRaf = 0;           // 绘制循环 rAF id（rAF 驱动绘制，前台不节流）
  let recDrawOk = 0, recDrawFail = 0;   // 绘制成功 / 连续失败计数（自愈判定 + 诊断）
  let recDrawFailAt = 0;        // 连续绘制失败起始时间（时间戳止损，rAF 帧率随显示器变化）
  let recVideoAdopted = false;   // 录制中 video 引用是否被重新定位过
  let recAdoptPending = 0;      // 上次尝试重定位 video 的时间戳（0 = 未在重试；失败后每 2s 重试一次）
  let recDiag = null, recDiagTimer = null;  // 录制诊断数据（停止 / 结束时 console 输出）
  let recFreezeTimer = null;   // 画面活性检测定时器（视频在播但画布内容不变 → 冻结止损）
  let recLastHash = null;      // 上次画布采样哈希
  let recFreezeCount = 0;      // 连续无变化计数
  let recLastCT = -1;          // 上次采样时 video.currentTime
  let recDowngradeTimer = null; // 自动降级评估（编码能力不足：丢拍率超标 → 降分辨率 / 降帧率）
  let recLastDrops = 0, recLastTicks = 0, recDowngrades = 0;  // 丢拍增量统计 + 降级次数
  let recChunkBytes = 0;        // MediaRecorder 已产出的编码数据字节数（编码进度）
  let recLastChunkAt = 0;       // 最近一次产出数据块的时刻（编码停滞判据）
  let recStartAt = 0;           // 本次录制开始时刻
  let recordingInternal = false;
  let recAutoStop = false;   // 是否正好从入点开始录制 → 到出点自动停止
  let recStopTarget = null;  // 自动停止目标时间（日志片段记录匹配出点，独立于预设出点）
  let recStopTime = null;    // 本次录制的停止时间（独立于预设出点）
  let recPaused = false;     // 页面切后台：MediaRecorder 已暂停（画中画保持录制未开启时）
  let pipActive = false;     // 画中画保持录制：录制期间 PiP 窗口激活（页面后台时视频仍渲染）
  let recPacer = null;       // CFR 时间戳自控器：最新帧 + 标准帧率节拍输出（输入输出解耦，背压丢拍不挂起）
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
  // 时间码基准：取「实际渲染帧的媒体时间」与「video.currentTime」的较小值。
  // 单独用 mediaTime 会在两类场景下偏大：
  //   ① 部分片源（芒果TV）首帧 PTS 不从 0 开始（偏移 2~3 帧），整条时间码会整体
  //      偏大——视频开头明明停在第一帧，却显示成第 2 帧；
  //   ② 播放头与渲染帧的时间基准差异。
  // 取较小值同时保留原设计意图：掉帧时 currentTime 会跳过未渲染的帧，
  // mediaTime 才是画面实际帧的时间（更小），据此显示才能与画面一致。
  function dispTime() {
    if (lastFrameMediaTime != null) {
      const ct = video ? video.currentTime : lastFrameMediaTime;
      return Math.max(0, Math.min(lastFrameMediaTime, ct));
    }
    return video ? video.currentTime : 0;
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
  // 备注段（不含分隔下划线）：用于「时间码 + 备注」拼接——有备注时备注紧跟时间码
  // 注意 noteSeg 的入参是「时间码对应的时刻」：时间码与备注必须取自同一时刻，
  // 否则会出现文件名里的时间码与备注对不上的情况
  function noteSeg(t) {
    const n = noteForFile(t);
    if (!n) return '';
    const clean = String(n).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
    return clean ? clean.slice(0, 30) : '';
  }
  // 统一文件命名：标题_时间码备注_时间.ext
  // - 无 SCS_/REC_ 类型前缀（靠扩展名区分类型）
  // - tcPlain：时间码（HH-MM-SS-FF 或 紧凑数字）
  // - noteTime：与时间码对应的时刻（截图 = 当前时刻；录制 = 入点时刻），
  //   备注就取自该时刻命中的标记点 / 片段，保证文件名内时间码与备注一致
  // - 无备注时退化为：标题_时间码_时间.ext
  function buildFileName(tcPlain, noteTime, ext) {
    return titleForFile() + tcPlain + noteSeg(noteTime) + '_' + fmtNow() + '.' + ext;
  }
  // 标题进入文件名：取完整网页标题清洗非法字符并截断 24 字（始终写入）
  function titleForFile() {
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

  // 截图：copyOnly=true 仅复制到剪贴板（C 键）；false 下载 PNG 并复制（S 键）
  function captureScreenshot(copyOnly) {
    if (!video || !video.videoWidth) { mgpToast('无画面'); return; }
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    try {
      c.getContext('2d').drawImage(video, 0, 0);
      c.toBlob(b => {
        if (!b) { mgpToast('截图失败'); return; }
        if (copyOnly) {
          // C 键：截图复制（不下载），与标注窗口内的复制行为一致
          annCopyBlob(b).then(ok => {
            mgpToast(ok ? '已复制截图' : '复制失败，请检查浏览器剪贴板权限', true);
          });
        } else {
          // 时间码与备注取自同一时刻（避免文件名内两者对不上）
          const t = dispTime();
          downloadBlob(b, buildFileName(fmtTCPlainF(t), t, 'png'));
          // S 键：下载并复制
          annCopyBlob(b).then(ok => {
            mgpToast(ok ? '截图保存 · 已复制' : '截图保存（复制失败）', true);
          });
        }
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
  // 保存打点截图：前缀统一 SCS；t 为打点时刻（时间码与备注均取自该时刻，保持一致）
  function saveShotBlob(b, t, toast) {
    if (!b) { mgpToast('截图失败', true); return; }
    downloadBlob(b, buildFileName(fmtTCPlainF(t), t, 'png'));
    if (toast) mgpToast(toast, true);
  }

  // ─── Recording (improved quality) ───────────
  let lastExpectedTime = 0, lastWallClock = 0;

  // 录制中 seek：不再锁回（锁回会与播放器自身的校正 seek 形成拉锯，导致画面卡住），
  // 而是把录制时间基准重同步到 seek 后的位置（录制时长仍按 MediaRecorder 计算，
  // 不受影响）；recAutoStop 判断用视频时间，seek 后同步更新停止目标
  function onSeekBlock(e) {
    if (!recordingInternal || !video) return;
    e.preventDefault(); e.stopPropagation();
    lastExpectedTime = video.currentTime;
    lastWallClock = performance.now() / 1000;
  }

  // 画中画保持录制开关（设置面板「画中画保持录制」）：开启后录制时自动进入画中画，
  // 页面切到后台时视频在 PiP 窗口中继续渲染（rVFC 不中断），录制画面不冻结
  function pipRecordEnabled() {
    const s = window.__mgpSettings || {};
    return s.pipRecord === true;
  }
  // 录制画面是否仍在渲染（PiP 窗口激活时后台页面也继续渲染视频）
  function pipOn() {
    return pipActive || (video != null && document.pictureInPictureElement === video);
  }

  // ─── 时间戳自控（CFR 输出）────────────────────
  // canvas.captureStream 的帧到达时刻抖动（渲染节拍 + 采样量化）导致 MediaRecorder
  // 输出 VFR（可变帧率）。此处用 MediaStreamTrackProcessor 读帧，按固定帧率网格
  // 重打时间戳（重复帧丢弃、缺帧用上一帧补），经 MediaStreamTrackGenerator 输出，
  // MediaRecorder 按输入帧 timestamp 打样本时间戳 → 输出恒定帧率。
  // 浏览器不支持（Firefox / 旧版 Chromium）时返回 null，调用方回退直连 recStream。
  // ─── 录制音频捕获 ─────────────────────────────
  // 优先 AudioContext（MediaElementSource）：video.captureStream() 会让 video 进入
  // 捕获模式，在部分播放器（芒果TV）上渲染被接管，后续 drawImage(video) 画不出新帧，
  // 表现为录制画面冻结（首帧后定格）而声音正常。AudioContext 只路由音频，不影响渲染；
  // 播放器已占用 MediaElementSource 等失败场景回退 video.captureStream() 取音频轨。
  let recAudioCtx = null;
  const recAudioSrcMap = new WeakMap();   // video 元素 → MediaElementSource（createMediaElementSource 每元素仅一次）
  function getRecAudioTrack(v) {
    try {
      if (!recAudioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('no-audio-context');
        recAudioCtx = new AC();
      }
      // Autoplay Policy：页面音频未被激活时 AudioContext 处于 suspended，
      // MediaStreamDestination 不会产生音频数据 → 直接回退 captureStream，
      // 避免"录制有概率没声音"（resume 是异步的，无法在取轨前保证完成）
      if (recAudioCtx.state !== 'running') {
        recAudioCtx.resume().catch(() => { });
        throw new Error('ac-not-running');
      }
      let src = recAudioSrcMap.get(v);
      if (!src) {
        src = recAudioCtx.createMediaElementSource(v);
        // MediaElementSource 会重路由 video 音频：必须接回扬声器保持正常出声
        src.connect(recAudioCtx.destination);
        recAudioSrcMap.set(v, src);
      }
      // 每次录制新建 MediaStreamDestination：录制停止会 stop recStream 全部轨道
      // （含本 dest 的音频轨），若复用旧 dest 会拿到已停止的轨道 → 录制无声
      const dest = recAudioCtx.createMediaStreamDestination();
      src.connect(dest);
      const t = dest.stream.getAudioTracks()[0];
      if (t) return { track: t, via: 'audiocontext' };
    } catch (e) { /* 回退下方方案 */ }
    try {
      const vs = v.captureStream();
      const t = vs.getAudioTracks()[0];
      if (t) return { track: t, via: 'capturestream' };
    } catch (e) { }
    return null;
  }


  // 录制采集帧率归一化：取最接近的标准档位（25 / 30 / 50 / 60），
  // 保证输出文件为标准帧率（剪辑软件友好）；时间码仍按真实校准帧率换算，不受影响
  function normRecFps(f) {
    const n = Math.max(20, Math.min(60, Math.round(f || 25)));
    let best = 25, bd = Infinity;
    for (const s of [60, 50, 30, 25]) {
      const d = Math.abs(s - n);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // CFR 时间戳自控（强制标准帧率）：
  // canvas.captureStream(fps) 的 fps 只是目标提示，实际输出帧率取决于 canvas 绘制
  // 频率，无法单独保证标准帧率。MediaRecorder 按帧时间戳封装——只要视频帧时间戳
  // 严格落在标准帧率网格（如 25fps → 40ms 一拍），输出文件即标准帧率。
  // 架构：输入侧持续读取 captureStream 只保留最新帧（丢弃中间帧，读取循环永不阻塞）；
  // 输出侧按标准帧率节拍把最新帧写入 generator（时间戳 = idx × frameDurUs）。
  // 输入输出完全解耦：编码器背压只导致"丢一拍"，不会挂起循环。
  // 浏览器不支持（Firefox / 旧版 Chromium）时返回 null，调用方回退直连 recStream。
  function startFramePacer(stream) {
    if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') return null;
    try {
      const vTrack = stream.getVideoTracks()[0];
      if (!vTrack) return null;
      const processor = new MediaStreamTrackProcessor({ track: vTrack });
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      const outStream = new MediaStream();
      outStream.addTrack(generator);
      // 音频是连续采样，无需规整，原样转发（pause 时随 MediaRecorder 一并暂停）
      stream.getAudioTracks().forEach(t => outStream.addTrack(t));
      const reader = processor.readable.getReader();
      const writer = generator.writable.getWriter();
      let frameDurUs = Math.round(1e6 / normRecFps(FPS)); // 标准帧率网格（微秒）
      let idx = 0;            // 已输出帧数（时间戳 = idx × frameDurUs，暂停后保持连续）
      let latest = null;      // 最新输入帧（节拍输出时使用；仅保留一帧，读取循环不积压）
      let drops = 0;          // 背压丢拍计数（诊断）
      let ticks = 0;          // 节拍总数（丢拍率 = drops / ticks）
      let stopped = false;
      let tickTimer = null;
      // 输入侧：持续读取，只保留最新帧（canvas 2× 采样节奏，读取远快于输出节拍）
      (async () => {
        try {
          while (!stopped) {
            const { value: f, done } = await reader.read();
            if (done) break;
            if (!f) continue;
            if (recPaused) { f.close(); continue; }   // 暂停期间丢弃输入帧
            if (latest) latest.close();
            latest = f;
          }
        } catch (e) { /* reader 取消 / 轨道停止 */ }
      })();
      // 输出侧：固定节拍（标准帧率），每拍输出最新帧；暂停时停拍。
      // 背压（编码器消费不及时）只丢这一拍，绝不挂起循环
      const tick = () => {
        if (stopped || recPaused) return;
        ticks++;
        if (!latest) return;
        const out = new VideoFrame(latest, { timestamp: idx * frameDurUs });
        idx++;
        if (writer.desiredSize != null && writer.desiredSize < 1) {
          drops++;
          try { out.close(); } catch (e) { }
          return;
        }
        writer.write(out).catch(() => { try { out.close(); } catch (e) { } });
      };
      let tickMs = Math.max(4, Math.round(frameDurUs / 1000));
      tickTimer = setInterval(tick, tickMs);
      return {
        stream: outStream,
        dropCount() { return drops; },
        tickCount() { return ticks; },
        // 动态调整目标帧率（自动降级用）：重建节拍，时间戳网格同步切换
        setFps(f) {
          const nf = Math.max(15, Math.min(60, Math.round(f || 25)));
          frameDurUs = Math.round(1e6 / nf);
          tickMs = Math.max(4, Math.round(frameDurUs / 1000));
          if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
          tickTimer = setInterval(tick, tickMs);
        },
        stop() {
          stopped = true;
          if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
          try { reader.cancel(); } catch (e) { }
          try { generator.stop(); } catch (e) { }
          try { if (latest) latest.close(); } catch (e) { }
        }
      };
    } catch (e) {
      return null;
    }
  }

  function toggleRecording() {
    if (recordingInternal) { stopRecording(); return; }
    if (!video || !video.videoWidth) { mgpToast('无画面'); return; }
    // 当前画面时刻（与时间码显示同源）：录制起点、入点命中判断均以此为准，
    // 避免用 video.currentTime（媒体时钟领先渲染帧）导致文件名时间码比画面多几帧
    const nowT = dispTime();
    // 录制始终从当前位置开始，不改变已打好的入点/出点；
    // 仅当“正好从入点开始”且存在有效出点时，播放到出点自动停止
    const hasRange = state.inPoint !== null && state.outPoint !== null && state.outPoint > state.inPoint;
    const atIn = hasRange && Math.abs(nowT - state.inPoint) <= 1 / FPS;
    // 从日志列表跳转到入点开始录制：当前播放位置命中某条片段记录的入点时，
    // 以该记录的出点作为自动停止目标（页面打点状态可能未设置）
    recStopTarget = null;
    if (!atIn) {
      const rec = logs.inOut.find(u => u.inTime != null && u.outTime != null && u.outTime > u.inTime
        && Math.abs(u.inTime - nowT) <= 1 / FPS);
      if (rec) recStopTarget = rec.outTime;
    }
    recordingInternal = true;
    recAutoStop = atIn || recStopTarget != null;
    recStopTime = null;
    state.recordingStart = nowT;
    state.tcMode = 'rec'; resetSpeed();
    saveState();
    lastExpectedTime = video.currentTime;   // seek 锁定基准用媒体时钟
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
    // 画中画保持录制（需用户手势）：页面切后台后视频在 PiP 窗口继续渲染，录制画面不冻结
    if (pipRecordEnabled() && typeof video.requestPictureInPicture === 'function') {
      video.requestPictureInPicture().then(() => { pipActive = true; }).catch(() => { pipActive = false; });
    }

    // 录制设置（面板「录制编码」）：1080p-h264 / 720p-h264 / 1080p-vp8 / 720p-vp8
    // 分辨率档限制 canvas 输出尺寸（源分辨率低于档位时不放大）；编码档决定 mimeType
    const recPref = (window.__mgpSettings || {}).recCodec || '1080p-h264';
    const recMaxW = recPref.indexOf('720p') === 0 ? 1280 : 1920;
    const recMaxH = recPref.indexOf('720p') === 0 ? 720 : 1080;
    const recWantVp8 = recPref.indexOf('vp8') !== -1;

    // canvas 转绘方案（实测最稳）：canvas 捕获固定帧率流 + rAF 重绘。
    // video.captureStream 直捕源流在部分播放器（芒果TV）会卡住画面，不使用
    recCanvas = document.createElement('canvas');
    recCanvas.width = Math.min(video.videoWidth, recMaxW);
    recCanvas.height = Math.min(video.videoHeight, recMaxH);
    recCtx = recCanvas.getContext('2d');
    // 画布挂入文档（移出视口不可见）：部分 Chromium 版本对不在文档中的 canvas
    // captureStream 采样会停止产帧，导致录制只有首帧画面
    recCanvas.style.cssText = 'position:fixed;left:-99999px;top:0;pointer-events:none;';
    document.body.appendChild(recCanvas);
    // 立即绘制首帧，避免录制开头输出空白帧
    paintRecFrame();
    // 采集帧率 = 最接近的标准档位（25/30/50/60）：输出标准帧率文件；
    // 绘制由采样间隔一半的定时器驱动（采样间隔内必有新绘制，不会漏帧）
    const capFps = normRecFps(FPS);
    recStream = recCanvas.captureStream(capFps);
    // 音频：AudioContext 捕获优先（避免 video.captureStream() 影响渲染），失败回退
    const audioRes = getRecAudioTrack(video);
    const audioVia = audioRes ? audioRes.via : 'none';
    if (audioRes && audioRes.track) recStream.addTrack(audioRes.track);
    if (!recStream.getVideoTracks().length) {
      recordingInternal = false;
      recAutoStop = false;
      mgpToast('无法采集视频流', true);
      return;
    }

    // 编码档：VP8（WebM）或 H.264（MP4，软编最快，默认）；VP8 供无硬件加速环境尝试
    const mt = (() => {
      const candidates = recWantVp8
        ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
        : [
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2;profiles=fmp4',
            'video/mp4;codecs=avc1.42E01E',
            'video/mp4',
            'video/webm;codecs=vp8,opus',
            'video/webm'
          ];
      for (const t of candidates)
        if (MediaRecorder.isTypeSupported(t)) return t;
    })();
    // 目标码率：按 canvas 实际输出分辨率档位取值（偏保守）。H.264 软编环境码率
    // 是编码耗时的直接因素，软编吞吐不足时低码率可显著提速
    const recPx = recCanvas.width * recCanvas.height;
    const videoBits = recPx >= 3840 * 2160 ? 12000000
      : recPx >= 1920 * 1080 ? 5000000
      : recPx >= 1280 * 720 ? 4000000
      : 3000000;
    // CFR 时间戳自控：按标准帧率网格重打时间戳，强制输出文件为标准帧率
    // （captureStream 直连输出帧率随绘制节奏浮动，无法保证标准帧率）；
    // 输入输出解耦 + 背压丢拍，不会像旧实现那样挂起冻结视频轨
    recPacer = startFramePacer(recStream);
    const mediaStream = recPacer ? recPacer.stream : recStream;
    try {
      recMediaRecorder = new MediaRecorder(mediaStream, {
        mimeType: mt,
        videoBitsPerSecond: videoBits,
        audioBitsPerSecond: 128000
      });
    } catch (e) {
      // 构造失败（编码器不支持等）：清理本次录制资源并恢复 UI，避免泄漏与状态卡死
      recordingInternal = false; recAutoStop = false;
      if (video) { video.removeEventListener('seeking', onSeekBlock, true); video.classList.remove('mgp-rec-border'); }
      if (pipOn()) { pipActive = false; document.exitPictureInPicture().catch(() => { }); }
      if (recStream) { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
      if (recPacer) { recPacer.stop(); recPacer = null; }
      if (recCanvas && recCanvas.parentElement) recCanvas.parentElement.removeChild(recCanvas);
      recCanvas = null; recCtx = null; pendingShot = null;
      if (btn) btn.classList.remove('active'); if (dot) dot.style.display = 'none';
      if (icon) icon.innerHTML = '<circle cx="8" cy="8" r="6"/>';
      if (bar) bar.classList.remove('recording');
      mgpToast('无法开始录制：编码器不支持', true);
      return;
    }
    recChunks = [];
    recChunkBytes = 0;
    recLastChunkAt = performance.now();
    recStartAt = performance.now();
    // 编码产出统计：ondataavailable 的字节数与时刻是判断「编码器是否跟得上」的
    // 唯一可靠信号（pacerDrops 只反映 pacer 队列背压，MediaRecorder 内部积压不反馈）
    recMediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) {
        recChunks.push(e.data);
        recChunkBytes += e.data.size;
        recLastChunkAt = performance.now();
      }
    };
    recMediaRecorder.onstop = () => finishRecording();
    // 编码器错误（H.264 硬件编码失败 / 资源耗尽等）监听：MediaRecorder 会静默停止
    // 消费视频轨导致画面定格，这里主动停止录制并提示，避免产出残缺文件
    recMediaRecorder.onerror = () => {
      if (recordingInternal) {
        try { mgpToast('录制出错（编码器异常），已停止', true); } catch (e) { }
        stopRecording();
      }
    };
    // Use shorter timeslice (250ms) for finer chunking — reduces data loss on crash
    recMediaRecorder.start(250);
    // 绘制驱动：requestAnimationFrame + 动态节拍。
    // 目标绘制间隔 = max(rAF 间隔, 采样间隔/2)：绘制频率约 2×采样帧率即可保证
    // 每次采样都采到最新画面（内容最多延迟半帧），同时不过度绘制——全尺寸
    // drawImage 是主线程重负载（1080p 每帧约 8MB 像素拷贝），高频绘制会与软编
    // 争抢 CPU 拖慢编码；rAF 间隔动态测量（兼容 60/120Hz 与主线程繁忙场景）
    let recRafLastTs = 0, recRafInterval = 16.7, recLastPaintTs = 0;
    paintRecFrame();
    const recRafLoop = ts => {
      if (!recordingInternal) return;
      if (recRafLastTs) recRafInterval = recRafInterval * 0.9 + (ts - recRafLastTs) * 0.1;
      recRafLastTs = ts;
      const targetPaintMs = Math.max(recRafInterval, (1000 / capFps) / 2);
      if (!recLastPaintTs || ts - recLastPaintTs >= targetPaintMs - 1) {
        recLastPaintTs = ts;
        paintRecFrame();
      }
      recPaintRaf = requestAnimationFrame(recRafLoop);
    };
    recPaintRaf = requestAnimationFrame(recRafLoop);

    // 录制诊断（排障用）：停止 / 结束时 console.info 输出，用于定位「画面卡住」类问题
    recDiag = {
      fps: FPS,
      capFps,
      pacerOn: !!recPacer,
      mimeType: mt,
      videoBits,
      audioVia,
      resW: recCanvas.width,
      resH: recCanvas.height,
      canvasInDom: !!recCanvas.parentElement,
      draws: 0, drawFails: 0, adopted: false, downgrades: 0,
      hwEnc: 'probing', hwEncCfg: ''
    };
    // 硬件编码器能力探测（WebCodecs）：MediaRecorder 无法指定编码器，
    // isConfigSupported 可判断本机是否存在可用的硬件 H.264 编码器
    // （返回 config.hardwareAcceleration 为 prefer-hardware 即硬件编码可用）
    try {
      if (typeof VideoEncoder !== 'undefined' && typeof VideoEncoder.isConfigSupported === 'function') {
        VideoEncoder.isConfigSupported({
          codec: 'avc1.42E01E',
          width: recCanvas.width,
          height: recCanvas.height,
          bitrate: videoBits,
          framerate: capFps,
          hardwareAcceleration: 'prefer-hardware'
        }).then(r => {
          if (!recDiag) return;
          recDiag.hwEnc = (r && r.supported) ? 'yes' : 'no';
          recDiag.hwEncCfg = (r && r.config && r.config.hardwareAcceleration) ? r.config.hardwareAcceleration : '';
        }).catch(() => { if (recDiag) recDiag.hwEnc = 'error'; });
      } else {
        recDiag.hwEnc = 'unsupported';
      }
    } catch (e) { recDiag.hwEnc = 'error'; }
    recDiagTimer = setInterval(() => {
      if (!recordingInternal) return;
      recDiag.draws = recDrawOk;
      recDiag.drawFails = recDrawFail;
      recDiag.adopted = recVideoAdopted;
      recDiag.pacerDrops = recPacer && typeof recPacer.dropCount === 'function' ? recPacer.dropCount() : -1;
      // 节拍数 = pacer 实际尝试输出的帧数：与最终文件帧数对比可区分
      // 「pacer 未输出」与「MediaRecorder 内部丢帧（编码吞吐不足）」
      recDiag.pacerTicks = recPacer && typeof recPacer.tickCount === 'function' ? recPacer.tickCount() : -1;
      recDiag.chunkBytes = recChunkBytes;
      recDiag.chunkCount = recChunks.length;
      recDiag.currentTime = video ? video.currentTime : -1;
    }, 500);

    // 画面活性检测：视频在播放（currentTime 前进）但 canvas 内容持续无变化 →
    // 绘制已失效（drawImage 冻结 / video 渲染被接管），自动停止录制避免产出
    // "画面定格"的废片。每 2s 采样画布 4 行像素哈希（分散采样防局部变化漏判）
    recLastHash = null; recFreezeCount = 0; recLastCT = -1;
    recFreezeTimer = setInterval(() => {
      if (!recordingInternal) return;
      if (!recCtx || !recCanvas || !video) { recLastCT = video ? video.currentTime : -1; return; }
      if (video.paused || video.readyState < 2) { recLastCT = video.currentTime; return; }
      let h = 0;
      try {
        const w = recCanvas.width, hh = recCanvas.height;
        const ys = [0, Math.floor(hh * 0.25), Math.floor(hh * 0.5), Math.floor(hh * 0.75)];
        for (const y of ys) {
          const d = recCtx.getImageData(0, y, Math.min(w, 320), 1).data;
          for (let i = 0; i < d.length; i += 16) h = (h * 31 + d[i]) | 0;
        }
      } catch (e) { recLastCT = video.currentTime; return; }   // 画布 tainted：无法采样，跳过
      const ct = video.currentTime;
      if (recLastHash !== null && h === recLastHash && ct > recLastCT) {
        recFreezeCount++;
        if (recFreezeCount >= 4) {   // ~8 秒无变化 → 冻结，止损停止
          recDiag.freeze = recFreezeCount;
          try { mgpToast('录制画面已冻结，录制已停止', true); } catch (e) { }
          stopRecording();
          return;
        }
      } else {
        recFreezeCount = 0;
      }
      recLastHash = h;
      recLastCT = ct;
    }, 2000);

    // ─── 自动降级：编码能力不足（软编环境常见）时保证录制流畅 ─────────
    // 判据用「MediaRecorder 实际编码产出」而非 pacer 丢拍率：
    // pacerDrops 只反映 pacer→generator 队列背压，MediaRecorder 内部积压
    // （编码器吞吐不足）不会反馈到该计数——曾导致 1080p 严重滞后却不降级。
    // 两种判据任一成立即降级：
    //   ① 编码停滞：已录 >5s 且超过 2.5s 没有新数据块（timeslice 250ms）
    //   ② 编码吞吐不足：累计产出字节数远低于目标码率对应的量
    // 降级顺序：先降录制分辨率（×2/3），已最低则目标帧率降一档（60→50→30→25）
    const REC_FPS_STEPS = [60, 50, 30, 25];
    function recDowngradeRes() {
      if (!recCanvas || !video) return false;
      const nw = Math.round(recCanvas.width * 2 / 3);
      const nh = Math.round(recCanvas.height * 2 / 3);
      if (nw < 320 || nh < 180) return false;   // 已到最低档
      recCanvas.width = nw; recCanvas.height = nh;
      recDiag.resW = nw; recDiag.resH = nh;
      return true;
    }
    function recFpsDownStep() {
      const cur = recDiag.capFps;
      const i = REC_FPS_STEPS.indexOf(cur);
      if (i < 0 || i >= REC_FPS_STEPS.length - 1) return false;  // 已到最低档
      const nf = REC_FPS_STEPS[i + 1];
      recDiag.capFps = nf;
      if (recPacer && typeof recPacer.setFps === 'function') recPacer.setFps(nf);
      return true;
    }
    function recDoDowngrade() {
      if (recDowngradeRes()) {
        recDowngrades++;
        recDiag.downgrades = recDowngrades;
        try { mgpToast('设备编码能力不足，已降低录制分辨率', true); } catch (e) { }
        return true;
      }
      if (recFpsDownStep()) {
        recDowngrades++;
        recDiag.downgrades = recDowngrades;
        try { mgpToast('设备编码能力不足，录制帧率已降为 ' + recDiag.capFps + 'fps', true); } catch (e) { }
        return true;
      }
      return false;
    }
    recLastDrops = 0; recLastTicks = 0;
    recDowngradeTimer = setInterval(() => {
      if (!recordingInternal || !recPacer) return;
      const now = performance.now();
      const elapsed = (now - recStartAt) / 1000;
      if (elapsed < 4) return;           // 启动初期不评估（编码器热身 / 首块延迟）
      const d = recPacer.dropCount(), t = recPacer.tickCount();
      const dD = d - recLastDrops, tD = t - recLastTicks;
      recLastDrops = d; recLastTicks = t;
      // ① 编码停滞：2.5s 无新数据块（timeslice 250ms）
      const stalled = now - recLastChunkAt > 2500;
      // ② 编码吞吐：累计字节数 < 目标码率 × 录制时长 × 30%（下限 20KB 防误判）
      const expectedBytes = ((videoBits + 128000) / 8) * elapsed * 0.3;
      const lowThroughput = recChunkBytes > 0 && recChunkBytes < expectedBytes && expectedBytes > 20000;
      // ③ pacer 丢拍率（旧判据，保留兜底）
      const highDrop = tD >= 20 && dD / tD > 0.4;
      if (!stalled && !lowThroughput && !highDrop) return;
      recDoDowngrade();
    }, 2000);

    // Render：16ms 定时重绘已在上面启动（captureStream 只在 canvas 有新绘制时产帧），
    // 不再叠加 rVFC / rAF 绘制链——多驱动无收益且增加不确定性

    // 录制绘制：先校验 video 引用健康度（播放器重建 / 切清晰度 / 元素被移除时自动重定位），
    // 再 drawImage 转绘。绘制连续失败（画面源不可用）时止损停止，避免产出「只有第一帧」的废片
    function paintRecFrame() {
      if (!recordingInternal) return;
      // 引用失效检测：video 不在文档 / 无媒体数据 / 尺寸丢失 → 尝试重定位当前播放器 video；
      // 重定位失败后每 2 秒重试一次（播放器重建期间新 video 可能延迟就绪）
      if (!video || !video.isConnected || video.readyState === 0 || video.videoWidth === 0) {
        if (!recAdoptPending || performance.now() - recAdoptPending > 2000) {
          recAdoptPending = performance.now();
          const cand = (window.__mgp_video && window.__mgp_video !== video && window.__mgp_video.isConnected && window.__mgp_video.videoWidth > 0)
            ? window.__mgp_video
            : ([...document.querySelectorAll('video')].find(x => x !== video && x.isConnected && x.videoWidth > 0 && x.readyState >= 2) || null);
          if (cand) {
            adoptRecVideo(cand);
            recVideoAdopted = true;
            try { mgpToast('录制已跟随新的视频源', true); } catch (e) { }
          }
        }
      } else {
        recAdoptPending = 0;
      }
      let ok = false;
      try {
        if (recCtx && video && video.isConnected && video.readyState >= 2 && video.videoWidth > 0) {
          recCtx.drawImage(video, 0, 0, recCanvas.width, recCanvas.height);
          ok = true;
        }
      } catch (e) { /* protected content or hidden video */ }
      if (ok) { recDrawOk++; recDrawFail = 0; recDrawFailAt = 0; }
      else {
        if (!recDrawFailAt) recDrawFailAt = performance.now();
        recDrawFail++;
        // 连续 ~3s 无法绘制（按时间戳判断，适配 rAF 帧率）：画面源已不可用且重定位未成功，止损停止
        if (performance.now() - recDrawFailAt > 3000) {
          try { mgpToast('视频画面源已失效，录制已停止', true); } catch (e) { }
          stopRecording();
        }
      }
    }
    // 录制中 video 元素被播放器重建 / 替换：把绘制与跳转锁定切换到新 video 引用
    function adoptRecVideo(nv) {
      if (video && video !== nv) {
        video.removeEventListener('ended', onVideoEnded);
        video.removeEventListener('seeking', onSeekBlock, true);
      }
      video = nv;
      video.addEventListener('ended', onVideoEnded);
      video.addEventListener('seeking', onSeekBlock, true);
      // 重同步跳转锁定基准；分辨率变化后画布同步（canvas 尺寸重置会清空画布，仅在尺寸变化时重置）
      lastExpectedTime = video.currentTime;
      lastWallClock = performance.now() / 1000;
      if (recCanvas && video.videoWidth > 0 &&
          (recCanvas.width !== video.videoWidth || recCanvas.height !== video.videoHeight)) {
        recCanvas.width = video.videoWidth;
        recCanvas.height = video.videoHeight;
      }
    }
    // 独立 rAF 轻量 tick：持续维护录制期望时间（跳转锁定），暂停时也保持时钟新鲜
    (function tickExpected() {
      if (!recordingInternal) return;
      const now = performance.now() / 1000;
      const elapsed = now - lastWallClock;
      if (recPaused) { lastWallClock = now; recRaf = requestAnimationFrame(tickExpected); return; } // 暂停中不累加期望时间
      if (!video.paused && video.readyState >= 2) {
        lastExpectedTime += elapsed * video.playbackRate;
      }
      lastWallClock = now;
      // 正好从入点开始录制：播放到出点自动停止（用画面时刻判断，与打点同源）
      if (recAutoStop && (recStopTarget != null ? dispTime() >= recStopTarget : (state.outPoint !== null && dispTime() >= state.outPoint))) {
        stopRecording();
        return;
      }
      recRaf = requestAnimationFrame(tickExpected);
    })();
  }

  function stopRecording() {
    recordingInternal = false;
    if (recRaf) cancelAnimationFrame(recRaf);
    if (recPaintRaf) cancelAnimationFrame(recPaintRaf);
    if (recPaintTimer) { clearInterval(recPaintTimer); recPaintTimer = null; }
    if (recDiagTimer) { clearInterval(recDiagTimer); recDiagTimer = null; }
    if (recFreezeTimer) { clearInterval(recFreezeTimer); recFreezeTimer = null; }
    if (recDowngradeTimer) { clearInterval(recDowngradeTimer); recDowngradeTimer = null; }
    try {
      if (recDiag) {
        recDiag.draws = recDrawOk; recDiag.drawFails = recDrawFail; recDiag.adopted = recVideoAdopted;
        console.info('[MGP-REC] stopped', JSON.stringify(recDiag));
      }
    } catch (e) { }
    video.removeEventListener('seeking', onSeekBlock, true);
    // 录制结束：退出画中画（若录制期间进入），恢复页面内视频显示
    if (pipOn()) {
      pipActive = false;
      document.exitPictureInPicture().catch(() => { });
    }
    recPaused = false;
    recStopTarget = null;
    recStopTime = video ? dispTime() : (state.recordingStart || 0);
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
    if (recPacer) { recPacer.stop(); recPacer = null; }
    if (recCanvas && recCanvas.parentElement) recCanvas.parentElement.removeChild(recCanvas);
    recMediaRecorder = null; recCanvas = null; recCtx = null;
    try {
      if (recDiag) {
        recDiag.draws = recDrawOk; recDiag.drawFails = recDrawFail; recDiag.adopted = recVideoAdopted;
        recDiag.chunks = recChunks.length;
        recDiag.duration = Math.max(0, recStopTime - (state.recordingStart || 0));
        console.info('[MGP-REC] saved', JSON.stringify(recDiag));
      }
    } catch (e) { }
    const btn = qs('#mgp-btn-rec'), dot = qs('#mgp-rec-dot'), icon = qs('#mgp-rec-icon');
    if (btn) btn.classList.remove('active'); if (dot) dot.style.display = 'none';
    if (icon) icon.innerHTML = '<circle cx="8" cy="8" r="6"/>';
    mgpHideToast();
    if (recChunks.length === 0) { mgpToast('录制为空'); recChunks = []; state.tcMode = 'live'; return; }
    const isMp4 = /^video\/mp4/.test(mimeType);
    const ext = isMp4 ? 'mp4' : 'webm';
    // 录制文件名：时间码固定用「入点时间码」（recordingStart），备注取自同一时刻，
    // 保证文件名内时间码与备注严格对应（此前时间码用停止时刻、备注用入点，二者不一致）
    const name = buildFileName(fmtTCPlainF(state.recordingStart || 0), state.recordingStart || 0, ext);
    const dur = recStopTime !== null ? Math.max(0, recStopTime - (state.recordingStart || 0)) : 0;
    const sec = Math.round(dur * 2) / 2;
    navigator.clipboard.writeText(String(sec)).catch(()=>{});
    // 原始文件快照：arrayBuffer 转换期间 recChunks 可能被下一次录制覆盖，回退时用快照
    const rawBlob = new Blob(recChunks, { type: mimeType || 'video/' + ext });
    const saveAndToast = blob => {
      downloadBlob(blob, name);
      mgpToast('录制结束 — ' + sec + 's', true);
    };
    // MediaRecorder 输出的 MP4 是 fragmented MP4（moov 前置 + moof/mdat 分片），
    // 部分剪辑软件（达芬奇旧版 / 会声会影 / Edius 等）无法读取。录制结束后
    // 经 remux.js 重封装为经典 MP4（ftyp | mdat | moov，无 moof）；失败则回退原始文件。
    if (isMp4 && MPGRemuxRef && typeof MPGRemuxRef.remuxToClassic === 'function') {
      rawBlob.arrayBuffer().then(buf => {
        try {
          const out = MPGRemuxRef.remuxToClassic(new Uint8Array(buf));
          saveAndToast(new Blob([out], { type: 'video/mp4' }));
        } catch (e) {
          saveAndToast(rawBlob);
        }
      }).catch(() => {
        saveAndToast(rawBlob);
      });
    } else {
      saveAndToast(rawBlob);
    }
    recChunks = [];
  }

  function markIn() {
    if (recordingInternal || !video) return;
    recStopTime = null;
    // 新入点重置出点去重标记：否则在相同出点时刻二次打出点会被误判重复而漏记
    lastLogOutTime = null;
    // 打点时刻统一用 dispTime()（实际渲染帧的媒体时间，与时间码显示同源）：
    // video.currentTime 是媒体时钟，通常领先渲染帧 2-3 帧，直接使用会导致
    // 记录的时间码比画面上看到的多出几帧
    const t = dispTime();
    state.inPoint = t; state.outPoint = null;
    state.tcMode = 'in'; saveState();
    if (video.paused) video.play().catch(()=>{});
    mgpToast('入点 ( ' + fmtTC(t) + ' | 0s )');
    // 打点自动截图：暂存当前画面，待 O 打出点时保存（多次 I 只保留最后一次，与日志入点逻辑一致）
    if (autoShot()) {
      shotToBlob(b => { if (b) pendingShot = { blob: b, tcPlain: fmtTCPlainF(t) }; });
    }
  }

  function markOut() {
    if (recordingInternal || state.inPoint === null || !video) return;
    recStopTime = null;
    const outTime = dispTime();   // 与时间码显示同源，避免比画面多出几帧
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
    // 保存最后一次 I 键时暂存的入点截图（记录已写入，备注可匹配）；
    // 时间码与备注均取入点时刻，保证文件名内两者一致
    if (autoShot() && pendingShot) {
      const ps = pendingShot; pendingShot = null;
      if (ps.blob) {
        const inT = state.inPoint != null ? state.inPoint : 0;
        downloadBlob(ps.blob, buildFileName(fmtTCPlainF(inT), inT, 'png'));
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
    } else if (toastEl.parentElement) {
      // 重新挂到 body 末尾：标注窗口等后插入的 fixed 元素 z-index 与 toast 相同（2147483647）
      // 时，层叠顺序由 DOM 顺序决定——toast 必须始终位于最上层（标注弹窗之上）
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
      if (!webFsSaved) return;   // 已退出全屏（observer 断开前的残留回调）
      const stack = [root];
      while (stack.length) {
        const el = stack.pop();
        if (!el || el.nodeType !== 1) continue;
        // 扩展控制栏、Toast 提示、标注截图窗口不隐藏（全屏中标注与提示正常显示）
        if (el === v || el === wrapper || el.id === 'mgp-toast-ext' || el.id === 'mgp-ann-mask') continue;
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
      // 断开隐藏兜底 observer（防泄漏与退出后误隐藏）
      if (webFsSaved.observer) { try { webFsSaved.observer.disconnect(); } catch (e) { } }
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
    if (annHost) return;   // 标注窗口打开期间：Esc 由标注窗口接管
    if (e.key === 'Escape' && webFsActive) exitWebFs();
  });

  // 网页全屏期间：双击画面只"吃掉"事件——不退出网页全屏，也不让页面/播放器
  // 借双击切入其他全屏（浏览器全屏等）。
  // 仅 webFsActive 时拦截：不影响其他全屏模式下的双击行为；
  // 扩展自身 UI（时间码切换 / 标注窗口 / 侧边按钮 / 悬浮进度条）不拦截
  window.addEventListener('dblclick', e => {
    if (!webFsActive) return;
    const t = e.target;
    if (t && t.nodeType === 1 && t.closest) {
      if (t.closest('#mgp-bar') || t.closest('#mgp-ann-mask') || t.closest('.mgp-side-btn') || t.closest('#mgp-fs-wrap')) return;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    }
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    // 拦截吞掉双击：网页全屏保持，不触发任何退出/切换
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
    // 与时间码显示同源（dispTime），避免记录比画面多出几帧
    const t = dispTime();
    state.markTime = t;
    state.tcMode = 'mk'; saveState();
    insertSorted(logs.marks, { time: t, tc: fmtTC(t), url: location.href, title: titleForLog() }, m => m.time != null ? m.time : 0);
    saveLogs();
    // 不自动复制时间码（避免覆盖用户剪贴板；需要时点击控制栏时间码或面板记录行复制）
    mgpToast('已标记 ( ' + fmtTC(t) + ' )', true);
    // 打点自动截图：M 打点立即保存
    if (autoShot()) {
      shotToBlob(b => saveShotBlob(b, t, '已标记 ( ' + fmtTC(t) + ' ) · 已截图'));
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
  // 跳转到记录时刻：统一经 alignToFrame 对齐到帧起点（直接 seek 到帧边界之间
  // 会渲染出比目标早一帧的画面，导致跳转后画面与记录时间码不符）
  function jumpIn() { if (state.inPoint === null || !video) return; recStopTime = null; video.currentTime = alignToFrame(state.inPoint); video.pause(); resetSpeed(); state.tcMode = 'in'; mgpToast('入点 ( ' + fmtTC(state.inPoint) + ' | 0s )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); }
  function jumpOut() { if (state.outPoint === null || !video) return; recStopTime = null; video.currentTime = alignToFrame(state.outPoint); video.pause(); resetSpeed(); const dur = state.outPoint - (state.inPoint||0); const sec = Math.round(dur*2)/2; state.tcMode = 'ot'; mgpToast('出点 ( ' + fmtTC(state.outPoint) + ' | ' + sec + 's )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); }

  document.addEventListener('keydown', e => {
    if (annHost) return;   // 标注窗口打开期间：快捷键由标注窗口接管
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
    if (e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); if (state.markTime !== null) { video.currentTime = alignToFrame(state.markTime); video.pause(); resetSpeed(); state.tcMode = 'mk'; mgpToast('标记点 ( ' + fmtTC(state.markTime) + ' )'); clearTimeout(stateTimer); stateTimer = setTimeout(() => { state.tcMode = 'live'; saveState(); }, 2000); } return; }
    // Shift+S：截图并在标注窗口中标注（红框 / 白边红字文本），Enter 保存 / Esc 取消
    if (e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); openAnnotate(); return; }
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
      case 's': case 'S': e.preventDefault(); captureScreenshot(false); break;
      // C：截图并复制到剪贴板（不下载，与标注窗口内 C 行为一致）
      case 'c': case 'C': e.preventDefault(); captureScreenshot(true); break;
    }
  });

  // ─── Shift+S 标注截图：截图 → 弹窗标注（主题色矩形 / 白边主题色文本）→ Enter 保存 / Esc 取消 ──
  const ANN_THEME = '#ff5f00';   // 标注主题色：与插件强调色一致（红框红字，白边不变）
  let annHost = null;      // 标注窗口宿主（light DOM 遮罩，shadow 内承载 UI）
  let annSource = null;    // 截图原图 canvas（标注重绘底图，不被修改）
  let annCanvas = null;    // 标注画布（显示 + 标注绘制）
  let annCtx = null;
  let annScale = 1;        // 原始像素 → 显示像素（坐标换算）
  let annAnnots = [];      // [{type:'rect',x,y,w,h},{type:'text',x,y,text,fs}]
  let annDrag = null;      // 拖拽画框预览 {x0,y0,x1,y1}（原始坐标）
  let annDragged = false;  // 本次拖拽是否超过阈值（区分「画框」与「点击加文本」）
  let annTextInput = null; // 文本输入框（shadow 内）
  let annPendingText = null; // 待确认文本标注位置 {x,y,fs}
  let annFileName = '';
  let annShowTC = false;   // 是否在截图右上角嵌入当前画面时间码（设置记忆，默认关）
  let annTC = '';          // 嵌入的时间码文本（进入标注时捕获，HH:MM:SS:FF）
  let annWinKey = null;

  // 标注窗口打开期间的全局键盘接管（capture 阶段，优先于主快捷键与网页全屏 Esc）
  annWinKey = e => {
    if (!annHost) return;
    const sr = annHost && annHost.shadowRoot;
    // 焦点在文本输入框：由输入框自身处理（Enter 确认文本 / Esc 取消输入 / C、Z 为普通字符输入）
    if (sr && sr.activeElement === annTextInput) return;
    const k = e.key && e.key.toLowerCase();
    // Z（或 Ctrl+Z / Cmd+Z）：撤销上一条标注——不按 Ctrl 也可触发
    if (k === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (annAnnots.length) {
        annAnnots.pop();
        annRedraw();
        try { mgpToast('已撤销标注', true); } catch (err) { }
      }
      return;
    }
    // C（或 Ctrl+C / Cmd+C）：复制带标注的截图到剪贴板——不按 Ctrl 也可触发
    if (k === 'c') {
      e.preventDefault();
      e.stopPropagation();
      annCopyToClipboard().then(ok => {
        try { mgpToast(ok ? '已复制截图' : '复制失败，请检查浏览器剪贴板权限', true); } catch (err) { }
      });
      return;
    }
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Enter') annClose(true);
    else annClose(false);
  };
  document.addEventListener('keydown', annWinKey, true);

  // 复制指定 PNG blob 到剪贴板（供 Ctrl+C 与保存时复用）
  function annCopyBlob(b) {
    return new Promise(resolve => {
      if (!b || typeof ClipboardItem === 'undefined') { resolve(false); return; }
      try {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': b })])
          .then(() => resolve(true))
          .catch(() => resolve(false));
      } catch (e) { resolve(false); }
    });
  }
  // 复制带标注的截图到剪贴板（PNG）
  function annCopyToClipboard() {
    return new Promise(resolve => {
      if (!annCanvas || !annSource) { resolve(false); return; }
      try {
        annCanvas.toBlob(b => annCopyBlob(b).then(resolve), 'image/png');
      } catch (e) { resolve(false); }
    });
  }

  function annPos(e) {
    const r = annCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(annCanvas.width, (e.clientX - r.left) / annScale)),
      y: Math.max(0, Math.min(annCanvas.height, (e.clientY - r.top) / annScale))
    };
  }

  // 重绘：底图 + 已确认标注 + 拖拽预览框 + 可选时间码
  function annRedraw() {
    if (!annCtx || !annSource) return;
    const ctx = annCtx, c = annCanvas;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(annSource, 0, 0);
    const lw = Math.max(3, Math.round(c.width / 300));   // 矩形线宽随分辨率
    for (const a of annAnnots) {
      if (a.type === 'rect') {
        // 白边包裹主题色框：先画白色粗边框，再叠主题色边框
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = lw * 2.6;
        ctx.strokeRect(a.x, a.y, a.w, a.h);
        ctx.strokeStyle = ANN_THEME;
        ctx.lineWidth = lw;
        ctx.strokeRect(a.x, a.y, a.w, a.h);
      } else if (a.type === 'text') {
        ctx.font = 'bold ' + a.fs + 'px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.lineWidth = Math.max(3, Math.round(a.fs / 6));
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(a.text, a.x, a.y);
        ctx.fillStyle = ANN_THEME;
        ctx.fillText(a.text, a.x, a.y);
      }
    }
    if (annDrag) {
      const x = Math.min(annDrag.x0, annDrag.x1), y = Math.min(annDrag.y0, annDrag.y1);
      const w = Math.abs(annDrag.x1 - annDrag.x0), h = Math.abs(annDrag.y1 - annDrag.y0);
      // 预览：白边虚线 + 主题色虚线（确认后同样白边包裹）
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw * 2.6;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.strokeStyle = ANN_THEME;
      ctx.lineWidth = lw;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
    // 嵌入时间码（开关开启时）：右上角，白边主题色粗体，与文本标注同风格（字号为标注文本的两倍）
    if (annShowTC && annTC) {
      const tcFs = Math.max(40, Math.round(c.width / 30));
      ctx.font = 'bold ' + tcFs + 'px "JetBrains Mono","Cascadia Code","Consolas",monospace';
      ctx.lineWidth = Math.max(3, Math.round(tcFs / 6));
      const tw = ctx.measureText(annTC).width;
      const tx = c.width - 16 - tw, ty = 16 + tcFs;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(annTC, tx, ty);
      ctx.fillStyle = ANN_THEME;
      ctx.fillText(annTC, tx, ty);
    }
  }

  // 确认文本标注：绘制到截图并关闭输入框
  function annCommitText() {
    if (!annPendingText || !annTextInput) return;
    const t = annTextInput.value.trim();
    const p = annPendingText;
    annPendingText = null;
    if (t) {
      annAnnots.push({ type: 'text', x: p.x, y: p.y, text: t, fs: p.fs });
      annRedraw();
    }
    annTextInput.hidden = true;
  }
  function annCancelText() {
    annPendingText = null;
    if (annTextInput) annTextInput.hidden = true;
  }

  // 保存（仅下载带标注的 PNG，不自动复制）或取消（关闭窗口）
  // 需要复制时在窗口内按 C / Ctrl+C（手动复制入口保留）
  function annClose(save) {
    if (save && annCanvas && annSource) {
      // 捕获文件名到局部变量：toBlob 异步回调执行时 annFileName 已被下方清理
      // 置空——直接引用会得到空字符串，a.download='' 被浏览器忽略，下载回退为
      // blob URL 的 UUID 文件名（如 0a891ae9-...）
      const fname = annFileName;
      try {
        annCanvas.toBlob(b => {
          if (!b) { mgpToast('保存失败', true); return; }
          downloadBlob(b, fname);
          try { mgpToast('标注截图已保存', true); } catch (err) { }
        }, 'image/png');
      } catch (e) { mgpToast('保存失败: 内容保护', true); }
    }
    if (annHost && annHost.parentElement) annHost.parentElement.removeChild(annHost);
    annHost = null; annSource = null; annCanvas = null; annCtx = null;
    annAnnots = []; annDrag = null; annPendingText = null; annTextInput = null; annFileName = '';
  }

  function openAnnotate() {
    if (!video || !video.videoWidth) { mgpToast('无画面'); return; }
    if (annHost) { mgpToast('标注窗口已打开'); return; }
    if (recordingInternal) { mgpToast('录制中无法标注截图'); return; }
    // 进入标注：暂停视频，保证标注画面与截图一致（画面停留在暂停帧）
    if (!video.paused) video.pause();
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    let ctx2;
    try {
      ctx2 = c.getContext('2d');
      ctx2.drawImage(video, 0, 0);
      ctx2.getImageData(0, 0, 1, 1);   // 提前验证画布可读取（受保护内容会在此抛错）
    } catch (e) { mgpToast('截图失败: 内容保护'); return; }
    annSource = c;
    // 嵌入时间码：读取设置（background 推送的完整设置），进入时捕获当前画面时间码
    const s = window.__mgpSettings || {};
    annShowTC = s.annotateTimecode === true;
    const shotT = dispTime();
    annTC = fmtTC(shotT, true);
    // 命名与直接截图（S 键）完全一致：标题_时间码备注_时间.png
    annFileName = buildFileName(fmtTCPlainF(shotT), shotT, 'png');
    annBuild();
  }

  function annBuild() {
    const mask = document.createElement('div');
    mask.id = 'mgp-ann-mask';
    mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
    document.body.appendChild(mask);
    annHost = mask;
    const sr = mask.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    // 亮/暗色主题由 CSS 变量驱动：annApplyTheme 按设置「亮色模式」切换 :host(.light)
    style.textContent = `
:host{all:initial;--ann-bg:rgba(24,24,30,.97);--ann-brd:rgba(255,255,255,.14);--ann-line:rgba(255,255,255,.1);--ann-text:#eee;--ann-muted:#9aa0a6;--ann-ghost:rgba(255,255,255,.25);--ann-ghost-hover:rgba(255,255,255,.08)}
:host(.light){--ann-bg:rgba(250,250,252,.98);--ann-brd:rgba(0,0,0,.18);--ann-line:rgba(0,0,0,.08);--ann-text:#1a1a20;--ann-muted:#6a6a72;--ann-ghost:rgba(0,0,0,.28);--ann-ghost-hover:rgba(0,0,0,.06)}
.ann-win{display:flex;flex-direction:column;background:var(--ann-bg);border:1px solid var(--ann-brd);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.6);max-width:92vw;max-height:92vh;overflow:hidden;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ann-text);font-size:13px}
.ann-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--ann-line)}
.ann-title{font-weight:700;font-size:14px}
.ann-tip{color:var(--ann-muted);font-size:12px}
.ann-grow{flex:1}
.ann-btn{background:#ff5f00;border:none;color:#fff;padding:5px 14px;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit}
.ann-btn:hover{background:#ff6a1a}
.ann-btn.ghost{background:transparent;border:1px solid var(--ann-ghost);color:var(--ann-text)}
.ann-btn.ghost:hover{background:var(--ann-ghost-hover)}
.ann-body{position:relative;padding:12px;display:flex;align-items:center;justify-content:center;overflow:auto}
#ann-canvas{cursor:crosshair;border-radius:4px;box-shadow:0 0 0 1px var(--ann-brd);max-width:none}
.ann-text{position:absolute;z-index:2;background:#fff;color:#e65400;border:2px solid #ff5f00;border-radius:4px;padding:4px 8px;font-weight:700;outline:none;min-width:150px;font-family:"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5)}
.ann-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;margin-right:2px}
.ann-sw-label{font-size:12px;color:var(--ann-muted);white-space:nowrap}
.ann-switch input{display:none}
.ann-sw-track{width:28px;height:16px;border-radius:8px;background:rgba(255,255,255,.18);position:relative;transition:background .15s;flex-shrink:0}
:host(.light) .ann-sw-track{background:rgba(0,0,0,.16)}
.ann-sw-track::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.4)}
.ann-switch input:checked + .ann-sw-track{background:#ff5f00}
.ann-switch input:checked + .ann-sw-track::after{transform:translateX(12px)}
`;
    sr.appendChild(style);
    const win = document.createElement('div');
    win.className = 'ann-win';
    win.innerHTML =
      '<div class="ann-head">' +
        '<span class="ann-title">标注截图</span>' +
        '<span class="ann-tip">拖拽画框 · 点击加字 · Ctrl+C 复制 · Ctrl+Z 撤销</span>' +
        '<span class="ann-grow"></span>' +
        '<label class="ann-switch" title="在截图右上角嵌入当前画面时间码">' +
          '<span class="ann-sw-label">嵌入时间码</span>' +
          '<input type="checkbox" id="ann-tc">' +
          '<span class="ann-sw-track"></span>' +
        '</label>' +
        '<button type="button" class="ann-btn ghost" id="ann-cancel">取消 (Esc)</button>' +
        '<button type="button" class="ann-btn" id="ann-save">保存 (Enter)</button>' +
      '</div>' +
      '<div class="ann-body">' +
        '<canvas id="ann-canvas"></canvas>' +
        '<input id="ann-text" class="ann-text" spellcheck="false" placeholder="输入标注文字，Enter 确认" hidden>' +
      '</div>';
    sr.appendChild(win);
    // 亮/暗色主题：初始应用 + 设置「亮色模式」切换时实时生效
    annApplyTheme();
    // 嵌入时间码开关：初始状态读设置（默认关闭），切换后立即重绘并持久化记忆
    const tcBox = sr.querySelector('#ann-tc');
    tcBox.checked = annShowTC;
    tcBox.addEventListener('change', () => {
      annShowTC = tcBox.checked;
      annRedraw();
      // 经隔离世界桥保存设置（MAIN world 无法直接写 chrome.storage），
      // 后台收到后推送到所有页面，重启后依旧生效
      try {
        window.postMessage({ __mgp: 'settings', patch: { annotateTimecode: annShowTC } }, '*');
      } catch (e) { }
    });
    // 点击窗口外（遮罩空白处）→ 取消；窗口内点击不处理（composedPath 区分 shadow 内外）
    mask.addEventListener('click', e => {
      const path = e.composedPath ? e.composedPath() : [];
      if (path[0] === mask) annClose(false);
    });

    const canvas = sr.querySelector('#ann-canvas');
    annCanvas = canvas;   // 必须赋值给全局引用：annRedraw / annPos / annClose 均依赖它
    canvas.width = annSource.width;
    canvas.height = annSource.height;
    // 按可用空间等比缩放显示（原始像素不缩放，坐标按 scale 换算）
    const maxW = Math.min(window.innerWidth * 0.9 - 48, 1280);
    const maxH = window.innerHeight * 0.9 - 100;
    annScale = Math.min(maxW / canvas.width, maxH / canvas.height);
    annScale = Math.max(0.1, Math.min(annScale, 2));
    canvas.style.width = Math.round(canvas.width * annScale) + 'px';
    canvas.style.height = Math.round(canvas.height * annScale) + 'px';
    annCtx = canvas.getContext('2d');
    annAnnots = [];
    annRedraw();

    const inp = sr.querySelector('#ann-text');
    annTextInput = inp;

    // 拖拽画框 / 点击加文本：pointer 事件 + 指针捕获（拖出画布也不丢失 mouseup）
    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (annPendingText) annCommitText();   // 先提交上一个未确认的文本
      const p = annPos(e);
      annDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      annDragged = false;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
    });
    canvas.addEventListener('pointermove', e => {
      if (!annDrag) return;
      const p = annPos(e);
      annDrag.x1 = p.x; annDrag.y1 = p.y;
      if (!annDragged && (Math.abs(annDrag.x1 - annDrag.x0) > 4 || Math.abs(annDrag.y1 - annDrag.y0) > 4)) annDragged = true;
      annRedraw();
    });
    canvas.addEventListener('pointerup', e => {
      if (!annDrag) return;
      const p = annPos(e);
      annDrag.x1 = p.x; annDrag.y1 = p.y;
      const d = annDrag;
      annDrag = null;
      annRedraw();
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { }
      if (annDragged) {
        // 拖拽 → 确认红色矩形标注
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
        const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
        if (w > 2 && h > 2) {
          annAnnots.push({ type: 'rect', x, y, w, h });
          annRedraw();
        }
      } else {
        // 点击 → 在该位置打开文本标注输入框
        annPendingText = { x: p.x, y: p.y, fs: Math.max(18, Math.round(annSource.width / 50)) };
        inp.value = '';
        inp.style.left = Math.round(p.x * annScale + 10) + 'px';
        inp.style.top = Math.round(p.y * annScale + 10) + 'px';
        inp.style.fontSize = Math.max(13, Math.round(annPendingText.fs * annScale * 0.6)) + 'px';
        inp.hidden = false;
        inp.focus();
      }
    });
    // 文本输入：Enter 确认标注 / Esc 取消输入；失焦确认（点保存按钮时文本先落定）
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.isComposing) return;   // 中文输入法组词中不拦截
      if (e.key === 'Enter') { e.preventDefault(); annCommitText(); }
      else if (e.key === 'Escape') { e.preventDefault(); annCancelText(); }
    });
    inp.addEventListener('blur', () => { if (annPendingText) annCommitText(); });
    sr.querySelector('#ann-save').addEventListener('click', () => annClose(true));
    sr.querySelector('#ann-cancel').addEventListener('click', () => annClose(false));
  }

  // 标注窗口亮 / 暗色：随设置「亮色模式」开关切换；设置变化时 background 推送设置
  // 触发页面 mgp-settings 事件 → 窗口打开期间实时切换主题
  function annApplyTheme() {
    const s = window.__mgpSettings || {};
    const light = s.theme === 'light';
    if (annHost) {
      annHost.classList.toggle('light', light);
      annHost.style.background = light ? 'rgba(30,30,40,.35)' : 'rgba(0,0,0,.6)';
    }
  }
  window.addEventListener('mgp-settings', () => {
    if (!annHost) return;
    annApplyTheme();
    // 设置推送（含外部变更的嵌入时间码开关）→ 同步窗口开关状态并重绘
    const s = window.__mgpSettings || {};
    annShowTC = s.annotateTimecode === true;
    const tb = annHost.shadowRoot && annHost.shadowRoot.querySelector('#ann-tc');
    if (tb) tb.checked = annShowTC;
    annRedraw();
  });

  window.addEventListener('mgp-video-found', syncBar);
  window.addEventListener('mgp-settings', syncBar);

  // ─── 后台录制保护 ─────────────────────────────
  // 页面切到后台：渲染流水线被浏览器节流（rVFC/rAF 停、定时器 ≥1s），canvas 不再更新，
  // 继续录制只会得到冻结画面 + 正常声音。切后台时暂停 MediaRecorder（音视频整段不写入），
  // 回前台恢复，前后音画保持同步；「画中画保持录制」开启时视频在 PiP 窗口继续渲染，不暂停。
  document.addEventListener('visibilitychange', () => {
    if (!recordingInternal || !recMediaRecorder) return;
    if (document.hidden && !pipOn() && recMediaRecorder.state === 'recording') {
      recMediaRecorder.pause();
      recPaused = true;
      // 重同步录制期望时间与时钟：暂停期间视频仍在播放（声音正常），恢复后避免 seek 锁误判
      lastExpectedTime = video ? video.currentTime : lastExpectedTime;
      lastWallClock = performance.now() / 1000;
      mgpToast('已暂停录制（页面切到后台）', true);
    } else if (!document.hidden && recMediaRecorder.state === 'paused') {
      recMediaRecorder.resume();
      recPaused = false;
      lastExpectedTime = video ? video.currentTime : lastExpectedTime;
      lastWallClock = performance.now() / 1000;
      // AudioContext 音频捕获：页面后台期间可能被自动挂起，回前台恢复
      if (recAudioCtx && recAudioCtx.state === 'suspended') recAudioCtx.resume().catch(() => { });
      mgpToast('已恢复录制', true);
    }
  });
  // 用户在画中画窗口点关闭：后台录制保护失效，之后再切后台走暂停逻辑
  document.addEventListener('leavepictureinpicture', e => {
    if (e.target === video) pipActive = false;
  });

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
        // 对齐到帧起点，保证链接打开后画面与记录的时间码一致
        if (!isNaN(t) && isFinite(t)) v.currentTime = alignToFrame(t);
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
