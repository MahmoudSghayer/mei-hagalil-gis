// ── VILLAGE COORDINATES (for filter zoom) ──
var VILLAGES = [
  { name: 'מגד אל-כרום', lat: 32.9189, lng: 35.2456 },
  { name: 'בענה',         lat: 32.9485, lng: 35.2617 },
  { name: 'דיר אל-אסד',   lat: 32.9356, lng: 35.2697 },
  { name: 'נחף',           lat: 32.9344, lng: 35.3025 },
  { name: 'סחנין',         lat: 32.8650, lng: 35.2978 },
  { name: 'דיר חנא',       lat: 32.8631, lng: 35.3589 },
  { name: 'עראבה',         lat: 32.8514, lng: 35.3339 }
];

// ── ALL LAYER CATEGORIES (existing + 13 new) ──
var SUB_LAYERS = {
  // Existing (DWG-derived)
  sewage_pipe:      { label:'קווי ביוב (DWG)', icon:'─', color:'#fbbf24', type:'line', weight:3, dashArray:'7,4', defaultOn:true },
  manhole:          { label:'שוחות ביוב (DWG)', icon:'⭕', color:'#06b6d4', type:'point', radius:5, defaultOn:true },
  sleeve:           { label:'שרוולים', icon:'⊟', color:'#a855f7', type:'line', weight:2, defaultOn:true },
  control_point:    { label:'נקודות בקרה', icon:'◉', color:'#ef4444', type:'point', radius:6, defaultOn:true },
  pipe_label:       { label:'תוויות צנרת', icon:'🏷️', color:'#fbbf24', type:'label', defaultOn:false },
  elevation_label:  { label:'גבהים (TL/IL)', icon:'📏', color:'#fde047', type:'label', defaultOn:false },
  attribute_label:  { label:'תוויות שוחות', icon:'#', color:'#a7f3d0', type:'label', defaultOn:false },
  distance_label:   { label:'מרחקים', icon:'↔', color:'#c4b5fd', type:'label', defaultOn:false },
  dimension_line:   { label:'קווי מידה', icon:'┄', color:'#cbd5e1', type:'line', weight:1, dashArray:'2,3', defaultOn:false },
  manhole_drawing:  { label:'שרטוטי שוחות', icon:'◇', color:'#94a3b8', type:'line', weight:1, defaultOn:false },
  // 13 NEW categories
  buildings:        { label:'🏢 בניינים', icon:'■', color:'#92400e', type:'mixed', defaultOn:true },
  parcels:          { label:'📐 חלקות', icon:'◇', color:'#ca8a04', type:'line', weight:1.5, defaultOn:false },
  water_meters:     { label:'🔢 מדי מים', icon:'■', color:'#0ea5e9', type:'point', radius:4, defaultOn:true },
  water_pipes:      { label:'💧 קווי מים', icon:'─', color:'#0284c7', type:'line', weight:3, defaultOn:true },
  sewage_pipes:     { label:'🟤 קווי ביוב', icon:'─', color:'#a16207', type:'line', weight:3, dashArray:'7,4', defaultOn:true },
  sewage_manholes:  { label:'⭕ שוחות ביוב', icon:'●', color:'#854d0e', type:'point', radius:5, defaultOn:true },
  hydrants:         { label:'🚒 הידרנטים', icon:'★', color:'#dc2626', type:'point', radius:6, defaultOn:true },
  valves:           { label:'🔧 מגופים', icon:'◆', color:'#7c3aed', type:'point', radius:5, defaultOn:true },
  control_valves:   { label:'⚙️ מגופים שולטים', icon:'◈', color:'#5b21b6', type:'point', radius:6, defaultOn:true },
  connection_points:{ label:'🔌 נקודות חיבור מקורות', icon:'⬢', color:'#0891b2', type:'point', radius:6, defaultOn:true },
  reservoirs:       { label:'🏗️ מאגרי מים', icon:'▣', color:'#0d9488', type:'mixed', defaultOn:true },
  pump_stations:    { label:'⛽ תחנות שאיבה', icon:'▲', color:'#15803d', type:'point', radius:7, defaultOn:true },
  sampling_points:  { label:'🧪 נקודות דיגום', icon:'•', color:'#be185d', type:'point', radius:5, defaultOn:false },
  main_sewer:         { label:'🔴 ביב ראשי', icon:'─', color:'#7f1d1d', type:'line', weight:3.5, defaultOn:true },
  supply_pipe:        { label:'🔵 קו הספקה', icon:'─', color:'#0369a1', type:'line', weight:2.5, defaultOn:true },
  sewage_cascade:     { label:'⬇️ מפל ביוב', icon:'⬇', color:'#92400e', type:'point', radius:5, defaultOn:true },
  fittings:           { label:'🔩 מתאמים', icon:'◈', color:'#64748b', type:'point', radius:4, defaultOn:true },
  annotation_points:  { label:'📍 נקודות להערות', icon:'•', color:'#f59e0b', type:'point', radius:4, defaultOn:false },
  sewer_exit:         { label:'🚪 יציאה מרשת ביוב', icon:'●', color:'#6b21a8', type:'point', radius:5, defaultOn:true },
  annotation_polygons:{ label:'🔷 פוליגונים להערות', icon:'◇', color:'#f59e0b', type:'polygon', defaultOn:false },
  annotation_lines:   { label:'📏 קווים להערות', icon:'─', color:'#f59e0b', type:'line', weight:1.5, dashArray:'4,3', defaultOn:false },
  valve_chamber:      { label:'🔲 תא מגופים', icon:'▣', color:'#0f766e', type:'point', radius:6, defaultOn:true },
  block:              { label:'🗂️ גוש', icon:'◇', color:'#ca8a04', type:'mixed', defaultOn:false },
  other:              { label:'אחר', icon:'·', color:'#94a3b8', type:'mixed', defaultOn:false }
};

