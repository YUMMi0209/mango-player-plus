/**
 * MG Player+ — WebM 色彩范围修正（limited range）
 *
 * 背景：Chrome 的 MediaRecorder 把 canvas（sRGB，全范围）编码为 WebM 时，
 * Colour 元素写的是 Range = 2（full range）。按标准播放器没问题，但大量播放器 /
 * 剪辑软件默认按 limited（broadcast，16-235）解释，于是把我们全范围的画面又
 * 拉伸一次 —— 表现为黑位被压、画面「偏深」。
 *
 * 做法：录制端把画面压缩到 limited（control-bar 里绘制时 contrast 压缩），
 * 这里把容器里的 Colour/Range 从 2 改成 1（broadcast），两边就一致了。
 * Colour 元素是定长的（每个子元素 1 字节值），所以只改一个字节，不移动任何偏移。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MPGWebmColor = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // EBML 变长整数长度（含标记位）
  function vintLen(b, p) {
    const first = b[p];
    if (first === undefined || first === 0) return 0;
    for (let len = 1; len <= 8; len++) if (first & (0x80 >> (len - 1))) return len;
    return 0;
  }
  const ID_COLOUR = [0x55, 0xB0];
  const ID_MATRIX = [0x55, 0xB1];
  const ID_RANGE = [0x55, 0xB9];
  const ID_TRANSFER = [0x55, 0xBA];
  const ID_PRIMARIES = [0x55, 0xBB];

  function at(b, p, id) { return b[p] === id[0] && b[p + 1] === id[1]; }

  // 从 p 开始解析一个「1 字节值」的子元素：返回 { id, value, next } 或 null
  function readSmallChild(b, p, len) {
    if (p + 2 > len) return null;
    const idLen = (b[p] === 0x55) ? 2 : 1;          // Colour 的子元素 ID 都是 2 字节
    const id = [b[p], b[p + 1]];
    const szLen = vintLen(b, p + idLen);
    if (!szLen) return null;
    const sz = b[p + idLen] & (0xFF >> szLen);
    const dataStart = p + idLen + szLen;
    if (dataStart + sz > len) return null;
    return { id, value: sz >= 1 ? b[dataStart] : null, size: sz, dataStart, next: dataStart + sz };
  }

  // 把第一个 Colour 里的 Range 改成 limited(1)；返回 { data, changed, reason }
  function toLimited(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const len = b.length;
    for (let p = 0; p + 4 < len; p++) {
      if (!at(b, p, ID_COLOUR)) continue;
      const colourSizeLen = vintLen(b, p + 2);
      if (!colourSizeLen) continue;
      const colourSize = b[p + 2] & (0xFF >> colourSizeLen);
      const colourStart = p + 2 + colourSizeLen;
      if (colourSize < 4 || colourStart + colourSize > len) continue;
      // 逐个子元素找 Range / Matrix / Transfer / Primaries
      let q = colourStart;
      const end = colourStart + colourSize;
      let rangeAt = -1, rangeVal = -1, sawMatrix = false, sawTransfer = false, sawPrimaries = false;
      while (q < end) {
        const c = readSmallChild(b, q, end);
        if (!c) break;
        if (at(b, q, ID_RANGE)) { rangeAt = c.dataStart; rangeVal = c.value; }
        else if (at(b, q, ID_MATRIX)) sawMatrix = true;
        else if (at(b, q, ID_TRANSFER)) sawTransfer = true;
        else if (at(b, q, ID_PRIMARIES)) sawPrimaries = true;
        q = c.next;
      }
      if (rangeAt < 0) return { data: b, changed: false, reason: 'Colour 无 Range 元素' };
      if (rangeVal === 1) return { data: b, changed: false, reason: '已是 limited' };
      if (rangeVal !== 2) return { data: b, changed: false, reason: 'Range 值非 2（' + rangeVal + '）' };
      const out = b.slice();
      out[rangeAt] = 1;   // 2 (full) → 1 (broadcast / limited)
      return {
        data: out, changed: true,
        reason: 'Range 2→1' + (sawMatrix && sawTransfer && sawPrimaries ? '（色彩三要素齐全）' : '')
      };
    }
    return { data: b, changed: false, reason: '未找到 Colour 元素' };
  }

  return { toLimited };
});
