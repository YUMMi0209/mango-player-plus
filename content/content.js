/**
 * MG Player+ — Content Script Entry
 * Detects video elements and triggers control bar injection.
 */
(function () {
  if (window.__mgp_active) return;
  window.__mgp_active = true;

  let currentVideo = null;
  let lastSrc = null;

  function findBestVideo() {
    const videos = document.querySelectorAll('video');
    let best = null, bestPx = 0;
    for (const v of videos) {
      if (v.videoWidth > 0 && v.offsetWidth > 0) {
        const px = v.videoWidth * v.videoHeight;
        if (px > bestPx) { bestPx = px; best = v; }
      }
    }
    if (!best) {
      for (const v of videos) {
        if (v.src || v.currentSrc || v.querySelector('source[src]')) {
          best = v; break;
        }
      }
    }
    return best;
  }

  function onVideoFound(video) {
    const src = video.src || video.currentSrc || '';
    if (video === currentVideo && src === lastSrc) return;
    currentVideo = video;
    lastSrc = src;
    window.__mgp_video = video;
    window.dispatchEvent(new CustomEvent('mgp-video-found', { detail: video }));
  }

  function scan() {
    const v = findBestVideo();
    if (v) onVideoFound(v);
  }

  scan();
  document.addEventListener('loadedmetadata', (e) => {
    if (e.target.tagName === 'VIDEO') scan();
  }, true);
  new MutationObserver(() => scan()).observe(
    document.body || document.documentElement,
    { childList: true, subtree: true }
  );

  // SPA 换集：URL 变化时强制重扫，确保新分集的视频被重新识别并派发事件
  let lastUrlKey = location.pathname;
  function onUrlChange() {
    const k = location.pathname;
    if (k !== lastUrlKey) {
      lastUrlKey = k;
      setTimeout(scan, 350);
    }
  }
  try {
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); onUrlChange(); return r; };
    });
    window.addEventListener('popstate', onUrlChange);
  } catch (e) { }

  // 面板「刷新」：不关闭弹窗/侧边栏，仅重置视频跟踪并重扫，确保重新定位当前视频并派发事件
  window.addEventListener('mgp-reload', () => {
    currentVideo = null;
    lastSrc = null;
    scan();
  });

  // 全局历史索引桥：接收页面（MAIN world）发来的打点统计，写入扩展级存储（跨网站共享）
  window.addEventListener('message', e => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__mgp !== 'history' || !d.key) return;
    chrome.storage.local.get('mpp_history').then(({ mpp_history }) => {
      const map = (mpp_history && typeof mpp_history === 'object') ? mpp_history : {};
      if ((d.marks || 0) + (d.inOut || 0) > 0) {
        map[d.key] = { title: String(d.title || ''), url: String(d.url || ''), marks: d.marks || 0, inOut: d.inOut || 0 };
      } else {
        delete map[d.key];
      }
      chrome.storage.local.set({ mpp_history: map }).catch(() => { });
    }).catch(() => { });
  });
})();