var gMap, gIncidentsLayer, gIncidents=[], gMarkers={};
var gCurrentBasemap = 'satellite';
var gActiveBasemapLayers = [];
var gCadastralLayer = null, gCadastralVisible = false;
var gVillages = [], gVillageLayers = {}, gVillageState = {}, gVillageBounds = {};
var gLastLat=null, gLastLng=null, gFilter='';
var gUser=null, gProfile=null, gClosingId=null;

var PRIORITY_COLORS={high:'#dc2626',medium:'#d97706',low:'#16a34a'};
var PRIORITY_HE={high:'גבוהה',medium:'בינונית',low:'נמוכה'};
var STATUS_HE={open:'פתוחה',in_progress:'בטיפול',closed:'סגורה'};
var ROLE_HE={admin:'מנהל מערכת',user:'משתמש'};

window.addEventListener('load', async function() {
  var res = await gSb.auth.getSession();
  if (!res.data || !res.data.session) { window.location.replace('pages/login.html'); return; }
  gUser = res.data.session.user;
  gProfile = await getProfile(gUser, true);
  if (!gProfile) return;
  setUserUI(gProfile);
  initMap();
  initSB();
  await loadAllVillages();
  document.getElementById('app').classList.add('ready');
});

function setUserUI(p) {
  var name = p.full_name || gUser.email.split('@')[0];
  var initials = name.split(' ').map(function(w){return w[0]||'';}).join('').substring(0,2).toUpperCase() || '??';
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-role-label').textContent = ROLE_HE[p.role] || p.role;
  document.getElementById('dd-name').textContent = name;
  document.getElementById('dd-email').textContent = gUser.email;
  if (p.role === 'admin') {
    document.getElementById('admin-link').style.display = 'inline-block';
    document.getElementById('logs-link').style.display = 'inline-block';
    document.getElementById('upload-link').style.display = 'inline-block';
  }
}

function toggleDD() { document.getElementById('user-dd').classList.toggle('open'); }

function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  var btn = document.getElementById('sidebar-collapse-btn');
  var collapsed = sb.classList.toggle('collapsed');
  btn.textContent = collapsed ? '›' : '‹';
  setTimeout(function() { gMap && gMap.invalidateSize(); }, 300);
}
document.addEventListener('click', function(e) {
  var btn = document.getElementById('user-btn');
  if (btn && !btn.contains(e.target)) document.getElementById('user-dd').classList.remove('open');
});

function openSettings() { document.getElementById('user-dd').classList.remove('open'); document.getElementById('s-name').value=gProfile?gProfile.full_name||'':''; document.getElementById('s-phone').value=gProfile?gProfile.phone||'':''; document.getElementById('s-email').value=gUser?gUser.email:''; document.getElementById('settings-bg').classList.add('open'); }
function closeSettings() { document.getElementById('settings-bg').classList.remove('open'); }
async function saveSettings() { var name=document.getElementById('s-name').value.trim(),phone=document.getElementById('s-phone').value.trim(); var res=await gSb.from('profiles').update({full_name:name,phone:phone}).eq('id',gUser.id); if(res.error){showToast('שגיאה');return;} if(gProfile){gProfile.full_name=name;gProfile.phone=phone;} setUserUI(gProfile); closeSettings(); showToast('✅ עודכן'); }
function openChangePass() { document.getElementById('user-dd').classList.remove('open'); document.getElementById('p-new').value=''; document.getElementById('p-confirm').value=''; document.getElementById('p-fill').style.width='0'; document.getElementById('pass-bg').classList.add('open'); }
function closePassModal() { document.getElementById('pass-bg').classList.remove('open'); }
function checkStr(val){var fill=document.getElementById('p-fill'),score=0;if(val.length>=8)score++;if(val.length>=12)score++;if(/[A-Z]/.test(val))score++;if(/[0-9]/.test(val))score++;if(/[^A-Za-z0-9]/.test(val))score++;var map=[{w:'20%',bg:'#dc2626'},{w:'40%',bg:'#f97316'},{w:'60%',bg:'#eab308'},{w:'80%',bg:'#22c55e'},{w:'100%',bg:'#16a34a'}];var s=map[Math.min(score-1,4)]||map[0];fill.style.width=s.w;fill.style.background=s.bg;}
async function changePass(){var p=document.getElementById('p-new').value,c=document.getElementById('p-confirm').value;if(p.length<8){showToast('לפחות 8 תווים');return;}if(p!==c){showToast('הסיסמאות לא תואמות');return;}var res=await gSb.auth.updateUser({password:p});if(res.error){showToast('שגיאה');return;}closePassModal();showToast('✅ עודכן');}

