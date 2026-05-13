// ════════════════════════════════════════════════════════════════
//  Mei HaGalil GIS — Search Feature (standalone module)
//  כלול ב-index.html אחרי שאר הסקריפטים:
//    <script src="search-feature.js"></script>
//  פיצ'רים:
//   - חיפוש קואורדינטות WGS84 (lat,lng)
//   - חיפוש קואורדינטות ITM (X,Y - רשת ישראל)
//   - חיפוש כתובת (Nominatim/OSM)
//   - חיפוש גוש/חלקה (פותח Govmap)
// ════════════════════════════════════════════════════════════════
(function() {
'use strict';

var gMarker = null;
var gPolygon = null;
var gPanel = null;

// ── Load proj4js for ITM conversion ──
function loadProj4(cb) {
  if (window.proj4) { cb(); return; }
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js';
  s.onload = function() {
    // Define EPSG:2039 (Israel TM Grid - ITM)
    window.proj4.defs('EPSG:2039',
      '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 ' +
      '+k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 ' +
      '+towgs84=-48,55,52,0,0,0,0 +units=m +no_defs'
    );
    cb();
  };
  document.head.appendChild(s);
}

// ── INJECT STYLES ──
var css = document.createElement('style');
css.textContent = `
#search-bar{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#fff;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,0.18);z-index:450;display:flex;align-items:center;width:440px;max-width:calc(100vw - 220px);overflow:hidden;border:1px solid rgba(0,0,0,0.08);font-family:'Segoe UI',Tahoma,Arial,sans-serif}
#search-input{flex:1;padding:11px 14px;border:none;outline:none;font-size:13px;direction:rtl;background:transparent;color:#1e293b;font-family:inherit}
#search-input::placeholder{color:#94a3b8}
#search-clear{padding:0 10px;background:none;border:none;cursor:pointer;color:#94a3b8;font-size:16px;display:none}
#search-clear:hover{color:#dc2626}
#search-clear.show{display:block}
#search-help-btn{padding:0 12px;background:#0d3b5e;color:#fff;border:none;cursor:pointer;font-size:14px;height:42px;font-family:inherit}
#search-help-btn:hover{background:#1a7fc1}
#search-results{position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,0.15);max-height:340px;overflow-y:auto;display:none;direction:rtl;border:1px solid #e2e8f0}
#search-results.show{display:block}
.sr-item{padding:10px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:13px}
.sr-item:hover{background:#eff6ff}
.sr-item:last-child{border-bottom:none}
.sr-title{font-weight:600;color:#0d3b5e;margin-bottom:2px}
.sr-sub{font-size:11px;color:#64748b}
.sr-icon{display:inline-block;width:18px;text-align:center;margin-left:6px}
.sr-loading{padding:14px;text-align:center;color:#64748b;font-size:12px}
.sr-empty{padding:14px;text-align:center;color:#94a3b8;font-size:12px}
.sr-section{padding:6px 14px;background:#f8fafc;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #e2e8f0}
#search-help{position:absolute;top:64px;left:50%;transform:translateX(-50%);background:#fff;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,0.2);width:440px;max-width:calc(100vw - 220px);z-index:451;padding:18px;display:none;direction:rtl;font-family:'Segoe UI',Tahoma,Arial,sans-serif;border:1px solid #e2e8f0}
#search-help.show{display:block}
#search-help h4{font-size:13px;color:#0d3b5e;margin:0 0 10px;font-weight:700}
.help-row{display:flex;gap:10px;margin-bottom:8px;font-size:12px;color:#1e293b;line-height:1.4}
.help-icon{font-size:16px;flex-shrink:0;width:22px}
.help-text{flex:1}
.help-text code{background:#f1f5f9;padding:1px 5px;border-radius:3px;font-family:monospace;font-size:11px;color:#0d3b5e}
.help-close{position:absolute;top:8px;left:10px;background:none;border:none;cursor:pointer;font-size:16px;color:#94a3b8}
.help-close:hover{color:#dc2626}
.search-result-popup{font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:rtl;text-align:right}
`;
document.head.appendChild(css);

// ── INJECT UI ──
function injectUI() {
  var mw = document.getElementById('map-wrap');
  if (!mw) { setTimeout(injectUI, 200); return; }

  var bar = document.createElement('div');
  bar.id = 'search-bar';
  bar.innerHTML =
    '<input id="search-input" type="text" placeholder="חיפוש: קואורדינטות, כתובת, או גוש/חלקה..." autocomplete="off"/>' +
    '<button id="search-clear" title="נקה">✖</button>' +
    '<button id="search-help-btn" title="עזרה">?</button>' +
    '<div id="search-results"></div>';
  mw.appendChild(bar);

  var help = document.createElement('div');
  help.id = 'search-help';
  help.innerHTML =
    '<button class="help-close" onclick="document.getElementById(\'search-help\').classList.remove(\'show\')">✖</button>' +
    '<h4>🔍 פורמטים נתמכים</h4>' +
    '<div class="help-row"><span class="help-icon">📍</span><span class="help-text"><strong>קואורדינטות WGS84</strong> (גוגל מפס): <code>32.9485, 35.2617</code></span></div>' +
    '<div class="help-row"><span class="help-icon">🇮🇱</span><span class="help-text"><strong>קואורדינטות ITM</strong> (רשת ישראל): <code>222000, 758500</code> או <code>222000 758500</code></span></div>' +
    '<div class="help-row"><span class="help-icon">🏠</span><span class="help-text"><strong>כתובת</strong>: <code>רחוב הרצל 5, סחנין</code></span></div>' +
    '<div class="help-row"><span class="help-icon">📐</span><span class="help-text"><strong>גוש/חלקה</strong>: <code>19012/35</code> או <code>גוש 19012 חלקה 35</code> — מציג גבולות החלקה ישירות על המפה</span></div>' +
    '<div style="font-size:11px;color:#64748b;margin-top:10px;padding-top:8px;border-top:1px solid #e2e8f0">💡 הקש Enter לחיפוש או בחר תוצאה מהרשימה</div>';
  mw.appendChild(help);

  var input = document.getElementById('search-input');
  var clearBtn = document.getElementById('search-clear');
  var helpBtn = document.getElementById('search-help-btn');

  input.addEventListener('input', onInputChange);
  input.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSearch(); });
  input.addEventListener('focus', function() {
    var v = input.value.trim();
    if (v.length >= 2) showSuggestions(v);
  });
  document.addEventListener('click', function(e) {
    if (!bar.contains(e.target)) hideResults();
  });
  clearBtn.addEventListener('click', function() {
    input.value = '';
    clearBtn.classList.remove('show');
    hideResults();
    clearMapMarker();
    input.focus();
  });
  helpBtn.addEventListener('click', function() {
    document.getElementById('search-help').classList.toggle('show');
  });
}

