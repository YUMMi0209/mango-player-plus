/* 芒着拉片 · Material You（Material Design 3）设计令牌
   把种子色展开成 M3 的「色调板（tonal palettes）」→「色彩角色（color roles）」→ CSS 变量。
   色调板用 OKLCh 近似 HCT：固定色相与彩度，tone(0..100) 决定明度；超出 sRGB 色域时二分降彩度。
   对外接口（挂在 window.MPM3）：
     apply(rootEl, dark)   把 --md-sys-* / 形状 / 动效 / 字体 变量写到元素上（默认 html）
     cssVars(dark)         取一份 { 变量名: 值 }（控制栏 shadow CSS 用）
     role(dark, name)      取单个色彩角色
     seed / tonal(hue,chroma,tone) / hexOf(...)
   主题切换：panel-core 只负责 documentElement.dataset.theme = 'light' | 'dark'，
   本文件用 MutationObserver 跟着换令牌（页面里其它地方只引用变量，不关心主题）。
*/
'use strict';
(() => {
  const SEED = '#ff5f00';           // 种子色：芒果橙（保持插件识别度）
  const STORE_KEY = null;           // 预留：以后可支持「从壁纸取色」

  // ── 色彩数学（sRGB ↔ OKLab/OKLCh）────────────────────────
  const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);
  function srgbToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
  function hexToRgb(hex) {
    const h = String(hex).replace('#', '');
    const n = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
    return [parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255];
  }
  const hex2 = v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  function rgbToOklch(rgb) {
    const r = srgbToLin(rgb[0]), g = srgbToLin(rgb[1]), b = srgbToLin(rgb[2]);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    const C = Math.sqrt(A * A + B * B);
    let h = Math.atan2(B, A) * 180 / Math.PI;
    if (h < 0) h += 360;
    return { L, C, h };
  }
  function oklchToRgb(L, C, h) {
    const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return [
      linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    ];
  }
  const inGamut = rgb => rgb.every(v => v >= -0.0008 && v <= 1.0008);
  // M3 的 tone = CIE L*（0..100）。OKLab 的 L 与 L* 不是线性关系：
  // 先 L* → 相对亮度 Y（CIE 分段函数），再取立方根得到 OKLab L（中性灰时 L_ok = cbrt(Y)）
  function toneToL(t) {
    const Ls = Math.max(0, Math.min(100, t));
    const Y = Ls > 8 ? Math.pow((Ls + 16) / 116, 3) : Ls / 903.3;
    return Math.cbrt(Y);
  }

  // ── 色调板：给定色相/彩度，tone → #hex（出域时二分降彩度，与 M3 的 gamut mapping 同理）
  const toneCache = new Map();
  function tonal(hue, chroma, tone) {
    const key = hue.toFixed(2) + '|' + chroma.toFixed(4) + '|' + tone.toFixed(1);
    const hit = toneCache.get(key);
    if (hit) return hit;
    let lo = 0, hi = chroma, best = 0;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToRgb(toneToL(tone), mid, hue))) { best = mid; lo = mid; } else hi = mid;
    }
    const rgb = oklchToRgb(toneToL(tone), best, hue);
    const hex = '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);
    toneCache.set(key, hex);
    return hex;
  }
  // 语义色（入点蓝 / 出点绿 / 标记黄）：固定色相，套 M3 的 container 角色
  const SEM = { in: 250, out: 155, mk: 85 };

  const seedC = rgbToOklch(hexToRgb(SEED));
  const H = seedC.h;
  const PAL = {
    primary: { hue: H, chroma: Math.min(0.24, Math.max(0.13, seedC.C)) },
    secondary: { hue: (H + 12) % 360, chroma: 0.085 },
    tertiary: { hue: (H + 68) % 360, chroma: 0.115 },
    neutral: { hue: H, chroma: 0.008 },
    neutralVariant: { hue: H, chroma: 0.022 },
    error: { hue: 27, chroma: 0.20 }
  };
  const tone = (name, t) => tonal(PAL[name].hue, PAL[name].chroma, t);
  const semTone = (name, t) => tonal(SEM[name], 0.14, t);

  // ── 色彩角色（M3 基线方案，light / dark）──────────────────
  function scheme(dark) {
    const c = (name, t) => tone(name, t);
    const s = (name, t) => semTone(name, t);
    if (!dark) {
      return {
        primary: c('primary', 40), onPrimary: c('primary', 100),
        primaryContainer: c('primary', 90), onPrimaryContainer: c('primary', 10),
        secondary: c('secondary', 40), onSecondary: c('secondary', 100),
        secondaryContainer: c('secondary', 90), onSecondaryContainer: c('secondary', 10),
        tertiary: c('tertiary', 40), onTertiary: c('tertiary', 100),
        tertiaryContainer: c('tertiary', 90), onTertiaryContainer: c('tertiary', 10),
        error: c('error', 40), onError: c('error', 100),
        errorContainer: c('error', 90), onErrorContainer: c('error', 10),
        surface: c('neutral', 98), onSurface: c('neutral', 10),
        surfaceDim: c('neutral', 87), surfaceBright: c('neutral', 98),
        surfaceContainerLowest: c('neutral', 100), surfaceContainerLow: c('neutral', 96),
        surfaceContainer: c('neutral', 94), surfaceContainerHigh: c('neutral', 92),
        surfaceContainerHighest: c('neutral', 90),
        onSurfaceVariant: c('neutralVariant', 30), outline: c('neutralVariant', 50),
        outlineVariant: c('neutralVariant', 80),
        inverseSurface: c('neutral', 20), inverseOnSurface: c('neutral', 95),
        inversePrimary: c('primary', 80),
        scrim: c('neutral', 0), shadow: c('neutral', 0), surfaceTint: c('primary', 40),
        semIn: s('in', 40), semInContainer: s('in', 90), semOnInContainer: s('in', 10),
        semOut: s('out', 40), semOutContainer: s('out', 90), semOnOutContainer: s('out', 10),
        semMk: s('mk', 35), semMkContainer: s('mk', 90), semOnMkContainer: s('mk', 15)
      };
    }
    return {
      primary: c('primary', 80), onPrimary: c('primary', 20),
      primaryContainer: c('primary', 30), onPrimaryContainer: c('primary', 90),
      secondary: c('secondary', 80), onSecondary: c('secondary', 20),
      secondaryContainer: c('secondary', 30), onSecondaryContainer: c('secondary', 90),
      tertiary: c('tertiary', 80), onTertiary: c('tertiary', 20),
      tertiaryContainer: c('tertiary', 30), onTertiaryContainer: c('tertiary', 90),
      error: c('error', 80), onError: c('error', 20),
      errorContainer: c('error', 30), onErrorContainer: c('error', 90),
      surface: c('neutral', 6), onSurface: c('neutral', 90),
      surfaceDim: c('neutral', 6), surfaceBright: c('neutral', 24),
      surfaceContainerLowest: c('neutral', 4), surfaceContainerLow: c('neutral', 10),
      surfaceContainer: c('neutral', 12), surfaceContainerHigh: c('neutral', 17),
      surfaceContainerHighest: c('neutral', 22),
      onSurfaceVariant: c('neutralVariant', 80), outline: c('neutralVariant', 60),
      outlineVariant: c('neutralVariant', 30),
      inverseSurface: c('neutral', 90), inverseOnSurface: c('neutral', 20),
      inversePrimary: c('primary', 40),
      scrim: c('neutral', 0), shadow: c('neutral', 0), surfaceTint: c('primary', 80),
      semIn: s('in', 80), semInContainer: s('in', 30), semOnInContainer: s('in', 90),
      semOut: s('out', 80), semOutContainer: s('out', 30), semOnOutContainer: s('out', 90),
      semMk: s('mk', 80), semMkContainer: s('mk', 30), semOnMkContainer: s('mk', 90)
    };
  }

  // 状态层（M3 state layers）：把 onSurface / primary 叠成 rgba 备用
  function rgbaOf(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return 'rgba(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ',' + a + ')';
  }
  const varsCache = {};
  function cssVars(dark) {
    const key = dark ? 'd' : 'l';
    if (varsCache[key]) return varsCache[key];
    const s = scheme(dark);
    const v = {};
    Object.keys(s).forEach(k => {
      v['--md-sys-color-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())] = s[k];
    });
    // 状态层 / 叠加色
    v['--md-state-hover'] = rgbaOf(s.onSurface, 0.08);
    v['--md-state-focus'] = rgbaOf(s.onSurface, 0.12);
    v['--md-state-press'] = rgbaOf(s.onSurface, 0.12);
    v['--md-state-drag'] = rgbaOf(s.onSurface, 0.16);
    v['--md-primary-hover'] = rgbaOf(s.primary, 0.08);
    v['--md-primary-press'] = rgbaOf(s.primary, 0.12);
    v['--md-on-primary-hover'] = rgbaOf(s.onPrimary, 0.10);
    v['--md-scrim-40'] = rgbaOf(s.scrim, 0.40);
    v['--md-scrim-60'] = rgbaOf(s.scrim, 0.60);
    v['--md-surface-92'] = rgbaOf(s.surface, 0.92);
    // 形状
    v['--md-shape-xs'] = '4px'; v['--md-shape-sm'] = '8px'; v['--md-shape-md'] = '12px';
    v['--md-shape-lg'] = '16px'; v['--md-shape-xl'] = '28px'; v['--md-shape-full'] = '999px';
    // 动效（M3 Expressive 曲线）
    v['--md-ease-standard'] = 'cubic-bezier(0.2, 0, 0, 1)';
    v['--md-ease-emph-dec'] = 'cubic-bezier(0.05, 0.7, 0.1, 1)';
    v['--md-ease-emph-acc'] = 'cubic-bezier(0.3, 0, 0.8, 0.15)';
    v['--md-ease-spring'] = 'cubic-bezier(0.34, 1.32, 0.64, 1)';
    v['--md-dur-short'] = '120ms'; v['--md-dur-med'] = '220ms';
    v['--md-dur-long'] = '380ms'; v['--md-dur-xlong'] = '520ms';
    // 字体（M3 type scale 的常用几档）
    v['--md-font'] = '"Google Sans","HarmonyOS Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    v['--md-mono'] = '"JetBrains Mono","Cascadia Code","Consolas",monospace';
    // 阴影（M3 elevation）
    const tint = rgbaOf(s.shadow, 0.28);
    v['--md-elev-1'] = '0 1px 2px ' + rgbaOf(s.shadow, 0.30) + ',0 1px 3px 1px ' + rgbaOf(s.shadow, 0.15);
    v['--md-elev-2'] = '0 1px 2px ' + rgbaOf(s.shadow, 0.30) + ',0 2px 6px 2px ' + rgbaOf(s.shadow, 0.15);
    v['--md-elev-3'] = '0 4px 8px 3px ' + rgbaOf(s.shadow, 0.15) + ',0 1px 3px ' + rgbaOf(s.shadow, 0.30);
    v['--md-elev-4'] = '0 6px 10px 4px ' + rgbaOf(s.shadow, 0.15) + ',0 2px 3px ' + rgbaOf(s.shadow, 0.30);
    void tint;
    // 兼容旧变量名（老样式 / 内联 style / 页面内 shadow DOM 都还引用它们）
    v['--bg'] = s.surface;
    v['--card'] = s.surfaceContainer;
    v['--card-brd'] = s.outlineVariant;
    v['--row'] = s.surfaceContainerLow;
    v['--row-h'] = s.surfaceContainerHigh;
    v['--row-brd'] = s.outlineVariant;
    v['--text'] = s.onSurface;
    v['--muted'] = s.onSurfaceVariant;
    v['--faint'] = s.outline;
    v['--orange'] = s.primary;
    v['--orange-dk'] = rgbaOf(s.primary, 0.14);
    v['--in'] = s.semIn;
    v['--out'] = s.semOut;
    v['--mk'] = s.semMk;
    v['--mono'] = v['--md-mono'];
    v['--led'] = s.primary; v['--led-glow'] = rgbaOf(s.primary, 0.45);
    v['--scan'] = 'transparent';
    v['--tape'] = s.surfaceContainerHigh; v['--tape-brd'] = s.outlineVariant;
    varsCache[key] = v;
    return v;
  }
  function isDark() {
    return (document.documentElement.dataset.theme || 'dark') !== 'light';
  }
  function apply(root, dark) {
    const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
    if (!el) return;
    const vars = cssVars(dark === undefined ? isDark() : !!dark);
    Object.keys(vars).forEach(k => el.style.setProperty(k, vars[k]));
  }
  // 主题变化时自动换令牌（panel-core 只改 dataset.theme）
  function watch() {
    if (typeof document === 'undefined') return;
    apply(document.documentElement, isDark());
    try {
      new MutationObserver(() => apply(document.documentElement, isDark())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) { }
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
    else watch();
  }
  const G = (typeof window !== 'undefined') ? window : globalThis;
  G.MPM3 = {
    seed: SEED,
    tonal, scheme, cssVars, apply, role: (dark, name) => scheme(dark)[name],
    isDark,
    /** 给 shadow root 用的完整 CSS 变量声明文本 */
    varBlock(dark) {
      const v = cssVars(dark);
      return ':host{' + Object.keys(v).map(k => k + ':' + v[k]).join(';') + '}';
    }
  };
})();