// ════════════════════════════════════════════════════════════
//  MAP (FIXED ZOOM: 20 max, 19 native)
// ════════════════════════════════════════════════════════════
function initMap() {
  gMap = L.map('map', { zoomControl:false, attributionControl:false, maxZoom:20 }).setView([32.91,35.30],11);
  L.control.zoom({ position: 'topright' }).addTo(gMap);
  applyBasemap(gCurrentBasemap);
  gMap.on('mousemove', function(e) {
    var txt = e.latlng.lat.toFixed(5) + '° N,  ' + e.latlng.lng.toFixed(5) + '° E';
    document.getElementById('coords').textContent = txt;
    document.getElementById('tc-coords').textContent = txt;
  });
  gMap.on('mouseout', function() {
    document.getElementById('tc-coords').textContent = '— הזז עכבר על המפה —';
  });
  gMap.on('zoomend',function(){document.getElementById('zoom-level').textContent=gMap.getZoom();});
  gMap.on('click',function(e){gLastLat=e.latlng.lat;gLastLng=e.latlng.lng;});
  gIncidentsLayer = L.layerGroup().addTo(gMap);
  MeasureTools.init(gMap);
  initCadastralLayer();
}

function initCadastralLayer() {
  gCadastralLayer = L.tileLayer.wms('https://www.govmap.gov.il/api/geoserver/ows/public/', {
    layers: 'govmap:layer_parcel_all',
    styles: 'govmap:layer_parcel_all',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    FEATUREVERSION: 2,
    TILED: true,
    maxZoom: 20,
    opacity: 1
  });

  gMap.on('click', function(e) {
    if (!gCadastralVisible) return;
    queryCadastralParcel(e);
  });
}

function toggleCadastralLayer() {
  gCadastralVisible = !gCadastralVisible;
  if (gCadastralVisible) {
    gCadastralLayer.addTo(gMap);
    gCadastralLayer.bringToFront();
  } else {
    gMap.removeLayer(gCadastralLayer);
    gMap.closePopup();
  }
  document.getElementById('cadastral-toggle').classList.toggle('active', gCadastralVisible);
}
window.toggleCadastralLayer = toggleCadastralLayer;

function queryCadastralParcel(e) {
  var bounds = gMap.getBounds();
  var size   = gMap.getSize();
  var sw = _latlngToMerc(bounds.getSouth(), bounds.getWest());
  var ne = _latlngToMerc(bounds.getNorth(), bounds.getEast());
  var bbox = sw[0] + ',' + sw[1] + ',' + ne[0] + ',' + ne[1];
  var cp   = e.containerPoint;

  var url = 'https://www.govmap.gov.il/api/geoserver/ows/public/?' +
    'REQUEST=GetFeatureInfo&SERVICE=WMS&VERSION=1.3.0' +
    '&LAYERS=govmap:layer_parcel_all&QUERY_LAYERS=govmap:layer_parcel_all' +
    '&CRS=EPSG:3857&FEATUREVERSION=2' +
    '&BBOX=' + bbox +
    '&WIDTH=' + size.x + '&HEIGHT=' + size.y +
    '&I=' + Math.round(cp.x) + '&J=' + Math.round(cp.y) +
    '&INFO_FORMAT=application/json&FEATURE_COUNT=1';

  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var features = data.features || [];
      if (!features.length) return;
      var p    = features[0].properties || {};
      var gush  = p.GUSH_NUM  || p.gush_num  || p.GUSH  || p.gush  || '—';
      var helka = p.PARCEL_NUM || p.parcel_num || p.HELKA_NUM || p.helka_num || p.HELKA || p.helka || '—';
      var area  = p.SHAPE_Area || p.shape_area || p.AREA || p.area || null;
      var areaStr = area ? '<div style="margin-top:4px">שטח: <b>' + (area / 1000).toFixed(3) + ' דונם</b></div>' : '';
      L.popup({ direction: 'top', className: 'cadastral-popup' })
        .setLatLng(e.latlng)
        .setContent(
          '<div style="direction:rtl;font-family:inherit;line-height:1.6">' +
          '<div style="font-weight:700;font-size:13px;margin-bottom:4px">📐 נתוני חלקה</div>' +
          '<div>גוש: <b>' + gush + '</b></div>' +
          '<div>חלקה: <b>' + helka + '</b></div>' +
          areaStr +
          '</div>'
        )
        .openOn(gMap);
    })
    .catch(function() {});
}