function onInputChange() {
  var v = document.getElementById('search-input').value.trim();
  document.getElementById('search-clear').classList.toggle('show', v.length > 0);
  if (v.length < 2) { hideResults(); return; }
  showSuggestions(v);
}

// ── SMART INPUT PARSER ──
// Returns { type, ... } based on input format
function parseInput(raw) {
  var s = raw.trim();
  if (!s) return null;

  // Pattern: "32.91, 35.30" or "32.91 35.30" → WGS84 (lat in 29-34, lng in 34-36 for Israel)
  var coordMatch = s.match(/^(-?\d+\.?\d*)[\s,،]+(-?\d+\.?\d*)$/);
  if (coordMatch) {
    var a = parseFloat(coordMatch[1]);
    var b = parseFloat(coordMatch[2]);
    // Israel WGS84 range: lat 29-34, lng 34-36
    if (a >= 29 && a <= 34 && b >= 34 && b <= 36) {
      return { type: 'wgs84', lat: a, lng: b };
    }
    // Israel ITM range: X 100000-300000, Y 400000-800000
    if (a >= 100000 && a <= 300000 && b >= 400000 && b <= 900000) {
      return { type: 'itm', x: a, y: b };
    }
    // Check reversed: "lng, lat" WGS84
    if (b >= 29 && b <= 34 && a >= 34 && a <= 36) {
      return { type: 'wgs84', lat: b, lng: a, swapped: true };
    }
  }

  // Pattern: "12345/67" or "12345 / 67" or "גוש 12345 חלקה 67"
  var gushMatch = s.match(/(\d{4,6})\s*[\/\\\-]\s*(\d{1,4})/) ||
                  s.match(/גוש\s*(\d{4,6})[^\d]*חלקה\s*(\d{1,4})/) ||
                  s.match(/(\d{4,6})\s+חלקה\s*(\d{1,4})/);
  if (gushMatch) {
    return { type: 'gush_helka', gush: gushMatch[1], helka: gushMatch[2] };
  }

  // Otherwise — address
  return { type: 'address', query: s };
}

