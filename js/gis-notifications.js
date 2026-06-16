// ════════════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — In-app Notifications (F6)
//  Self-contained: injects a 🔔 bell into .topbar-right on any page, lists the
//  logged-in user's notifications, marks read, and live-updates via Supabase
//  Realtime. Notifications are written server-side by the workflow RPCs
//  (submit/approve/reject). RLS: a user sees only their own.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var uid = null, items = [], open = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function fmt(ts) { try { return new Date(ts).toLocaleString('he-IL'); } catch (e) { return ''; } }

  function injectStyles() {
    if (document.getElementById('ntf-styles')) return;
    var s = document.createElement('style'); s.id = 'ntf-styles';
    s.textContent =
      '#ntf-wrap{position:relative;display:inline-block;margin-inline-end:6px}' +
      '#ntf-bell{position:relative;background:none;border:none;font-size:20px;cursor:pointer;padding:4px 6px;line-height:1}' +
      '#ntf-badge{position:absolute;top:-2px;left:-2px;min-width:16px;height:16px;padding:0 3px;background:#dc2626;color:#fff;' +
      'border-radius:999px;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center}' +
      '#ntf-panel{display:none;position:absolute;top:38px;left:0;width:330px;max-height:62vh;overflow:auto;background:#fff;' +
      'border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);z-index:2000;direction:rtl}' +
      '#ntf-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #eef2f7;font-weight:700;color:#0d3b5e}' +
      '#ntf-head button{background:none;border:none;color:#1a7fc1;cursor:pointer;font:inherit;font-size:12px}' +
      '.ntf-item{padding:10px 12px;border-bottom:1px solid #f1f5f9}.ntf-item.unread{background:#eff6ff}' +
      '.ntf-t{font-weight:700;color:#1e293b;font-size:13px}.ntf-b{font-size:12px;color:#475569;margin-top:2px}' +
      '.ntf-m{font-size:11px;color:#94a3b8;margin-top:3px}.ntf-empty{padding:24px;text-align:center;color:#94a3b8}';
    document.head.appendChild(s);
  }

  function build() {
    var host = document.querySelector('.topbar-right');
    if (!host || document.getElementById('ntf-wrap')) return;
    var wrap = document.createElement('div'); wrap.id = 'ntf-wrap';
    wrap.innerHTML = '<button id="ntf-bell" title="התראות" aria-label="התראות">🔔<span id="ntf-badge"></span></button>' +
      '<div id="ntf-panel"><div id="ntf-head"><span>התראות</span><button id="ntf-readall">סמן הכל כנקרא</button></div><div id="ntf-list"></div></div>';
    host.insertBefore(wrap, host.firstChild);
    document.getElementById('ntf-bell').onclick = function (e) { e.stopPropagation(); setOpen(!open); };
    document.getElementById('ntf-readall').onclick = markAllRead;
    document.addEventListener('click', function (e) { if (open && !wrap.contains(e.target)) setOpen(false); });
  }

  function setOpen(v) { open = v; var p = document.getElementById('ntf-panel'); if (p) p.style.display = v ? 'block' : 'none'; }

  function refreshBadge() {
    var n = items.filter(function (i) { return !i.read; }).length;
    var b = document.getElementById('ntf-badge'); if (!b) return;
    b.textContent = n > 99 ? '99+' : (n || ''); b.style.display = n ? 'flex' : 'none';
  }

  function render() {
    var l = document.getElementById('ntf-list'); if (!l) return;
    if (!items.length) { l.innerHTML = '<div class="ntf-empty">אין התראות</div>'; return; }
    l.innerHTML = items.map(function (i) {
      return '<div class="ntf-item' + (i.read ? '' : ' unread') + '" data-id="' + i.id + '">' +
        '<div class="ntf-t">' + esc(i.title) + '</div>' +
        (i.body ? '<div class="ntf-b">' + esc(i.body) + '</div>' : '') +
        '<div class="ntf-m">' + fmt(i.created_at) + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(l.querySelectorAll('.ntf-item'), function (el) {
      el.onclick = function () { markRead(+el.getAttribute('data-id')); };
    });
  }

  async function load() {
    var r = await gSb.from('notifications').select('*').order('created_at', { ascending: false }).limit(30);
    items = (r && r.data) || []; refreshBadge(); render();
  }

  function markRead(id) {
    var it = items.find(function (x) { return x.id === id; });
    if (it && !it.read) { it.read = true; refreshBadge(); render(); gSb.from('notifications').update({ read: true }).eq('id', id); }
  }
  async function markAllRead() {
    var ids = items.filter(function (i) { return !i.read; }).map(function (i) { return i.id; });
    if (!ids.length) return;
    items.forEach(function (i) { i.read = true; }); refreshBadge(); render();
    await gSb.from('notifications').update({ read: true }).in('id', ids);
  }

  function subscribe() {
    try {
      gSb.channel('ntf-' + uid)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + uid },
          function (payload) {
            items.unshift(payload.new); if (items.length > 50) items.pop();
            refreshBadge(); render();
            if (window.showToast) showToast('🔔 ' + (payload.new.title || 'התראה חדשה'));
          })
        .subscribe();
    } catch (e) {}
  }

  async function init() {
    try {
      var u = await gSb.auth.getUser();
      uid = u && u.data && u.data.user && u.data.user.id;
    } catch (e) { return; }
    if (!uid) return;
    injectStyles(); build(); await load(); subscribe();
  }

  var tries = 0;
  var timer = setInterval(function () {
    if (window.gSb && document.querySelector('.topbar-right')) { clearInterval(timer); init(); }
    else if (++tries > 100) clearInterval(timer);
  }, 200);
})();