function _latlngToMerc(lat, lng) {
  var R = 6378137;
  return [lng * Math.PI / 180 * R, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R];
}

function applyBasemap(key) {
  gActiveBasemapLayers.forEach(function(l) { gMap.removeLayer(l); });
  gActiveBasemapLayers = [];
  var isDark = false, name = '';
  if (key === 'satellite') {
    name = 'Google לוויין HD'; isDark = true;
    gActiveBasemapLayers = [
      L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { maxZoom:20, maxNativeZoom:19, subdomains:['0','1','2','3'], attribution:'Google' })
    ];
  } else if (key === 'hybrid') {
    name = 'Google היברידי'; isDark = true;
    gActiveBasemapLayers = [
      L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom:20, maxNativeZoom:19, subdomains:['0','1','2','3'], attribution:'Google' })
    ];
  } else if (key === 'streets') {
    name = 'Google רחובות'; isDark = false;
    gActiveBasemapLayers = [
      L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom:20, maxNativeZoom:19, subdomains:['0','1','2','3'], attribution:'Google' })
    ];
  } else if (key === 'light') {
    name = 'CartoDB בהיר'; isDark = false;
    gActiveBasemapLayers = [
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom:20, maxNativeZoom:19, attribution:'CartoDB' })
    ];
  }
  gActiveBasemapLayers.forEach(function(l) { l.addTo(gMap); l.bringToBack(); });
  document.body.classList.toggle('dark-basemap', !!isDark);
  document.getElementById('basemap-name').textContent = name;
  document.querySelectorAll('.basemap-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-basemap') === key);
  });
  gCurrentBasemap = key;
}

function switchBasemap(key) { applyBasemap(key); }
window.switchBasemap = switchBasemap;

// ════════════════════════════════════════════════════════════
//  LOAD VILLAGES
// ════════════════════════════════════════════════════════════
async function loadAllVillages() {
  var listRes = await gSb.from('village_layers').select('*').eq('is_active', true).order('uploaded_at', {ascending: true});
  if (listRes.error || !listRes.data || !listRes.data.length) {
    document.getElementById('dwg-layers-list').innerHTML = '<div class="empty-msg" style="font-size:11px;padding:8px 0">אין שכבות עדיין' + (gProfile.role === 'admin' ? '. <a href="pages/upload.html" style="color:var(--blue-mid)">העלה קובץ ראשון</a>' : '') + '</div>';
    return;
  }
  gVillages = listRes.data;
  document.getElementById('layer-count').textContent = gVillages.length;
  for (var i = 0; i < gVillages.length; i++) await loadVillageData(gVillages[i]);
  renderVillagesList();
}

