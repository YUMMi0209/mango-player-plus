/* 质检表（QC 表）导入解析器（零依赖）
   把「质检表 / 露出表」里的时间码解析成当前视频的标记点记录：

   - 时间码写法：
       · 6 位纯数字：分:秒:帧（MMSSFF）或 时:分:秒（HHMMSS），按视频时长自动判定
       · 8 位纯数字：HHMMSSFF（时:分:秒:帧）
       · 9 位纯数字：多为多打/漏打一位，按「1+8 / 8+1」切分取合法的一种
       · 带分隔符：mm:ss / hh:mm:ss / hh:mm:ss:ff（分隔符兼容误打的 ; ）
   - 备注来源：
       · 所在列的分类表头（植入 / 包装权益 / 空镜 / 其他…，过长标题不作为分类）
       · 同一行的标签列（分线 / 艺人，合并单元格自动向下填充）
       · 单元格文本（去掉时间码本身；紧邻时间码前后的【品牌】/（说明）归属该时间码）
       · 品牌 / 秒数列（「阿维塔 4s」这类）
   - 同一时刻的多条记录合并备注，避免重复标记点

   scan(sheets)   → 每个工作表的分节与时间码数量（导入前供用户选择 sheet）
   parse(sheets, { fps, duration, mode }) → { marks, mode, sheetStats, total, skippedOut }
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QcImport = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 这些表头不作为备注里的「分类」前缀（插件导出格式的列 / 纯数值列 / 通用列）
  const SKIP_HEADERS = ['序号', '时间码', '入点时间码', '出点时间码', '备注', '链接', '入点链接', '标题', '秒数', '时长', '颜色', '内容'];
  const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;
  // 数字串：6-9 位（9 位多为多打/漏打一位）；另兼容「00000」这类手写的 0 时刻
  const RUN_RE = /(?<!\d)(\d{6,9}|00000)(?!\d)/g;
  const CLOCK_RE = /(?<!\d)(\d{1,2}[:;]\d{2}(?:[:;]\d{2}){0,2})(?!\d)/g;

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/_x00[0-9A-Fa-f]{2}_/g, '')   // Excel 转义换行 _x000D_ / _x000A_
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s·•\-—:：,，、]+/, '')
      .replace(/[\s·•\-—:：,，、]+$/, '')
      .trim();
  }
  // 表头规范化：去掉括号补充说明（「内容权益（深度、交互…）」→「内容权益」）
  function normHeader(s) {
    return clean(s).replace(/[（(][^）)]*[）)]/g, '').trim();
  }

  // ─── 时间码 → 秒 ─────────────────────────────────────────
  function digits6ToSec(tok, mode, fps) {
    const a = parseInt(tok.slice(0, 2), 10);
    const b = parseInt(tok.slice(2, 4), 10);
    const c = parseInt(tok.slice(4, 6), 10);
    if (!isFinite(a) || !isFinite(b) || !isFinite(c)) return null;
    if (mode === 'mmssff') {
      if (b > 59) return null;
      return a * 60 + b + c / fps;
    }
    if (b > 59 || c > 59) return null;
    return a * 3600 + b * 60 + c;
  }
  function digits8ToSec(tok, fps) {
    const h = parseInt(tok.slice(0, 2), 10), m = parseInt(tok.slice(2, 4), 10);
    const s = parseInt(tok.slice(4, 6), 10), f = parseInt(tok.slice(6, 8), 10);
    if (![h, m, s, f].every(isFinite)) return null;
    if (m > 59 || s > 59 || f > 99) return null;
    return { sec: h * 3600 + m * 60 + s + f / fps, strict: f < fps };
  }
  // 数字串 → 秒；9 位按 1+8 / 8+1 取合法切分，7 位按 1+6 / 6+1
  function runToSec(run, mode, fps) {
    const L = run.length;
    const out = [];
    if (L === 5) {
      if (run === '00000') out.push({ sec: 0, strict: true });   // 手写的 0 时刻
    } else if (L === 6) {
      const v = digits6ToSec(run, mode, fps);
      if (v != null) out.push({ sec: v, strict: true });
    } else if (L === 8) {
      const v = digits8ToSec(run, fps);
      if (v) out.push(v);
    } else if (L === 9) {
      const a = digits8ToSec(run.slice(1), fps);
      if (a) out.push(a);
      const b = digits8ToSec(run.slice(0, 8), fps);
      if (b) out.push(b);
    } else if (L === 7) {
      const a = digits6ToSec(run.slice(1), mode, fps);
      if (a != null) out.push({ sec: a, strict: true });
      const b = digits6ToSec(run.slice(0, 6), mode, fps);
      if (b != null) out.push({ sec: b, strict: true });
    }
    if (!out.length) return null;
    const strict = out.filter(o => o.strict);
    return strict.length ? strict[0] : out[0];
  }
  function clockToSec(tok, fps) {
    const p = tok.replace(/;/g, ':').split(':').map(n => parseInt(n, 10));
    if (p.some(n => !isFinite(n))) return null;
    if (p.length === 2) return { sec: p[0] * 60 + p[1], strict: true };
    if (p.length === 3) return { sec: p[0] * 3600 + p[1] * 60 + p[2], strict: true };
    if (p.length === 4) {
      if (p[3] > 99) return null;
      return { sec: p[0] * 3600 + p[1] * 60 + p[2] + p[3] / fps, strict: p[3] < fps };
    }
    return null;
  }
  // 6 位数字的读法判定：首位 > 23 只可能是「分」；否则用视频时长挑选
  function detectMode(digits6, duration, fps) {
    if (!digits6.length) return 'hhmmss';
    let maxFirst = 0;
    digits6.forEach(t => { const v = parseInt(t.slice(0, 2), 10); if (v > maxFirst) maxFirst = v; });
    if (maxFirst > 23) return 'mmssff';
    const hh = digits6.map(t => digits6ToSec(t, 'hhmmss', fps)).filter(v => v != null);
    const mm = digits6.map(t => digits6ToSec(t, 'mmssff', fps)).filter(v => v != null);
    const fits = arr => (duration > 0 ? arr.filter(v => v <= duration + 2).length : arr.length);
    const maxOf = arr => (arr.length ? Math.max.apply(null, arr) : 0);
    const fh = fits(hh), fm = fits(mm);
    if (fm > fh) return 'mmssff';
    if (fh > fm) return 'hhmmss';
    return maxOf(mm) > maxOf(hh) ? 'mmssff' : 'hhmmss';
  }

  // ─── 行列结构 ────────────────────────────────────────────
  function cellText(cell) { return String(cell == null ? '' : cell); }
  function countRowTokens(row) {
    let n = 0;
    (row || []).forEach(cell => {
      const s = cellText(cell);
      if (!s) return;
      RUN_RE.lastIndex = 0;
      let m;
      while ((m = RUN_RE.exec(s)) !== null) n++;
      CLOCK_RE.lastIndex = 0;
      while ((m = CLOCK_RE.exec(s)) !== null) n++;
    });
    return n;
  }
  function isTitleRow(row) {
    if (!row || countRowTokens(row) > 0) return false;
    const txt = (row || []).map(clean).filter(Boolean).join(' ');
    if (!txt) return false;
    return /质检表|总时长|[（(]\s*\d+\s*分钟/.test(txt);
  }
  function sheetLayout(rows) {
    let firstTc = -1;
    for (let i = 0; i < rows.length; i++) if (countRowTokens(rows[i]) > 0) { firstTc = i; break; }
    // 表头行：首个含时间码的行之前，非空单元格最多且本身不含时间码的行
    let headerIdx = -1, best = 0;
    const limit = firstTc < 0 ? rows.length : firstTc;
    for (let i = 0; i < limit; i++) {
      const r = rows[i] || [];
      if (isTitleRow(r)) continue;
      const n = r.filter(c => clean(c)).length;
      if (n >= 2 && n > best) { best = n; headerIdx = i; }
    }
    const headerRow = headerIdx >= 0 ? (rows[headerIdx] || []) : [];
    const headers = headerRow.map(normHeader);
    let width = 0;
    rows.forEach(r => { if (r && r.length > width) width = r.length; });
    return { headerIdx, headers, width };
  }

  // ─── 一行文本 → 时间码 + 归属的【品牌】/（说明）────────────────
  // 时间码后面的（说明）/【品牌】：仅当后面没有紧跟另一个时间码时，才归属当前时间码
  // （否则那些【品牌】是下一个时间码的前置品牌，如【宁德时代】013818）
  function attachTail(line, items) {
    items.forEach((t, i) => {
      const next = items[i + 1];
      let pos = t.end;
      const tails = [];
      for (;;) {
        const rest = line.slice(pos);
        const mm = rest.match(/^\s*(?:[（(]([^）)]*)[）)]|【([^】]*)】)/);
        if (!mm) break;
        const val = clean(mm[1] != null ? mm[1] : mm[2]);
        if (val) tails.push(val);
        pos += mm[0].length;
      }
      if (!tails.length) return;
      if (next && pos <= next.start && /^\s*$/.test(line.slice(pos, next.start))) return;
      t.tails = tails;
      t.tailEnd = pos;
    });
  }
  function splitLine(line, mode, fps) {
    const raws = [];
    RUN_RE.lastIndex = 0;
    let m;
    while ((m = RUN_RE.exec(line)) !== null) raws.push({ tok: m[1], start: m.index, end: m.index + m[1].length, kind: 'run' });
    CLOCK_RE.lastIndex = 0;
    while ((m = CLOCK_RE.exec(line)) !== null) raws.push({ tok: m[1], start: m.index, end: m.index + m[1].length, kind: 'clock' });
    if (!raws.length) return null;
    raws.sort((a, b) => a.start - b.start);
    const items = [];
    raws.forEach(t => {
      if (items.some(x => t.start >= x.start && t.end <= x.end)) return;
      const v = t.kind === 'run' ? runToSec(t.tok, mode, fps) : clockToSec(t.tok, fps);
      if (!v) return;
      t.sec = v.sec;
      t.strict = v.strict;
      items.push(t);
    });
    if (!items.length) return null;
    // 归属前置【品牌】时的原始文本
    const line0 = line;
    let cursor = 0;
    let text = '';
    items.forEach(t => {
      let seg = line0.slice(cursor, t.start);
      const brands = [];
      for (;;) {
        const mm = seg.match(/【([^】]*)】\s*$/);
        if (!mm) break;
        if (clean(mm[1])) brands.unshift(clean(mm[1]));
        seg = seg.slice(0, mm.index);
      }
      t.brands = brands;
      text += seg + ' ';
      cursor = t.end;
    });
    text += line0.slice(cursor);
    attachTail(line0, items);
    // 去掉归属到时间码的尾部（说明）/【品牌】，备注只保留公共文本
    let cleanText = text;
    items.forEach(t => {
      if (t.tails && t.tails.length) {
        const sub = line0.slice(t.end, t.tailEnd);
        cleanText = cleanText.replace(sub, ' ');
      }
    });
    return { items: items, text: tidy(cleanText.replace(/\s+/g, ' ')) };
  }

  // 行内的品牌 / 秒数信息：「阿维塔 4s」
  function valueText(row, ctx, col) {
    const out = [];
    let dur = '';
    const width = Math.max((row || []).length, ctx.headers.length);
    for (let c = 0; c < width; c++) {
      const h = clean(ctx.headers[c]);
      const v = clean((row || [])[c]);
      if (!v) continue;
      if (/^(秒数|时长)$/.test(h)) { if (!dur) dur = v; continue; }
      if (c === col) continue;
      if (NUMERIC_RE.test(v) && parseFloat(v) > 0 && h && SKIP_HEADERS.indexOf(h) < 0 && !/时间码|链接/.test(h)) {
        out.push(h + ' ' + v + 's');
      }
    }
    if (!out.length && dur) out.push(dur + 's');
    return out.join(' / ');
  }

  function clip(s, n) {
    s = clean(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  // 去掉只由分隔符组成的小片段（「— + —」这类区间连接符残留）
  function tidy(s) {
    return clean(String(s || '')
      .split(/\s+/)
      .filter(p => p && !/^[+—–~～\-—:：,，、]+$/.test(p))
      .join(' '));
  }
  // ─── 导入前扫描：工作表 / 分节 / 时间码数量 ──────────────────
  function scan(sheets) {
    return (sheets || []).map(sh => {
      const rows = sh.rows || [];
      const sections = [];
      let cur = { title: '', start: 0, end: rows.length - 1, tokens: 0 };
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || [];
        if (isTitleRow(row)) {
          const title = clean(row.map(clean).filter(Boolean).join(' '));
          if (cur.tokens === 0) {
            // 连续标题行（表名 + 总时长）合并成一节
            cur.title = cur.title ? cur.title + ' · ' + title : title;
          } else {
            cur.end = i - 1;
            sections.push(cur);
            cur = { title: title, start: i, end: rows.length - 1, tokens: 0 };
          }
          continue;
        }
        cur.tokens += countRowTokens(row);
      }
      sections.push(cur);
      const tokens = sections.reduce((a, s) => a + s.tokens, 0);
      return { name: sh.name || '', rows: rows, sections: sections, tokens: tokens };
    });
  }

  // ─── 解析为标记点 ────────────────────────────────────────
  function parse(sheets, opts) {
    opts = opts || {};
    const fps = opts.fps > 0 ? opts.fps : 25;
    const duration = opts.duration > 0 ? opts.duration : 0;
    // ① 先收集所有 6 位纯数字，用于判定读法
    const digits6 = [];
    (sheets || []).forEach(sh => {
      (sh.rows || []).forEach(row => {
        (row || []).forEach(cell => {
          const s = cellText(cell);
          if (!s) return;
          RUN_RE.lastIndex = 0;
          let m;
          while ((m = RUN_RE.exec(s)) !== null) if (m[1].length === 6) digits6.push(m[1]);
        });
      });
    });
    const mode = (opts.mode === 'hhmmss' || opts.mode === 'mmssff') ? opts.mode : detectMode(digits6, duration, fps);

    const byTime = new Map();
    const sheetStats = [];
    let total = 0, skippedOut = 0, unparsed = 0;
    (sheets || []).forEach(sh => {
      const rows = sh.rows || [];
      const ctx = sheetLayout(rows);
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || [];
        for (let col = 0; col < row.length; col++) {
          const cellRaw = cellText(row[col]);
          if (!cellRaw) continue;
          // Excel 换行转义 _x000D_ / _x000A_ 视为换行：同一单元格内的多行各自成条
          cellRaw.replace(/_x00(?:0D|0A)_/gi, '\n').split('\n').forEach(lineRaw => {
            const line = lineRaw.trim();
            if (!line) return;
            RUN_RE.lastIndex = 0;
            const digitRuns = (line.match(RUN_RE) || []).length;
            CLOCK_RE.lastIndex = 0;
            const clockRuns = (line.match(CLOCK_RE) || []).length;
            const sp = splitLine(line, mode, fps);
            if (!sp) {
              if (digitRuns + clockRuns > 0) unparsed += digitRuns + clockRuns;
              return;
            }
            const vals = valueText(row, ctx, col);
            sp.items.forEach(item => {
              total++;
              if (duration > 0 && item.sec > duration + 2) { skippedOut++; return; }
              // 备注只写「对应项目」：单元格里紧跟时间码的说明 / 品牌（如 00295306趣多多空镜 → 趣多多空镜），
              // 不写列分类、分线、艺人等额外信息；单元格里只有时间码时（露出表这类）退化为品牌 / 秒数
              const tags = (item.brands || []).concat(item.tails || []);
              let note = tidy([sp.text, tags.join('/')].filter(Boolean).join(' '));
              if (!note) note = vals;
              note = clip(note, 80);
              const key = Math.round(item.sec * 100) / 100;
              const prev = byTime.get(key);
              if (!prev) {
                byTime.set(key, { time: key, note: note });
                count++;
              } else if (note && prev.note.indexOf(note) < 0) {
                prev.note = clip(prev.note ? prev.note + ' / ' + note : note, 120);
              }
            });
          });
        }
      }
      sheetStats.push({ name: sh.name || '', count: count });
    });
    const marks = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    return {
      marks: marks, mode: mode, sheetStats: sheetStats, total: total,
      skippedOut: skippedOut, unparsed: unparsed,
      has6: digits6.length > 0      // 是否含 6 位数字（读法可切换）
    };
  }

  return { parse, scan, detectMode, _internal: { clean, sheetLayout, splitLine, valueText, runToSec, clockToSec } };
});
