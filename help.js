// 教程页脚本（扩展页面禁止内联脚本，所以单独成文件）

// 跟随插件设置中的亮色 / 暗色主题
try {
  chrome.storage.local.get('mpp_settings').then(({ mpp_settings }) => {
    if (mpp_settings && mpp_settings.theme === 'light') document.documentElement.dataset.theme = 'light';
  }).catch(() => { });
} catch (e) { }

// 常见问题：按关键词筛选
(function () {
  const q = document.getElementById('faq-q');
  const empty = document.getElementById('faq-empty');
  if (!q) return;
  const items = [...document.querySelectorAll('#faq details')];
  q.addEventListener('input', () => {
    const k = q.value.trim().toLowerCase();
    let shown = 0;
    items.forEach(d => {
      const hit = !k || (d.textContent || '').toLowerCase().includes(k);
      d.hidden = !hit;
      if (hit) shown++;
      if (k && hit) d.open = true; else if (!k) d.open = false;
    });
    if (empty) empty.hidden = shown > 0;
  });
})();

// 顶部导航：高亮当前所在章节
(function () {
  const links = [...document.querySelectorAll('.nav a.pill')];
  const map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const secs = [...document.querySelectorAll('section[id]')];
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      links.forEach(a => a.classList.remove('on'));
      const a = map.get(en.target.id);
      if (!a) return;
      a.classList.add('on');
      // 只横向滚动导航条本身，让当前项可见（不能用 scrollIntoView：它会连带滚动页面，与用户滚动互相打架）
      const bar = a.parentElement;
      const l = a.offsetLeft, r = l + a.offsetWidth;
      if (l < bar.scrollLeft) bar.scrollLeft = l - 12;
      else if (r > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = r - bar.clientWidth + 12;
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  secs.forEach(s => io.observe(s));
})();
