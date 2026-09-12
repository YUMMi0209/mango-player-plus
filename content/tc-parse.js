/* 时间码输入解析（面板就地编辑 / 控制栏右键输入共用一套逻辑，避免两处规则不一致）
   支持格式（fps 用于末段帧号换算，帧号必须 < fps）：
     hh:mm:ss:ff   00:01:12:18
     mm:ss:ff      01:12:18
     mm:ss         01:12
     hhmmssff      00011218（无分隔）
     mmssff        011218  （无分隔）
     mmss          0112    （无分隔）
   解析失败返回 null（调用方提示「无法识别的时间码」） */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MPGTcParse = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseTCInput(raw, fps) {
    const F = fps > 0 ? fps : 25;
    const s = String(raw == null ? '' : raw).trim();
    if (!s || !/^[0-9:]+$/.test(s)) return null;
    if (s.indexOf(':') !== -1) {
      const parts = s.split(':');
      if (parts.length < 2 || parts.length > 4) return null;
      if (parts.some(p => p === '')) return null;   // 12: / :12 / 1::2 这类残缺写法
      const n = parts.map(Number);
      if (n.some(isNaN)) return null;
      if (parts.length === 2) {
        // mm:ss
        if (n[1] >= 60) return null;
        return n[0] * 60 + n[1];
      }
      // 3 段：mm:ss:ff；4 段：hh:mm:ss:ff（末段为帧）
      const ff = n[n.length - 1], ss = n[n.length - 2];
      if (ss >= 60 || ff >= F) return null;
      if (parts.length === 3) return n[0] * 60 + ss + ff / F;
      const hh = n[0], mm = n[1];
      if (mm >= 60) return null;
      return hh * 3600 + mm * 60 + ss + ff / F;
    }
    const d = s.length;
    if (d === 4) {
      const mm = Number(s.slice(0, 2)), ss = Number(s.slice(2, 4));
      return ss < 60 ? mm * 60 + ss : null;
    }
    if (d === 6) {
      const mm = Number(s.slice(0, 2)), ss = Number(s.slice(2, 4)), ff = Number(s.slice(4, 6));
      return (ss < 60 && ff < F) ? mm * 60 + ss + ff / F : null;
    }
    if (d === 8) {
      const hh = Number(s.slice(0, 2)), mm = Number(s.slice(2, 4));
      const ss = Number(s.slice(4, 6)), ff = Number(s.slice(6, 8));
      return (mm < 60 && ss < 60 && ff < F) ? hh * 3600 + mm * 60 + ss + ff / F : null;
    }
    return null;
  }

  return { parseTCInput };
});
