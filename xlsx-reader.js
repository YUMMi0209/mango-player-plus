/* 最小 XLSX 读取器：仅支持本插件导出的 xlsx（ZIP 条目 STORED 不压缩 + inlineStr 单元格）
   返回 { marks: rows[][], inOut: rows[][] }，第一行为表头 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XlsxReader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseZip(bytes) {
    const entries = {};
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0;
    while (p + 4 <= bytes.length) {
      if (dv.getUint32(p, true) !== 0x04034b50) break;
      const nlen = dv.getUint16(p + 26, true);
      const elen = dv.getUint16(p + 28, true);
      const csize = dv.getUint32(p + 18, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nlen));
      entries[name] = bytes.subarray(p + 30 + nlen + elen, p + 30 + nlen + elen + csize);
      p += 30 + nlen + elen + csize;
    }
    return entries;
  }

  function decodeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function parseSheet(xml) {
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    const cellRe = /<c\b[^>]*>([\s\S]*?)<\/c>|<c\b[^>]*\/>/g;
    let m;
    while ((m = rowRe.exec(xml)) !== null) {
      const cells = [];
      let cm;
      while ((cm = cellRe.exec(m[1])) !== null) {
        const inner = cm[1] || '';
        const tm = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        cells.push(tm ? decodeXml(tm[1]) : '');
      }
      rows.push(cells);
    }
    return rows;
  }

  function read(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const entries = parseZip(bytes);
    const s1 = entries['xl/worksheets/sheet1.xml'];
    const s2 = entries['xl/worksheets/sheet2.xml'];
    if (!s1 && !s2) return null;
    const out = {};
    if (s1) out.marks = parseSheet(new TextDecoder().decode(s1));
    if (s2) out.inOut = parseSheet(new TextDecoder().decode(s2));
    return out;
  }

  return { read };
});