async function loadVillageData(village) {
  try {
    var urlRes = gSb.storage.from('village-layers').getPublicUrl(village.file_path);
    var publicUrl = urlRes.data.publicUrl;
    var res = await fetch(publicUrl);
    if (!res.ok) throw new Error('Failed: ' + village.file_path);
    var data = await res.json();
    var categories = {};
    var bounds = L.latLngBounds([]);
    data.features.forEach(function(f) {
      var cat = (f.properties && f.properties._category) || 'other';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(f);
      var g = f.geometry;
      if (!g) return;
      if (g.type === 'Point') bounds.extend([g.coordinates[1], g.coordinates[0]]);
      else if (g.type === 'LineString') g.coordinates.forEach(function(c){bounds.extend([c[1],c[0]]);});
      else if (g.type === 'MultiLineString') g.coordinates.forEach(function(line){line.forEach(function(c){bounds.extend([c[1],c[0]]);});});
      else if (g.type === 'Polygon') g.coordinates[0].forEach(function(c){bounds.extend([c[1],c[0]]);});
    });
    gVillageBounds[village.village_id] = bounds;
    gVillageLayers[village.village_id] = {};
    gVillageState[village.village_id] = { masterOn: true, cats: {}, counts: {}, collapsed: false };
    Object.keys(categories).forEach(function(catId) {
      var def = SUB_LAYERS[catId] || SUB_LAYERS.other;
      var group = L.layerGroup();
      categories[catId].forEach(function(feat) {
        var p = feat.properties || {};
        var g = feat.geometry;
        if (!g) return;
        if (def.type === 'label' && g.type === 'Point' && p.Text) {
          var icon = L.divIcon({ className:'map-label', html:'<span style="color:'+def.color+'">'+p.Text+'</span>', iconSize:null, iconAnchor:[0,0] });
          L.marker([g.coordinates[1], g.coordinates[0]], { icon:icon }).addTo(group);
        } else if (g.type === 'Point') {
          var marker = L.circleMarker([g.coordinates[1], g.coordinates[0]], { radius:def.radius||4, color:'#fff', weight:1.5, fillColor:def.color, fillOpacity:0.9 });
          marker.bindPopup(buildPopup(p, def, village));
          marker.addTo(group);
        } else if (g.type === 'LineString') {
          var coords = g.coordinates.map(function(c){return [c[1],c[0]];});
          var line = L.polyline(coords, { color:def.color, weight:def.weight||2, opacity:0.95, dashArray:def.dashArray });
          line.bindPopup(buildPopup(p, def, village));
          line.addTo(group);
        } else if (g.type === 'MultiLineString') {
          g.coordinates.forEach(function(line) {
            var c = line.map(function(c){return [c[1],c[0]];});
            var pl = L.polyline(c, { color:def.color, weight:def.weight||2, opacity:0.95, dashArray:def.dashArray });
            pl.bindPopup(buildPopup(p, def, village));
            pl.addTo(group);
          });
        } else if (g.type === 'Polygon') {
          var coords = g.coordinates[0].map(function(c){return [c[1],c[0]];});
          var poly = L.polygon(coords, { color:def.color, weight:def.weight||1.5, opacity:0.85, fillOpacity:0.25, fillColor:def.color });
          poly.bindPopup(buildPopup(p, def, village));
          poly.addTo(group);
        }
      });
      gVillageLayers[village.village_id][catId] = group;
      gVillageState[village.village_id].cats[catId] = !!def.defaultOn;
      gVillageState[village.village_id].counts[catId] = categories[catId].length;
      if (def.defaultOn) group.addTo(gMap);
    });
  } catch(e) { console.error('Failed to load ' + village.village_id, e); }
}

function buildPopup(props, catDef, village) {
  var html = '<div style="font-size:12px;line-height:1.5">';
  if (props.Text) html += '<div style="font-weight:700;font-size:14px;color:'+catDef.color+';margin-bottom:4px">'+props.Text+'</div>';
  html += '<div class="popup-row"><span class="popup-key">סוג</span><span class="popup-val">'+catDef.label+'</span></div>';
  if (props.Layer) html += '<div class="popup-row"><span class="popup-key">שכבה</span><span class="popup-val">'+props.Layer+'</span></div>';
  if (props.EntityHand) html += '<div class="popup-row"><span class="popup-key">מזהה</span><span class="popup-val">'+props.EntityHand+'</span></div>';
  html += '<div style="margin-top:6px;padding-top:5px;border-top:1px solid #e2e8f0;font-size:10px;color:#64748b">'+village.icon+' '+village.village_name+'</div></div>';
  return html;
}

function renderVillagesList() {
  var el = document.getElementById('dwg-layers-list');
  if (!gVillages.length) { el.innerHTML = '<div class="empty-msg" style="font-size:11px">אין שכבות עדיין</div>'; return; }
  el.innerHTML = gVillages.map(function(v) {
    var state = gVillageState[v.village_id];
    if (!state) return '';
    var subsHtml = Object.keys(state.cats).map(function(catId) {
      var def = SUB_LAYERS[catId] || SUB_LAYERS.other;
      var on = state.cats[catId];
      var count = state.counts[catId] || 0;
      var swatchStyle;
      if (def.type === 'point') swatchStyle = 'background:'+def.color+';border-radius:50%';
      else if (def.type === 'label') swatchStyle = 'background:#fff;border:1px solid '+def.color+';color:'+def.color;
      else swatchStyle = def.dashArray ? 'background:repeating-linear-gradient(90deg,'+def.color+' 0 4px,transparent 4px 7px)' : 'background:'+def.color;
      return '<div class="sub-layer" onclick="toggleSubLayer(\''+v.village_id+'\',\''+catId+'\')">'+
        '<div class="sub-swatch" style="'+swatchStyle+'">'+(def.type==='label'?def.icon:'')+'</div>'+
        '<span class="sub-label">'+def.label+'</span>'+
        '<span class="sub-count">'+count+'</span>'+
        '<div class="mini-toggle '+(on?'on':'')+'" id="sub-tog-'+v.village_id+'-'+catId+'"></div></div>';
    }).join('');
    var collapsedClass = state.collapsed ? ' collapsed' : '';
    return '<div class="village-group'+collapsedClass+'" id="vg-'+v.village_id+'">'+
      '<div class="village-header" onclick="toggleVillageCollapse(\''+v.village_id+'\')">'+
        '<span class="village-icon">'+v.icon+'</span>'+
        '<span class="village-name">'+v.village_name+'</span>'+
        '<span class="zoom-link" onclick="event.stopPropagation();zoomToVillage(\''+v.village_id+'\')">🎯</span>'+
        '<div class="toggle on" id="master-tog-'+v.village_id+'" onclick="event.stopPropagation();toggleVillage(\''+v.village_id+'\')"></div>'+
        '<span class="village-arrow">▾</span></div>'+
      '<div class="village-content">' + subsHtml + '</div></div>';
  }).join('');
}

