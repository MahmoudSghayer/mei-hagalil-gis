/* ══════════════════════════════════════════════════════════════════════════
   GIS Geocode Assist — ArcGIS reverse geocoding (Phase 3).
   When a dispatcher drops a new incident on the map, resolve the clicked point
   to a real street address (ArcGIS World Geocoder, Hebrew) and:
     • auto-select the correct ישוב (village) in the incident form, and
     • show the resolved address with a one-click "add to description" action.

   No DB change — uses the village field the incident already has, and the
   address rides in the free-text description only if the user opts in.
   Uses the Geocoding privilege the key already carries (geocode-api.arcgis.com
   is already in the CSP). Self-contained IIFE → window.GISGeoAssist.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Village labels EXACTLY as they appear in the incident <select id="f-village">.
  var VILLAGE_OPTS = ['מגד אל-כרום', 'בענה', 'דיר אל-אסד', 'נחף', 'סחנין', 'דיר חנא', 'עראבה'];

  function key() { return window.GIS_ARCGIS_KEY || ''; }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // Spelling-tolerant Hebrew normaliser (mirrors GIS.meters.normHe): strips
  // geresh/quotes/hyphens, collapses doubled yod/vav, normalises spaces. So
  // "מג׳ד אל-כרום" / "מגד אלכרום" / "דייר חנא" all reduce to one comparable form.
  function normHe(s) {
    return String(s == null ? '' : s)
      .replace(/['"׳״’`\-]/g, '')
      .replace(/יי/g, 'י')
      .replace(/וו/g, 'ו')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // First village option that appears in any of the given strings, or null.
  function villageFromText() {
    for (var a = 0; a < arguments.length; a++) {
      var hay = normHe(arguments[a]); if (!hay) continue;
      for (var i = 0; i < VILLAGE_OPTS.length; i++) {
        if (hay.indexOf(normHe(VILLAGE_OPTS[i])) !== -1) return VILLAGE_OPTS[i];
      }
    }
    return null;
  }

  // Reverse-geocode (lng,lat) → { long, match, city } or null on any failure
  // (no key, error, timeout) — callers degrade silently.
  async function reverseGeocode(lng, lat) {
    if (!key()) return null;
    var url = 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode' +
      '?f=json&location=' + lng + ',' + lat + '&langCode=he&outSR=4326&token=' + encodeURIComponent(key());
    try {
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, 4500);
      var r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) return null;
      var d = await r.json();
      if (!d || d.error || !d.address) return null;
      var a = d.address;
      return {
        long: a.LongLabel || a.Match_addr || '',
        match: a.Match_addr || a.LongLabel || '',
        city: a.City || a.Neighborhood || a.District || a.Region || ''
      };
    } catch (e) { return null; }
  }

  // ── incident-modal hook (called from finishIncPick in index.js) ───────────
  async function fillIncident(lat, lng) {
    showHint('🔎 מאתר כתובת…', null);
    var info = await reverseGeocode(lng, lat);
    if (!info) { showHint(null); return; }

    // auto-select the village only if the user hasn't already chosen one
    var sel = document.getElementById('f-village');
    if (sel && !sel.value) {
      var v = villageFromText(info.city, info.long, info.match);
      if (v) sel.value = v;
    }
    showHint(info.long || info.match, info.long || info.match);
  }

  // Inject/refresh a small address line above the description textarea, with an
  // "add to description" button (opt-in, never overwrites the user's text).
  function showHint(text, addr) {
    var desc = document.getElementById('f-desc');
    if (!desc) return;
    var row = desc.closest ? desc.closest('.form-row') : desc.parentNode;
    var host = document.getElementById('inc-addr-hint');
    if (!text) { if (host) host.remove(); return; }
    if (!host) {
      host = document.createElement('div');
      host.id = 'inc-addr-hint';
      host.style.cssText = 'margin:0 0 8px;padding:7px 10px;background:#eff4ff;border:1px solid #c7d7fe;border-radius:7px;font-size:12px;color:#1e3a8a;display:flex;align-items:center;gap:8px;direction:rtl';
      if (row && row.parentNode) row.parentNode.insertBefore(host, row);
      else desc.parentNode.insertBefore(host, desc);
    }
    var btn = addr ? '<button type="button" id="inc-addr-add" style="margin-inline-start:auto;background:#2563eb;color:#fff;border:none;border-radius:5px;padding:3px 9px;cursor:pointer;font-size:12px;flex:none">➕ הוסף לתיאור</button>' : '';
    host.innerHTML = '<span style="flex:1">📍 ' + esc(text) + '</span>' + btn;
    var ab = document.getElementById('inc-addr-add');
    if (ab) ab.onclick = function () {
      var cur = desc.value.trim();
      if (cur.indexOf(addr) === -1) desc.value = cur ? (cur + ' · ' + addr) : addr;
      ab.disabled = true; ab.textContent = '✓ נוסף';
    };
  }

  window.GISGeoAssist = {
    reverseGeocode: reverseGeocode,
    villageFromText: villageFromText,
    fillIncident: fillIncident
  };
})();