// ── SUGGESTIONS DROPDOWN ──
function showSuggestions(raw) {
  var parsed = parseInput(raw);
  var rs = document.getElementById('search-results');
  if (!parsed) { hideResults(); return; }

  var html = '';
  if (parsed.type === 'wgs84') {
    var note = parsed.swapped ? ' <span style="color:#d97706">(זוהה lng,lat → תוקן)</span>' : '';
    html = '<div class="sr-section">📍 קואורדינטות WGS84</div>' +
      '<div class="sr-item" onclick="window.searchExecute()">' +
        '<div class="sr-title"><span class="sr-icon">🎯</span>' + parsed.lat.toFixed(5) + '°N, ' + parsed.lng.toFixed(5) + '°E' + note + '</div>' +
        '<div class="sr-sub">לחץ או הקש Enter לעבור למיקום</div>' +
      '</div>';
  } else if (parsed.type === 'itm') {
    html = '<div class="sr-section">🇮🇱 קואורדינטות ITM (רשת ישראל)</div>' +
      '<div class="sr-item" onclick="window.searchExecute()">' +
        '<div class="sr-title"><span class="sr-icon">🎯</span>X=' + parsed.x.toLocaleString() + ', Y=' + parsed.y.toLocaleString() + '</div>' +
        '<div class="sr-sub">המרה אוטומטית ל-WGS84 ב-Enter</div>' +
      '</div>';
  } else if (parsed.type === 'gush_helka') {
    html = '<div class="sr-section">📐 גוש / חלקה</div>' +
      '<div class="sr-item" onclick="window.searchExecute()">' +
        '<div class="sr-title"><span class="sr-icon">📐</span>גוש ' + parsed.gush + ', חלקה ' + parsed.helka + '</div>' +
        '<div class="sr-sub">לחץ Enter להצגת גבולות החלקה על המפה</div>' +
      '</div>';
  } else if (parsed.type === 'address') {
    html = '<div class="sr-section">🏠 חיפוש כתובת</div>' +
      '<div class="sr-loading">⏳ מחפש "' + parsed.query + '"...</div>';
    rs.innerHTML = html;
    rs.classList.add('show');
    fetchAddressSuggestions(parsed.query);
    return;
  }

  rs.innerHTML = html;
  rs.classList.add('show');
}

function hideResults() {
  document.getElementById('search-results').classList.remove('show');
}

// ── ADDRESS SEARCH (Nominatim) ──
var gAddressDebounce = null;
function fetchAddressSuggestions(query) {
  if (gAddressDebounce) clearTimeout(gAddressDebounce);
  gAddressDebounce = setTimeout(async function() {
    try {
      // Bias to Israel + 7 villages bounding box
      var url = 'https://nominatim.openstreetmap.org/search?format=json' +
                '&q=' + encodeURIComponent(query) +
                '&countrycodes=il' +
                '&accept-language=he' +
                '&limit=6' +
                '&viewbox=35.10,33.00,35.50,32.80' +
                '&bounded=0';
      var resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      renderAddressResults(query, data);
    } catch(e) {
      console.error('Nominatim error:', e);
      var rs = document.getElementById('search-results');
      rs.innerHTML = '<div class="sr-section">🏠 חיפוש כתובת</div>' +
        '<div class="sr-empty">שגיאה בחיפוש. נסה שוב או השתמש בקואורדינטות.</div>';
    }
  }, 350);
}

function renderAddressResults(query, results) {
  var rs = document.getElementById('search-results');
  if (!results.length) {
    rs.innerHTML = '<div class="sr-section">🏠 חיפוש כתובת</div>' +
      '<div class="sr-empty">לא נמצאו תוצאות עבור "' + query + '"</div>';
    return;
  }
  rs.innerHTML = '<div class="sr-section">🏠 חיפוש כתובת — ' + results.length + ' תוצאות</div>' +
    results.map(function(r, i) {
      var name = r.display_name || r.name || '?';
      var parts = name.split(',').slice(0, 3).join(',');
      return '<div class="sr-item" onclick="window.searchPickAddress(' + i + ')">' +
        '<div class="sr-title"><span class="sr-icon">📍</span>' + parts + '</div>' +
        '<div class="sr-sub">' + parseFloat(r.lat).toFixed(5) + '°N, ' + parseFloat(r.lon).toFixed(5) + '°E</div>' +
      '</div>';
    }).join('');
  window._addressResults = results;
}

