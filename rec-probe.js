/* 开发用：录制编码器安全探测（跑在扩展源的隐藏 iframe 里 = 独立渲染进程）
   目的：有的机器 MediaRecorder.isTypeSupported('video/mp4;codecs=avc1…') 返回 true，
        但一编码就让 Chromium CHECK 崩溃（页面 STATUS_BREAKPOINT）。
        把探测放在跨源的扩展页面里，即使它崩了，也只会崩掉这个 iframe 的进程，页面不受影响。
   父页面用法：iframe.postMessage 不需要；本脚本通过 parent.postMessage 回结果
        { __mgpProbe: 1, ok: true|false, why: '', mime: '' } */
(() => {
  const send = msg => { try { parent.postMessage(Object.assign({ __mgpProbe: 1 }, msg), '*'); } catch (e) { } };
  const fail = why => send({ ok: false, why: String(why || '') });
  window.addEventListener('error', e => fail('onerror:' + (e.message || '')));
  try {
    if (typeof MediaRecorder === 'undefined') { fail('no-mediarecorder'); return; }
    const mime = 'video/mp4;codecs=avc1.42E01E';
    if (!MediaRecorder.isTypeSupported(mime)) { fail('unsupported'); return; }
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    const ctx = c.getContext('2d');
    const paint = n => { ctx.fillStyle = (n % 2) ? '#f00' : '#0f0'; ctx.fillRect(0, 0, 96, 96); };
    paint(0);
    if (typeof c.captureStream !== 'function') { fail('no-capturestream'); return; }
    const st = c.captureStream();
    const rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 1000000 });
    let chunks = 0;
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks++; };
    rec.onerror = () => fail('rec-error');
    rec.onstop = () => send({ ok: chunks > 0, why: chunks > 0 ? '' : 'no-data', mime: rec.mimeType || '' });
    rec.start(100);
    let n = 1;
    const t = setInterval(() => {
      paint(n++);
      if (n > 12) { clearInterval(t); try { rec.stop(); } catch (e) { } }
    }, 60);
  } catch (e) { fail(e && e.message || e); }
})();
