// ════════════════════════════════════════════════════════════════
//  מי הגליל GIS — ייבוא מדי מים (Arad) · עמוד אדמין
//  מנתח CSV/JSON ומייבא דרך מנוע ה-GIS:  GIS.meters.importMeters(rows)
//  (לעולם לא ניגש ל-gSb / טבלת meters ישירות).
// ════════════════════════════════════════════════════════════════

var gRows = null;   // הרשומות המנותחות
var MAX_FILE_MB = 8;   // גודל קובץ מרבי לייבוא

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
  document.getElementById('fp-size').textContent = fmtSize(file.size);
  document.getElementById('mi-result').style.display = 'none';
  document.getElementById('mi-err').textContent = '';

  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    gRows = null;
    document.getElementById('mi-preview-wrap').style.display = 'block';
    document.getElementById('mi-table').innerHTML = '';
    document.getElementById('mi-count').textContent = '0';
    document.getElementById('mi-err').textContent =
      'הקובץ גדול מדי (' + fmtSize(file.size) + '). הגודל המרבי לייבוא הוא ' + MAX_FILE_MB + ' MB.';
    return;
  }

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
// Lazily-created progress panel (a 32k-meter import is ~100 chunked RPC calls,
// so the user needs to see how far along it is and roughly how long is left).
function ensureProgress() {
  var p = document.getElementById('mi-progress');
  if (p) return p;
  p = document.createElement('div');
  p.id = 'mi-progress';
  p.style.cssText = 'display:none;margin-top:14px;padding:14px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc';
  p.innerHTML =
    '<div id="mip-stage" style="font-size:13px;font-weight:700;color:#0d3b5e;margin-bottom:8px">מייבא מדי מים…</div>' +
    '<div style="height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden">' +
      '<div id="mip-fill" style="height:100%;width:0%;background:#1a7fc1;transition:width .25s"></div></div>' +
    '<div id="mip-text" style="font-size:12px;color:#64748b;margin-top:6px">—</div>';
  var btn = document.getElementById('mi-import-btn');
  var host = (btn && btn.closest('.card')) || document.getElementById('mi-preview-wrap') || document.body;
  host.appendChild(p);
  return p;
}

function fmtETA(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  if (sec < 60) return Math.round(sec) + ' שׄ';
  return Math.floor(sec / 60) + ':' + ('0' + Math.round(sec % 60)).slice(-2) + ' דק';
}

async function doImport() {
  if (!gRows) return;
  var btn = document.getElementById('mi-import-btn');
  btn.disabled = true; btn.textContent = 'מייבא…';
  document.getElementById('mi-err').textContent = '';

  var p = ensureProgress();
  var fill = document.getElementById('mip-fill');
  var text = document.getElementById('mip-text');
  var stage = document.getElementById('mip-stage');
  p.style.display = 'block';
  stage.textContent = 'מייבא מדי מים…';
  fill.style.width = '0%';
  text.textContent = 'מתכונן… (' + gRows.length + ' רשומות)';
  var startedAt = Date.now();

  try {
    var result = await GIS.meters.importMeters(gRows, 'csv-json-upload', {
      onProgress: function (done, total) {
        var pct = total ? Math.round(done / total * 100) : 0;
        fill.style.width = pct + '%';
        var elapsed = (Date.now() - startedAt) / 1000;
        var eta = done ? elapsed / done * (total - done) : 0;
        text.textContent = done + ' / ' + total + ' (' + pct + '%)' +
          (eta && pct < 100 ? ' · נותרו כ-' + fmtETA(eta) : '');
      }
    });
    fill.style.width = '100%';
    stage.textContent = '✅ הייבוא הושלם';
    text.textContent = 'יובאו ' + result.total + ' מדים (' + result.inserted + ' חדשים, ' + result.updated + ' עודכנו)';
    document.getElementById('r-ins').textContent = result.inserted;
    document.getElementById('r-upd').textContent = result.updated;
    document.getElementById('r-tot').textContent = result.total;
    document.getElementById('mi-result').style.display = 'block';
    document.getElementById('mi-err').textContent = result.skipped
      ? 'הערה: ' + result.skipped + ' שורות דולגו (חסר מספר מונה — למשל שורת סיכום).'
      : '';
  } catch (e) {
    stage.textContent = '⚠️ הייבוא נכשל';
    document.getElementById('mi-err').textContent = 'שגיאת ייבוא: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '⬆️ ייבא מדים';
  }
}

// ── CSV לדוגמה ────────────────────────────────────────────────────────────────
function downloadSample() {
  // תבנית בפורמט קובץ Arad (כותרות בעברית). מספר מונה = מזהה ייחודי.
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

function fmtSize(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';
}

// esc() centralized in auth.js (window.escHtml)