window.searchPickAddress = function(idx) {
  var r = window._addressResults[idx];
  if (!r) return;
  goToLocation(parseFloat(r.lat), parseFloat(r.lon),
               r.display_name.split(',').slice(0,2).join(','),
               '🏠 כתובת', 17);
  hideResults();
};

// ── ITM ↔ WGS84 CONVERSION ──
function itmToWgs84(x, y) {
  if (!window.proj4) return null;
  var wgs = window.proj4('EPSG:2039', 'EPSG:4326', [x, y]);
  return { lng: wgs[0], lat: wgs[1] };
}

// ── EXECUTE SEARCH (Enter or click) ──
window.searchExecute = function() {
  var raw = document.getElementById('search-input').value.trim();
  doSearch(raw);
};

function doSearch(raw) {
  raw = raw || document.getElementById('search-input').value.trim();
  var parsed = parseInput(raw);
  if (!parsed) return;

  if (parsed.type === 'wgs84') {
    goToLocation(parsed.lat, parsed.lng,
                 parsed.lat.toFixed(5) + '°N, ' + parsed.lng.toFixed(5) + '°E',
                 '📍 WGS84', 17);
    hideResults();
  } else if (parsed.type === 'itm') {
    if (!window.proj4) {
      loadProj4(function() {
        var w = itmToWgs84(parsed.x, parsed.y);
        if (w) goToLocation(w.lat, w.lng,
                            'X=' + parsed.x.toLocaleString() + ', Y=' + parsed.y.toLocaleString(),
                            '🇮🇱 ITM → WGS84', 17);
      });
    } else {
      var w = itmToWgs84(parsed.x, parsed.y);
      if (w) goToLocation(w.lat, w.lng,
                          'X=' + parsed.x.toLocaleString() + ', Y=' + parsed.y.toLocaleString(),
                          '🇮🇱 ITM → WGS84', 17);
    }
    hideResults();
  } else if (parsed.type === 'gush_helka') {
    handleGushHelka(parsed.gush, parsed.helka);
    hideResults();
  } else if (parsed.type === 'address') {
    // For Enter on address input — pick first result if available
    if (window._addressResults && window._addressResults.length) {
      window.searchPickAddress(0);
    }
  }
}

// ── GUSH/HELKA — proxied through our own Vercel serverless function ──
// /api/parcel handles CORS + tries multiple Israeli cadastre backends server-side
function handleGushHelka(gush, helka) {
  clearMapMarker();
  showPanel(
    '📐 גוש ' + gush + ' · חלקה ' + helka,
    '<span style="color:#64748b">⏳ מחפש חלקה...</span>'
  );

  fetch('/api/parcel?gush=' + encodeURIComponent(gush) + '&helka=' + encodeURIComponent(helka))
    .then(function(r) {
      if (r.status === 404) throw new Error('not found');
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    })
    .then(function(data) { renderParcelPolygon(gush, helka, data); })
    .catch(function(e) {
      console.error('Gush/Helka error:', e.message);
      showPanel(
        '📐 גוש ' + gush + ' · חלקה ' + helka,
        (e.message === 'not found'
          ? '❌ לא נמצאה חלקה זו במאגר.'
          : '❌ שגיאה בחיפוש. נסה שוב.') +
        '<br><span style="font-size:11px;color:#64748b">ודא שמספרי הגוש והחלקה נכונים.</span>'
      );
    });
}

