// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — fields.js   →   GIS.fields
//  ArcGIS-style attribute schema: structured, dynamic, and calculated fields.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before fields.js');

  // Accept friendly type aliases, store the 4 canonical DB types.
  var TYPE_ALIASES = {
    number: 'float', numeric: 'float', double: 'float', decimal: 'float', float: 'float',
    int: 'int', integer: 'int',
    text: 'text', string: 'text', varchar: 'text', date: 'text',
    bool: 'bool', boolean: 'bool'
  };
  function normalizeType(t) {
    var key = String(t || 'text').toLowerCase();
    return TYPE_ALIASES[key] || 'text';
  }

  function coerce(value, type) {
    if (value === null || value === undefined || value === '') return null;
    if (type === 'int') { var i = parseInt(value, 10); return isNaN(i) ? NaN : i; }
    if (type === 'float') { var f = parseFloat(value); return isNaN(f) ? NaN : f; }
    if (type === 'bool') {
      if (typeof value === 'boolean') return value;
      return /^(true|1|yes)$/i.test(String(value));
    }
    return String(value);
  }

  GIS.fields = {

    getFields: async function (layerId) {
      GIS._assert(layerId, 'getFields requires a layerId');
      var sb = GIS.sb();
      return GIS._unwrap(
        await sb.from('fields').select('*').eq('layer_id', layerId).order('created_at'),
        'load fields') || [];
    },

    // Add a field definition. fieldDefinition = { name, type, is_calculated?, expression? }
    // Admin only (RLS). If calculated, the expression is validated up-front.
    addField: async function (layerId, fieldDefinition) {
      GIS._assert(layerId && fieldDefinition && fieldDefinition.name, 'addField requires (layerId, { name, type })');
      await GIS._requireRole(['admin'], 'add fields');

      var def = {
        layer_id: layerId,
        name: fieldDefinition.name,
        type: normalizeType(fieldDefinition.type),
        is_calculated: !!fieldDefinition.is_calculated,
        expression: fieldDefinition.expression || null
      };

      if (def.is_calculated) {
        GIS._assert(def.expression, 'a calculated field requires an expression');
        // Validate the expression compiles against the existing field names.
        var existing = (await GIS.fields.getFields(layerId)).map(function (f) { return f.name; });
        GIS.calculator.compile(def.expression, existing); // throws if invalid
      }

      var sb = GIS.sb();
      return GIS._unwrap(await sb.from('fields').insert(def).select().single(), 'add field');
    },

    // Validate (and coerce) a properties object against the layer schema.
    // Returns { valid, errors:[], coerced:{} }. Unknown keys are kept as-is.
    validateFeatureProperties: async function (layerId, properties) {
      GIS._assert(layerId, 'validateFeatureProperties requires a layerId');
      var defs = await GIS.fields.getFields(layerId);
      var byName = {}; defs.forEach(function (d) { byName[d.name] = d; });
      var errors = [], coerced = {};
      Object.keys(properties || {}).forEach(function (key) {
        var def = byName[key];
        if (!def) { coerced[key] = properties[key]; return; }      // dynamic/unknown field
        if (def.is_calculated) return;                             // calculated fields are derived, not input
        var v = coerce(properties[key], def.type);
        if (typeof v === 'number' && isNaN(v)) {
          errors.push("Field '" + key + "' must be a " + def.type);
        } else {
          coerced[key] = v;
        }
      });
      return { valid: errors.length === 0, errors: errors, coerced: coerced };
    },

    // Convenience: compute a calculated field over a whole layer and persist it.
    // Loads features → evaluates the expression → writes each value into
    // properties[fieldName]. Respects RLS (admin|engineer to write features).
    calculate: async function (layerId, fieldName, expression) {
      GIS._assert(layerId && fieldName && expression, 'calculate requires (layerId, fieldName, expression)');
      var fc = await GIS.features.getFeatures(layerId);
      var values = GIS.calculator.calculateField(fc.features, expression);
      var updates = [];
      for (var i = 0; i < fc.features.length; i++) {
        var f = fc.features[i];
        var props = Object.assign({}, f.properties);
        delete props.__id; delete props.__layer_id;
        props[fieldName] = values[i];
        updates.push(GIS.features.updateFeature(f.id || f.properties.__id, props));
      }
      await Promise.all(updates);
      return { field: fieldName, updated: updates.length, values: values };
    }
  };
})();
