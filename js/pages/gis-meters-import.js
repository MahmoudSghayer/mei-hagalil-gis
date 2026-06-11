// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — ייבוא מדי מים (ARad) · עמוד אדמין
//  מנתח CSV/JSON ומייבא דרך מנוע ה-GIS:  GIS.meters.importMeters(rows)
//  (לעולם לא ניגש ל-gSb / טבלת meters ישירות).
// ════════════════════════════════════════════════════════════════

var gRows = null;   // הרשומות המנותחות

window.addEventListener('load', async function () {
  var res = await gSb.auth.getSession();
  if (!res.data || !res.data.session) { window.location.replace('login.html'); return; }
  var role = await getUserRole(res.data.session.user.id);
  if (role !== 'admin') { window.location.replace('../index.html'); return; }
  document.body.classList.add('ready');
  setupDragDrop();
});

// ── גרירה/שחרור + בחירת קובץ ──────────────────────────────────────────────────
function setupDragDrop() {
  var zone = document.getElementById('drop-zone');
  var input = document.getElementById('file-input');
  input.addEventListener('change', function () { if (input.files[0]) handleFile(input.files[0]); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('dragover'); });
  });
  zone.addEventListener('drop', function (e) {
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
}

function clearFile() {
  gRows = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('mi-preview-wrap').style.display = 'none';
  document.getElementById('mi-result').style.display = 'none';
}

function handleFile(file) {
  document.getElementById('file-preview').style.display = 'flex';
  document.getElementById('fp-name').textContent = file.name;
  document.getElementById('fp-size').textContent = (file.size / 1024).toFixed(1) + ' KB';
  document.getElementById('mi-result').style.display = 'none';
  document.getElementById('mi-err').textContent = '';

  var reader = new FileReader();
  reader.onload = function () {
    try {
      var text = reader.result;
      var rows = /\.json$/i.test(file.name) ? parseJSON(text) : parseCSV(text);
      if (!rows.length) throw new Error('לא נמצאו רשומות בקובץ');
      gRows = rows;
      renderPreview(rows);
    } catch (e) {
      gRows = null;
      document.getElementById('mi-preview-wrap').style.display = 'block';
      document.getElementById('mi-table').innerHTML = '';
      document.getElementById('mi-count').textContent = '0';
      document.getElementById('mi-err').textContent = 'שגיאה בקריאת הקובץ: ' + e.message;
    }
  };
  reader.readAsText(file);
}

// ── מנתחים ────────────────────────────────────────────────────────────────────
function parseJSON(text) {
  var data = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.meters)) return data.meters;
  if (data && Array.isArray(data.data)) return data.data;
  throw new Error('JSON חייב להיות מערך או אובייקט עם שדה meters/data');
}

// CSV עם תמיכה בשדות מצוטטים ופסיקים בתוך מרכאות
function parseCSV(text) {
  text = text.replace(/^﻿/, '');           // הסר BOM
  var rows = [], row = [], field = '', inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) throw new Error('קובץ CSV חייב לכלול שורת כותרת ולפחות רשומה אחת');
  var headers = rows[0].map(function (h) { return h.trim(); });
  return rows.slice(1)
    .filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); })
    .map(function (r) {
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = (r[idx] !== undefined ? r[idx].trim() : ''); });
      return obj;
    });
}

// ── תצוגה מקדימה ──────────────────────────────────────────────────────────────
function renderPreview(rows) {
  document.getElementById('mi-preview-wrap').style.display = 'block';
  document.getElementById('mi-count').textContent = rows.length;
  document.getElementById('mi-err').textContent = '';
  var cols = Object.keys(rows[0]);
  var tbl = document.getElementById('mi-table');
  var head = '<thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead>';
  var bodyRows = rows.slice(0, 50).map(function (r) {
    return '<tr>' + cols.map(function (c) { return '<td>' + esc(r[c]) + '</td>'; }).join('') + '</tr>';
  }).join('');
  tbl.innerHTML = head + '<tbody>' + bodyRows + '</tbody>';
}

// ── ייבוא דרך המנוע ───────────────────────────────────────────────────────────
async function doImport() {
  if (!gRows) return;
  var btn = document.getElementById('mi-import-btn');
  btn.disabled = true; btn.textContent = 'מייבא…';
  document.getElementById('mi-err').textContent = '';
  try {
    var result = await GIS.meters.importMeters(gRows, 'csv-json-upload');
    document.getElementById('r-ins').textContent = result.inserted;
    document.getElementById('r-upd').textContent = result.updated;
    document.getElementById('r-tot').textContent = result.total;
    document.getElementById('mi-result').style.display = 'block';
    document.getElementById('mi-err').textContent = result.skipped
      ? 'הערה: ' + result.skipped + ' שורות דולגו (חסר מספר מונה — למשל שורת סיכום).'
      : '';
  } catch (e) {
    document.getElementById('mi-err').textContent = 'שגיאת ייבוא: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '⬆️ ייבא מדים';
  }
}

// ── CSV לדוגמה ────────────────────────────────────────────────────────────────
function downloadSample() {
  // תבנית בפורמט קובץ ARad (כותרות בעברית). מספר מונה = מזהה ייחודי.
  var csv = [
    'מס זיהוי,מספר משדר,מספר צרכן,מספר מונה,שם צרכן,כתובת,זמן קריאה אחרונה,קריאה אחרונה(קוב),אזור,טלפון,קו אורך,קו רוחב',
    '26020049,70B3D5A9F00A9C87,26254417,70B3D5A9F00A9C87,גריר קאסם ועולא חלאילה,שכונת אלעין דייר חנא,09/06/2026 11:38,1038.744,23,503328774,35.3739283,32.8583',
    '26020050,70B3D5A9F00A81E7,27571421,70B3D5A9F00A81E7,סלאמה קאסם וזוהיר חלאילה,שכונת אלעין דייר חנא,09/06/2026 11:52,441.257,24,506475505,35.3740333,32.8582367'
  ].join('\n');
  // BOM כדי ש-Excel יזהה UTF-8 ויציג עברית נכון.
  var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'meters-sample.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
