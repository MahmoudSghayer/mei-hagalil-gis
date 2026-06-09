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
  } catch (e) {
    document.getElementById('mi-err').textContent = 'שגיאת ייבוא: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '⬆️ ייבא מדים';
  }
}

// ── CSV לדוגמה ────────────────────────────────────────────────────────────────
function downloadSample() {
  var csv = [
    'arad_meter_id,customer_id,asset_code,lng,lat,last_reading,consumption,status,install_date',
    'ARAD-900100,CUST-777,PIPE-1001,35.2970,32.8655,1200,14.2,active,2021-05-01',
    'ARAD-900101,CUST-778,,35.2995,32.8656,4300,22.7,active,2019-11-20'
  ].join('\n');
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'meters-sample.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
