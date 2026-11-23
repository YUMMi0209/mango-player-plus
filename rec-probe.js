/* 开发用：录制编码器安全探测（跑在扩展源的隐藏 iframe 里 = 独立渲染进程）
   目的：本机 MediaRecorder 的 H.264 可能「isTypeSupported 说支持、start() 之后把渲染进程搞崩」
        （STATUS_BREAKPOINT），或者静默零字节。把探测放在跨源的扩展页面里，崩了也只崩这个 iframe。
   入参（hash）：#w=1920&h=1080&c=avc1.640028
   回传：parent.postMessage({ __mgpProbe: 1, ok: true|false, bytes, why, mime }) */
(() => {
  const send = msg => { try { parent.postMessage(Object.assign({ __mgpProbe: 1 }, msg), '*'); } catch (e) { } };
  const fail = why => send({ ok: false, why: String(why || '') });
  window.addEventListener('error', e => fail('onerror:' + (e.message || '')));
  try {
    const q = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    const W = Math.max(96, Math.min(4096, parseInt(q.get('w') || '1280', 10) || 1280));
    const H = Math.max(96, Math.min(4096, parseInt(q.get('h') || '720', 10) || 720));
    const codec = String(q.get('c') || 'avc1.4D401F');
    if (typeof MediaRecorder === 'undefined') { fail('no-mediarecorder'); return; }
    const mime = 'video/mp4;codecs=' + codec;
    if (!MediaRecorder.isTypeSupported(mime)) { fail('unsupported'); return; }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { alpha: false });
    let n = 0;
    const paint = () => {
      ctx.fillStyle = 'hsl(' + ((n * 11) % 360) + ',70%,45%)';
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 24; i++) {
        ctx.fillStyle = 'hsl(' + ((n * 7 + i * 13) % 360) + ',80%,60%)';
        ctx.fillRect((n * 17 + i * 53) % Math.max(1, W - 80), (n * 23 + i * 41) % Math.max(1, H - 60), 80, 60);
      }
      n++;
    };
    paint();
    if (typeof c.captureStream !== 'function') { fail('no-capturestream'); return; }
    const st = c.captureStream();
    const rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: W * H >= 1280 * 720 ? 8000000 : 2000000 });
    let bytes = 0, chunks = 0;
    rec.ondataavailable = e => { if (e.data && e.data.size) { bytes += e.data.size; chunks++; } };
    rec.onerror = () => fail('rec-error');
    rec.onstop = () => send({ ok: bytes > 2000, bytes, w: W, h: H, why: bytes > 2000 ? '' : 'no-data', mime: rec.mimeType || mime });
    rec.start(200);
    let ticks = 0;
    const t = setInterval(() => {
      paint();
      if (++ticks >= 18) { clearInterval(t); try { rec.stop(); } catch (e) { } }
    }, 55);
  } catch (e) { fail(e && e.message || e); }
})();
