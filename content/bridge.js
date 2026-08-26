/* 芒着拉片 · 隔离世界桥（ISOLATED world）
   MAIN world 的 content script 拿不到 chrome.* API，历史索引桥必须在此运行。
   - 接收页面（MAIN world）postMessage 的 history 事件 → 写入扩展级存储
   - 站点白名单校验：仅默认白名单（芒果TV / 百度网盘）或用户「应用于当前网页」授权的站点
     才接受消息，防止任意站点页面脚本伪造历史索引污染扩展存储
   - 消息字段值校验：key / title / url / 计数长度与类型 */
(() => {
  const DEF_HOSTS = ['mgtv.com', 'pan.baidu.com'];
  function defHostOk() {
    const h = location.hostname;
    return DEF_HOSTS.some(d => h === d || h.endsWith('.' + d));
  }
  function activeHostOk(hosts) {
    return Array.isArray(hosts) && hosts.indexOf(location.hostname) !== -1;
  }
  window.addEventListener('message', e => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__mgp !== 'history' || !d.key) return;
    // 站点白名单校验（授权列表读扩展存储）
    chrome.storage.local.get('mpp_settings').then(({ mpp_settings }) => {
      const hosts = mpp_settings && Array.isArray(mpp_settings.activeHosts) ? mpp_settings.activeHosts : [];
      if (!defHostOk() && !activeHostOk(hosts)) return;
      // 字段值校验：类型与长度限制，防伪造脏数据
      const key = String(d.key || '').slice(0, 300);
      if (!key) return;
      const title = String(d.title || '').slice(0, 200);
      const url = String(d.url || '').slice(0, 2000);
      const marks = Number.isFinite(d.marks) ? Math.max(0, Math.min(9999, Math.floor(d.marks))) : 0;
      const inOut = Number.isFinite(d.inOut) ? Math.max(0, Math.min(9999, Math.floor(d.inOut))) : 0;
      chrome.storage.local.get('mpp_history').then(({ mpp_history }) => {
        const map = (mpp_history && typeof mpp_history === 'object') ? mpp_history : {};
        if (marks + inOut > 0) map[key] = { title, url, marks, inOut };
        else delete map[key];
        chrome.storage.local.set({ mpp_history: map }).catch(() => { });
      }).catch(() => { });
    }).catch(() => { });
  });
})();
