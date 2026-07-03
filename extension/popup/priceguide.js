  // Copy icon SVGs
  var COPY_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  // Add copy buttons to all SKU pills (skip placeholder "Specific" ones)
  document.querySelectorAll('.sku').forEach(function(skuEl) {
    var text = skuEl.textContent.trim();
    if (text === 'Specific' || text === '' || text.length < 3) return;

    var wrap = document.createElement('span');
    wrap.className = 'sku-wrap';
    var parent = skuEl.parentNode;
    parent.insertBefore(wrap, skuEl);
    wrap.appendChild(skuEl);

    var btn = document.createElement('button');
    btn.className = 'btn-copy-sku';
    btn.title = 'Copy ' + text;
    btn.innerHTML = COPY_SVG;
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      navigator.clipboard.writeText(text).then(function() {
        btn.classList.add('copied');
        btn.innerHTML = CHECK_SVG;
        setTimeout(function() {
          btn.classList.remove('copied');
          btn.innerHTML = COPY_SVG;
        }, 1500);
      });
    });
    wrap.appendChild(btn);
  });

  const navLinks = document.querySelectorAll('.nav-link');
  const mainEl = document.getElementById('main');
  function updateActive() {
    const sections = document.querySelectorAll('[id]');
    let current = '';
    sections.forEach(s => { if (s.getBoundingClientRect().top <= 60) current = s.id; });
    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href') === '#' + current) link.classList.add('active');
    });
  }
  mainEl.addEventListener('scroll', updateActive);
  navLinks.forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const target = document.querySelector(link.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });
