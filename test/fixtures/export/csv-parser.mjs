// Minimal CSV parser sufficient for buildCSV()'s output: every field is always
// double-quoted, embedded quotes are escaped as "", records are \n-delimited and
// never contain a literal newline (properties_json/WKT values don't either).
export function parseCSV(text) {
  return text.split('\n').filter(Boolean).map(function (line) {
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  });
}
