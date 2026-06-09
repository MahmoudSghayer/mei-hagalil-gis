// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — queries.js   →   GIS.queries
//  SQL-like attribute filtering.
//
//      material = 'PVC'
//      install_year < 2000
//      diameter > 100 AND status = 'active'
//      material = 'PVC' OR material = 'PE'
//
//  parseFilterToSQL() turns the text into a SAFE structured form
//  { logic, conditions:[{field,op,value}] }. That structure (never raw SQL)
//  is sent to the query_features RPC, which whitelists operators, regex-checks
//  field names, and quotes values. No injection surface.
//
//  Supported operators: =, !=, <>, <, <=, >, >=, LIKE
//  Combine with a single AND or a single OR (mixed precedence not supported —
//  run two queries instead; keeps behaviour predictable in production).
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before queries.js');

  function tokenize(input) {
    var tokens = [], i = 0;
    var startsWith = function (s) { return input.substr(i, s.length) === s; };
    while (i < input.length) {
      var c = input[i];
      if (/\s/.test(c)) { i++; continue; }
      if (startsWith('<=') || startsWith('>=') || startsWith('!=') || startsWith('<>')) {
        tokens.push({ t: 'op', v: input.substr(i, 2) }); i += 2; continue;
      }
      if (c === '=' || c === '<' || c === '>') { tokens.push({ t: 'op', v: c }); i++; continue; }
      if (c === '(' || c === ')') { tokens.push({ t: c }); i++; continue; }
      if (c === "'" || c === '"') {
        var q = c, s = ''; i++;
        while (i < input.length && input[i] !== q) s += input[i++];
        if (input[i] !== q) throw new Error('Unterminated string in filter');
        i++; tokens.push({ t: 'value', v: s }); continue;
      }
      if (/[0-9.]/.test(c)) {
        var n = '';
        while (i < input.length && /[0-9.]/.test(input[i])) n += input[i++];
        tokens.push({ t: 'value', v: parseFloat(n) }); continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var id = '';
        while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) id += input[i++];
        var lo = id.toLowerCase();
        if (lo === 'and' || lo === 'or') tokens.push({ t: lo });
        else if (lo === 'like') tokens.push({ t: 'op', v: 'like' });
        else if (lo === 'true' || lo === 'false') tokens.push({ t: 'value', v: lo === 'true' });
        else if (lo === 'null') tokens.push({ t: 'value', v: null });
        else tokens.push({ t: 'ident', v: id });
        continue;
      }
      throw new Error("Unexpected character '" + c + "' in filter");
    }
    tokens.push({ t: 'eof' });
    return tokens;
  }

  // Evaluate one { field, op, value } condition against a properties object.
  function evalCond(props, c) {
    var left = c.field === 'asset_code' ? props.asset_code : props[c.field];
    var right = c.value;
    if (typeof right === 'number') {
      var ln = parseFloat(left);
      if (isNaN(ln)) return false;
      switch (c.op) {
        case '=': return ln === right; case '!=': case '<>': return ln !== right;
        case '<': return ln < right; case '<=': return ln <= right;
        case '>': return ln > right; case '>=': return ln >= right;
        default: return false;
      }
    }
    if (c.op === 'like') {
      var pat = String(right).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
      return new RegExp('^' + pat + '$').test(String(left == null ? '' : left).toLowerCase());
    }
    var ls = String(left == null ? '' : left), rs = String(right);
    switch (c.op) {
      case '=': return ls === rs; case '!=': case '<>': return ls !== rs;
      case '<': return ls < rs; case '<=': return ls <= rs;
      case '>': return ls > rs; case '>=': return ls >= rs;
      default: return false;
    }
  }

  GIS.queries = {

    // Parse a filter string into { logic:'and'|'or', conditions:[{field,op,value}] }.
    parseFilterToSQL: function (filter) {
      if (filter === undefined || filter === null || String(filter).trim() === '') {
        return { logic: 'and', conditions: [] };
      }
      var tokens = tokenize(String(filter)), pos = 0;
      var peek = function () { return tokens[pos]; };
      var next = function () { return tokens[pos++]; };
      var conditions = [], logic = null;

      function readCondition() {
        var fld = next();
        if (fld.t !== 'ident') throw new Error('Expected a field name in filter');
        var op = next();
        if (op.t !== 'op') throw new Error("Expected an operator after '" + fld.v + "'");
        var val = next();
        if (val.t !== 'value') throw new Error("Expected a value after '" + op.v + "'");
        return { field: fld.v, op: op.v, value: val.v };
      }

      conditions.push(readCondition());
      while (peek().t === 'and' || peek().t === 'or') {
        var connector = next().t;
        if (logic && logic !== connector) {
          throw new Error('Mixed AND/OR is not supported — run two separate queries.');
        }
        logic = connector;
        conditions.push(readCondition());
      }
      if (peek().t !== 'eof') throw new Error('Unexpected trailing tokens in filter');
      return { logic: logic || 'and', conditions: conditions };
    },

    // Evaluate a parsed filter against an in-memory feature array (client-side).
    // Used for data that isn't in PostGIS (e.g. the uploaded village GeoJSON
    // served as flat files). Same operators as the server-side RPC.
    applyFilter: function (features, filter) {
      var parsed = (filter && typeof filter === 'object' && filter.conditions)
        ? filter : GIS.queries.parseFilterToSQL(filter);
      if (!parsed.conditions.length) return features || [];
      var test = function (f) {
        var props = (f && f.properties) || {};
        var results = parsed.conditions.map(function (c) { return evalCond(props, c); });
        return parsed.logic === 'or' ? results.some(Boolean) : results.every(Boolean);
      };
      return (features || []).filter(test);
    },

    // Filter a layer's features. `filter` may be a string ("diameter > 100")
    // or an already-parsed { logic, conditions } object. Returns GeoJSON.
    queryFeatures: async function (layerId, filter) {
      GIS._assert(layerId, 'queryFeatures requires a layerId');
      var parsed = (filter && typeof filter === 'object' && filter.conditions)
        ? filter : GIS.queries.parseFilterToSQL(filter);
      var sb = GIS.sb();
      var fc = GIS._unwrap(await sb.rpc('query_features', {
        p_layer_id: layerId,
        p_conditions: parsed.conditions,
        p_logic: parsed.logic,
        p_limit: GIS.config.defaultFeatureLimit
      }), 'query features');
      return fc || GIS.emptyFC();
    }
  };
})();
