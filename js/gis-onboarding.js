/* js/gis-onboarding.js — first-run guided tour + persistent help launcher.
   Self-contained IIFE, no dependencies, purely additive (cannot affect any
   existing feature). Shows a one-time welcome walkthrough (localStorage-gated)
   and injects a floating "?" button to reopen it anytime.
   RTL Hebrew, on-brand (#0d3b5e). window.GISOnboarding = { open, reset }. */
(function () {
  'use strict';
  var KEY = 'mgis_onboarded_v1';

  var SLIDES = [
    { ic: '💧', t: 'ברוכים הבאים למערכת ה‑GIS של מי הגליל',
      b: 'מערכת ניהול תשתיות המים והביוב — מפה אינטראקטיבית, שכבות, תקלות, מדי מים וכלי רשת. סיור קצר (30 שניות) יראה לכם את עיקרי המערכת.' },
    { ic: '🗂️', t: 'שכבות (פאנל התוכן)',
      b: 'בסרגל הצד: הדליקו וכבו שכבות לפי כפר וקטגוריה, שנו צבע, כווננו שקיפות, סדרו שכבה קדימה/אחורה והתמקדו בשכבה — בלחיצה אחת.' },
    { ic: '🔎', t: 'איתור מהיר',
      b: 'מהסרגל העליון אפשר לאתר נכס, מד מים (Arad) לפי מספר, או כתובת — והמפה תטוס ישירות לתוצאה ותסמן אותה.' },
    { ic: '🧰', t: 'רצועת הכלים',
      b: 'בראש המסך: מדידה, ניתוח מרחבי, בידוד מגופים ומעקב זרימה, חיבור מונים, ייצוא (DWG/DXF/SHP/KML) והדפסת גיליון מפה.' },
    { ic: '🛠️', t: 'תקלות בשטח',
      b: 'לפתיחת תקלה: לחצו "+ פתח תקלה חדשה" וסמנו את המיקום על המפה. עובדי שטח יכולים לדווח גם מהנייד (מצב שטח / PWA).' }
  ];

  var css = document.createElement('style');
  css.textContent = [
    '.mgo-bg{position:fixed;inset:0;background:rgba(13,59,94,.55);backdrop-filter:blur(2px);z-index:100050;display:none;align-items:center;justify-content:center;}',
    '.mgo-bg.open{display:flex;}',
    '.mgo-card{width:min(440px,92vw);background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.35);padding:26px 24px 18px;text-align:center;direction:rtl;font-family:inherit;animation:mgo-in .25s ease both;}',
    '@keyframes mgo-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}',
    '.mgo-ic{font-size:46px;line-height:1;margin-bottom:10px;}',
    '.mgo-t{font-size:19px;font-weight:800;color:#0d3b5e;margin-bottom:8px;}',
    '.mgo-b{font-size:14px;line-height:1.7;color:#475569;min-height:96px;}',
    '.mgo-dots{display:flex;gap:6px;justify-content:center;margin:14px 0 16px;}',
    '.mgo-dot{width:8px;height:8px;border-radius:50%;background:#cbd5e1;transition:all .2s;}',
    '.mgo-dot.on{background:#0d3b5e;width:22px;border-radius:5px;}',
    '.mgo-btns{display:flex;gap:8px;align-items:center;justify-content:space-between;}',
    '.mgo-btn{border:none;border-radius:9px;padding:9px 16px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;}',
    '.mgo-next{background:#0d3b5e;color:#fff;flex:1;}',
    '.mgo-next:hover{background:#0a2e49;}',
    '.mgo-back{background:#eef2f6;color:#0d3b5e;}',
    '.mgo-skip{background:none;color:#94a3b8;font-size:12.5px;}',
    '.mgo-help{position:fixed;bottom:14px;inset-inline-start:14px;z-index:9000;width:38px;height:38px;border-radius:50%;border:none;background:#0d3b5e;color:#fff;font-size:18px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);}',
    '.mgo-help:hover{background:#0a2e49;}'
  ].join('');
  document.head.appendChild(css);

  var bg, titleEl, bodyEl, icEl, dotsEl, backBtn, nextBtn, i = 0;

  function build() {
    bg = document.createElement('div');
    bg.className = 'mgo-bg';
    bg.setAttribute('role', 'dialog');
    bg.setAttribute('aria-modal', 'true');
    bg.setAttribute('aria-label', 'סיור היכרות');
    bg.innerHTML =
      '<div class="mgo-card" role="document">' +
        '<div class="mgo-ic"></div>' +
        '<div class="mgo-t"></div>' +
        '<div class="mgo-b"></div>' +
        '<div class="mgo-dots"></div>' +
        '<div class="mgo-btns">' +
          '<button class="mgo-btn mgo-skip" type="button">דלג</button>' +
          '<button class="mgo-btn mgo-back" type="button">הקודם</button>' +
          '<button class="mgo-btn mgo-next" type="button">הבא</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bg);
    icEl = bg.querySelector('.mgo-ic');
    titleEl = bg.querySelector('.mgo-t');
    bodyEl = bg.querySelector('.mgo-b');
    dotsEl = bg.querySelector('.mgo-dots');
    backBtn = bg.querySelector('.mgo-back');
    nextBtn = bg.querySelector('.mgo-next');
    dotsEl.innerHTML = SLIDES.map(function () { return '<span class="mgo-dot"></span>'; }).join('');
    bg.querySelector('.mgo-skip').onclick = finish;
    backBtn.onclick = function () { if (i > 0) { i--; paint(); } };
    nextBtn.onclick = function () { if (i < SLIDES.length - 1) { i++; paint(); } else { finish(); } };
    bg.addEventListener('click', function (e) { if (e.target === bg) finish(); });
    document.addEventListener('keydown', function (e) {
      if (!bg.classList.contains('open')) return;
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowLeft') nextBtn.click();   // RTL: left = next
      else if (e.key === 'ArrowRight') backBtn.click();
    });

    var help = document.createElement('button');
    help.className = 'mgo-help';
    help.type = 'button';
    help.textContent = '?';
    help.title = 'סיור היכרות / עזרה';
    help.setAttribute('aria-label', 'פתח סיור היכרות ועזרה');
    help.onclick = open;
    document.body.appendChild(help);
  }

  function paint() {
    var s = SLIDES[i];
    icEl.textContent = s.ic;
    titleEl.textContent = s.t;
    bodyEl.textContent = s.b;
    Array.prototype.forEach.call(dotsEl.children, function (d, k) { d.className = 'mgo-dot' + (k === i ? ' on' : ''); });
    backBtn.style.visibility = i === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = i === SLIDES.length - 1 ? 'בואו נתחיל' : 'הבא';
  }

  function open() { if (!bg) build(); i = 0; paint(); bg.classList.add('open'); }
  function finish() { if (bg) bg.classList.remove('open'); try { localStorage.setItem(KEY, '1'); } catch (e) {} }
  function reset() { try { localStorage.removeItem(KEY); } catch (e) {} open(); }

  function init() {
    build();
    var seen = false;
    try { seen = !!localStorage.getItem(KEY); } catch (e) {}
    if (!seen) setTimeout(open, 900);   // let the map paint first
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.GISOnboarding = { open: open, reset: reset };
})();
