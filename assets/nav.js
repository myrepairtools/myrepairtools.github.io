/* ===========================================================================
 * CPR myrepairtools.github.io — Shared Navigation
 * ---------------------------------------------------------------------------
 * Drop into any tool page with:
 *   <script src="assets/nav.js" data-section="admin"></script>
 * or
 *   <script src="assets/nav.js" data-section="operations"></script>
 *
 * Per-page: the script injects a top nav into <body>. Each page should
 * REMOVE its existing <header> element so they don't double up.
 *
 * To add a new tool or rename one, edit the SECTIONS config block below
 * and the change propagates to every page.
 *
 * Mobile: below 760px the tool links + section toggle collapse behind a
 * hamburger button with large tap targets.
 * ========================================================================= */
(function () {
  'use strict';

  // Skip nav entirely when this page is loaded inside an iframe
  // (e.g., embedded in RepairQ via the RQ Mods extension).
  if (window.self !== window.top) return;

  // ──────────────────────────────────────────────────────────────────────────
  // CONFIG — tools per section
  // ──────────────────────────────────────────────────────────────────────────
  const SECTIONS = {
    admin: {
      label: 'Admin',
      icon: '🔒',
      color: '#DC282E',        // CPR red
      landing: 'admin.html',
      tools: [
        { label: 'Cash Admin',            url: 'cash-admin.html' },
        { label: 'Claim Ledger',          url: 'claim-ledger.html' },
        { label: 'Commission Calculator', url: 'commission-calculator.html' },
        { label: 'Employee Records',      url: 'employee-records.html' },
        { label: 'Profit First',          url: 'profit-first.html' }
      ]
    },
    operations: {
      label: 'Operations',
      icon: '🔧',
      color: '#4FB0E3',        // CPR blue
      landing: 'operations.html',
      tools: [
        { label: 'Cash Tracker',       url: 'cash-tracker.html' },
        { label: 'Price Calculator',   url: 'price-calc-and-guide.html' },
        { label: 'Price Guide',        url: 'price-guide.html' },
        { label: 'Jerry Ding Order',   url: 'jerry-ding-order.html' },
        { label: 'PO Converter',       url: 'po-converter.html' }
      ]
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Resolve section from this script tag's data-section attribute
  // ──────────────────────────────────────────────────────────────────────────
  const scriptEl = document.currentScript ||
    (function () {
      const scripts = document.getElementsByTagName('script');
      for (let i = scripts.length - 1; i >= 0; i--) {
        if (/nav\.js(\?|$)/.test(scripts[i].src)) return scripts[i];
      }
      return null;
    })();
  const sectionKey = (scriptEl && scriptEl.dataset.section) || 'operations';
  const section = SECTIONS[sectionKey] || SECTIONS.operations;

  // Identify the current page (used to mark the active tool link)
  const currentFile = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // ──────────────────────────────────────────────────────────────────────────
  // STYLES (injected once)
  // ──────────────────────────────────────────────────────────────────────────
  const css = `
    .cpr-nav {
      position: sticky; top: 0; z-index: 100;
      background: #FFFFFF;
      border-bottom: 2px solid ${section.color};
      font-family: 'Nunito', sans-serif;
      box-shadow: 0 1px 4px rgba(45,45,59,0.06);
    }
    .cpr-nav-strip { height: 6px; background: #0F0F12; }
    .cpr-nav-inner {
      max-width: 1400px; margin: 0 auto;
      padding: 12px 24px;
      display: flex; align-items: center; gap: 20px;
    }
    .cpr-nav-brand {
      display: flex; align-items: center; gap: 12px;
      text-decoration: none; color: #2D2D3B;
      flex-shrink: 0;
    }
    .cpr-nav-brand img { height: 36px; width: auto; display: block; }

    /* menu wrapper (tools + toggle) */
    .cpr-nav-menu {
      display: flex; align-items: center; gap: 20px;
      flex: 1;
    }
    .cpr-nav-tools {
      display: flex; align-items: center; gap: 4px;
      flex: 1; flex-wrap: wrap;
    }
    .cpr-nav-tools a {
      text-decoration: none; color: #4E4E50;
      font-weight: 700; font-size: 13px;
      padding: 8px 14px; border-radius: 6px;
      transition: all 0.15s;
      letter-spacing: 0.2px;
      position: relative;
    }
    .cpr-nav-tools a:hover { background: #F3F2F2; color: #2D2D3B; }
    .cpr-nav-tools a.active { color: #2D2D3B; font-weight: 800; background: transparent; }
    .cpr-nav-tools a.active::after {
      content: '';
      position: absolute;
      left: 14px; right: 14px; bottom: 2px;
      height: 2px; border-radius: 1px;
      background: #4FB0E3;
    }

    /* Section toggle (pill) */
    .cpr-nav-toggle {
      display: inline-flex; align-items: center;
      background: #F3F2F2;
      border-radius: 999px;
      padding: 3px;
      flex-shrink: 0;
    }
    .cpr-toggle-segment {
      text-decoration: none;
      font-family: 'Nunito', sans-serif;
      font-weight: 800; font-size: 11px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      padding: 6px 14px;
      border-radius: 999px;
      color: #4E4E50;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .cpr-toggle-segment:hover { color: #2D2D3B; }
    .cpr-toggle-segment.active {
      background: ${section.color}; color: #FFFFFF;
      box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    }
    .cpr-toggle-segment.active:hover { color: #FFFFFF; }

    /* Hamburger — hidden on desktop */
    .cpr-nav-burger {
      display: none;
      margin-left: auto;
      background: #F3F2F2; border: none; border-radius: 8px;
      width: 42px; height: 42px;
      cursor: pointer; flex-shrink: 0;
      align-items: center; justify-content: center;
      color: #2D2D3B;
    }
    .cpr-nav-burger:hover { background: #E7E6E6; }
    .cpr-nav-burger svg { width: 22px; height: 22px; display: block; }

    /* ── Mobile ── */
    @media (max-width: 760px) {
      .cpr-nav-inner { padding: 10px 16px; gap: 12px; flex-wrap: wrap; }
      .cpr-nav-brand img { height: 30px; }
      .cpr-nav-burger { display: inline-flex; }

      .cpr-nav-menu {
        display: none;
        flex-basis: 100%; width: 100%;
        flex-direction: column; align-items: stretch;
        gap: 10px;
        padding-top: 8px;
      }
      .cpr-nav-menu.open { display: flex; }

      .cpr-nav-tools {
        flex-direction: column; align-items: stretch;
        gap: 2px; flex: none;
      }
      .cpr-nav-tools a {
        font-size: 16px; font-weight: 700;
        padding: 13px 14px; border-radius: 8px;
      }
      .cpr-nav-tools a.active { background: #F3F2F2; }
      .cpr-nav-tools a.active::after { display: none; }

      .cpr-nav-toggle {
        align-self: stretch;
        justify-content: center;
        padding: 4px;
      }
      .cpr-toggle-segment {
        flex: 1; text-align: center;
        font-size: 13px; padding: 10px 14px;
      }
    }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ──────────────────────────────────────────────────────────────────────────
  // NAV HTML
  // ──────────────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  const toolLinks = section.tools.map(t => {
    const isActive = t.url.toLowerCase() === currentFile ? ' class="active"' : '';
    return `<a href="${escapeHtml(t.url)}"${isActive}>${escapeHtml(t.label)}</a>`;
  }).join('');

  const toggleSegments = Object.keys(SECTIONS).map(key => {
    const s = SECTIONS[key];
    const active = key === sectionKey ? ' active' : '';
    return `<a class="cpr-toggle-segment${active}" href="${escapeHtml(s.landing)}">${escapeHtml(s.label)}</a>`;
  }).join('');

  const burgerSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

  const navHtml = `
    <header class="cpr-nav">
      <div class="cpr-nav-strip"></div>
      <div class="cpr-nav-inner">
        <a class="cpr-nav-brand" href="${escapeHtml(section.landing)}">
          <img src="assets/images/CPR%20Icon.PNG" alt="CPR" onerror="this.style.display='none'" />
        </a>
        <button class="cpr-nav-burger" id="cprNavBurger" aria-label="Menu" aria-expanded="false">${burgerSvg}</button>
        <div class="cpr-nav-menu" id="cprNavMenu">
          <nav class="cpr-nav-tools">${toolLinks}</nav>
          <div class="cpr-nav-toggle">${toggleSegments}</div>
        </div>
      </div>
    </header>
  `;

  // ──────────────────────────────────────────────────────────────────────────
  // Inject + wire up the hamburger
  // ──────────────────────────────────────────────────────────────────────────
  function injectNav() {
    const wrap = document.createElement('div');
    wrap.innerHTML = navHtml.trim();
    document.body.insertBefore(wrap.firstChild, document.body.firstChild);

    const burger = document.getElementById('cprNavBurger');
    const menu = document.getElementById('cprNavMenu');
    if (burger && menu) {
      burger.addEventListener('click', function () {
        const open = menu.classList.toggle('open');
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      window.addEventListener('resize', function () {
        if (window.innerWidth > 760) {
          menu.classList.remove('open');
          burger.setAttribute('aria-expanded', 'false');
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNav);
  } else {
    injectNav();
  }
})();
