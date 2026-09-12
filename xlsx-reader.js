/* 最小 XLSX 读取器（零依赖）
   支持范围：
   - ZIP：中央目录优先（方法 0 STORED / 8 DEFLATE），无中央目录时按本地头顺序扫描
     （兼容本插件自身导出的顺序 STORED 条目）；DEFLATE 用自实现的 raw inflate，
     不依赖 DecompressionStream，旧版 Chromium 同样可用
   - 单元格：sharedStrings(t="s")、inlineStr、str、数字 / 布尔、列位置按 r 属性还原
   - 返回 { sheets: [{ name, rows }], marks, inOut }
     sheets 为全部工作表（rows 为字符串二维数组，空单元格为 ''），
     marks / inOut 仅在识别出「本插件导出格式」时填充（表头含 时间码 + 链接） */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XlsxReader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── ZIP ────────────────────────────────────────────────
  function u32(dv, p) { return dv.getUint32(p, true); }
  function u16(dv, p) { return dv.getUint16(p, true); }

  function scanLocalEntries(bytes, dv) {
    const list = [];
    let p = 0;
    while (p + 30 <= bytes.length) {
      if (u32(dv, p) !== 0x04034b50) break;
      const method = u16(dv, p + 8);
      const csize = u32(dv, p + 18);
      const usize = u32(dv, p + 22);
      const nlen = u16(dv, p + 26);
      const elen = u16(dv, p + 28);
      const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nlen));
      const start = p + 30 + nlen + elen;
      list.push({ name, method, csize, usize, data: bytes.subarray(start, start + csize) });
      p = start + csize;
    }
    return list;
  }

  function parseZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 找 EOCD（末尾最多 65557 字节内）
    let eocd = -1;
    const from = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= from; i--) {
      if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return scanLocalEntries(bytes, dv);
    const count = u16(dv, eocd + 10);
    let p = u32(dv, eocd + 16);
    const list = [];
    for (let i = 0; i < count && p + 46 <= bytes.length; i++) {
      if (u32(dv, p) !== 0x02014b50) break;
      const method = u16(dv, p + 10);
      const csize = u32(dv, p + 20);
      const usize = u32(dv, p + 24);
      const nlen = u16(dv, p + 28);
      const elen = u16(dv, p + 30);
      const clen = u16(dv, p + 32);
      const lho = u32(dv, p + 42);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
      // 数据起点以本地头为准（本地 extra 长度可能与中央目录不同）
      const lnlen = u16(dv, lho + 26);
      const lelen = u16(dv, lho + 28);
      const start = lho + 30 + lnlen + lelen;
      list.push({ name, method, csize, usize, data: bytes.subarray(start, start + csize) });
      p += 46 + nlen + elen + clen;
    }
    return list.length ? list : scanLocalEntries(bytes, dv);
  }

  // ─── raw DEFLATE 解压（puff 风格：规范 Huffman + 逐位解码）──
  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function inflateRaw(data, expected) {
    let bitPos = 0;
    const out = new Uint8Array(Math.max(64, expected || 0, data.length * 3));
    let len = 0;
    const need = n => {
      if (len + n > out.length) {
        let cap = out.length * 2;
        while (cap < len + n) cap *= 2;
        const nb = new Uint8Array(cap); nb.set(out.subarray(0, len));
        // eslint-disable-next-line no-global-assign
        outRef.buf = nb;
      }
    };
    // 用对象包一层，便于扩容后同步引用
    const outRef = { buf: out };
    const push = b => {
      if (len >= outRef.buf.length) need(1);
      outRef.buf[len++] = b;
    };
    const bits = n => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byte = data[bitPos >> 3];
        if (byte === undefined) throw new Error('inflate: eof');
        v |= ((byte >> (bitPos & 7)) & 1) << i;
        bitPos++;
      }
      return v;
    };
    const build = lengths => {
      let maxBits = 0;
      for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
      const counts = new Array(maxBits + 1).fill(0);
      for (let i = 0; i < lengths.length; i++) if (lengths[i]) counts[lengths[i]]++;
      const offs = new Array(maxBits + 2).fill(0);
      for (let i = 1; i <= maxBits; i++) offs[i + 1] = offs[i] + counts[i];
      const symbols = new Array(offs[maxBits + 1]);
      for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
      return { counts, symbols, maxBits };
    };
    const decode = tree => {
      let code = 0, first = 0, index = 0;
      for (let l = 1; l <= tree.maxBits; l++) {
        code |= bits(1);
        const count = tree.counts[l];
        if (code - first < count) return tree.symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
      }
      throw new Error('inflate: bad code');
    };
    const inflateBlock = (litTree, distTree) => {
      for (;;) {
        const sym = decode(litTree);
        if (sym < 256) { push(sym); continue; }
        if (sym === 256) return;
        const li = sym - 257;
        if (li < 0 || li >= LEN_BASE.length) throw new Error('inflate: bad length');
        const length = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const ds = decode(distTree);
        if (ds >= DIST_BASE.length) throw new Error('inflate: bad distance');
        const dist = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
        if (dist > len) throw new Error('inflate: dist out of range');
        for (let i = 0; i < length; i++) push(outRef.buf[len - dist]);
      }
    };
    for (;;) {
      const last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitPos = (bitPos + 7) & ~7;
        const p = bitPos >> 3;
        const blen = data[p] | (data[p + 1] << 8);
        bitPos += 32;
        for (let i = 0; i < blen; i++) push(data[(bitPos >> 3) + i]);
        bitPos += blen * 8;
      } else if (type === 1) {
        const litLens = new Array(288);
        for (let i = 0; i < 144; i++) litLens[i] = 8;
        for (let i = 144; i < 256; i++) litLens[i] = 9;
        for (let i = 256; i < 280; i++) litLens[i] = 7;
        for (let i = 280; i < 288; i++) litLens[i] = 8;
        inflateBlock(build(litLens), build(new Array(30).fill(5)));
      } else if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const clLens = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clLens[CLEN_ORDER[i]] = bits(3);
        const clTree = build(clLens);
        const lens = [];
        while (lens.length < hlit + hdist) {
          const sym = decode(clTree);
          if (sym < 16) lens.push(sym);
          else if (sym === 16) {
            if (!lens.length) throw new Error('inflate: bad repeat');
            const prev = lens[lens.length - 1];
            let r = bits(2) + 3;
            while (r--) lens.push(prev);
          } else if (sym === 17) {
            let r = bits(3) + 3;
            while (r--) lens.push(0);
          } else if (sym === 18) {
            let r = bits(7) + 11;
            while (r--) lens.push(0);
          } else throw new Error('inflate: bad code length');
        }
        inflateBlock(build(lens.slice(0, hlit)), build(lens.slice(hlit, hlit + hdist)));
      } else {
        throw new Error('inflate: bad block type');
      }
      if (last) break;
    }
    return outRef.buf.subarray(0, len);
  }

  function entryBytes(entry) {
    if (!entry) return null;
    if (entry.method === 0) return entry.data;
    if (entry.method === 8) return inflateRaw(entry.data, entry.usize);
    return null;
  }

  // ─── XML ────────────────────────────────────────────────
  function decodeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }
  const dec = u8 => new TextDecoder().decode(u8);
  // 单元格文本：拼接 <t> 片段（富文本多个 run）
  function cellText(xml) {
    let s = '', m;
    const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    while ((m = re.exec(xml)) !== null) s += decodeXml(m[1]);
    return s;
  }
  function colIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }
  function parseShared(xml) {
    const list = [];
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) list.push(cellText(m[1]));
    return list;
  }
  function parseSheetRows(xml, shared) {
    const rows = [];
    const rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
    let m;
    while ((m = rowRe.exec(xml)) !== null) {
      const attrs = m[1] || '';
      const inner = m[3] || '';
      const rm = attrs.match(/\br="(\d+)"/);
      const r = rm ? parseInt(rm[1], 10) - 1 : rows.length;
      while (rows.length < r) rows.push([]);
      const cells = [];
      const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(inner)) !== null) {
        const cAttrs = cm[1] || '';
        const cInner = cm[3] || '';
        const refM = cAttrs.match(/\br="([A-Z]+)\d+"/);
        const ci = refM ? colIndex(refM[1]) : cells.length;
        const tM = cAttrs.match(/\bt="([^"]+)"/);
        const type = tM ? tM[1] : '';
        let val = '';
        if (type === 'inlineStr') {
          val = cellText(cInner);
        } else if (type === 's') {
          const vm = cInner.match(/<v>([\s\S]*?)<\/v>/);
          const idx = vm ? parseInt(vm[1], 10) : NaN;
          val = isNaN(idx) ? '' : (shared[idx] != null ? shared[idx] : '');
        } else {
          const vm = cInner.match(/<v>([\s\S]*?)<\/v>/);
          if (vm) val = decodeXml(vm[1]);
          else if (cInner.indexOf('<t') !== -1) val = cellText(cInner);
        }
        while (cells.length < ci) cells.push('');
        cells[ci] = val;
      }
      rows[r] = cells;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }
  // 去掉 XML 标签的纯文本（用于 workbook.xml 的 sheet 名）
  function attrOf(tagAttrs, name) {
    const m = String(tagAttrs).match(new RegExp('\\b' + name + '="([^"]*)"'));
    return m ? decodeXml(m[1]) : '';
  }
  // 工作表清单：workbook.xml + rels 映射，缺失时回退 sheet1/sheet2 顺序读取
  function sheetList(entries) {
    const wb = entries['xl/workbook.xml'];
    const rels = entries['xl/_rels/workbook.xml.rels'];
    const out = [];
    if (wb) {
      const wbXml = dec(entryBytes(wb) || new Uint8Array());
      const relMap = {};
      if (rels) {
        const relXml = dec(entryBytes(rels) || new Uint8Array());
        const re = /<Relationship\b([^>]*)\/?>/g;
        let m;
        while ((m = re.exec(relXml)) !== null) {
          relMap[attrOf(m[1], 'Id')] = attrOf(m[1], 'Target');
        }
      }
      const re = /<sheet\b([^>]*)\/?>/g;
      let m;
      while ((m = re.exec(wbXml)) !== null) {
        const name = (attrOf(m[1], 'name') || ('Sheet' + (out.length + 1))).trim();
        const rid = attrOf(m[1], 'r:id') || attrOf(m[1], 'id');
        let target = relMap[rid] || '';
        if (!target) target = 'worksheets/sheet' + (out.length + 1) + '.xml';
        target = target.replace(/^\/+/, '').replace(/^xl\//, '');
        // 处理 ../ 相对路径
        const parts = target.split('/');
        const stack = [];
        parts.forEach(p => { if (p === '..') stack.pop(); else if (p !== '.' && p !== '') stack.push(p); });
        out.push({ name, path: 'xl/' + stack.join('/') });
      }
    }
    if (!out.length) {
      if (entries['xl/worksheets/sheet1.xml']) out.push({ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' });
      if (entries['xl/worksheets/sheet2.xml']) out.push({ name: 'Sheet2', path: 'xl/worksheets/sheet2.xml' });
    }
    return out.filter(s => entries[s.path]);
  }

  // 本插件导出格式识别（严格，避免把质检表误判成本插件导出）：
  //   标记点表：时间码 + 颜色 + 备注
  //   片段表  ：入点时间码 + 出点时间码 + 时长（兼容旧表头「时间码 / 时间码」）
  function tableFor(rows) {
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const header = (rows[i] || []).map(s => String(s == null ? '' : s).trim());
      const at = t => header.indexOf(t);
      const tcs = []; header.forEach((h, k) => { if (h === '时间码') tcs.push(k); });
      let idx = null, kind = null;
      if (at('时间码') >= 0 && at('颜色') >= 0 && at('备注') >= 0) {
        kind = 'marks';
        idx = { tc: at('时间码'), color: at('颜色'), note: at('备注'), url: at('链接'), title: at('标题') };
      } else if ((at('入点时间码') >= 0 && at('出点时间码') >= 0) || tcs.length >= 2) {
        if (at('时长') < 0 || at('备注') < 0) continue;
        kind = 'inOut';
        idx = {
          tc: at('入点时间码') >= 0 ? at('入点时间码') : tcs[0],
          outTC: at('出点时间码') >= 0 ? at('出点时间码') : tcs[1],
          dur: at('时长'), note: at('备注'),
          url: at('入点链接') >= 0 ? at('入点链接') : at('链接'),
          title: at('标题')
        };
      }
      if (!kind) continue;
      const data = rows.slice(i + 1).filter(r => r && String(r[idx.tc] == null ? '' : r[idx.tc]).trim() !== '');
      if (!data.length) continue;
      return { kind, idx, data };
    }
    return null;
  }

  function read(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let entries = {};
    try {
      parseZip(bytes).forEach(e => { entries[e.name] = e; });
    } catch (err) {
      return null;
    }
    const sharedEntry = entries['xl/sharedStrings.xml'];
    const shared = sharedEntry ? parseShared(dec(entryBytes(sharedEntry) || new Uint8Array())) : [];
    const list = sheetList(entries);
    if (!list.length) return null;
    const sheets = list.map(s => {
      let rows = [];
      try { rows = parseSheetRows(dec(entryBytes(entries[s.path]) || new Uint8Array()), shared); } catch (e) { rows = []; }
      return { name: s.name, rows };
    });
    const out = { sheets: sheets, marks: null, inOut: null };
    sheets.forEach(s => {
      const t = tableFor(s.rows);
      if (!t) return;
      const cell = (r, i) => (i >= 0 && r[i] != null) ? String(r[i]).trim() : '';
      if (t.kind === 'marks' && !out.marks) {
        out.marks = [['序号', '时间码', '颜色', '备注', '链接', '标题']].concat(t.data.map(r => [
          cell(r, 0), cell(r, t.idx.tc), cell(r, t.idx.color), cell(r, t.idx.note), cell(r, t.idx.url), cell(r, t.idx.title)
        ]));
      } else if (t.kind === 'inOut' && !out.inOut) {
        out.inOut = [['序号', '入点时间码', '出点时间码', '时长', '备注', '入点链接', '标题']].concat(t.data.map(r => [
          cell(r, 0), cell(r, t.idx.tc), cell(r, t.idx.outTC), cell(r, t.idx.dur), cell(r, t.idx.note), cell(r, t.idx.url), cell(r, t.idx.title)
        ]));
      }
    });
    return out;
  }

  return { read, inflateRaw };
});
