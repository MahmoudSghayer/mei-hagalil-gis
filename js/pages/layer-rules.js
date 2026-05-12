var gAdminId = null;
var gAdminProfile = null;
var gRules = [];

window.addEventListener('load', async function() {
  var res = await gSb.auth.getSession();
  if (!res.data || !res.data.session) { window.location.replace('login.html'); return; }
  gAdminId = res.data.session.user.id;
  gAdminProfile = await getProfile(res.data.session.user, true);
  if (!gAdminProfile) return;
  if (gAdminProfile.role !== 'admin') { window.location.replace('../index.html'); return; }
  document.body.classList.add('ready');
  MotionUtils.animatePageIn();
  loadRules();
});

async function loadRules() {
  var res = await gSb.from('layer_mapping_rules').select('*').order('priority', {ascending: true});
  if (res.error) { showToast('שגיאה בטעינה: ' + res.error.message, 'error'); return; }
  gRules = res.data || [];
  renderRules();
  renderStats();
}

function renderStats() {
  var total = gRules.length;
  var active = gRules.filter(function(r){return r.is_active;}).length;
  var ignored = gRules.filter(function(r){return r.category === 'IGNORE';}).length;
  var matches = gRules.reduce(function(sum, r){return sum + (r.match_count || 0);}, 0);
  document.getElementById('s-total').textContent = total;
  document.getElementById('s-active').textContent = active;
  document.getElementById('s-ignore').textContent = ignored;
  document.getElementById('s-matches').textContent = matches.toLocaleString();
}

function categoryName(cat) {
  var map = {
    IGNORE: '🚫 דלג',
    water_pipes:'💧 קווי מים', water_meters:'🔢 מדי מים', hydrants:'🚒 הידרנטים',
    valves:'🔧 מגופים', control_valves:'⚙️ מגופים שולטים',
    connection_points:'🔌 נקודות חיבור', reservoirs:'🏗️ מאגרים',
    pump_stations:'⛽ תחנות שאיבה', sampling_points:'🧪 נקודות דיגום',
    sewage_pipes:'🟤 קווי ביוב', sewage_manholes:'⭕ שוחות ביוב',
    buildings:'🏢 בניינים', parcels:'📐 חלקות', sleeve:'🔧 שרוולים',
    pipe_label:'🏷️ תוויות צנרת', elevation_label:'📏 גבהים',
    attribute_label:'📊 תוויות נתונים', distance_label:'↔ מרחקים',
    other:'❓ אחר'
  };
  return map[cat] || cat;
}

function renderRules() {
  var el = document.getElementById('rules-list');
  if (!gRules.length) {
    el.innerHTML = '<div class="empty">אין חוקים. צור את הראשון!</div>';
    return;
  }
  var rows = gRules.map(function(r) {
    var catClass = r.category === 'IGNORE' ? 'cat-ignore' : 'cat-active';
    var statusIcon = r.is_active ? '✅' : '⏸️';
    return '<tr>' +
      '<td><span class="priority-num">'+r.priority+'</span></td>' +
      '<td><span class="pattern-cell">'+r.pattern+'</span></td>' +
      '<td><span class="match-pill match-'+r.match_type+'">'+r.match_type+'</span></td>' +
      '<td><span class="cat-pill '+catClass+'">'+categoryName(r.category)+'</span></td>' +
      '<td style="text-align:center">'+statusIcon+'</td>' +
      '<td style="text-align:center"><span class="priority-num">'+(r.match_count||0)+'</span></td>' +
      '<td style="font-size:11px;color:var(--muted)">'+(r.notes||'—')+'</td>' +
      '<td style="white-space:nowrap">'+
        '<button class="btn-sm btn-edit" onclick="openEditModal('+r.id+')">✏️ ערוך</button>'+
        '<button class="btn-sm btn-delete" onclick="deleteRule('+r.id+')">🗑️</button>'+
      '</td>' +
    '</tr>';
  }).join('');
  el.innerHTML = '<table><thead><tr>' +
    '<th style="width:60px">עדיפות</th>'+
    '<th>דפוס</th><th>התאמה</th><th>קטגוריה</th>'+
    '<th style="width:50px">פעיל</th>'+
    '<th style="width:80px">התאמות</th>'+
    '<th>הערות</th>'+
    '<th style="width:140px">פעולות</th>' +
    '</tr></thead><tbody>'+rows+'</tbody></table>';
  MotionUtils.animateTableRows('#rules-list tbody');
}

function openCreateModal() {
  document.getElementById('modal-title').textContent = '➕ חוק חדש';
  document.getElementById('edit-id').value = '';
  document.getElementById('f-pattern').value = '';
  document.getElementById('f-match-type').value = 'contains';
  document.getElementById('f-category').value = 'water_pipes';
  document.getElementById('f-priority').value = '100';
  document.getElementById('f-active').value = 'true';
  document.getElementById('f-notes').value = '';
  document.getElementById('rule-modal-bg').classList.add('open');
}

function openEditModal(id) {
  var r = gRules.find(function(x){return x.id===id;});
  if (!r) return;
  document.getElementById('modal-title').textContent = '✏️ עריכת חוק';
  document.getElementById('edit-id').value = r.id;
  document.getElementById('f-pattern').value = r.pattern;
  document.getElementById('f-match-type').value = r.match_type;
  document.getElementById('f-category').value = r.category;
  document.getElementById('f-priority').value = r.priority;
  document.getElementById('f-active').value = r.is_active ? 'true' : 'false';
  document.getElementById('f-notes').value = r.notes || '';
  document.getElementById('rule-modal-bg').classList.add('open');
}

function closeModal() { document.getElementById('rule-modal-bg').classList.remove('open'); }

async function saveRule() {
  var id = document.getElementById('edit-id').value;
  var pattern = document.getElementById('f-pattern').value.trim();
  var matchType = document.getElementById('f-match-type').value;
  var category = document.getElementById('f-category').value;
  var priority = parseInt(document.getElementById('f-priority').value) || 100;
  var isActive = document.getElementById('f-active').value === 'true';
  var notes = document.getElementById('f-notes').value.trim();

  if (!pattern) { showToast('דפוס חובה', 'error'); return; }

  var data = {
    pattern: pattern,
    match_type: matchType,
    category: category,
    priority: priority,
    is_active: isActive,
    notes: notes,
    updated_at: new Date().toISOString()
  };

  var btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = '⏳ שומר...';
  var res;
  if (id) {
    res = await gSb.from('layer_mapping_rules').update(data).eq('id', id);
  } else {
    data.created_by = gAdminId;
    data.created_by_name = gAdminProfile.full_name || '';
    res = await gSb.from('layer_mapping_rules').insert([data]);
  }
  btn.disabled = false; btn.textContent = '💾 שמור';

  if (res.error) {
    if (res.error.code === '23505') {
      showToast('דפוס "' + pattern + '" עם סוג ההתאמה הזה כבר קיים', 'error');
    } else {
      showToast('שגיאה: ' + res.error.message, 'error');
    }
    return;
  }
  showToast('✅ נשמר', 'success');
  closeModal();
  loadRules();
}

async function deleteRule(id) {
  var r = gRules.find(function(x){return x.id===id;});
  if (!r) return;
  if (!confirm('למחוק את החוק "' + r.pattern + '"?')) return;
  var res = await gSb.from('layer_mapping_rules').delete().eq('id', id);
  if (res.error) { showToast('שגיאה: ' + res.error.message, 'error'); return; }
  showToast('🗑️ נמחק', 'success');
  loadRules();
}

function showToast(msg, type) {
  MotionUtils.showToast(msg, type);
}