function toggleVillageCollapse(villageId) {
  var state = gVillageState[villageId];
  state.collapsed = !state.collapsed;
  document.getElementById('vg-'+villageId).classList.toggle('collapsed', state.collapsed);
}

function collapseAll() {
  gVillages.forEach(function(v) {
    if (gVillageState[v.village_id]) {
      gVillageState[v.village_id].collapsed = true;
      var el = document.getElementById('vg-'+v.village_id);
      if (el) el.classList.add('collapsed');
    }
  });
}

function expandAll() {
  gVillages.forEach(function(v) {
    if (gVillageState[v.village_id]) {
      gVillageState[v.village_id].collapsed = false;
      var el = document.getElementById('vg-'+v.village_id);
      if (el) el.classList.remove('collapsed');
    }
  });
}

function toggleVillage(villageId) {
  var state = gVillageState[villageId];
  state.masterOn = !state.masterOn;
  document.getElementById('master-tog-'+villageId).classList.toggle('on', state.masterOn);
  Object.keys(state.cats).forEach(function(catId) {
    var layer = gVillageLayers[villageId][catId];
    if (state.masterOn && state.cats[catId]) gMap.addLayer(layer);
    else if (!state.masterOn) gMap.removeLayer(layer);
  });
}

function toggleSubLayer(villageId, catId) {
  var state = gVillageState[villageId];
  var layer = gVillageLayers[villageId][catId];
  state.cats[catId] = !state.cats[catId];
  document.getElementById('sub-tog-'+villageId+'-'+catId).classList.toggle('on', state.cats[catId]);
  if (state.cats[catId] && state.masterOn) gMap.addLayer(layer);
  else gMap.removeLayer(layer);
}

function zoomToVillage(villageId) {
  var bounds = gVillageBounds[villageId];
  if (bounds && bounds.isValid()) gMap.flyToBounds(bounds, {padding:[50,50], duration:1.2, maxZoom:18});
}

// ════════════════════════════════════════════════════════════
//  INCIDENTS
// ════════════════════════════════════════════════════════════
function initSB(){loadIncidents();subscribeRT();}
function loadIncidents(){gSb.from('incidents').select('*').in('status',['open','in_progress']).order('created_at',{ascending:false}).then(function(res){if(res.error){console.error(res.error);return;}gIncidents=res.data||[];renderAll();document.getElementById('realtime-dot').style.background='#22c55e';});}
function subscribeRT(){gSb.channel('inc-rt').on('postgres_changes',{event:'*',schema:'public',table:'incidents'},function(p){if(p.eventType==='INSERT'){gIncidents.unshift(p.new);showToast('תקלה חדשה: '+p.new.title);}else if(p.eventType==='UPDATE'){var i=gIncidents.findIndex(function(x){return x.id===p.new.id;});if(i>=0)gIncidents[i]=p.new;else gIncidents.unshift(p.new);if(p.new.status==='closed')gIncidents=gIncidents.filter(function(x){return x.id!==p.new.id;});}else if(p.eventType==='DELETE')gIncidents=gIncidents.filter(function(x){return x.id!==p.old.id;});renderAll();}).subscribe();}

function isVisibleToMe(inc){if(inc.status==='open')return true;if(inc.status==='in_progress')return inc.assigned_to===gUser.id||gProfile.role==='admin';return false;}
function isMine(inc){return inc.assigned_to===gUser.id&&inc.status==='in_progress';}
function renderAll(){renderMarkers();renderMyIncidents();renderOpenIncidents();updateStats();}

function renderMarkers() {
  gIncidentsLayer.clearLayers();
  gMarkers = {};
  gIncidents.forEach(function(inc) { if (isVisibleToMe(inc)) addMarker(inc, false); });
}

