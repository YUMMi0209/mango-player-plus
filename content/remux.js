/**
 * MG Player+ — fMP4 → classic MP4 remux
 *
 * MediaRecorder 输出的 MP4 是 fragmented MP4（moov 前置 + moof/mdat 分片），
 * 部分剪辑软件（达芬奇旧版、会声会影、Edius 等）无法读取。
 * 本模块把 fMP4 重封装为经典 MP4：ftyp | mdat(样本数据) | moov(完整 stbl，无 moof)。
 *
 * 输入：完整文件的字节（MediaRecorder 全部 chunk 合并）
 * 输出：标准 MP4 字节（同步返回）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MPGRemux = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── 二进制工具 ───────────────────────────────
  function rdU16(b, p) { return (b[p] << 8) | b[p + 1]; }
  function rdU32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }
  // int32 有符号读取：trun 的 data_offset 与 sample_cts 均为有符号 32 位整数
  // （data_offset 可为负——样本数据位于 moof 之前；cts 可为负——B 帧 PTS 早于 DTS），
  // 按无符号读取会把负值变成巨大正数，导致样本数据偏移错乱、文件在对应位置损坏
  function rdS32(b, p) { return rdU32(b, p) | 0; }
  function rdU64(b, p) { return rdU32(b, p) * 4294967296 + rdU32(b, p + 4); }
  function wrU32(arr, p, v) {
    arr[p] = (v >>> 24) & 255; arr[p + 1] = (v >>> 16) & 255;
    arr[p + 2] = (v >>> 8) & 255; arr[p + 3] = v & 255;
  }
  function ascii(b, p, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]);
    return s;
  }

  // ─── box 遍历 ────────────────────────────────
  function* walkBoxes(bytes, start, end) {
    let p = start;
    while (p + 8 <= end) {
      const size32 = rdU32(bytes, p);
      const type = ascii(bytes, p + 4, 4);
      let size = size32, header = 8;
      if (size32 === 1) { size = rdU64(bytes, p + 8); header = 16; }
      else if (size32 === 0) { size = end - p; }
      if (size < header || p + size > end) break; // 数据不完整，停止扫描
      yield { type, start: p, header, size, data: p + header, end: p + size };
      p += size;
    }
  }

  // ─── tfhd / trun 解析（moof 样本表）────────────
  const TFHD_BASE_DATA_OFFSET = 0x000001;
  const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
  const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
  const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;
  const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;

  const TRUN_DATA_OFFSET = 0x000001;
  const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
  const TRUN_SAMPLE_DURATION = 0x000100;
  const TRUN_SAMPLE_SIZE = 0x000200;
  const TRUN_SAMPLE_FLAGS = 0x000400;
  const TRUN_SAMPLE_CTS = 0x000800;

  function parseTfhd(bytes, b) {
    const d = b.data;
    const flags = rdU32(bytes, d) & 0xFFFFFF;
    const r = { trackId: rdU32(bytes, d + 4), flags };
    let p = d + 8;
    if (flags & TFHD_BASE_DATA_OFFSET) { r.baseDataOffset = rdU64(bytes, p); p += 8; }
    if (flags & 0x000002) p += 4; // sample-description-index
    if (flags & TFHD_DEFAULT_SAMPLE_DURATION) { r.defaultSampleDuration = rdU32(bytes, p); p += 4; }
    if (flags & TFHD_DEFAULT_SAMPLE_SIZE) { r.defaultSampleSize = rdU32(bytes, p); p += 4; }
    if (flags & TFHD_DEFAULT_SAMPLE_FLAGS) { r.defaultSampleFlags = rdU32(bytes, p); p += 4; }
    r.defaultBaseIsMoof = !!(flags & TFHD_DEFAULT_BASE_IS_MOOF);
    return r;
  }

  function parseTrun(bytes, b) {
    const d = b.data;
    const version = bytes[d];
    const flags = rdU32(bytes, d) & 0xFFFFFF;
    const r = { count: rdU32(bytes, d + 4) };
    let p = d + 8;
    if (flags & TRUN_DATA_OFFSET) { r.dataOffset = rdS32(bytes, p); p += 4; }
    if (flags & TRUN_FIRST_SAMPLE_FLAGS) { r.firstSampleFlags = rdU32(bytes, p); p += 4; }
    // 新版 ISO 14496-12（2015+）trun 语法：每样本一组字段，按 flags 置位顺序交错存放。
    // Chromium 的 MediaRecorder 即按此布局输出（旧版"数组各自连续"的布局已废弃）。
    const dur = [], size = [], sampleFlags = [], cts = [];
    for (let i = 0; i < r.count; i++) {
      if (flags & TRUN_SAMPLE_DURATION) { dur.push(rdU32(bytes, p)); p += 4; }
      if (flags & TRUN_SAMPLE_SIZE) { size.push(rdU32(bytes, p)); p += 4; }
      if (flags & TRUN_SAMPLE_FLAGS) { sampleFlags.push(rdU32(bytes, p)); p += 4; }
      if (flags & TRUN_SAMPLE_CTS) { cts.push(rdS32(bytes, p)); p += 4; }
    }
    if (dur.length) r.durations = dur;
    if (size.length) r.sizes = size;
    if (sampleFlags.length) r.sampleFlags = sampleFlags;
    if (cts.length) r.cts = cts;
    r.version = version;
    return r;
  }

  // ─── 色彩范围标签：改成 limited（与录制端的对比度压缩配套）──
  // 背景：Chrome 录制 canvas（sRGB，全范围 0-255）时，容器里写的是「全范围」标签，
  // 但大量播放器 / 剪辑软件默认按 limited（16-235）解释视频，于是把我们全范围的画面
  // 又拉伸一次 —— 黑位被压掉、画面发闷「偏深」。录制端已把画面压缩到 limited，
  // 这里把容器标签一并改成 limited，两边一致，无论软件看不看标签都不会再偏。
  // H.264 的范围有两处声明，必须一起改，否则不同软件各按各的解释：
  //   · SPS VUI 的 video_full_range_flag（解码器 / 剪辑软件普遍读这里，最重要）
  //   · avc1 → colr(nclx) 的 full_range_flag（QuickTime / 达芬奇读这里）
  const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
  const VISUAL_ENTRIES = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01'];

  // RBSP 去防竞争字节：00 00 03 → 00 00
  function rbspUnescape(nal) {
    const out = new Uint8Array(nal.length);
    let n = 0;
    for (let i = 0; i < nal.length; i++) {
      if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
        out[n++] = 0; out[n++] = 0; i += 2;
        continue;
      }
      out[n++] = nal[i];
    }
    return out.subarray(0, n);
  }
  // 重新插入防竞争字节：出现 00 00 且后一字节 ≤ 3 时插 0x03
  function rbspEscape(rbsp) {
    const out = new Uint8Array(rbsp.length + (rbsp.length >> 1) + 16);
    let n = 0, zeros = 0;
    for (let i = 0; i < rbsp.length; i++) {
      const v = rbsp[i];
      if (zeros >= 2 && v <= 3) { out[n++] = 3; zeros = 0; }
      out[n++] = v;
      zeros = v === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, n);
  }
  // 按 SPS 语法走到 VUI 的 video_full_range_flag，返回它的位偏移与当前值。
  // 任一步与预期不符（无 VUI / 无 video_signal_type / 越界）返回 null —— 宁可不动。
  function spsFullRangeBit(rbsp) {
    let bit = 0, over = false;
    const u = n => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        if ((bit >> 3) >= rbsp.length) { over = true; return 0; }
        v = (v << 1) | ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1);
        bit++;
      }
      return v;
    };
    const ue = () => { let z = 0; while (!over && u(1) === 0) { if (++z > 31) break; } const v = z && !over ? u(z) : 0; return (1 << z) - 1 + v; };
    const se = () => { const v = ue(); return (v & 1) ? (v + 1) >> 1 : -(v >> 1); };
    const profile = u(8); u(8); u(8); ue();
    let chromaFormat = 1;
    if (HIGH_PROFILES.indexOf(profile) >= 0) {
      chromaFormat = ue();
      if (chromaFormat === 3) u(1);
      ue(); ue(); u(1);                       // bit_depth_luma/chroma_minus8 + qpprime
      if (u(1)) {                             // seq_scaling_matrix_present_flag
        const n = chromaFormat !== 3 ? 8 : 12;
        for (let j = 0; j < n; j++) {
          if (!u(1)) continue;
          const size = j < 6 ? 16 : 64;
          let last = 8, next = 8;
          for (let k = 0; k < size; k++) {
            if (next !== 0) next = (last + se() + 256) % 256;
            if (next !== 0) last = next;
          }
        }
      }
    }
    ue();                                     // log2_max_frame_num_minus4
    const pocType = ue();
    if (pocType === 0) ue();
    else if (pocType === 1) { u(1); se(); se(); const n = ue(); for (let j = 0; j < n; j++) se(); }
    ue();                                     // max_num_ref_frames
    u(1);                                     // gaps_in_frame_num_value_allowed_flag
    ue(); ue();                               // pic_width/height_in_mbs_minus1
    if (!u(1)) u(1);                          // frame_mbs_only_flag → mb_adaptive_frame_field_flag
    u(1);                                     // direct_8x8_inference_flag
    if (u(1)) { ue(); ue(); ue(); ue(); }     // frame_cropping
    if (over || !u(1)) return null;           // vui_parameters_present_flag
    if (u(1)) { const idc = u(8); if (idc === 255) { u(16); u(16); } }   // aspect_ratio_info
    if (u(1)) u(1);                           // overscan_info_present_flag
    if (over || !u(1)) return null;           // video_signal_type_present_flag
    u(3);                                     // video_format
    const flagBit = bit, value = u(1);
    return over ? null : { bit: flagBit, value };
  }
  // 单个 SPS NAL（含 NAL 头）→ limited；已 limited 或无法解析时返回 null
  function spsToLimited(nal) {
    if (!nal || nal.length < 8) return null;
    const rbsp = rbspUnescape(nal.subarray(1));
    const f = spsFullRangeBit(rbsp);
    if (!f || f.value === 0) return null;
    const patched = rbsp.slice();
    patched[f.bit >> 3] &= ~(0x80 >> (f.bit & 7));
    const body = rbspEscape(patched);
    const out = new Uint8Array(body.length + 1);
    out[0] = nal[0];
    out.set(body, 1);
    return out;
  }
  function wrU16(arr, p, v) { arr[p] = (v >> 8) & 255; arr[p + 1] = v & 255; }
  function u16bytes(v) { const a = new Uint8Array(2); wrU16(a, 0, v); return a; }

  // avcC：把其中每个 SPS 改成 limited
  function avcCToLimited(payload) {
    if (payload.length < 7 || payload[0] !== 1) return { data: payload, changed: 0 };
    let p = 5;
    const nSps = payload[p++] & 0x1F;
    const parts = [];
    let changed = 0;
    for (let i = 0; i < nSps; i++) {
      if (p + 2 > payload.length) return { data: payload, changed: 0 };
      const len = rdU16(payload, p); p += 2;
      if (p + len > payload.length) return { data: payload, changed: 0 };
      const nal = payload.subarray(p, p + len); p += len;
      const fix = spsToLimited(nal);
      if (fix) { changed++; parts.push(u16bytes(fix.length), fix); }
      else parts.push(u16bytes(len), nal);
    }
    if (!changed) return { data: payload, changed: 0 };
    parts.push(payload.subarray(p));          // numOfPictureParameterSets + PPS 等原样保留
    return { data: concat([payload.subarray(0, 6), ...parts]), changed };
  }
  // colr(nclx)：full_range_flag 1→0
  function colrToLimited(payload) {
    if (payload.length < 11 || ascii(payload, 0, 4) !== 'nclx') return { data: payload, changed: 0 };
    const off = 4 + 6;                        // primaries(2) transfer(2) matrix(2)
    if (!(payload[off] & 0x80)) return { data: payload, changed: 0 };
    const out = payload.slice();
    out[off] &= 0x7F;
    return { data: out, changed: 1 };
  }
  // 视频样本描述（avc1 等）：改 SPS VUI 与 colr。结构不符预期时整体不动。
  function entryToLimited(entry, type) {
    if (VISUAL_ENTRIES.indexOf(type) < 0 || entry.length < 86) return { data: entry, changed: 0 };
    const kids = [];
    let p = 86, changed = 0;                  // VisualSampleEntry 固定 86 字节头（含 box 头）
    while (p + 8 <= entry.length) {
      const size = rdU32(entry, p);
      if (size < 8 || p + size > entry.length) return { data: entry, changed: 0 };
      const ktype = ascii(entry, p + 4, 4);
      const kid = entry.subarray(p, p + size);
      if (ktype === 'avcC') {
        const r = avcCToLimited(kid.subarray(8));
        if (r.changed) { kids.push(box('avcC', r.data)); changed++; } else kids.push(kid);
      } else if (ktype === 'colr') {
        const r = colrToLimited(kid.subarray(8));
        if (r.changed) { kids.push(box('colr', r.data)); changed++; } else kids.push(kid);
      } else kids.push(kid);
      p += size;
    }
    if (p !== entry.length) return { data: entry, changed: 0 };
    if (!changed) return { data: entry, changed: 0 };
    return { data: box(type, concat([entry.subarray(8, 86), ...kids])), changed };
  }
  function stsdToLimited(stsd) {
    if (!stsd || stsd.length < 16) return { data: stsd, changed: 0 };
    const count = rdU32(stsd, 12);
    const entries = [];
    let p = 16, changed = 0;
    for (let i = 0; i < count; i++) {
      if (p + 8 > stsd.length) return { data: stsd, changed: 0 };
      const size = rdU32(stsd, p);
      if (size < 8 || p + size > stsd.length) return { data: stsd, changed: 0 };
      const r = entryToLimited(stsd.subarray(p, p + size), ascii(stsd, p + 4, 4));
      entries.push(r.data); changed += r.changed;
      p += size;
    }
    if (p !== stsd.length || !changed) return { data: stsd, changed: 0 };
    return { data: box('stsd', concat([stsd.subarray(8, 12), u32bytes(count), ...entries])), changed };
  }
  function u32bytes(v) { const a = new Uint8Array(4); wrU32(a, 0, v); return a; }

  // ─── moov 解析（保留原始字节，供重建）──────────
  function parseMoov(bytes, moovBox) {
    const info = { timescale: 1000, nextTrackId: 3, mvhdRaw: null, trex: [], traks: [] };
    for (const b of walkBoxes(bytes, moovBox.data, moovBox.end)) {
      if (b.type === 'mvhd') {
        info.mvhdRaw = bytes.slice(b.start, b.end);
        const v = bytes[b.data];
        info.timescale = rdU32(bytes, b.data + (v === 1 ? 20 : 12));
        info.nextTrackId = rdU32(bytes, b.data + (v === 1 ? 108 : 96));
      } else if (b.type === 'trak') {
        info.traks.push(parseTrak(bytes, b));
      } else if (b.type === 'mvex') {
        for (const t of walkBoxes(bytes, b.data, b.end)) {
          if (t.type === 'trex') {
            const d = t.data;
            info.trex.push({
              trackId: rdU32(bytes, d + 4),
              defDur: rdU32(bytes, d + 12),
              defSize: rdU32(bytes, d + 16),
              defFlags: rdU32(bytes, d + 20)
            });
          }
        }
      }
    }
    return info;
  }

  function parseTrak(bytes, trakBox) {
    const t = { id: 0, tkhdRaw: null, mdhdRaw: null, hdlrRaw: null, minfRaw: null, stsdRaw: null, edtsRaw: null, handler: '' };
    for (const b of walkBoxes(bytes, trakBox.data, trakBox.end)) {
      if (b.type === 'tkhd') {
        t.tkhdRaw = bytes.slice(b.start, b.end);
        // tkhd 有 v0/v1 两种版本：track_ID 位于 fullbox 后 8 字节（v0）或 16 字节（v1）
        t.id = rdU32(bytes, b.data + (bytes[b.data] === 1 ? 20 : 12));
      } else if (b.type === 'edts') {
        t.edtsRaw = bytes.slice(b.start, b.end);
      } else if (b.type === 'mdia') {
        for (const m of walkBoxes(bytes, b.data, b.end)) {
          if (m.type === 'mdhd') {
            t.mdhdRaw = bytes.slice(m.start, m.end);
            const v = bytes[m.data];
            t.mdhdTimescale = rdU32(bytes, m.data + (v === 1 ? 20 : 12));
          } else if (m.type === 'hdlr') {
            t.hdlrRaw = bytes.slice(m.start, m.end);
            t.handler = ascii(bytes, m.data + 8, 4);
          } else if (m.type === 'minf') {
            // 保留 minf 中除 stbl 外的 box（vmhd/smhd/dinf），stbl 重建
            const parts = [];
            let stblRaw = null;
            for (const s of walkBoxes(bytes, m.data, m.end)) {
              if (s.type === 'stbl') {
                for (const sb of walkBoxes(bytes, s.data, s.end)) {
                  if (sb.type === 'stsd') stblRaw = bytes.slice(sb.start, sb.end);
                }
              } else {
                parts.push(bytes.slice(s.start, s.end));
              }
            }
            t.minfRaw = parts;
            t.stsdRaw = stblRaw;
          }
        }
      }
    }
    return t;
  }

  // ─── 主流程：fMP4 → classic MP4 ──────────────
  // info（可选）：调用方传入一个对象，用于回传本次改写的色彩标签情况（排障用）
  function remuxToClassic(input, info) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const len = bytes.length;

    // 1. 顶层 box 扫描：ftyp / moov / moof / mdat
    let ftypRaw = null, moovBox = null;
    const moofs = [];
    for (const b of walkBoxes(bytes, 0, len)) {
      if (b.type === 'ftyp') ftypRaw = bytes.slice(b.start, b.end);
      else if (b.type === 'moov') moovBox = b;
      else if (b.type === 'moof') moofs.push(b);
    }
    if (!ftypRaw) throw new Error('remux: missing ftyp');
    if (!moovBox) throw new Error('remux: missing moov');
    if (!moofs.length) throw new Error('remux: no moof (not fragmented?)');

    const moov = parseMoov(bytes, moovBox);
    const trexById = new Map(moov.trex.map(x => [x.trackId, x]));

    // 2. 解析所有 moof → 每轨样本 { offset, size, duration, isSync, cts }
    const samplesByTrack = new Map();
    const lastDataEnd = new Map();
    for (const m of moofs) {
      for (const traf of walkBoxes(bytes, m.data, m.end)) {
        if (traf.type !== 'traf') continue;
        let tfhd = null, trun = null;
        for (const tb of walkBoxes(bytes, traf.data, traf.end)) {
          if (tb.type === 'tfhd') tfhd = parseTfhd(bytes, tb);
          else if (tb.type === 'trun') trun = parseTrun(bytes, tb);
        }
        if (!tfhd || !trun) continue;
        const trex = trexById.get(tfhd.trackId);
        let list = samplesByTrack.get(tfhd.trackId);
        if (!list) { list = []; samplesByTrack.set(tfhd.trackId, list); }
        // 样本数据基准偏移：base-data-offset > default-base-is-moof > 前一片段数据末尾
        let base;
        if (tfhd.baseDataOffset != null) base = tfhd.baseDataOffset;
        else if (tfhd.defaultBaseIsMoof) base = m.start;
        else base = lastDataEnd.get(tfhd.trackId) || 0;
        let off = trun.dataOffset != null ? base + trun.dataOffset : base;
        for (let i = 0; i < trun.count; i++) {
          const size = trun.sizes != null ? trun.sizes[i]
            : (tfhd.defaultSampleSize != null ? tfhd.defaultSampleSize : (trex ? trex.defSize : 0));
          const dur = trun.durations != null ? trun.durations[i]
            : (tfhd.defaultSampleDuration != null ? tfhd.defaultSampleDuration : (trex ? trex.defDur : 0));
          let flags = trun.sampleFlags != null ? trun.sampleFlags[i]
            : (tfhd.defaultSampleFlags != null ? tfhd.defaultSampleFlags : (trex ? trex.defFlags : 0));
          if (i === 0 && trun.firstSampleFlags != null) flags = trun.firstSampleFlags;
          list.push({
            offset: off,
            size,
            duration: dur,
            isSync: !(flags & 0x10000),
            cts: trun.cts != null ? trun.cts[i] : 0
          });
          off += size;
        }
        lastDataEnd.set(tfhd.trackId, off);
      }
    }
    if (!samplesByTrack.size) throw new Error('remux: no samples');

    // 3. 布局：ftyp + mdat(header + 样本数据) + moov
    const all = [];
    for (const [trackId, list] of samplesByTrack) {
      for (const s of list) all.push({ trackId, s });
    }
    all.sort((a, b) => a.s.offset - b.s.offset); // 保持录制交错顺序
    let totalData = 0;
    for (const e of all) totalData += e.s.size;
    const mdatHeader = (totalData + 8) > 0xFFFFFFFF ? 16 : 8;
    let cur = ftypRaw.length + mdatHeader;
    for (const e of all) { e.outOffset = cur; cur += e.s.size; }

    // 4. 重建 moov
    const movieTs = moov.timescale || 1000;
    let maxMovieDur = 0;
    let colorFix = 0;
    const trakBytes = [];
    for (const t of moov.traks) {
      const list = samplesByTrack.get(t.id) || [];
      if (!list.length || !t.stsdRaw || !t.mdhdRaw) continue;
      const mediaDur = list.reduce((a, s) => a + (s.duration || 0), 0);
      const movieDur = Math.round(mediaDur * movieTs / (t.mdhdTimescale || 1));
      if (movieDur > maxMovieDur) maxMovieDur = movieDur;

      // tkhd / mdhd：保留原始字节，仅改写 duration 字段
      const tkhd = t.tkhdRaw.slice();
      const tkhdV = tkhd[8];
      wrU32(tkhd, 8 + (tkhdV === 1 ? 28 : 20), movieDur);
      const mdhd = t.mdhdRaw.slice();
      const mdhdV = mdhd[8];
      wrU32(mdhd, 8 + (mdhdV === 1 ? 24 : 16), Math.min(mediaDur, 0xFFFFFFFF));

      // stbl 表（stsd 先把色彩范围标签改成 limited，与录制端的 limited 画面配套）
      const stsdFix = stsdToLimited(t.stsdRaw);
      if (stsdFix.changed) colorFix++;
      const stts = buildStts(list);
      const stblParts = [stsdFix.data];
      stblParts.push(stts);
      const ctts = buildCtts(list);
      if (ctts) stblParts.push(ctts);
      const stss = buildStss(list);
      if (stss) stblParts.push(stss);
      stblParts.push(buildStsc(list.length));
      stblParts.push(buildStsz(list));
      stblParts.push(buildStco(all, t.id));

      const stbl = box('stbl', concat(stblParts));
      const minf = box('minf', concat([...t.minfRaw, stbl]));
      const mdia = box('mdia', concat([mdhd, t.hdlrRaw, minf]));
      const trak = box('trak', concat([tkhd, t.edtsRaw, mdia]));
      trakBytes.push(trak);
    }
    if (!trakBytes.length) throw new Error('remux: no usable tracks (traks=' + moov.traks.length + ', sampleTracks=' + samplesByTrack.size + ')');

    // mvhd：保留原始字节，改写 duration
    const mvhd = moov.mvhdRaw.slice();
    const mvhdV = mvhd[8];
    wrU32(mvhd, 8 + (mvhdV === 1 ? 24 : 16), Math.min(maxMovieDur, 0xFFFFFFFF));
    const moovOut = box('moov', concat([mvhd, ...trakBytes]));

    // 5. 写输出
    const mdatSize = mdatHeader + totalData;
    const out = new Uint8Array(ftypRaw.length + mdatSize + moovOut.length);
    let p = 0;
    out.set(ftypRaw, p); p += ftypRaw.length;
    if (mdatHeader === 16) {
      wrU32(out, p, 1); p += 4;
      for (let i = 0; i < 4; i++) out[p + i] = 'mdat'.charCodeAt(i); p += 4;
      // 64 位 size：写入高 32 位
      wrU32(out, p, Math.floor(mdatSize / 4294967296)); p += 4;
      wrU32(out, p, mdatSize >>> 0); p += 4;
    } else {
      wrU32(out, p, mdatSize); p += 4;
      for (let i = 0; i < 4; i++) out[p + i] = 'mdat'.charCodeAt(i); p += 4;
    }
    for (const e of all) {
      out.set(bytes.subarray(e.s.offset, e.s.offset + e.s.size), p);
      p += e.s.size;
    }
    out.set(moovOut, p);
    if (info) info.rangeTag = colorFix > 0 ? 'limited×' + colorFix : 'unchanged';
    return out;
  }

  // ─── stbl 表构建 ─────────────────────────────
  function concat(parts) {
    let n = 0;
    for (const x of parts) if (x) n += x.length;
    const out = new Uint8Array(n);
    let p = 0;
    for (const x of parts) { if (!x) continue; out.set(x, p); p += x.length; }
    return out;
  }

  function buildStts(list) {
    // 按 duration 游程分组
    const runs = [];
    for (const s of list) {
      const d = s.duration || 1;
      const last = runs[runs.length - 1];
      if (last && last.delta === d) last.count++;
      else runs.push({ count: 1, delta: d });
    }
    const out = new Uint8Array(8 + 8 * runs.length);
    wrU32(out, 0, 0);            // fullbox version/flags
    wrU32(out, 4, runs.length);
    runs.forEach((r, i) => { wrU32(out, 8 + i * 8, r.count); wrU32(out, 12 + i * 8, r.delta); });
    return box('stts', out);
  }

  function buildCtts(list) {
    const hasCts = list.some(s => s.cts !== 0);
    if (!hasCts) return null;
    const neg = list.some(s => s.cts < 0);
    const runs = [];
    for (const s of list) {
      const v = s.cts;
      const last = runs[runs.length - 1];
      if (last && last.offset === v) last.count++;
      else runs.push({ count: 1, offset: v });
    }
    const out = new Uint8Array(8 + 8 * runs.length);
    wrU32(out, 0, neg ? 1 : 0);
    wrU32(out, 4, runs.length);
    runs.forEach((r, i) => { wrU32(out, 8 + i * 8, r.count); wrU32(out, 12 + i * 8, r.offset >>> 0); });
    return box('ctts', out);
  }

  function buildStss(list) {
    const syncNums = [];
    list.forEach((s, i) => { if (s.isSync) syncNums.push(i + 1); });
    if (syncNums.length === list.length) return null; // 全部关键帧可省略
    const out = new Uint8Array(8 + 4 * syncNums.length);
    wrU32(out, 0, 0);
    wrU32(out, 4, syncNums.length);
    syncNums.forEach((n, i) => wrU32(out, 8 + i * 4, n));
    return box('stss', out);
  }

  function buildStsc(count) {
    const out = new Uint8Array(8 + 12);
    wrU32(out, 0, 0);
    wrU32(out, 4, 1);
    wrU32(out, 8, 1);  // first_chunk
    wrU32(out, 12, 1); // samples_per_chunk（每样本一个 chunk，与 stco 一一对应）
    wrU32(out, 16, 1); // sample_description_index
    return box('stsc', out);
  }

  function buildStsz(list) {
    const out = new Uint8Array(12 + 4 * list.length);
    wrU32(out, 0, 0);
    wrU32(out, 4, 0);                       // sample_size = 0（变长）
    wrU32(out, 8, list.length);
    list.forEach((s, i) => wrU32(out, 12 + i * 4, s.size));
    return box('stsz', out);
  }

  function buildStco(all, trackId) {
    const offs = all.filter(e => e.trackId === trackId).map(e => e.outOffset);
    const big = offs.some(o => o > 0xFFFFFFFF);
    const out = new Uint8Array(8 + (big ? 8 : 4) * offs.length);
    wrU32(out, 0, 0);
    wrU32(out, 4, offs.length);
    offs.forEach((o, i) => {
      if (big) { wrU32(out, 8 + i * 8, Math.floor(o / 4294967296)); wrU32(out, 12 + i * 8, o >>> 0); }
      else wrU32(out, 8 + i * 4, o);
    });
    return box(big ? 'co64' : 'stco', out);
  }

  function box(type, payload) {
    const out = new Uint8Array(8 + payload.length);
    wrU32(out, 0, 8 + payload.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
  }

  // _test：仅供开发自检脚本调用（Material/qc-dev/check-color-fix.js），扩展运行时不使用
  return {
    remuxToClassic,
    _test: { stsdToLimited, avcCToLimited, spsToLimited, spsFullRangeBit, rbspUnescape, rbspEscape }
  };
});
