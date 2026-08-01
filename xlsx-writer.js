/* 最小 XLSX 生成器：两个工作表（标记点 / 入点到出点），无第三方依赖
   ZIP 条目用 STORED（不压缩）+ inlineStr 单元格，Excel / WPS 均可打开 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XlsxWriter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const enc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  function colLetter(i) {
    let s = '', n = i + 1;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function sheetXml(rows, widths) {
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    x += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    if (widths && widths.length) {
      x += '<cols>';
      widths.forEach((w, i) => { x += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; });
      x += '</cols>';
    }
    x += '<sheetData>';
    rows.forEach((r, ri) => {
      const n = ri + 1;
      x += '<row r="' + n + '">';
      r.forEach((c, ci) => {
        x += '<c r="' + colLetter(ci) + n + '" t="inlineStr"><is><t xml:space="preserve">' + enc(c) + '</t></is></c>';
      });
      x += '</row>';
    });
    x += '</sheetData></worksheet>';
    return x;
  }

  // ─── ZIP（STORED）─────────────────────────
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime() {
    const d = new Date();
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    return { time, date };
  }

  function localHeader(name, crc, size, dt) {
    const nb = new TextEncoder().encode(name);
    const b = new Uint8Array(30 + nb.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true);
    v.setUint16(8, 0, true);          // 0 = STORED
    v.setUint16(10, dt.time, true);
    v.setUint16(12, dt.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, size, true);
    v.setUint32(22, size, true);
    v.setUint16(26, nb.length, true);
    v.setUint16(28, 0, true);
    b.set(nb, 30);
    return b;
  }

  function centralEntry(name, crc, size, offset, dt) {
    const nb = new TextEncoder().encode(name);
    const b = new Uint8Array(46 + nb.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, 0x0800, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, dt.time, true);
    v.setUint16(14, dt.date, true);
    v.setUint32(16, crc, true);
    v.setUint32(20, size, true);
    v.setUint32(24, size, true);
    v.setUint16(28, nb.length, true);
    v.setUint16(30, 0, true);
    v.setUint16(32, 0, true);
    v.setUint16(34, 0, true);
    v.setUint16(36, 0, true);
    v.setUint32(38, 0, true);
    v.setUint32(42, offset, true);
    b.set(nb, 46);
    return b;
  }

  function endRecord(count, cdSize, cdOffset) {
    const b = new Uint8Array(22);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(4, 0, true);
    v.setUint16(6, 0, true);
    v.setUint16(8, count, true);
    v.setUint16(10, count, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, cdOffset, true);
    v.setUint16(20, 0, true);
    return b;
  }

  function makeZip(entries) {
    const dt = dosDateTime();
    const body = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const data = new TextEncoder().encode(e.data);
      const crc = crc32(data);
      const lh = localHeader(e.name, crc, data.length, dt);
      body.push(lh, data);
      central.push({ name: e.name, crc, size: data.length, offset });
      offset += lh.length + data.length;
    }
    const cdOffset = offset;
    const cds = central.map(c => centralEntry(c.name, c.crc, c.size, c.offset, dt));
    const cdSize = cds.reduce((s, b) => s + b.length, 0);
    body.push.apply(body, cds);
    body.push(endRecord(central.length, cdSize, cdOffset));
    const total = body.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const b of body) { out.set(b, p); p += b.length; }
    return out;
  }

  // ─── XLSX 组装 ────────────────────────────
  function build(mkRows, ioRows) {
    const entries = [
      { name: '[Content_Types].xml', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>' },
      { name: '_rels/.rels', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>' },
      { name: 'xl/workbook.xml', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' +
        '<sheet name="' + enc('标记点') + '" sheetId="1" r:id="rId1"/>' +
        '<sheet name="' + enc('入点到出点') + '" sheetId="2" r:id="rId2"/>' +
        '</sheets>' +
        '</workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
        '</Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(mkRows, [8, 14, 8, 60]) },
      { name: 'xl/worksheets/sheet2.xml', data: sheetXml(ioRows, [8, 14, 14, 10, 60]) }
    ];
    return makeZip(entries);
  }

  return { build };
});
