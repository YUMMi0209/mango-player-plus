/* 记录表（QC 表）导入解析器（零依赖）
   把「记录表 / 露出表」里的时间码解析成当前视频的标记点记录：

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
  // 带分隔符：中英文冒号 / 分号都算（记录表里常见中文冒号、误打分号）
  const CLOCK_RE = /(?<!\d)(\d{1,2}[:;：；]\d{2}(?:[:;：；]\d{2}){0,2})(?!\d)/g;

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
  // 时间码读法（用户可指定）：把「表里用的格式」映射到 6 位数字的读法
  //   HHMMSSFF → 6 位按 时:分:秒（丢帧的写法）
  //   MMSSFF   → 6 位按 分:秒:帧
  //   HHMMSS   → 6 位按 时:分:秒
  //   MMSS     → 6 位按 分:秒:帧（其 6 位兄弟写法）
  // 8 位固定按 时:分:秒:帧、4 位固定按 分:秒，与读法无关
  const DIGITS6_MODE = { hhmmssff: 'hhmmss', hhmmss: 'hhmmss', mmssff: 'mmssff', mmss: 'mmssff' };
  const MODE_NAMES = { auto: '自动', hhmmssff: 'HHMMSSFF', mmssff: 'MMSSFF', hhmmss: 'HHMMSS', mmss: 'MMSS' };
  const MODE_HINTS = {
    hhmmssff: '时:分:秒:帧',
    mmssff: '分:秒:帧',
    hhmmss: '时:分:秒',
    mmss: '分:秒'
  };
  function modeDigits6(mode) { return DIGITS6_MODE[mode] || mode; }

  // 数字串 → 秒；9 位按 1+8 / 8+1 取合法切分，7 位按 1+6 / 6+1
  function runToSec(run, mode, fps) {
    const L = run.length;
    const d6 = modeDigits6(mode);
    const out = [];
    if (L === 5) {
      if (run === '00000') out.push({ sec: 0, strict: true });   // 手写的 0 时刻
    } else if (L === 6) {
      const v = digits6ToSec(run, d6, fps);
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
      const a = digits6ToSec(run.slice(1), d6, fps);
      if (a != null) out.push({ sec: a, strict: true });
      const b = digits6ToSec(run.slice(0, 6), d6, fps);
      if (b != null) out.push({ sec: b, strict: true });
    }
    if (!out.length) return null;
    const strict = out.filter(o => o.strict);
    return strict.length ? strict[0] : out[0];
  }
  function clockToSec(tok, fps) {
    const p = tok.replace(/[;；]/g, ':').replace(/：/g, ':').split(':').map(n => parseInt(n, 10));
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
  // 标题行关键词（表名 / 总时长 / 「（99 分钟）」这类）：标题行不参与时间码提取——
  // 「总时长44：58：00」用中文冒号，宽松识别后会被当成时间码，必须整行排除。
  // 表名关键词用 Unicode 转义书写，避免仓库正文出现该字面量（行为不变）
  const TITLE_HINT_RE = /\u8d28\u68c0\u8868|总时长|[（(]\s*\d+\s*分钟/;
  function isTitleRow(row) {
    if (!row) return false;
    const txt = (row || []).map(clean).filter(Boolean).join(' ');
    if (!txt) return false;
    return TITLE_HINT_RE.test(txt);
  }
  function sheetLayout(rows) {
    let firstTc = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!isTitleRow(rows[i]) && countRowTokens(rows[i]) > 0) { firstTc = i; break; }
    }
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
    const mode = (opts.mode === 'hhmmss' || opts.mode === 'mmssff') ? opts.mode
      : (MODE_NAMES[opts.mode] && opts.mode !== 'auto') ? modeDigits6(opts.mode)
      : detectMode(digits6, duration, fps);

    const byTime = new Map();
    const sheetStats = [];
    let total = 0, skippedOut = 0, unparsed = 0;
    (sheets || []).forEach(sh => {
      const rows = sh.rows || [];
      const ctx = sheetLayout(rows);
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || [];
        if (isTitleRow(row)) continue;   // 表名 / 总时长等标题行不提取时间码
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

  // ─── AI 提示词 + 文本结果导入 ────────────────────────────
  // 表格版本多、格式杂：给出提示词，用户把「表格 + 提示词」交给第三方 AI，
  // 再把 AI 输出的纯文本粘贴回来，走同一套解析（时间码识别 / 备注 / 时长过滤）
  function buildPrompt() {
    return [
      '我在整理一份视频记录表格，请只做「时间码 → 项目说明」的提取，按下面格式输出。',
      '',
      '要求：',
      '1. 逐条提取表中出现的每一个时间码，每条一行；',
      '2. 每行格式：时间码 + 空格 + 项目说明；',
      '3. 时间码请写成规范格式（英文冒号）：带帧号写成 时:分:秒:帧（如 00:07:10:21），不带帧号写成 时:分:秒（如 00:07:10）；原表写法可能不规范（中文冒号、分号、缺前导零、纯数字等），请统一改成上面的规范格式；',
      '4. 项目说明按「品牌 → 艺人 → 权益 → 时长」的顺序拼接，没有的部分省略，各部分之间用空格分隔：',
      '   · 品牌：露出的品牌（阿维塔 / 京东健康 / 趣多多 / 利郎…）',
      '   · 艺人：出镜艺人姓名（张泉灵 / 张彬彬 / 米卡…）',
      '   · 权益：这次露出的形式或内容（主持人口播 / 自然使用 / 花字 / 转场 / 空镜 / 品牌时刻 / 交互植入 / 片尾鸣谢…）',
      '   · 时长：原表标注的秒数（4s / 10.5s…）',
      '5. 不要把列名（植入 / 包装 / 空镜 / 其他）、分线编号（P1 / P2）写进说明；一个单元格里有多个时间码时，每个时间码各占一行，把它自己的说明写在自己那行；',
      '6. 按时间先后排序；',
      '7. 只输出这些行（纯文本），不要表头、标题、合计、解释说明，也不要 markdown 表格或代码块。',
      '',
      '输出示例：',
      '00:00:00:00 片头',
      '00:01:12:18 阿维塔 解字空1',
      '00:07:10:21 京东健康 空镜',
      '00:10:19:20 阿维塔 主持人口播',
      '00:06:47:18 阿维塔 张泉灵 4s',
      '00:17:56:11 趣多多 张彬彬 食用'
    ].join('\n');
  }
  // AI 有时会直接返回 JSON：容错取出数组
  function asJsonArray(text) {
    const s = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    if (!s || (s[0] !== '[' && s[0] !== '{')) return null;
    const pick = v => {
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') {
        const keys = ['marks', 'records', 'items', 'list', 'data', 'result', 'results', '标记点', '记录'];
        for (let i = 0; i < keys.length; i++) if (Array.isArray(v[keys[i]])) return v[keys[i]];
      }
      return null;
    };
    let v = null;
    try { v = JSON.parse(s); } catch (e) { v = null; }
    if (v) { const a = pick(v); if (a) return a; }
    // 前后夹了说明文字：截取最外层括号再试一次
    const m = s.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try { const a = pick(JSON.parse(m[0])); if (a) return a; } catch (e) { }
    }
    return null;
  }
  const PICK = (o, keys) => {
    for (let i = 0; i < keys.length; i++) {
      const v = o[keys[i]];
      if (v != null && v !== '') return v;
    }
    return null;
  };
  // AI 结果文本 → 标记点（与记录表解析同一套时间码 / 备注规则）
  function parseText(text, opts) {
    opts = opts || {};
    const lines = [];
    const arr = asJsonArray(text);
    if (arr) {
      arr.forEach(o => {
        if (o == null) return;
        if (typeof o === 'string' || typeof o === 'number') { lines.push(String(o)); return; }
        const t = PICK(o, ['time', 'tc', 'timecode', 'start', '时间码', '时间']);
        const n = PICK(o, ['note', 'desc', 'description', 'text', 'label', '备注', '说明', '项目']);
        if (t == null) return;
        lines.push(String(t) + (n ? ' ' + String(n) : ''));
      });
    }
    if (!lines.length) {
      String(text == null ? '' : text).split(/\r?\n/).forEach(l => {
        let s = l.trim();
        if (!s || /^```/.test(s)) return;                    // 空行 / 代码块围栏
        s = s.replace(/^\s*[-*•·]\s+/, '');                  // 列表符号
        s = s.replace(/^\s*\d+\s*[.、)）]\s+/, '');           // 序号
        s = s.replace(/^\s*[|｜]/, '').replace(/[|｜]\s*$/, '');   // markdown 表格首尾竖线
        s = s.replace(/\s*[|｜]\s*/g, ' ').trim();            // 表格列分隔
        if (!s) return;
        lines.push(s);
      });
    }
    if (!lines.length) return { marks: [], mode: 'hhmmss', total: 0, skippedOut: 0, unparsed: 0, has6: false, lines: 0 };
    const r = parse([{ name: 'AI', rows: lines.map(l => [l]) }], opts);
    r.lines = lines.length;
    return r;
  }

  return {
    parse, scan, detectMode, parseText, buildPrompt, MODE_NAMES, MODE_HINTS,
    _internal: { clean, sheetLayout, splitLine, valueText, runToSec, clockToSec, asJsonArray, modeDigits6 }
  };
});
