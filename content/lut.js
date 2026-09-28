/* 芒着拉片 · 颜色查找表（MAIN world）
   把 .cube（3D LUT）应用到视频画面上：在视频上方叠一层 WebGL 画布，逐帧把视频当作纹理，
   经 3D 查找表采样后绘制出来（GPU 完成，不占用主线程像素搬运）。
   - 只在启用时绘制；关闭时移除画布，画面回到原始视频
   - 截图 / 录制仍取原始画面（LUT 只是「看」的辅助，导出交给剪辑软件）
   - LUT 数据由隔离世界的桥（content/bridge.js）从扩展内 luts/*.cube 取回后送来
   对外接口：window.MPGLut = { CATALOG, get/set, apply, clear, isOn, parseCube, _debug } */
'use strict';
(() => {
  // LUT 目录：面板里选的 id ↔ 扩展内文件。文件为相机官方 Look LUT（原文件名见 file 字段）
  const CATALOG = {
    slog3: { id: 'slog3', label: 'SLog3', desc: 'SLog3 / SGamut3.Cine → LC-709 TypeA（Sony）', file: 'luts/slog3-sgamut3cine-to-lc709-typea.cube' },
    clog3: { id: 'clog3', label: 'CLog3', desc: 'Canon Log 3 / Cinema Gamut → Canon 709', file: 'luts/clog3-cinema-gamut-to-canon709.cube' },
    slog2: { id: 'slog2', label: 'SLog2', desc: 'SLog2 / SGamut → LC-709 TypeA（Sony）', file: 'luts/slog2-sgamut-to-lc709-typea.cube' },
    clog2: { id: 'clog2', label: 'CLog2', desc: 'Canon Log 2 / Cinema Gamut → Canon 709', file: 'luts/clog2-cinema-gamut-to-canon709.cube' }
  };
  const cache = {};          // id → { size, data: Uint8Array }（解析后的 LUT）
  let on = false;            // 是否已应用（默认不应用）
  let curId = '';            // 当前应用的 LUT id

  // ── 解析 .cube（3D）：返回 { size, data }，data 为 RGB 顺序、R 变化最快 ──
  function parseCube(text) {
    if (!text) return null;
    const lines = String(text).split(/\r?\n/);
    let size = 0;
    const vals = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line[0] === '#') continue;
      const m = /^LUT_3D_SIZE\s+(\d+)/i.exec(line);
      if (m) { size = parseInt(m[1], 10); continue; }
      if (/^(TITLE|DOMAIN_MIN|DOMAIN_MAX|LUT_1D_SIZE)/i.test(line)) continue;
      // 数据行：三个 0~1 浮点
      const p = line.split(/\s+/);
      if (p.length < 3) continue;
      const r = parseFloat(p[0]), g = parseFloat(p[1]), b = parseFloat(p[2]);
      if (!isFinite(r) || !isFinite(g) || !isFinite(b)) continue;
      vals.push(r, g, b);
    }
    if (!size || size < 2 || vals.length < size * size * size * 3) return null;
    const data = new Uint8Array(size * size * size * 4);   // 用 RGBA 便于上传
    for (let i = 0, n = size * size * size; i < n; i++) {
      const r = Math.max(0, Math.min(1, vals[i * 3]));
      const g = Math.max(0, Math.min(1, vals[i * 3 + 1]));
      const b = Math.max(0, Math.min(1, vals[i * 3 + 2]));
      data[i * 4] = Math.round(r * 255);
      data[i * 4 + 1] = Math.round(g * 255);
      data[i * 4 + 2] = Math.round(b * 255);
      data[i * 4 + 3] = 255;
    }
    return { size, data };
  }

  // ── WebGL2：3D 纹理 + 全屏四边形 ──
  let cv = null, gl = null, prog = null, texLut = null, texVid = null, quad = null;
  let lutSize = 0, frames = 0, lastError = '';
  let layoutInfo = null;   // 最近一次算出的摆放信息（诊断用：宽高与视频比例是否一致）
  // WebGL2 的 GLSL ES 3.00：必须带 #version 300 es 才能用 sampler3D / texture()
  const VS = '#version 300 es\nin vec2 p;out vec2 v;void main(){v=vec2(p.x*0.5+0.5,0.5-p.y*0.5);gl_Position=vec4(p,0.0,1.0);}';
  // 3D 纹理采样要把 [0,1] 映射到「纹素中心」：uvw = (c*(N-1)+0.5)/N，否则线性插值会整体偏暗
  // （N=2 时最夸张：0.18 → 0、0.31 → 0.13；N=33 也有约 1.5% 的系统偏移）
  // uvScale/uvOff：object-fit:cover 时画布铺满元素框，靠它裁出可见的那块源画面
  const FS = '#version 300 es\nprecision mediump float;in vec2 v;uniform sampler2D vid;uniform mediump sampler3D lut;' +
    'uniform float lutN;uniform vec2 uvScale;uniform vec2 uvOff;out vec4 o;' +
    'void main(){vec3 c=clamp(texture(vid,v*uvScale+uvOff).rgb,0.0,1.0);' +
    'o=vec4(texture(lut,(c*(lutN-1.0)+0.5)/lutN).rgb,1.0);}';

  function compile(vsSrc, fsSrc) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) { lastError = gl.getShaderInfoLog(fs) || 'shader'; return null; }
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { lastError = gl.getProgramInfoLog(p) || 'link'; return null; }
    return p;
  }
  function ensureGL(video) {
    if (gl && cv && cv.isConnected) return true;
    cv = document.createElement('canvas');
    cv.className = 'mgp-lut-canvas';
    // z-index 与网页全屏时的视频相同（2147483646）：靠 DOM 顺序压在视频之上，
    // 又低于控制栏（2147483647）；尺寸与位置由 layout() 按视频的 object-fit 精确摆放
    cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2147483646;';
    gl = cv.getContext('webgl2', { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, desynchronized: true });
    if (!gl) { lastError = 'no-webgl2'; cv = null; return false; }
    prog = compile(VS, FS);
    if (!prog) { gl = null; cv = null; return false; }
    gl.useProgram(prog);
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    texVid = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texVid);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    texLut = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, texLut);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(prog, 'vid'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'lut'), 1);
    gl.uniform2f(gl.getUniformLocation(prog, 'uvScale'), 1, 1);
    gl.uniform2f(gl.getUniformLocation(prog, 'uvOff'), 0, 0);
    // 画布挂在视频元素**之后**：站点自己的控件在视频之后，这样它们仍在画布之上；
    // z-index 与全屏时的视频相同（都 2147483646），靠 DOM 顺序压在视频之上、控制栏（2147483647）之下
    const host = video.parentElement;
    if (!host) { gl = null; cv = null; return false; }
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    if (video.nextSibling) host.insertBefore(cv, video.nextSibling); else host.appendChild(cv);
    return true;
  }
  function uploadLut(lut) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, texLut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
    lutSize = lut.size;
    const loc = gl.getUniformLocation(prog, 'lutN');
    if (loc) gl.uniform1f(loc, lut.size);
  }
  // object-position 解析（支持 关键字 / 百分比 / px），返回 [x, y] 的像素偏移
  function parsePos(pos, slackX, slackY) {
    const terms = String(pos || '50% 50%').trim().split(/\s+/);
    const ax = (t, slack) => {
      if (!t) return 0.5;
      if (t === 'left' || t === 'top') return 0;
      if (t === 'right' || t === 'bottom') return 1;
      if (t === 'center') return 0.5;
      if (/%$/.test(t)) return parseFloat(t) / 100;
      const px = parseFloat(t);
      return (isFinite(px) && slack) ? px / slack : 0.5;
    };
    const fx = ax(terms[0], slackX);
    const fy = ax(terms[1] !== undefined ? terms[1] : terms[0], slackY);
    return [fx * slackX, fy * slackY];
  }
  // 摆放画布：**严格照视频元素自己的 object-fit / object-position**，保证比例不变形。
  // 关键场景：网页全屏时插件把视频设为 object-fit:contain（100vw×100vh），画面上下（或左右）
  // 有黑边；画布必须只铺在「画面区域」上，铺满整个元素框就会把画面拉伸变形。
  function layout(video) {
    if (!cv || !video) return null;
    const host = video.parentElement;
    if (!host) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    const er = video.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const bw = er.width, bh = er.height;
    if (!bw || !bh || !vw || !vh) return null;
    const cs = getComputedStyle(video);
    const fit = cs.objectFit || 'fill';
    let cw = bw, ch = bh, uvs = [1, 1], uvo = [0, 0];
    if (fit === 'contain' || fit === 'scale-down' || fit === 'none') {
      let s = Math.min(bw / vw, bh / vh);
      if (fit === 'none') s = 1;
      else if (fit === 'scale-down') s = Math.min(s, 1);
      cw = vw * s; ch = vh * s;
    } else if (fit === 'cover') {
      const s = Math.max(bw / vw, bh / vh);
      const shownW = bw / s, shownH = bh / s;   // 元素框里实际可见的源像素区域
      uvs = [shownW / vw, shownH / vh];
      uvo = [(1 - uvs[0]) / 2, (1 - uvs[1]) / 2];
    }
    const [offX, offY] = parsePos(cs.objectPosition, bw - cw, bh - ch);
    const left = (er.left - hr.left) + offX;
    const top = (er.top - hr.top) + offY;
    cv.style.left = Math.round(left) + 'px';
    cv.style.top = Math.round(top) + 'px';
    cv.style.width = Math.round(cw) + 'px';
    cv.style.height = Math.round(ch) + 'px';
    // 绘制缓冲：跟随内容区域尺寸（按设备像素比，保证与视频元素同样的清晰度）
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.max(2, Math.round(cw * dpr)), ph = Math.max(2, Math.round(ch * dpr));
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    gl.uniform2f(gl.getUniformLocation(prog, 'uvScale'), uvs[0], uvs[1]);
    gl.uniform2f(gl.getUniformLocation(prog, 'uvOff'), uvo[0], uvo[1]);
    layoutInfo = { fit: fit, boxW: Math.round(bw), boxH: Math.round(bh), cssW: Math.round(cw), cssH: Math.round(ch),
      bufW: pw, bufH: ph, videoW: vw, videoH: vh,
      aspect: cw && ch ? Math.round((cw / ch) * 1000) / 1000 : 0,
      videoAspect: Math.round((vw / vh) * 1000) / 1000 };
    return layoutInfo;
  }
  function draw(video) {
    if (!gl || !cv) return;
    const li = layout(video);
    if (!li) return;
    gl.viewport(0, 0, cv.width, cv.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texVid);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (e) { return; }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    frames++;
  }
  let rafId = 0;
  function loop(video) {
    if (!on) return;
    draw(video);
    // 画面每来一帧就重绘一次（暂停时也保留最后一帧，不再空转）
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => loop(video));
    } else {
      rafId = requestAnimationFrame(() => loop(video));
    }
  }
  function startLoop(video) {
    stopLoop();
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => loop(video));
    } else {
      rafId = requestAnimationFrame(() => loop(video));
    }
  }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  // ── 对外接口 ──
  function apply(id, cubeText, video) {
    // 显式传入的文本优先（调用方最清楚要哪份），没传才用缓存
    const lut = (cubeText ? parseCube(cubeText) : null) || cache[id];
    if (!lut) { lastError = 'lut-parse'; return false; }
    if (!video || !video.videoWidth) { lastError = 'no-video'; return false; }
    if (!ensureGL(video)) return false;
    cache[id] = lut;
    uploadLut(lut);
    curId = id; on = true;
    draw(video);        // 立刻出一帧，避免开关后短暂黑屏
    startLoop(video);
    return true;
  }
  function clear() {
    on = false;
    stopLoop();
    if (cv && cv.parentElement) cv.parentElement.removeChild(cv);
    cv = null;
    if (gl) { try { gl.getExtension('WEBGL_lose_context').loseContext(); } catch (e) { } }
    gl = null; prog = null; texLut = null; texVid = null; lutSize = 0;
    return true;
  }
  // 页面换视频 / 视频容器重建后，把画布重新挂到新容器并继续绘制
  function rebind(video) {
    if (!on) return;
    if (!gl || !video || !video.videoWidth) return;
    const host = video.parentElement;
    if (!host) return;
    if (gl && cv && cv.parentElement === host) { draw(video); return; }
    if (!gl) { apply(curId, null, video); return; }
    if (cv && cv.parentElement) cv.parentElement.removeChild(cv);
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    if (video.nextSibling) host.insertBefore(cv, video.nextSibling); else host.appendChild(cv);
    draw(video);
  }
  window.MPGLut = {
    CATALOG: CATALOG,
    ids: Object.keys(CATALOG),
    name(id) { return (CATALOG[id] || {}).label || ''; },
    file(id) { return (CATALOG[id] || {}).file || ''; },
    isOn() { return on; },
    currentId() { return curId; },
    apply: apply,
    clear: clear,
    rebind: rebind,
    parseCube: parseCube,
    layoutInfo() { return layoutInfo; },
    lastError() { return lastError; },
    _debug() { return { on: on, id: curId, lutSize: lutSize, frames: frames, gl: !!gl, canvas: !!cv }; }
  };
})();