function addMarker(inc, flyTo) {
  var color = PRIORITY_COLORS[inc.priority] || '#888';
  var mine = isMine(inc);
  var ringStyle = mine ? 'border:3px solid #1e40af;' : 'border:2.5px solid #fff;';
  var ic = L.divIcon({className:'',html:'<div style="width:24px;height:24px;background:'+color+';'+ringStyle+'border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center"><span style="color:#fff;font-size:12px;font-weight:800">!</span></div>',iconSize:[24,24],iconAnchor:[12,12]});
  var mineTag = mine?'<div class="popup-mine-tag">🛠️ בטיפולך</div>':'';
  var actions = '';
  if (inc.status==='open') actions = '<div class="popup-actions"><button class="popup-btn" onclick="takeIncident('+inc.id+')">📋 קח לטיפול</button><button class="popup-btn danger" onclick="openCloseModal('+inc.id+')">✔ סגור</button></div>';
  else if (inc.status==='in_progress' && mine) actions = '<div class="popup-actions"><button class="popup-btn success" onclick="openCloseModal('+inc.id+')">✔ סיים וסגור</button></div>';
  var m = L.marker([inc.lat,inc.lng],{icon:ic}).bindPopup(mineTag+'<div class="popup-title">'+inc.title+'</div><div class="popup-row"><span class="popup-key">ישוב</span><span class="popup-val">'+inc.village+'</span></div><div class="popup-row"><span class="popup-key">עדיפות</span><span class="popup-val" style="color:'+color+'">'+(PRIORITY_HE[inc.priority]||inc.priority)+'</span></div><div class="popup-row"><span class="popup-key">סטטוס</span><span class="popup-val">'+(STATUS_HE[inc.status]||inc.status)+'</span></div><div class="popup-row"><span class="popup-key">נפתח</span><span class="popup-val">'+timeAgo(inc.created_at)+'</span></div>'+(inc.description?'<div style="font-size:12px;color:#64748b;margin-top:6px;padding-top:5px;border-top:1px solid #e2e8f0">'+inc.description+'</div>':'')+actions);
  m.addTo(gIncidentsLayer); gMarkers[inc.id]=m;
  if (flyTo) { gMap.flyTo([inc.lat,inc.lng],17,{duration:1.5}); setTimeout(function(){m.openPopup();},1600); }
}

function renderMyIncidents() {
  var mine = gIncidents.filter(isMine), panel = document.getElementById('my-panel');
  document.getElementById('my-count').textContent = mine.length;
  if (!mine.length) { panel.style.display='none'; return; }
  panel.style.display='block';
  document.getElementById('my-list').innerHTML = mine.map(function(inc){return '<div class="inc-item mine" onclick="zoomTo('+inc.lat+','+inc.lng+','+inc.id+')"><div class="inc-top"><span class="inc-title">'+inc.title+'</span><span class="badge badge-'+inc.priority+'">'+(PRIORITY_HE[inc.priority]||inc.priority)+'</span></div><div class="inc-meta"><span class="inc-village">'+inc.village+'</span><span>'+timeSince(inc.taken_at||inc.created_at)+'</span></div></div>';}).join('');
}

function renderOpenIncidents() {
  var open = gIncidents.filter(function(i){return i.status==='open';});
  if (gFilter) open = open.filter(function(i){return i.village===gFilter;});
  var panel = document.getElementById('incidents-panel');
  document.getElementById('open-count').textContent = open.length;
  if (!open.length) { panel.innerHTML='<div class="empty-msg">אין תקלות פתוחות'+(gFilter?' ב'+gFilter:'')+'</div>'; return; }
  panel.innerHTML = open.map(function(inc){return '<div class="inc-item" onclick="zoomTo('+inc.lat+','+inc.lng+','+inc.id+')"><div class="inc-top"><span class="inc-title">'+inc.title+'</span><span class="badge badge-'+inc.priority+'">'+(PRIORITY_HE[inc.priority]||inc.priority)+'</span></div><div class="inc-meta"><span class="inc-village">'+inc.village+'</span><span>'+timeAgo(inc.created_at)+'</span></div></div>';}).join('');
}

function updateStats() {
  document.getElementById('stat-incidents').textContent = gIncidents.filter(function(i){return i.status==='open';}).length;
  document.getElementById('stat-mine').textContent = gIncidents.filter(isMine).length;
}

function zoomTo(lat,lng,id){gMap.setView([lat,lng],18);if(gMarkers[id])setTimeout(function(){gMarkers[id].openPopup();},300);}

// ── FIXED: village filter zooms to village ──
function filterByVillage(val) {
  gFilter = val;
  renderOpenIncidents();
  if (val) {
    var v = VILLAGES.find(function(x){return x.name === val;});
    if (v) gMap.flyTo([v.lat, v.lng], 15, {duration: 1.2});
  } else {
    gMap.flyTo([32.91, 35.30], 11, {duration: 1});
  }
}

