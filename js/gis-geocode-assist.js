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

  // Letters-only Hebrew normaliser: keep only Hebrew letters (drops spaces,
  // hyphens, the ASCII apostrophe ArcGIS uses in "מג'ד", bidi/zero-width marks,
  // geresh/gershayim…), then collapse doubled yod/vav. This makes the dropdown
  // labels (hyphenated, e.g. "מגד אל-כרום") match ArcGIS City strings (which use
  // an apostrophe + spaces, e.g. "מג'ד אל כרום") — verified across all 7 villages.
  function normVillage(s) {
    return String(s == null ? '' : s)
      .replace(/[^א-ת]/g, '')
      .replace(/יי/g, 'י')
      .replace(/וו/g, 'ו');
  }

  // First village option whose letters appear in any of the given strings, or null.
  function villageFromText() {
    for (var a = 0; a < arguments.length; a++) {
      var hay = normVillage(arguments[a]); if (!hay) continue;
      for (var i = 0; i < VILLAGE_OPTS.length; i++) {
        var nv = normVillage(VILLAGE_OPTS[i]);
        if (nv && hay.indexOf(nv) !== -1) return VILLAGE_OPTS[i];
      }
    }
    return null;
  }

  // Town centres (WGS84) — fallback when reverse-geocode can't name the village
  // (e.g. a point that resolves only to a highway, as בענה/נחף centres do). Every
  // incident in this utility's area sits in one of these 7 towns, so nearest-centre
  // is a strong default the dispatcher can still override. Coords mirror VILLAGES
  // in js/pages/index.js. Labels match the f-village <option> text exactly (ASCII hyphen).
  var VILLAGE_CENTERS = [
    { n: 'מגד אל-כרום', lat: 32.9189, lng: 35.2456 },
    { n: 'בענה', lat: 32.9485, lng: 35.2617 },
    { n: 'דיר אל-אסד', lat: 32.9356, lng: 35.2697 },
    { n: 'נחף', lat: 32.9344, lng: 35.3025 },
    { n: 'סחנין', lat: 32.8650, lng: 35.2978 },
    { n: 'דיר חנא', lat: 32.8631, lng: 35.3589 },
    { n: 'עראבה', lat: 32.8514, lng: 35.3339 }
  ];
  function nearestVillage(lng, lat) {
    var best = null, bd = Infinity;
    for (var i = 0; i < VILLAGE_CENTERS.length; i++) {
      var c = VILLAGE_CENTERS[i];
      var dy = lat - c.lat, dx = (lng - c.lng) * Math.cos(lat * Math.PI / 180);
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c.n; }
    }
    return best;
  }
  // Village label for a point: prefer the reverse-geocoded name, else nearest centre.
  function villageForPoint(lng, lat, info) {
    var byName = info ? villageFromText(info.city, info.long, info.match) : null;
    return byName || nearestVillage(lng, lat);
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
    // Village can be set with NO network call (nearest centre) — do it immediately
    // so the form is right even if the key/geocoder is unavailable. Only when the
    // user hasn't already chosen one.
    var sel = document.getElementById('f-village');
    var ours = null;
    if (sel && !sel.value) { ours = nearestVillage(lng, lat); if (ours) sel.value = ours; }

    showHint('🔎 מאתר כתובת…', null);
    var info = await reverseGeocode(lng, lat);
    if (!info) { showHint(null); return; }

    // Refine to the exact reverse-geocoded village — but never clobber a manual
    // choice (only overwrite our own nearest-centre default or an empty field).
    if (sel && (sel.value === '' || sel.value === ours)) {
      var byName = villageFromText(info.city, info.long, info.match);
      if (byName) sel.value = byName;
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
    villageForPoint: villageForPoint,
    nearestVillage: nearestVillage,
    fillIncident: fillIncident
  };
})();
