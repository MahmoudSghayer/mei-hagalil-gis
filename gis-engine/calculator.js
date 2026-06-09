// ════════════════════════════════════════════════════════════════════════
//  GIS ENGINE — calculator.js   →   GIS.calculator
//  Safe field-calculator (ArcGIS-style). NO eval / NO new Function.
//
//  Supports:   2026 - install_year
//              diameter * 1.2
//              length(geometry)
//              age * 0.5 + diameter * 0.01
//
//  How it's safe: the string is tokenized → parsed into an AST → every
//  identifier is checked against a field whitelist and every function against
//  a whitelist → the AST is walked by a plain interpreter. The user string is
//  never executed. The only way to reach JS is through the whitelisted
//  FUNCTIONS map below.
// ════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var GIS = window.GIS;
  GIS._assert(GIS, 'core.js must load before calculator.js');

  // length(geometry) → geodesic length in metres (uses GIS.spatial helper).
  var FUNCTIONS = {
    length: function (g) { return GIS.spatial.geometryLength(g); },
    round: function (x, d) { d = d || 0; return Number(Number(x).toFixed(d)); },
    abs: Math.abs, ceil: Math.ceil, floor: Math.floor, sqrt: Math.sqrt,
    pow: Math.pow, min: Math.min, max: Math.max,
    coalesce: function () {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (v !== null && v !== undefined && !(typeof v === 'number' && isNaN(v))) return v;
      }
      return null;
    }
  };

  // ── Tokenizer ──────────────────────────────────────────────────────────
  function tokenize(input) {
    var tokens = [], i = 0;
    var isDigit = function (c) { return c >= '0' && c <= '9'; };
    var isIdentStart = function (c) { return /[A-Za-z_]/.test(c); };
    var isIdent = function (c) { return /[A-Za-z0-9_]/.test(c); };
    while (i < input.length) {
      var c = input[i];
      if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
      if (isDigit(c) || (c === '.' && isDigit(input[i + 1]))) {
        var num = '';
        while (i < input.length && (isDigit(input[i]) || input[i] === '.')) num += input[i++];
        tokens.push({ t: 'num', v: parseFloat(num) }); continue;
      }
      if (c === "'" || c === '"') {
        var q = c, s = ''; i++;
        while (i < input.length && input[i] !== q) s += input[i++];
        if (input[i] !== q) throw new Error('Unterminated string literal');
        i++; tokens.push({ t: 'str', v: s }); continue;
      }
      if (isIdentStart(c)) {
        var id = '';
        while (i < input.length && isIdent(input[i])) id += input[i++];
        tokens.push({ t: 'ident', v: id }); continue;
      }
      if ('+-*/%(),'.indexOf(c) !== -1) { tokens.push({ t: c }); i++; continue; }
      throw new Error("Unexpected character '" + c + "' in expression");
    }
    tokens.push({ t: 'eof' });
    return tokens;
  }

  // ── Parser (recursive descent, standard precedence) ────────────────────
  function parse(tokens) {
    var pos = 0;
    var peek = function () { return tokens[pos]; };
    var next = function () { return tokens[pos++]; };
    var expect = function (t) {
      if (peek().t !== t) throw new Error("Expected '" + t + "' but found '" + peek().t + "'");
      return next();
    };
    function parseExpr() {
      var left = parseTerm();
      while (peek().t === '+' || peek().t === '-') left = { k: 'bin', op: next().t, left: left, right: parseTerm() };
      return left;
    }
    function parseTerm() {
      var left = parseFactor();
      while (peek().t === '*' || peek().t === '/' || peek().t === '%') left = { k: 'bin', op: next().t, left: left, right: parseFactor() };
      return left;
    }
    function parseFactor() {
      var tok = peek();
      if (tok.t === '-') { next(); return { k: 'neg', expr: parseFactor() }; }
      if (tok.t === '+') { next(); return parseFactor(); }
      if (tok.t === 'num') { next(); return { k: 'num', v: tok.v }; }
      if (tok.t === 'str') { next(); return { k: 'str', v: tok.v }; }
      if (tok.t === '(') { next(); var e = parseExpr(); expect(')'); return e; }
      if (tok.t === 'ident') {
        next();
        if (peek().t === '(') {
          next(); var args = [];
          if (peek().t !== ')') { args.push(parseExpr()); while (peek().t === ',') { next(); args.push(parseExpr()); } }
          expect(')');
          return { k: 'call', name: tok.v.toLowerCase(), args: args };
        }
        return { k: 'ident', name: tok.v };
      }
      throw new Error("Unexpected token '" + tok.t + "' in expression");
    }
    var ast = parseExpr();
    if (peek().t !== 'eof') throw new Error('Unexpected trailing tokens in expression');
    return ast;
  }

  function collect(node, idents, funcs) {
    switch (node.k) {
      case 'ident': idents[node.name] = true; break;
      case 'neg': collect(node.expr, idents, funcs); break;
      case 'bin': collect(node.left, idents, funcs); collect(node.right, idents, funcs); break;
      case 'call': funcs[node.name] = true; node.args.forEach(function (a) { collect(a, idents, funcs); }); break;
      default: break;
    }
  }

  function evalNode(node, scope) {
    switch (node.k) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'ident': {
        if (node.name === 'geometry') return scope.geometry;       // raw geometry passes through
        var v = scope.props ? scope.props[node.name] : undefined;
        if (v === undefined || v === null) return 0;                // missing → numeric-safe 0
        var n = Number(v);
        return isNaN(n) ? v : n;                                    // keep text fields as text
      }
      case 'neg': return -evalNode(node.expr, scope);
      case 'bin': {
        var a = evalNode(node.left, scope), b = evalNode(node.right, scope);
        switch (node.op) {
          case '+': return (typeof a === 'string' || typeof b === 'string') ? ('' + a + b) : a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? null : a / b;
          case '%': return b === 0 ? null : a % b;
        }
        break;
      }
      case 'call': {
        var fn = FUNCTIONS[node.name];
        if (!fn) throw new Error("Unknown function " + node.name);
        var args = node.args.map(function (x) { return evalNode(x, scope); });
        return fn.apply(null, args);
      }
    }
    throw new Error('Bad expression node');
  }

  GIS.calculator = {

    // Compile + validate once. allowedFields = field names that may appear.
    // Returns { evaluate(feature), identifiers }.  Throws on unknown field/fn.
    compile: function (expression, allowedFields) {
      GIS._assert(typeof expression === 'string' && expression.trim(), 'empty expression');
      var allowed = {}; (allowedFields || []).forEach(function (f) { allowed[f] = true; });
      allowed.geometry = true;
      var ast = parse(tokenize(expression));
      var idents = {}, funcs = {};
      collect(ast, idents, funcs);
      Object.keys(idents).forEach(function (id) {
        if (!allowed[id]) throw new Error("Unknown field '" + id + "' in expression");
      });
      Object.keys(funcs).forEach(function (fn) {
        if (!FUNCTIONS[fn]) throw new Error("Function '" + fn + "' is not allowed");
      });
      return {
        identifiers: Object.keys(idents),
        evaluate: function (feature) {
          return evalNode(ast, { props: (feature && feature.properties) || {}, geometry: feature && feature.geometry });
        }
      };
    },

    // Evaluate one expression against one feature.
    evaluateExpression: function (feature, expression) {
      var allowed = Object.keys((feature && feature.properties) || {});
      return GIS.calculator.compile(expression, allowed).evaluate(feature);
    },

    // Evaluate one expression across many features → array of values.
    calculateField: function (features, expression) {
      features = features || [];
      var allowed = {};
      features.forEach(function (f) {
        Object.keys((f && f.properties) || {}).forEach(function (k) { allowed[k] = true; });
      });
      var compiled = GIS.calculator.compile(expression, Object.keys(allowed));
      return features.map(function (f) { return compiled.evaluate(f); });
    }
  };
})();
