(() => {
  const nav = document.querySelector('nav');
  const links = nav?.querySelector('.nav-links');
  if (nav && links) {
    const toggle = document.createElement('button');
    toggle.className = 'nav-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Open navigation menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '☰';
    nav.insertBefore(toggle, links);

    const syncNavHeight = () => {
      document.documentElement.style.setProperty('--site-nav-height', `${nav.getBoundingClientRect().height}px`);
    };
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
      toggle.textContent = open ? '×' : '☰';
      requestAnimationFrame(syncNavHeight);
    });
    links.addEventListener('click', event => {
      if (event.target.closest('a') && links.classList.contains('is-open')) {
        links.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open navigation menu');
        toggle.textContent = '☰';
        requestAnimationFrame(syncNavHeight);
      }
    });
    new ResizeObserver(syncNavHeight).observe(nav);
    syncNavHeight();
  }

  document.querySelectorAll('a[target="_blank"]').forEach(link => {
    link.rel = 'noopener noreferrer';
  });
})();
