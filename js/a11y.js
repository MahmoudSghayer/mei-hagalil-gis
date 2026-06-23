/* js/a11y.js — app-wide accessibility helpers (no dependencies, self-initialising).
   Runs generically so each page only needs to <script defer src="js/a11y.js"> once:
   1. Injects a keyboard-only "skip to main content" link.
   2. Promotes every .modal-bg/.modal-box to a real ARIA dialog (role=dialog,
      aria-modal, aria-labelledby) and TRAPS keyboard focus while it is open
      (.modal-bg.open), restoring focus to the trigger on close; Esc activates the
      dialog's Cancel button (.btn-secondary) so existing close logic still runs.
   3. Associates each visible .form-label with its form control (adds `for`).
   WCAG 2.1 AA targets: 1.3.1, 2.1.2 (no keyboard trap → managed trap), 2.4.1,
   2.4.3, 3.3.2, 4.1.2. */
(function () {
  'use strict';

  var FOCUSABLE = 'a[href],area[href],button:not([disabled]),' +
    'input:not([disabled]):not([type=hidden]),select:not([disabled]),' +
    'textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable=true]';

  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), isVisible);
  }
  function uid(p) { return p + Math.random().toString(36).slice(2, 8); }

  /* ---------- 1. skip link ---------- */
  function addSkipLink() {
    if (document.querySelector('.skip-link')) return;
    var main = document.querySelector('[role=main],main,#map,#content,.auth-card,form');
    if (!main) return;
    if (!main.id) main.id = 'a11y-main';
    if (main.getAttribute('tabindex') === null) main.setAttribute('tabindex', '-1');
    var a = document.createElement('a');
    a.href = '#' + main.id;
    a.className = 'skip-link';
    a.textContent = 'דלג לתוכן הראשי';
    a.addEventListener('click', function () {
      setTimeout(function () { try { main.focus(); } catch (e) {} }, 0);
    });
    document.body.insertBefore(a, document.body.firstChild);
  }

  /* ---------- 2. modal dialogs + focus trap ---------- */
  var trap = null; // { box, returnTo, onKey }

  function releaseTrap() {
    if (!trap) return;
    document.removeEventListener('keydown', trap.onKey, true);
    var rt = trap.returnTo;
    trap = null;
    if (rt && typeof rt.focus === 'function') { try { rt.focus(); } catch (e) {} }
  }

  function engageTrap(box) {
    if (trap && trap.box === box) return;
    releaseTrap();
    var returnTo = document.activeElement;
    function onKey(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        var cancel = box.querySelector('.btn-secondary,[data-dismiss]');
        if (cancel) { e.preventDefault(); cancel.click(); }
        return;
      }
      if (e.key !== 'Tab' && e.keyCode !== 9) return;
      var f = focusables(box);
      if (!f.length) { e.preventDefault(); try { box.focus(); } catch (er) {} return; }
      var first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey && (a === first || !box.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    trap = { box: box, returnTo: returnTo, onKey: onKey };
    var f = focusables(box);
    setTimeout(function () { try { (f[0] || box).focus(); } catch (e) {} }, 30);
  }

  function initDialog(bg) {
    var box = bg.querySelector('.modal-box');
    if (!box) return;
    if (!box.getAttribute('role')) box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (box.getAttribute('tabindex') === null) box.setAttribute('tabindex', '-1');
    var title = box.querySelector('.modal-title');
    if (title && !box.getAttribute('aria-labelledby')) {
      if (!title.id) title.id = uid('a11y-dlg-');
      box.setAttribute('aria-labelledby', title.id);
    }
    var mo = new MutationObserver(function () {
      if (bg.classList.contains('open')) engageTrap(box);
      else if (trap && trap.box === box) releaseTrap();
    });
    mo.observe(bg, { attributes: true, attributeFilter: ['class'] });
    if (bg.classList.contains('open')) engageTrap(box);
  }

  /* ---------- 3. label ↔ control association ---------- */
  function associateLabels() {
    var labels = document.querySelectorAll('label:not([for])');
    Array.prototype.forEach.call(labels, function (lab) {
      if (lab.querySelector('input,select,textarea')) return; // label already wraps its control
      var ctrl = lab.nextElementSibling;
      while (ctrl && !/^(INPUT|SELECT|TEXTAREA)$/.test(ctrl.tagName)) ctrl = ctrl.nextElementSibling;
      if (!ctrl) { var p = lab.parentElement; if (p) ctrl = p.querySelector('input,select,textarea'); }
      if (!ctrl) return;
      if (!ctrl.id) ctrl.id = uid('a11y-f-');
      lab.setAttribute('for', ctrl.id);
    });
  }

  function init() {
    try { addSkipLink(); } catch (e) {}
    try { Array.prototype.forEach.call(document.querySelectorAll('.modal-bg'), initDialog); } catch (e) {}
    try { associateLabels(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.GISA11y = { focusables: focusables, releaseTrap: releaseTrap, refresh: init };
})();