function renderParcelPolygon(gush, helka, data) {
  if (!data.features || !data.features.length) {
    showPanel('📐 גוש ' + gush + ' · חלקה ' + helka, '❌ לא נמצאה חלקה זו במאגר הקדסטר.');
    return;
  }
  var feat  = data.features[0];
  var rings = feat.geometry && feat.geometry.rings;
  if (!rings || !rings.length) {
    showPanel('📐 גוש ' + gush + ' · חלקה ' + helka, '⚠️ נמצאה חלקה אך חסרים נתוני גבולות.');
    return;
  }

  var latlngs = rings.map(function(ring) {
    return ring.map(function(pt) { return [pt[1], pt[0]]; });
  });
  gPolygon = L.polygon(latlngs, {
    color: '#1a7fc1', weight: 2.5, fillColor: '#1a7fc1', fillOpacity: 0.15, interactive: false
  }).addTo(window.gMap);
  window.gMap.flyToBounds(gPolygon.getBounds(), { padding: [60, 60], maxZoom: 18, duration: 1.2 });

  var area = (feat.attributes || {}).SHAPE_Area;
  showParcelPanel(gush, helka, area);
}

function showParcelPanel(gush, helka, area) {
  var areaStr = area
    ? 'שטח: ' + (area / 1000).toFixed(3) + ' דונם (' + Math.round(area) + ' מ"ר)<br>'
    : '';
  showPanel(
    '📐 גוש ' + gush + ' · חלקה ' + helka,
    areaStr +
    '<span style="font-size:11px;color:#64748b;display:block;margin-top:6px">' +
      '<span style="cursor:pointer;color:#dc2626" onclick="window.searchClearMarker()">✖ הסר סימון</span>' +
    '</span>'
  );
}

// ── DISPLAY MARKER + ZOOM ──
function goToLocation(lat, lng, title, subtitle, zoom) {
  if (!window.gMap) { alert('המפה לא נטענה'); return; }
  clearMapMarker();

  // Create custom marker
  var ic = L.divIcon({
    className: '',
    html: '<div style="width:28px;height:28px;background:#dc2626;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 3px 10px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);color:#fff;font-size:14px;font-weight:800">!</span></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 28]
  });
  gMarker = L.marker([lat, lng], { icon: ic }).addTo(window.gMap);
  gMarker.bindPopup(
    '<div class="search-result-popup">' +
      '<div style="font-weight:700;color:#0d3b5e;font-size:13px;margin-bottom:4px">' + subtitle + '</div>' +
      '<div style="font-size:12px;color:#1e293b">' + title + '</div>' +
      '<div style="margin-top:6px;padding-top:5px;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b">' +
        '<span style="cursor:pointer;color:#dc2626" onclick="window.searchClearMarker()">✖ הסר סימון</span>' +
      '</div>' +
    '</div>'
  ).openPopup();

  window.gMap.flyTo([lat, lng], zoom || 17, { duration: 1.2 });

  showPanel(subtitle, title);
}

function clearMapMarker() {
  if (gMarker) { window.gMap.removeLayer(gMarker); gMarker = null; }
  if (gPolygon) { window.gMap.removeLayer(gPolygon); gPolygon = null; }
  hidePanel();
}
window.searchClearMarker = clearMapMarker;

// ── INFO PANEL ──
function showPanel(title, content) {
  hidePanel();
  gPanel = document.createElement('div');
  gPanel.id = 'search-info-panel';
  gPanel.style.cssText = 'position:absolute;top:14px;right:14px;background:#fff;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,0.18);width:280px;max-width:calc(100vw - 580px);z-index:445;padding:14px;direction:rtl;font-family:\'Segoe UI\',Tahoma,Arial,sans-serif;border:1px solid #e2e8f0';
  gPanel.innerHTML =
    '<button onclick="window.searchClearMarker()" style="position:absolute;top:8px;left:10px;background:none;border:none;cursor:pointer;font-size:14px;color:#94a3b8;padding:0">✖</button>' +
    '<div style="font-weight:700;color:#0d3b5e;font-size:13px;margin-bottom:6px;padding-left:20px">' + title + '</div>' +
    '<div style="font-size:12px;color:#1e293b;line-height:1.5">' + content + '</div>';
  var mw = document.getElementById('map-wrap');
  if (mw) mw.appendChild(gPanel);
}

function hidePanel() {
  if (gPanel && gPanel.parentNode) gPanel.parentNode.removeChild(gPanel);
  gPanel = null;
}

// ── INIT ──
function init() {
  if (!document.getElementById('map-wrap')) {
    setTimeout(init, 200); return;
  }
  injectUI();
  loadProj4(function() { console.log('✓ proj4 loaded for ITM'); });
  console.log('✓ Search feature loaded');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