async function takeIncident(id){var now=new Date().toISOString();var res=await gSb.from('incidents').update({status:'in_progress',assigned_to:gUser.id,taken_at:now}).eq('id',id);if(res.error){showToast('שגיאה');return;}var inc=gIncidents.find(function(i){return i.id===id;});await logAction(id,'taken',null,inc);showToast('📋 הועברה לטיפולך');gMap.closePopup();if(inc){inc.status='in_progress';inc.assigned_to=gUser.id;inc.taken_at=now;}renderAll();}

function openCloseModal(id){gClosingId=id;var inc=gIncidents.find(function(i){return i.id===id;});if(!inc)return;document.getElementById('close-incident-info').textContent=inc.title+' — '+inc.village;document.getElementById('close-notes').value='';document.getElementById('close-modal-bg').classList.add('open');gMap.closePopup();}
function closeCloseModal(){document.getElementById('close-modal-bg').classList.remove('open');}

async function confirmClose(){var notes=document.getElementById('close-notes').value.trim();if(!notes){showToast('אנא תאר מה בוצע');return;}var id=gClosingId;var inc=gIncidents.find(function(i){return i.id===id;});if(!inc)return;var now=new Date().toISOString();var duration=inc.taken_at?Math.floor((new Date(now)-new Date(inc.taken_at))/1000):null;var res=await gSb.from('incidents').update({status:'closed',closed_at:now,resolution_notes:notes,assigned_to:inc.assigned_to||gUser.id}).eq('id',id);if(res.error){showToast('שגיאה');return;}await logAction(id,'closed',notes,inc,duration);gIncidents=gIncidents.filter(function(x){return x.id!==id;});if(gMarkers[id])gIncidentsLayer.removeLayer(gMarkers[id]);delete gMarkers[id];renderAll();closeCloseModal();showToast('✔ נסגרה');}

async function logAction(incidentId,action,notes,inc,durationSec){await gSb.from('incident_logs').insert([{incident_id:incidentId,user_id:gUser.id,user_name:gProfile.full_name||gUser.email,action:action,incident_title:inc?inc.title:null,incident_village:inc?inc.village:null,incident_priority:inc?inc.priority:null,notes:notes,duration_seconds:durationSec||null}]);}

function openIncModal(){if(gLastLat){document.getElementById('f-lat').value=gLastLat.toFixed(5);document.getElementById('f-lng').value=gLastLng.toFixed(5);}document.getElementById('inc-modal-bg').classList.add('open');}
function closeIncModal(){document.getElementById('inc-modal-bg').classList.remove('open');}

async function submitIncident(){var title=document.getElementById('f-title').value.trim(),village=document.getElementById('f-village').value,priority=document.getElementById('f-priority').value,desc=document.getElementById('f-desc').value.trim(),lat=parseFloat(document.getElementById('f-lat').value),lng=parseFloat(document.getElementById('f-lng').value);if(!title||!village||isNaN(lat)||isNaN(lng)){showToast('אנא מלא את כל השדות');return;}var rec={title:title,village:village,priority:priority,description:desc,lat:lat,lng:lng,status:'open',created_by:gUser.id};var res=await gSb.from('incidents').insert([rec]).select().single();if(res.error){showToast('שגיאה: '+res.error.message);return;}await logAction(res.data.id,'created',null,res.data);closeIncModal();['f-title','f-village','f-desc','f-lat','f-lng'].forEach(function(id){document.getElementById(id).value='';});document.getElementById('f-priority').value='medium';showToast('✅ נפתחה');}

function timeAgo(iso){if(!iso)return'';var d=Math.floor((Date.now()-new Date(iso))/60000);if(d<1)return'הרגע';if(d<60)return'לפני '+d+' דק׳';var h=Math.floor(d/60);if(h<24)return'לפני '+h+' שעות';return'לפני '+Math.floor(h/24)+' ימים';}
function timeSince(iso){if(!iso)return'';var d=Math.floor((Date.now()-new Date(iso))/60000);if(d<1)return'בטיפול: זה עתה';if(d<60)return'בטיפול: '+d+' דק׳';var h=Math.floor(d/60);if(h<24)return'בטיפול: '+h+' שעות';return'בטיפול: '+Math.floor(h/24)+' ימים';}
function showToast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},3000);}

window.takeIncident=takeIncident;
window.openCloseModal=openCloseModal;
window.zoomTo=zoomTo;
window.toggleVillage=toggleVillage;
window.toggleSubLayer=toggleSubLayer;
window.toggleVillageCollapse=toggleVillageCollapse;
window.collapseAll=collapseAll;
window.expandAll=expandAll;
window.zoomToVillage=zoomToVillage;
window.filterByVillage=filterByVillage;

