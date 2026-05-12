/**
 * motion-utils.js
 * Shared animation helpers using the Motion vanilla library.
 * Loads Motion from CDN on first use; all functions degrade gracefully without it.
 */
(function () {
  'use strict';

  var M = null;
  var _loaded = false;
  var _queue  = [];

  function ensureMotion(cb) {
    if (_loaded) { cb(M); return; }
    if (window.Motion) { M = window.Motion; _loaded = true; cb(M); return; }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/motion@11/dist/motion.js';
    s.onload  = function () { M = window.Motion || null; _loaded = true; cb(M); _queue.forEach(function(f){ f(M); }); _queue = []; };
    s.onerror = function () { _loaded = true; cb(null); };
    document.head.appendChild(s);
  }

  /* ── PAGE ENTRANCE ─────────────────────────────────────── */
  function animatePageIn() {
    ensureMotion(function (m) {
      if (!m) return;

      var statCards = document.querySelectorAll('.stat-card');
      if (statCards.length) {
        m.animate(statCards,
          { opacity: [0, 1], y: [18, 0] },
          { delay: m.stagger(0.07), duration: 0.38, easing: [0.16, 1, 0.3, 1] }
        );
      }

      var cards = document.querySelectorAll('.card');
      if (cards.length) {
        m.animate(cards,
          { opacity: [0, 1], y: [12, 0] },
          { delay: m.stagger(0.09, { start: statCards.length ? 0.22 : 0 }),
            duration: 0.4, easing: [0.16, 1, 0.3, 1] }
        );
      }
    });
  }

  /* ── TABLE ROWS ────────────────────────────────────────── */
  function animateTableRows(tbodyOrSelector) {
    ensureMotion(function (m) {
      if (!m) return;
      var tbody = typeof tbodyOrSelector === 'string'
        ? document.querySelector(tbodyOrSelector)
        : tbodyOrSelector;
      if (!tbody) return;
      var rows = tbody.querySelectorAll('tr');
      if (!rows.length) return;
      m.animate(rows,
        { opacity: [0, 1], x: [6, 0] },
        { delay: m.stagger(0.025), duration: 0.26, easing: [0.16, 1, 0.3, 1] }
      );
    });
  }

  /* ── MODAL ─────────────────────────────────────────────── */
  function openModal(bgEl) {
    if (!bgEl) return;
    bgEl.classList.add('open');
    ensureMotion(function (m) {
      if (!m) return;
      var inner = bgEl.querySelector('.modal');
      if (!inner) return;
      m.animate(inner,
        { opacity: [0, 1], scale: [0.93, 1], y: [12, 0] },
        { duration: 0.24, easing: [0.175, 0.885, 0.32, 1.15] }
      );
    });
  }

  function closeModal(bgEl, cb) {
    if (!bgEl) return;
    ensureMotion(function (m) {
      if (!m) { bgEl.classList.remove('open'); if (cb) cb(); return; }
      var inner = bgEl.querySelector('.modal');
      if (!inner) { bgEl.classList.remove('open'); if (cb) cb(); return; }
      m.animate(inner,
        { opacity: [1, 0], scale: [1, 0.95], y: [0, 8] },
        { duration: 0.18, easing: 'ease-in' }
      ).finished.then(function () {
        bgEl.classList.remove('open');
        if (cb) cb();
      });
    });
  }

  /* ── TOAST ─────────────────────────────────────────────── */
  function showToast(msg, type, duration) {
    var t = document.getElementById('toast');
    if (!t) return;
    duration = duration || 3500;

    t.textContent = msg;
    t.className   = '';
    if (type) t.classList.add(type);

    clearTimeout(t.__timer);

    ensureMotion(function (m) {
      if (m) {
        m.animate(t, { opacity: [0, 1], y: [16, 0] },
          { duration: 0.28, easing: [0.175, 0.885, 0.32, 1.15] });
        t.classList.add('show');
        t.__timer = setTimeout(function () {
          m.animate(t, { opacity: [1, 0], y: [0, 10] },
            { duration: 0.2, easing: 'ease-in' })
            .finished.then(function () { t.classList.remove('show'); });
        }, duration);
      } else {
        t.classList.add('show');
        t.__timer = setTimeout(function () { t.classList.remove('show'); }, duration);
      }
    });
  }

  /* ── SKELETON HELPERS ───────────────────────────────────── */
  function showSkeleton(container, count) {
    if (!container) return;
    count = count || 5;
    var html = '';
    for (var i = 0; i < count; i++) {
      html += '<div class="skeleton skeleton-row" style="opacity:' + (1 - i * 0.08).toFixed(2) + '"></div>';
    }
    container.innerHTML = html;
  }

  function hideSkeleton(container) {
    if (!container) return;
    container.querySelectorAll('.skeleton').forEach(function (el) { el.remove(); });
  }

  /* ── STAT CARD COUNTER ─────────────────────────────────── */
  function countUp(el, target, duration) {
    if (!el || isNaN(target)) return;
    duration = duration || 600;
    var start = 0, startTime = null;
    function step(ts) {
      if (!startTime) startTime = ts;
      var p = Math.min((ts - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(ease * target);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ── PUBLIC API ─────────────────────────────────────────── */
  window.MotionUtils = {
    init:             function (cb) { ensureMotion(function () { if (cb) cb(); }); },
    animatePageIn:    animatePageIn,
    animateTableRows: animateTableRows,
    openModal:        openModal,
    closeModal:       closeModal,
    showToast:        showToast,
    showSkeleton:     showSkeleton,
    hideSkeleton:     hideSkeleton,
    countUp:          countUp
  };

}());
