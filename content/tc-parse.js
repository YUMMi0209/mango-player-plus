/* 时间码输入解析（面板就地编辑 / 控制栏右键输入 / 日志表导入 共用一套逻辑）
   支持形式（fps 用于帧号换算）：
     hh:mm:ss:ff   00:01:12:18
     mm:ss:ff      01:12:18
     mm:ss         01:12
     hhmmssff      00011218（无分隔符）
     mmssff        011218  （无分隔符 · 6 位，也可读作 hhmmss → 需要用户确认）
     hhmmss        011218  （无分隔符 · 6 位）
     mmss          0112    （无分隔符）
   分隔符兼容中英文冒号与分号（: ： ; ；），有无分隔符都可以。

   6 位数字有歧义（MMSSFF 还是 HHMMSS）：analyzeTCInput 会把两种读法都返回，
   由调用方弹窗让用户确认；**MMSSFF 优先**（默认读法），parseTCInput 也取它。 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MPGTcParse = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEP_RE = /[:：;；]/;                 // 英文冒号 / 中文全角冒号 / 分号（中英文）
  const ONLY_CHARS_RE = /^[0-9:：;；]+$/;    // 只允许数字与这些分隔符

  const FORM_NAMES = {
    'hh:mm:ss:ff': '时:分:秒:帧',
    'hh:mm:ss': '时:分:秒',
    'mm:ss:ff': '分:秒:帧',
    'mm:ss': '分:秒',
    'hhmmssff': '时:分:秒:帧',
    'hhmmss': '时:分:秒',
    'mmssff': '分:秒:帧',
    'mmss': '分:秒'
  };

  // nums = [时(或分), 分(或秒), 秒(或帧), 帧]；fps 用于末段帧号换算
  function secOf(form, nums, fps) {
    switch (form) {
      case 'hh:mm:ss:ff':
      case 'hhmmssff':
        return (nums[1] < 60 && nums[2] < 60 && nums[3] < fps) ? nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / fps : null;
      case 'hh:mm:ss':
      case 'hhmmss':
        return (nums[1] < 60 && nums[2] < 60) ? nums[0] * 3600 + nums[1] * 60 + nums[2] : null;
      case 'mm:ss:ff':
      case 'mmssff':
        return (nums[1] < 60 && nums[2] < fps) ? nums[0] * 60 + nums[1] + nums[2] / fps : null;
      case 'mm:ss':
      case 'mmss':
        return (nums[1] < 60) ? nums[0] * 60 + nums[1] : null;
    }
    return null;
  }
  const mk = (form, nums, fps) => {
    const sec = secOf(form, nums, fps);
    return sec == null ? null : { form: form, formName: FORM_NAMES[form], sec: sec };
  };

  // 分析输入：
  //   成功 → { ok:true, sec, form, formName, ambiguous, options:[{form,formName,sec}] }
  //   6 位数字两种读法都成立时 ambiguous=true（调用方弹窗让用户选，options[0] 为默认：分:秒:帧）
  //   失败 → { ok:false }
  function analyzeTCInput(raw, fps) {
    const F = fps > 0 ? fps : 25;
    const s = String(raw == null ? '' : raw).trim();
    if (!s || !ONLY_CHARS_RE.test(s)) return { ok: false };
    const done = options => {
      if (!options.length) return { ok: false };
      const best = options[0];
      return {
        ok: true, sec: best.sec, form: best.form, formName: best.formName,
        ambiguous: options.length > 1, options: options
      };
    };
    if (SEP_RE.test(s)) {
      const parts = s.split(SEP_RE);
      if (parts.length < 2 || parts.length > 4) return { ok: false };
      if (parts.some(p => p === '')) return { ok: false };      // 12: / :12 / 1::2 这类残缺写法
      const n = parts.map(Number);
      if (n.some(isNaN)) return { ok: false };
      if (parts.length === 2) return done([mk('mm:ss', n, F)].filter(Boolean));
      if (parts.length === 3) {
        // 带冒号的 3 段按惯例读作 分:秒:帧（不合法时退回 时:分:秒），不算歧义
        return done([mk('mm:ss:ff', n, F) || mk('hh:mm:ss', n, F)].filter(Boolean));
      }
      return done([mk('hh:mm:ss:ff', n, F)].filter(Boolean));
    }
    const d = s.length;
    const D = (at, len) => Number(s.substr(at, len));
    if (d === 4) return done([mk('mmss', [D(0, 2), D(2, 2)], F)].filter(Boolean));
    if (d === 6) {
      const nums = [D(0, 2), D(2, 2), D(4, 2)];
      // 6 位：分:秒:帧 与 时:分:秒 都可能成立 → 两种读法都给出去
      // 顺序即优先级：**分:秒:帧优先**（弹窗默认选中它）
      return done([mk('mmssff', nums, F), mk('hhmmss', nums, F)].filter(Boolean));
    }
    if (d === 8) return done([mk('hhmmssff', [D(0, 2), D(2, 2), D(4, 2), D(6, 2)], F)].filter(Boolean));
    return { ok: false };
  }

  // 首选读法（默认：分:秒:帧）→ 秒；无法识别返回 null
  function parseTCInput(raw, fps) {
    const r = analyzeTCInput(raw, fps);
    return r.ok ? r.sec : null;
  }

  // 秒 → 时间码文本（默认带帧号 hh:mm:ss:ff）
  function fmtTC(sec, fps, withFrames) {
    const F = fps > 0 ? fps : 25;
    const total = Math.max(0, Math.round((Number(sec) || 0) * F));
    const p = n => String(n).padStart(2, '0');
    const base = p(Math.floor(total / (3600 * F))) + ':' + p(Math.floor(total / (60 * F)) % 60) + ':' + p(Math.floor(total / F) % 60);
    return withFrames === false ? base : base + ':' + p(total % F);
  }

  return { parseTCInput, analyzeTCInput, fmtTC, FORM_NAMES };
});
