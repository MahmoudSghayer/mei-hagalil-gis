/* ══════════════════════════════════════════════════════════════════════════
   GIS Network Trace — Phase 2 (water utility).
   Client-side connectivity graph + valve-isolation / connected tracing,
   built from the engine's loaded village features (GIS.* by _category).

   Flow: arm from the רשת ribbon tab → click a pipe (the break) → we find its
   village + network type, pull the FULL village network, build an undirected
   graph (pipe endpoints snapped at TOL_M, valves snapped to nodes), flood out
   from the break stopping at valves, then highlight the isolated pipes, the
   valves to close, and count affected hydrants + meters.

   Self-contained IIFE. Reads via GIS.features.getFeatures / GIS.layers /
   GIS.meters. Renders on window.gMap. No edits to index.js / the engine.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // category key → network role. Editable via GISTrace.roles.
  var ROLE_BY_CAT = {
    water_pipes: 'water', supply_pipe: 'water',
    sewage_pipes: 'sewer', main_sewer: 'sewer',
    valves: 'valve', control_valves: 'valve',
    hydrants: 'device', water_meters: 'meter',
    sewage_manholes: 'snode', fittings: 'fitting'
  };

  var TOL_M = 0.6;          // pipe-endpoint snap tolerance (verified: 92% coincide <=0.5m)
  var VALVE_SNAP_M = 1.6;   // valve→node snap (verified: 99% within 1m)
  var DEVICE_BUF_M = 25;    // hydrant/meter counted as affected if within this of an isolated pipe
  var CLICK_FIND_M = 18;    // max click→pipe pick distance
  var CLICK_BBOX_M = 90;    // bbox half-size used to locate the clicked pipe/village

  var GISTrace = {
    roles: ROLE_BY_CAT,
    tol: TOL_M,
    startIsolation: function () { arm('isolation'); },
    startConnected: function () { arm('connected'); },
    clear: clearAll,
    _state: null
  };
  window.GISTrace = GISTrace;

  // ── geo helpers (WGS84 lng/lat, metric via local scale) ────────────────────
  function scaleAt(lat) { return { x: 111320 * Math.cos(lat * Math.PI / 180), y: 110540 }; }
  function distM(a, b, sc) { var dx = (a[0] - b[0]) * sc.x, dy = (a[1] - b[1]) * sc.y; return Math.hypot(dx, dy); }
  // distance (m) from point p to segment ab, all [lng,lat]
  function segDistM(p, a, b, sc) {
    var ax = a[0] * sc.x, ay = a[1] * sc.y, bx = b[0] * sc.x, by = b[1] * sc.y, px = p[0] * sc.x, py = p[1] * sc.y;
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  // line parts of a (Multi)LineString → array of coord arrays
  function partsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
  }
  function polylineLenM(coords, sc) {
    var L = 0;
    for (var i = 1; i < coords.length; i++) L += distM(coords[i - 1], coords[i], sc);
    return L;
  }

  // spatial hash for tolerance snapping / proximity (cell = tol meters)
  function makeHash(sc, cellM) {
    var grid = new Map();
    function key(lng, lat) { return Math.round(lng * sc.x / cellM) + '_' + Math.round(lat * sc.y / cellM); }
    return {
      add: function (lng, lat, val) {
        var gx = Math.round(lng * sc.x / cellM), gy = Math.round(lat * sc.y / cellM), k = gx + '_' + gy;
        var a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push({ lng: lng, lat: lat, val: val });
        return k;
      },
      near: function (lng, lat, r) {            // return vals within r meters
        var gx = Math.round(lng * sc.x / cellM), gy = Math.round(lat * sc.y / cellM), out = [];
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
          var a = grid.get((gx + dx) + '_' + (gy + dy)); if (!a) continue;
          for (var i = 0; i < a.length; i++) if (distM([lng, lat], [a[i].lng, a[i].lat], sc) <= r) out.push(a[i].val);
        }
        return out;
      }
    };
  }

  // ── ribbon plumbing ────────────────────────────────────────────────────────
  function toast(msg, type) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.className = (type ? type + ' ' : '') + 'show';
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = ''; }, 2600);
  }
  function banner(html) {
    var b = document.getElementById('gis-trace-banner');
    if (!b) { b = document.createElement('div'); b.id = 'gis-trace-banner'; document.body.appendChild(b); }
    if (html === false) { b.style.display = 'none'; return; }
    b.innerHTML = html; b.style.display = 'block';
  }

  // ── arm: wait for a pipe click ─────────────────────────────────────────────
  function arm(mode) {
    if (!window.gMap || !window.GIS) { toast('המנוע עדיין נטען…'); return; }
    clearAll();
    GISTrace._state = { mode: mode };
    var c = window.gMap.getContainer(); c.style.cursor = 'crosshair';
    banner(mode === 'isolation'
      ? '🚰 <b>בידוד מגופים</b> — לחץ על קו צינור במקום התקלה'
      : '🔗 <b>מעקב מחוברים</b> — לחץ על קו צינור');
    window.gMap.once('click', onPick);
    GISTrace._state.disarm = function () { window.gMap.off('click', onPick); c.style.cursor = ''; banner(false); };
  }
  function cancelArm() { if (GISTrace._state && GISTrace._state.disarm) GISTrace._state.disarm(); }

  function bboxAround(latlng, halfM) {
    var sc = scaleAt(latlng.lat);
    var dLng = halfM / sc.x, dLat = halfM / sc.y;
    return { minLng: latlng.lng - dLng, minLat: latlng.lat - dLat, maxLng: latlng.lng + dLng, maxLat: latlng.lat + dLat };
  }

  function parseLayer(l) {
    var i = l.name.indexOf(' · ');
    var village = i >= 0 ? l.name.slice(0, i) : l.name;
    var cat = i >= 0 ? l.name.slice(i + 3) : l.name;
    return { id: l.id, name: l.name, village: village, cat: cat, role: GISTrace.roles[cat] || null, color: l.color };
  }

  async function onPick(e) {
    var st = GISTrace._state; if (!st) return;
    st.disarm();
    banner('⏳ בונה את רשת המים…');
    try {
      var click = [e.latlng.lng, e.latlng.lat];
      var sc = scaleAt(e.latlng.lat);
      var layers = (await GIS.layers.getLayers()).map(parseLayer);
      var pipeLayers = layers.filter(function (l) { return l.role === 'water' || l.role === 'sewer'; });
      if (!pipeLayers.length) { banner(false); toast('אין שכבות צנרת במנוע'); return; }

      // Step A — find the clicked pipe (→ village + network type) via a small bbox.
      var bb = bboxAround(e.latlng, CLICK_BBOX_M);
      var best = null;
      for (var i = 0; i < pipeLayers.length; i++) {
        var fc = await GIS.features.getInBBox(pipeLayers[i].id, bb, 400);
        (fc.features || []).forEach(function (f) {
          partsOf(f.geometry).forEach(function (coords) {
            for (var k = 1; k < coords.length; k++) {
              var d = segDistM(click, coords[k - 1], coords[k], sc);
              if (!best || d < best.d) best = { d: d, layer: pipeLayers[i], feature: f };
            }
          });
        });
      }
      if (!best || best.d > CLICK_FIND_M) { banner(false); toast('לא נמצא צינור סמוך — לחץ קרוב יותר לקו'); return; }

      var village = best.layer.village, netType = best.layer.role; // 'water' | 'sewer'

      // Step B — pull the FULL village network of the same type + valves + devices + meters.
      var vlayers = layers.filter(function (l) { return l.village === village; });
      var pipes = vlayers.filter(function (l) { return l.role === netType; });
      var valveLs = vlayers.filter(function (l) { return l.role === 'valve'; });
      var deviceLs = vlayers.filter(function (l) { return l.role === 'device' || l.role === 'snode'; });

      var pipeFeats = [], valveFeats = [], deviceFeats = [];
      for (var p = 0; p < pipes.length; p++) (await GIS.features.getFeatures(pipes[p].id, 100000)).features.forEach(function (f) { pipeFeats.push(f); });
      for (var v = 0; v < valveLs.length; v++) (await GIS.features.getFeatures(valveLs[v].id, 100000)).features.forEach(function (f) { valveFeats.push(f); });
      for (var d = 0; d < deviceLs.length; d++) (await GIS.features.getFeatures(deviceLs[d].id, 100000)).features.forEach(function (f) { deviceFeats.push(f); });

      var g = buildGraph(pipeFeats, valveFeats, sc);

      // Step C — locate the break edge precisely in the full graph.
      var brk = null;
      g.edges.forEach(function (ed, idx) {
        for (var s = 1; s < ed.coords.length; s++) {
          var dd = segDistM(click, ed.coords[s - 1], ed.coords[s], sc);
          if (!brk || dd < brk.d) brk = { d: dd, idx: idx };
        }
      });
      if (!brk) { banner(false); toast('שגיאה באיתור הצינור ברשת'); return; }

      var res = (st.mode === 'connected')
        ? flood(g, brk.idx, false)
        : flood(g, brk.idx, true);

      var affected = countAffected(res, g, deviceFeats, sc);
      render(res, g, affected, { village: village, netType: netType, mode: st.mode, click: e.latlng });
      banner(false);
    } catch (err) {
      banner(false);
      console.error('[GISTrace]', err);
      toast('שגיאה בניתוח הרשת: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  // ── graph ──────────────────────────────────────────────────────────────────
  function buildGraph(pipeFeats, valveFeats, sc) {
    var nodes = [];                 // {lng,lat,valve?}
    var hash = makeHash(sc, TOL_M);
    function getNode(lng, lat) {
      var hit = hash.near(lng, lat, TOL_M);
      if (hit.length) return hit[0];
      var id = nodes.length; nodes.push({ lng: lng, lat: lat, valve: null });
      hash.add(lng, lat, id);
      return id;
    }
    var edges = [];                 // {a,b,feature,coords,lenM}
    var adj = [];                   // nodeId → [edgeIdx]
    function link(n, ei) { (adj[n] || (adj[n] = [])).push(ei); }

    pipeFeats.forEach(function (f) {
      partsOf(f.geometry).forEach(function (coords) {
        if (coords.length < 2) return;
        var a = getNode(coords[0][0], coords[0][1]);
        var b = getNode(coords[coords.length - 1][0], coords[coords.length - 1][1]);
        if (a === b) return;        // zero-length / loop
        var ei = edges.length;
        edges.push({ a: a, b: b, feature: f, coords: coords, lenM: polylineLenM(coords, sc) });
        link(a, ei); link(b, ei);
      });
    });

    // snap valves to nearest node within VALVE_SNAP_M
    var vnodeHash = makeHash(sc, VALVE_SNAP_M);
    nodes.forEach(function (n, id) { vnodeHash.add(n.lng, n.lat, id); });
    var unsnapped = 0;
    valveFeats.forEach(function (vf) {
      var c = vf.geometry && vf.geometry.coordinates; if (!c) return;
      var near = vnodeHash.near(c[0], c[1], VALVE_SNAP_M);
      if (!near.length) { unsnapped++; return; }
      // nearest of the candidates
      var bid = near[0], bd = Infinity;
      near.forEach(function (id) { var dd = distM([c[0], c[1]], [nodes[id].lng, nodes[id].lat], sc); if (dd < bd) { bd = dd; bid = id; } });
      nodes[bid].valve = valveInfo(vf);
    });

    return { nodes: nodes, edges: edges, adj: adj, unsnappedValves: unsnapped };
  }

  function valveInfo(f) {
    var p = f.properties || {};
    return {
      feature: f,
      num: p.ValveNum || p.asset_code || p.GlobalID || '—',
      type: p.ValveType, normalPos: p.NormalPosi, operable: p.Operable, status: p.Status,
      lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1]
    };
  }

  // flood from a break edge. withValves=true → stop at valve nodes (isolation).
  function flood(g, startEdge, withValves) {
    var isoEdges = new Set([startEdge]);
    var valves = [];                 // boundary valves (to close)
    var seen = new Set();
    var queue = [];
    function visitNode(n) {
      if (seen.has(n)) return;
      var node = g.nodes[n];
      if (withValves && node.valve) { valves.push(node.valve); return; }  // boundary
      seen.add(n); queue.push(n);
    }
    var e0 = g.edges[startEdge];
    visitNode(e0.a); visitNode(e0.b);
    while (queue.length) {
      var n = queue.pop();
      (g.adj[n] || []).forEach(function (ei) {
        isoEdges.add(ei);
        var ed = g.edges[ei];
        var m = (ed.a === n) ? ed.b : ed.a;
        visitNode(m);
      });
    }
    // de-dupe valves by feature
    var uniq = [], keys = new Set();
    valves.forEach(function (v) { var k = v.num + ':' + v.lng + ',' + v.lat; if (!keys.has(k)) { keys.add(k); uniq.push(v); } });
    return { edges: isoEdges, valves: uniq, startEdge: startEdge };
  }

  function countAffected(res, g, deviceFeats, sc) {
    // hash all isolated pipe vertices, then test each device against it
    var vh = makeHash(sc, DEVICE_BUF_M);
    res.edges.forEach(function (ei) { g.edges[ei].coords.forEach(function (c) { vh.add(c[0], c[1], 1); }); });
    var hydrants = [], meters = 0, devTotal = 0;
    deviceFeats.forEach(function (f) {
      var c = f.geometry && f.geometry.coordinates; if (!c) return;
      if (vh.near(c[0], c[1], DEVICE_BUF_M).length) {
        devTotal++;
        var p = f.properties || {};
        if (p.HydrantNum != null) hydrants.push(p.HydrantNum);
      }
    });
    // meters from the dedicated Arad table (best-effort, async-safe: handled in render)
    return { hydrants: hydrants, devTotal: devTotal, meters: meters };
  }

  // ── render on map + results card ───────────────────────────────────────────
  function ensurePane() {
    if (!window.gMap.getPane('gisTrace')) {
      window.gMap.createPane('gisTrace').style.zIndex = 650;
      window.gMap.createPane('gisTraceTop').style.zIndex = 660;
    }
  }

  function render(res, g, affected, meta) {
    ensurePane();
    clearLayers();
    var st = GISTrace._state || (GISTrace._state = {});

    // isolated pipes (red)
    var feats = [];
    res.edges.forEach(function (ei) { feats.push(g.edges[ei].feature); });
    var isoColor = meta.mode === 'connected' ? '#1a7fc1' : '#dc2626';
    st.overlay = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
      pane: 'gisTrace',
      style: { color: isoColor, weight: 6, opacity: 0.85 }
    }).addTo(window.gMap);

    // valves to close (only isolation mode)
    st.valveLayer = L.layerGroup([], { pane: 'gisTraceTop' }).addTo(window.gMap);
    if (meta.mode === 'isolation') {
      res.valves.forEach(function (v) {
        var inop = isInoperable(v);
        var icon = L.divIcon({ className: '', html: '<div class="gis-valve-mk' + (inop ? ' inop' : '') + '">' + (inop ? '⚠' : '⛔') + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
        L.marker([v.lat, v.lng], { icon: icon, pane: 'gisTraceTop', title: 'מגוף ' + v.num })
          .bindPopup(valvePopup(v)).addTo(st.valveLayer);
      });
    }

    // total length
    var totalM = 0; res.edges.forEach(function (ei) { totalM += g.edges[ei].lenM; });

    // fit
    try { window.gMap.fitBounds(st.overlay.getBounds(), { padding: [60, 60], maxZoom: 18 }); } catch (e) {}

    card(res, { totalM: totalM, affected: affected, meta: meta, unsnapped: g.unsnappedValves });
    countMeters(res, g, meta).then(function (m) { var el = document.getElementById('gtc-meters'); if (el) el.textContent = m.toLocaleString('he-IL'); }).catch(function () {});
  }

  function isInoperable(v) {
    // best-effort: Operable that reads as 0 / false / "לא". Codes unknown → only flag obvious negatives.
    var o = v.operable;
    return o === 0 || o === '0' || o === false || o === 'No' || o === 'no';
  }

  function valvePopup(v) {
    var rows = [['מספר מגוף', v.num], ['סוג', v.type], ['מצב נורמלי', v.normalPos], ['ניתן להפעלה', v.operable], ['סטטוס', v.status]];
    var h = '<div style="font-size:12.5px;line-height:1.7;min-width:150px"><b>⛔ מגוף לסגירה</b>';
    rows.forEach(function (r) { if (r[1] != null && r[1] !== '') h += '<br>' + r[0] + ': <b>' + r[1] + '</b>'; });
    return h + '</div>';
  }

  async function countMeters(res, g, meta) {
    if (!window.GIS || !GIS.meters || !GIS.meters.getMeters) return 0;
    var fc = await GIS.meters.getMeters();
    var sc = scaleAt(meta.click.lat);
    var vh = makeHash(sc, DEVICE_BUF_M);
    res.edges.forEach(function (ei) { g.edges[ei].coords.forEach(function (c) { vh.add(c[0], c[1], 1); }); });
    var n = 0;
    (fc.features || []).forEach(function (f) {
      var c = f.geometry && f.geometry.coordinates; if (!c) return;
      var p = f.properties || {};
      var vv = p.village || (p.raw_data && p.raw_data.village);
      if (vv && meta.village && vv !== meta.village) return;
      if (vh.near(c[0], c[1], DEVICE_BUF_M).length) n++;
    });
    return n;
  }

  // ── results card ────────────────────────────────────────────────────────────
  function card(res, info) {
    closeCard();
    var el = document.createElement('div');
    el.id = 'gis-trace-card';
    var isol = info.meta.mode === 'isolation';
    var valveRows = res.valves.map(function (v, i) {
      var inop = isInoperable(v);
      return '<div class="gtc-valve' + (inop ? ' inop' : '') + '" data-vi="' + i + '">' +
        '<span class="gtc-vk">' + (inop ? '⚠' : '⛔') + '</span>' +
        '<span class="gtc-vn">מגוף ' + esc(v.num) + '</span>' +
        (v.type != null && v.type !== '' ? '<span class="gtc-vt">סוג ' + esc(v.type) + '</span>' : '') +
        '</div>';
    }).join('') || '<div class="gtc-empty">לא נמצאו מגופים תוחמים — הרשת פתוחה עד הקצה. בדוק שכבת מגופים פעילה.</div>';

    el.innerHTML =
      '<div class="gtc-head"><span>' + (isol ? '🚰 בידוד מגופים' : '🔗 מקטע מחובר') + '</span>' +
        '<button class="gtc-x" title="נקה">✕</button></div>' +
      '<div class="gtc-sub">' + esc(info.meta.village) + ' · רשת ' + (info.meta.netType === 'water' ? 'מים' : 'ביוב') + '</div>' +
      '<div class="gtc-stats">' +
        stat(res.edges.size, 'קטעי צינור') +
        stat(Math.round(info.totalM).toLocaleString('he-IL'), 'מ׳ אורך') +
        (isol ? stat(res.valves.length, 'מגופים לסגירה') : '') +
      '</div>' +
      '<div class="gtc-stats">' +
        stat('<span id="gtc-meters">…</span>', 'מדי מים מושפעים') +
        stat(info.affected.hydrants.length, 'הידרנטים') +
      '</div>' +
      (isol ? '<div class="gtc-vlist-h">מגופים לסגירה (מהקרוב לתקלה כלפי חוץ)</div><div class="gtc-vlist">' + valveRows + '</div>' : '') +
      (info.unsnapped ? '<div class="gtc-warn">⚠ ' + info.unsnapped + ' מגופים לא חוברו לרשת (מרחק > ' + VALVE_SNAP_M + ' מ׳) — ייתכן בידוד חלקי.</div>' : '') +
      '<div class="gtc-actions"><button class="gtc-clear">נקה תוצאה</button></div>';

    document.body.appendChild(el);
    el.querySelector('.gtc-x').onclick = clearAll;
    el.querySelector('.gtc-clear').onclick = clearAll;
    // click a valve row → zoom to it
    el.querySelectorAll('.gtc-valve').forEach(function (row) {
      row.onclick = function () {
        var v = res.valves[+row.getAttribute('data-vi')];
        if (v && window.gMap) { window.gMap.setView([v.lat, v.lng], 19); }
      };
    });
  }
  function stat(n, l) { return '<div class="gtc-stat"><div class="gtc-n">' + n + '</div><div class="gtc-l">' + l + '</div></div>'; }

  // ── teardown ────────────────────────────────────────────────────────────────
  function clearLayers() {
    var st = GISTrace._state; if (!st) return;
    if (st.overlay) { window.gMap.removeLayer(st.overlay); st.overlay = null; }
    if (st.valveLayer) { window.gMap.removeLayer(st.valveLayer); st.valveLayer = null; }
  }
  function closeCard() { var c = document.getElementById('gis-trace-card'); if (c) c.remove(); }
  function clearAll() { cancelArm(); clearLayers(); closeCard(); banner(false); if (window.gMap) window.gMap.getContainer().style.cursor = ''; GISTrace._state = null; }

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
})();
