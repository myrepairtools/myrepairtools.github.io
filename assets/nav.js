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
 * ========================================================================= */
(function () {
  'use strict';

  // Skip nav entirely when this page is loaded inside an iframe
  // (e.g., embedded in RepairQ via the RQ Mods extension). The hosting
  // app provides its own chrome, so injecting our nav would just take
  // up space and look odd.
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
        { label: 'Profit First',     url: 'profit-first.html' },
        { label: 'Claim Ledger',     url: 'claim-ledger.html' },
        { label: 'Employee Records', url: 'employee-records.html' },
        { label: 'Commissions',      url: 'commission-calculator.html' }
      ]
    },
    operations: {
      label: 'Operations',
      icon: '🔧',
      color: '#4FB0E3',        // CPR blue
      landing: 'operations.html',
      tools: [
        { label: 'Price Calc & Guide', url: 'price-calc-and-guide.html' },
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
  const otherKey = sectionKey === 'admin' ? 'operations' : 'admin';
  const otherSection = SECTIONS[otherKey];

  // Identify the current page (used to mark the active tool link)
  const currentFile = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();

  // ──────────────────────────────────────────────────────────────────────────
  // STYLES (injected once)
  // ──────────────────────────────────────────────────────────────────────────
  const css = `
    .cpr-nav {
      position: sticky; top: 0; z-index: 100;
      background: #FFFFFF;
      border-bottom: 4px solid ${section.color};
      font-family: 'Nunito', sans-serif;
      box-shadow: 0 1px 4px rgba(45,45,59,0.06);
    }
    .cpr-nav-strip {
      height: 6px; background: #0F0F12;
    }
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
    .cpr-nav-title {
      font-weight: 900; font-size: 14px; letter-spacing: 0.4px;
      color: #2D2D3B;
    }
    .cpr-nav-section-badge {
      background: ${section.color}; color: #FFFFFF;
      font-weight: 800; font-size: 11px; letter-spacing: 0.5px;
      text-transform: uppercase;
      padding: 4px 10px; border-radius: 6px;
      display: inline-flex; align-items: center; gap: 4px;
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
    }
    .cpr-nav-tools a:hover {
      background: #F3F2F2; color: #2D2D3B;
    }
    .cpr-nav-tools a.active {
      background: ${section.color}; color: #FFFFFF;
    }
    .cpr-nav-switch {
      text-decoration: none;
      font-weight: 800; font-size: 12px;
      padding: 8px 14px; border-radius: 6px;
      border: 1.5px solid ${otherSection.color};
      color: ${otherSection.color};
      background: #FFFFFF;
      transition: all 0.15s;
      letter-spacing: 0.3px;
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .cpr-nav-switch:hover {
      background: ${otherSection.color}; color: #FFFFFF;
    }
    @media (max-width: 800px) {
      .cpr-nav-inner { padding: 10px 14px; gap: 10px; flex-wrap: wrap; }
      .cpr-nav-title { display: none; }
      .cpr-nav-tools a { font-size: 12px; padding: 6px 10px; }
      .cpr-nav-switch { font-size: 11px; padding: 6px 10px; }
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

  const navHtml = `
    <header class="cpr-nav">
      <div class="cpr-nav-strip"></div>
      <div class="cpr-nav-inner">
        <a class="cpr-nav-brand" href="${escapeHtml(section.landing)}">
          <img src="assets/images/CPRLogo_NoAssurant_Black.svg" alt="CPR" onerror="this.style.display='none'" />
          <span class="cpr-nav-section-badge">${section.icon} ${escapeHtml(section.label)}</span>
        </a>
        <nav class="cpr-nav-tools">${toolLinks}</nav>
        <a class="cpr-nav-switch" href="${escapeHtml(otherSection.landing)}">
          ${otherSection.icon} ${escapeHtml(otherSection.label)} →
        </a>
      </div>
    </header>
  `;

  // ──────────────────────────────────────────────────────────────────────────
  // Inject at the top of <body>
  // ──────────────────────────────────────────────────────────────────────────
  function injectNav() {
    const wrap = document.createElement('div');
    wrap.innerHTML = navHtml.trim();
    document.body.insertBefore(wrap.firstChild, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNav);
  } else {
    injectNav();
  }
})();
