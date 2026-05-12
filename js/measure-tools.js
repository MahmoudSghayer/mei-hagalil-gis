/* Measurement tools — distance, area, bearing, radius */
var MeasureTools = (function () {
  var map, active = null;
  var drawn = [];       // all committed layers
  var tempLine = null;  // rubber-band polyline
  var tempCircle = null;
  var pts = [];         // click points for active tool

  // ── Math helpers ──────────────────────────────────────────
  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
            Math.sin(dLng/2)*Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function bearingDeg(lat1, lng1, lat2, lng2) {
    var f1 = lat1 * Math.PI/180, f2 = lat2 * Math.PI/180;
    var dl = (lng2 - lng1) * Math.PI/180;
    var y = Math.sin(dl)*Math.cos(f2);
    var x = Math.cos(f1)*Math.sin(f2) - Math.sin(f1)*Math.cos(f2)*Math.cos(dl);
    return ((Math.atan2(y, x) * 180/Math.PI) + 360) % 360;
  }

  function polygonAreaM2(points) {
    if (points.length < 3) return 0;
    var refLat = points.reduce(function(s,p){return s+p.lat;},0) / points.length;
    var mLat = 111320;
    var mLng = 111320 * Math.cos(refLat * Math.PI / 180);
    var n = points.length, area = 0;
    for (var i = 0; i < n; i++) {
      var j = (i+1) % n;
      area += points[i].lng * mLng * points[j].lat * mLat;
      area -= points[j].lng * mLng * points[i].lat * mLat;
    }
    return Math.abs(area) / 2;
  }

  function fmtDist(m) {
    if (m < 1000) return m.toFixed(1) + ' מ׳';
    return (m / 1000).toFixed(3) + ' ק"מ';
  }

  function fmtArea(m2) {
    var dunam = (m2 / 1000).toFixed(3);
    var sqm = m2.toFixed(0);
    var ha = m2 >= 10000 ? ' · ' + (m2/10000).toFixed(4) + ' ה׳' : '';
    return sqm + ' מ"ר · ' + dunam + ' דונם' + ha;
  }

  function compassHe(deg) {
    var dirs = ['צפון','צפון-מזרח','מזרח','דרום-מזרח','דרום','דרום-מערב','מערב','צפון-מערב'];
    return dirs[Math.round(deg / 45) % 8];
  }

  function totalDist() {
    var d = 0;
    for (var i = 1; i < pts.length; i++)
      d += haversine(pts[i-1].lat, pts[i-1].lng, pts[i].lat, pts[i].lng);
    return d;
  }

  function midPt(a, b) { return { lat:(a.lat+b.lat)/2, lng:(a.lng+b.lng)/2 }; }

  // ── Instruction banner ────────────────────────────────────
  var bannerEl = null;
  function showBanner(msg) {
    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.id = 'mt-banner';
      document.getElementById('map-wrap').appendChild(bannerEl);
    }
    bannerEl.innerHTML = msg;
    bannerEl.style.display = 'block';
  }
  function hideBanner() { if (bannerEl) bannerEl.style.display = 'none'; }

  // ── Result label on map ───────────────────────────────────
  function addResult(latlng, html) {
    var icon = L.divIcon({ className: 'mt-result-icon', html: html, iconSize: null, iconAnchor: [0, 0] });
    var m = L.marker([latlng.lat, latlng.lng], { icon: icon, interactive: false }).addTo(map);
    drawn.push(m);
    return m;
  }

  // ── Vertex dot ────────────────────────────────────────────
  function addDot(latlng) {
    var d = L.circleMarker([latlng.lat, latlng.lng], {
      radius: 5, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1, interactive: false
    }).addTo(map);
    drawn.push(d);
  }

  // ── Finish handlers ───────────────────────────────────────
  function finishDistance() {
    clearTemp();
    var latlngs = pts.map(function(p){return [p.lat, p.lng];});
    var line = L.polyline(latlngs, { color:'#f59e0b', weight:3, opacity:0.9, interactive:false }).addTo(map);
    drawn.push(line);
    var total = totalDist();
    var last = pts[pts.length-1];
    addResult(last, '<div class="mt-result-box">' +
      '<div class="mt-r-title">📏 מרחק כולל</div>' +
      '<div class="mt-r-val">' + fmtDist(total) + '</div>' +
      '<div class="mt-r-sub">' + pts.length + ' נקודות</div>' +
      '</div>');
    deactivate();
  }

  function finishArea() {
    clearTemp();
    var latlngs = pts.map(function(p){return [p.lat, p.lng];});
    var poly = L.polygon(latlngs, { color:'#10b981', weight:2.5, opacity:0.9, fillColor:'#10b981', fillOpacity:0.1, interactive:false }).addTo(map);
    drawn.push(poly);
    var area = polygonAreaM2(pts);
    var centLat = pts.reduce(function(s,p){return s+p.lat;},0)/pts.length;
    var centLng = pts.reduce(function(s,p){return s+p.lng;},0)/pts.length;
    addResult({lat:centLat, lng:centLng}, '<div class="mt-result-box">' +
      '<div class="mt-r-title">📐 שטח פוליגון</div>' +
      '<div class="mt-r-val">' + (area/1000).toFixed(3) + ' דונם</div>' +
      '<div class="mt-r-sub">' + area.toFixed(0) + ' מ"ר · ' + pts.length + ' פינות</div>' +
      '</div>');
    deactivate();
  }

  function finishBearing() {
    clearTemp();
    var a = pts[0], b = pts[1];
    var br = bearingDeg(a.lat, a.lng, b.lat, b.lng);
    var dist = haversine(a.lat, a.lng, b.lat, b.lng);
    var line = L.polyline([[a.lat,a.lng],[b.lat,b.lng]], { color:'#8b5cf6', weight:3, opacity:0.9, interactive:false }).addTo(map);
    drawn.push(line);
    addResult(b, '<div class="mt-result-box">' +
      '<div class="mt-r-title">🧭 כיוון / אזימוט</div>' +
      '<div class="mt-r-val">' + br.toFixed(2) + '°</div>' +
      '<div class="mt-r-sub">' + compassHe(br) + ' · ' + fmtDist(dist) + '</div>' +
      '</div>');
    deactivate();
  }

  function finishRadius() {
    clearTemp();
    var a = pts[0], b = pts[1];
    var r = haversine(a.lat, a.lng, b.lat, b.lng);
    var area = Math.PI * r * r;
    var circle = L.circle([a.lat, a.lng], { radius:r, color:'#06b6d4', weight:2.5, opacity:0.9, fillColor:'#06b6d4', fillOpacity:0.07, interactive:false }).addTo(map);
    drawn.push(circle);
    addResult({lat:a.lat, lng:a.lng}, '<div class="mt-result-box">' +
      '<div class="mt-r-title">⭕ רדיוס / מעגל</div>' +
      '<div class="mt-r-val">' + fmtDist(r) + '</div>' +
      '<div class="mt-r-sub">שטח: ' + (area/1000).toFixed(2) + ' דונם</div>' +
      '</div>');
    deactivate();
  }

  // ── Map event handlers ────────────────────────────────────
  function onMouseMove(e) {
    if (!pts.length) return;
    var ll = e.latlng;
    if (active === 'distance' || active === 'area') {
      var latlngs = pts.map(function(p){return [p.lat,p.lng];});
      latlngs.push([ll.lat, ll.lng]);
      if (active === 'area' && pts.length >= 2) latlngs.push([pts[0].lat, pts[0].lng]);
      if (tempLine) tempLine.setLatLngs(latlngs);
      else tempLine = L.polyline(latlngs, { color:'#f59e0b', weight:2, dashArray:'6,4', opacity:0.8, interactive:false }).addTo(map);
      if (active === 'distance') {
        var seg = haversine(pts[pts.length-1].lat, pts[pts.length-1].lng, ll.lat, ll.lng);
        var ttl = totalDist() + seg;
        showBanner('📏 &nbsp;מקטע נוכחי: <b>' + fmtDist(seg) + '</b> &nbsp;|&nbsp; סה"כ: <b>' + fmtDist(ttl) + '</b> &nbsp;|&nbsp; לחץ פעמיים לסיום');
      }
    } else if ((active === 'bearing' || active === 'radius') && pts.length === 1) {
      var latlngs = [[pts[0].lat,pts[0].lng],[ll.lat,ll.lng]];
      if (tempLine) tempLine.setLatLngs(latlngs);
      else tempLine = L.polyline(latlngs, { color:'#f59e0b', weight:2, dashArray:'6,4', opacity:0.8, interactive:false }).addTo(map);
      if (active === 'radius') {
        var r = haversine(pts[0].lat, pts[0].lng, ll.lat, ll.lng);
        if (tempCircle) tempCircle.setRadius(r);
        else tempCircle = L.circle([pts[0].lat,pts[0].lng], { radius:r, color:'#06b6d4', weight:1.5, dashArray:'4,4', fillOpacity:0.04, interactive:false }).addTo(map);
        showBanner('⭕ &nbsp;רדיוס: <b>' + fmtDist(r) + '</b> &nbsp;|&nbsp; לחץ לאישור');
      } else {
        var br = bearingDeg(pts[0].lat, pts[0].lng, ll.lat, ll.lng);
        showBanner('🧭 &nbsp;כיוון: <b>' + br.toFixed(1) + '° ' + compassHe(br) + '</b> &nbsp;|&nbsp; לחץ לאישור');
      }
    }
  }

  function onClick(e) {
    pts.push({ lat: e.latlng.lat, lng: e.latlng.lng });
    addDot({ lat: e.latlng.lat, lng: e.latlng.lng });

    if (active === 'distance') {
      if (pts.length >= 2) {
        var seg = haversine(pts[pts.length-2].lat, pts[pts.length-2].lng, pts[pts.length-1].lat, pts[pts.length-1].lng);
        var mid = midPt(pts[pts.length-2], pts[pts.length-1]);
        var icon = L.divIcon({ className:'mt-seg-label', html:'<span>' + fmtDist(seg) + '</span>', iconSize:null });
        var lbl = L.marker([mid.lat, mid.lng], { icon:icon, interactive:false }).addTo(map);
        drawn.push(lbl);
      }
      showBanner('📏 &nbsp;לחץ להוסיף נקודה &nbsp;|&nbsp; לחץ פעמיים לסיום &nbsp;(' + pts.length + ' נקודות)');
    }
    if (active === 'area') {
      showBanner('📐 &nbsp;לחץ להוסיף פינה &nbsp;|&nbsp; לחץ פעמיים לסגירה &nbsp;(' + pts.length + ' פינות)');
    }
    if (active === 'bearing' && pts.length === 1) {
      showBanner('🧭 &nbsp;כעת לחץ על נקודת הסיום');
    }
    if (active === 'bearing' && pts.length === 2) finishBearing();
    if (active === 'radius' && pts.length === 1) {
      showBanner('⭕ &nbsp;כעת לחץ על קצה המעגל');
    }
    if (active === 'radius' && pts.length === 2) finishRadius();
  }

  function onDblClick(e) {
    if (active === 'distance' && pts.length >= 2) {
      pts.pop(); // remove extra point added by the click before dblclick
      drawn.pop() && map.removeLayer(drawn[drawn.length]); // remove last dot
      finishDistance();
    } else if (active === 'area' && pts.length >= 3) {
      pts.pop();
      finishArea();
    }
  }

  function clearTemp() {
    if (tempLine)   { map.removeLayer(tempLine);   tempLine = null; }
    if (tempCircle) { map.removeLayer(tempCircle); tempCircle = null; }
  }

  // ── Toolbar ───────────────────────────────────────────────
  function buildToolbar() {
    var wrap = document.getElementById('map-wrap');
    if (!wrap || document.getElementById('measure-toolbar')) return;
    var el = document.createElement('div');
    el.id = 'measure-toolbar';
    el.setAttribute('dir', 'rtl');
    el.innerHTML =
      '<div class="mt-header">🛠 מדידה</div>' +
      '<button class="mt-btn" id="mt-btn-distance" onclick="MeasureTools.activate(\'distance\')" title="מרחק נקודה לנקודה">📏<span>מרחק</span></button>' +
      '<button class="mt-btn" id="mt-btn-area"     onclick="MeasureTools.activate(\'area\')"     title="שטח פוליגון">📐<span>שטח</span></button>' +
      '<button class="mt-btn" id="mt-btn-bearing"  onclick="MeasureTools.activate(\'bearing\')"  title="כיוון ואזימוט">🧭<span>כיוון</span></button>' +
      '<button class="mt-btn" id="mt-btn-radius"   onclick="MeasureTools.activate(\'radius\')"   title="רדיוס ושטח מעגל">⭕<span>רדיוס</span></button>' +
      '<div class="mt-sep"></div>' +
      '<button class="mt-btn mt-clear" onclick="MeasureTools.clearAll()" title="נקה הכל">🗑<span>נקה</span></button>';
    wrap.appendChild(el);
  }

  function setActiveBtn(tool) {
    document.querySelectorAll('.mt-btn').forEach(function(b){ b.classList.remove('active'); });
    if (tool) {
      var btn = document.getElementById('mt-btn-' + tool);
      if (btn) btn.classList.add('active');
    }
  }

  // ── Public API ────────────────────────────────────────────
  function activate(tool) {
    if (active === tool) { deactivate(); return; }
    deactivate();
    active = tool;
    pts = [];
    setActiveBtn(tool);
    map.getContainer().classList.add('mt-cursor');
    map.doubleClickZoom.disable();
    map.on('click', onClick);
    map.on('dblclick', onDblClick);
    map.on('mousemove', onMouseMove);
    var instrs = {
      distance: '📏 &nbsp;לחץ להוסיף נקודות מרחק &nbsp;|&nbsp; לחץ פעמיים לסיום &nbsp;|&nbsp; ESC לביטול',
      area:     '📐 &nbsp;לחץ להוסיף פינות פוליגון &nbsp;|&nbsp; לחץ פעמיים לסגירה &nbsp;|&nbsp; ESC לביטול',
      bearing:  '🧭 &nbsp;לחץ על נקודת ההתחלה &nbsp;|&nbsp; ESC לביטול',
      radius:   '⭕ &nbsp;לחץ על מרכז המעגל &nbsp;|&nbsp; ESC לביטול'
    };
    showBanner(instrs[tool] || '');
  }

  function deactivate() {
    if (!active) return;
    active = null;
    pts = [];
    clearTemp();
    map.off('click', onClick);
    map.off('dblclick', onDblClick);
    map.off('mousemove', onMouseMove);
    map.doubleClickZoom.enable();
    map.getContainer().classList.remove('mt-cursor');
    setActiveBtn(null);
    hideBanner();
  }

  function clearAll() {
    deactivate();
    drawn.forEach(function(l){ try { map.removeLayer(l); } catch(e){} });
    drawn = [];
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') deactivate();
  });

  return {
    init: function(m) { map = m; buildToolbar(); },
    activate: activate,
    clearAll: clearAll
  };
})();
