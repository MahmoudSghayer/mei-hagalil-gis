// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — layers.js   →   GIS.layers
//  Manage layer definitions (Pipes, Valves, Hydrants, ...).
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before layers.js');

  GIS.layers = {

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
