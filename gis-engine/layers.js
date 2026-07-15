// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — layers.js   →   GIS.layers
//  Manage layer definitions (Pipes, Valves, Hydrants, ...).
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before layers.js');

  GIS.layers = {

    // Lightweight layer list — id, name, geometry_type, color, village,
    // category only (NO fields join). Use for the Contents pane / pickers
    // that never read layer.fields, so first paint doesn't pull every field
    // of every layer. village/category are the DB-derived columns (W5.2 —
    // gis-engine/sql/migrations/2026-07-15-layers-village-category.sql);
    // included here so callers can prefer them via LayerNaming.fromRow()
    // instead of re-parsing `name`.
    list: async function () {
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('layers').select('id, name, geometry_type, color, village, category').order('name'), 'load layers') || [];
    },

    // List all layers (each enriched with its field definitions).
    getLayers: async function () {
      var sb = GIS.sb();
      var layers = GIS._unwrap(
        await sb.from('layers').select('*').order('name'), 'load layers');
      var fields = GIS._unwrap(
        await sb.from('fields').select('*'), 'load fields') || [];
      var byLayer = {};
      fields.forEach(function (f) { (byLayer[f.layer_id] = byLayer[f.layer_id] || []).push(f); });
      return layers.map(function (l) { l.fields = byLayer[l.id] || []; return l; });
    },

    getLayerById: async function (id) {
      GIS._assert(id, 'getLayerById requires an id');
      var sb = GIS.sb();
      var layer = GIS._unwrap(
        await sb.from('layers').select('*').eq('id', id).single(), 'load layer');
      layer.fields = GIS._unwrap(
        await sb.from('fields').select('*').eq('layer_id', id).order('created_at'), 'load fields') || [];
      return layer;
    },

    // Delete a layer and all its features (FK cascade). Admin only.
    deleteLayer: async function (id) {
      GIS._assert(id, 'deleteLayer requires an id');
      await GIS._requireRole(['admin'], 'delete layers');
      var sb = GIS.sb();
      GIS._unwrap(await sb.from('layers').delete().eq('id', id), 'delete layer');
      return { id: id, deleted: true };
    },

    // Persist a layer's display colour (hex). Admin only (RLS on layers).
    setColor: async function (layerId, color) {
      GIS._assert(layerId && color, 'setColor requires (layerId, color)');
      await GIS._requireRole(['admin'], 'recolor layers');
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('layers').update({ color: color }).eq('id', layerId).select().single(), 'set color');
    },

    // Bounding box [minLng, minLat, maxLng, maxLat] over the given layers,
    // or null if empty. Used to fly the map to a village.
    extent: async function (layerIds) {
      GIS._assert(layerIds && layerIds.length, 'extent requires layerIds');
      var sb = GIS.sb();
      return GIS._unwrap(await sb.rpc('layers_extent', { p_layer_ids: layerIds }), 'layer extent');
    },

    // Find a layer by exact name (used to map a migrated village+category to
    // its engine layer). Returns the layer row or null.
    findByName: async function (name) {
      GIS._assert(name, 'findByName requires a name');
      var sb = GIS.sb();
      var rows = GIS._unwrap(
        await sb.from('layers').select('*').eq('name', name).limit(1), 'find layer') || [];
      return rows[0] || null;
    },

    // Create a layer.  { name, geometry_type: 'Point'|'LineString'|'Polygon' }
    // Admin only (enforced by RLS; checked early for a clear message).
    createLayer: async function (data) {
      GIS._assert(data && data.name && data.geometry_type, 'createLayer requires { name, geometry_type }');
      await GIS._requireRole(['admin'], 'create layers');
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('layers').insert({
          name: data.name, geometry_type: data.geometry_type
        }).select().single(), 'create layer');
    }
  };
})();
