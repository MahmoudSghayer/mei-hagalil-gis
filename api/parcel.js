// Vercel serverless proxy — finds parcel centroid via data.gov.il CKAN API
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { gush, helka } = req.query;
  if (!gush || !helka || isNaN(gush) || isNaN(helka)) {
    return res.status(400).json({ error: 'missing or invalid gush / helka' });
  }

  const g = parseInt(gush);
  const h = parseInt(helka);
  const log = [];

  // ── 1. Search data.gov.il for queryable parcel datasets ───────────────────
  const searchR = await get(
    'https://data.gov.il/api/3/action/package_search' +
    '?q=' + encodeURIComponent('גוש חלקה') +
    '&rows=15',
    8000
  );
  log.push({ step: 'data.gov.il search', status: searchR.status });

  const packages = searchR.data?.result?.results || [];
  const resources = packages
    .flatMap(p => (p.resources || []).map(r => ({ id: r.id, name: r.name, pkg: p.title, active: r.datastore_active })))
    .filter(r => r.active);

  log.push({
    packages: packages.map(p => p.title),
    queryable_resources: resources.map(r => ({ id: r.id, name: r.name, pkg: r.pkg }))
  });

  // Field name combinations to try (Israeli cadastre datasets vary)
  const fieldCombos = [
    { g: 'GUSH_NUM',  h: 'PARCEL_NUM' },
    { g: 'GUSH_NUM',  h: 'HELKA_NUM'  },
    { g: 'GUSH',      h: 'PARCEL'     },
    { g: 'GUSH',      h: 'HELKA'      },
    { g: 'gush_num',  h: 'parcel_num' },
    { g: 'gush_num',  h: 'helka_num'  },
    { g: 'GUS_NUM',   h: 'HLK_NUM'    },
  ];

  for (const resource of resources.slice(0, 8)) {
    for (const combo of fieldCombos) {
      const filters = encodeURIComponent(JSON.stringify({ [combo.g]: g, [combo.h]: h }));
      const r = await get(
        `https://data.gov.il/api/3/action/datastore_search` +
        `?resource_id=${resource.id}&filters=${filters}&limit=1`,
        6000
      );
      const records = r.data?.result?.records;
      log.push({ resource_id: resource.id, combo, status: r.status, count: records?.length ?? 0, sample: records?.[0] });

      if (records?.length) {
        const rec = records[0];
        // Try to find coordinates (might be ITM X/Y or WGS84 lat/lng)
        const x = num(rec.X || rec.x || rec.ITM_X || rec.itm_x || rec.Lon || rec.lon);
        const y = num(rec.Y || rec.y || rec.ITM_Y || rec.itm_y || rec.Lat || rec.lat);
        const area = num(rec.SHAPE_Area || rec.shape_area || rec.AREA || rec.area);
        if (x && y) {
          return res.json({ type: 'centroid', x, y, itm: x > 100000, area });
        }
        // Record found but no coord fields — log it and keep trying
        log.push({ msg: 'record found but no coord fields', keys: Object.keys(rec) });
      }
    }
  }

  // ── 2. Fallback: try data.gov.il SQL search with wider filter ────────────
  // Try the SQL endpoint which allows LIKE-style matching
  const sqlResources = resources.slice(0, 3).map(r => r.id);
  for (const rid of sqlResources) {
    const sql = `SELECT * FROM "${rid}" WHERE "GUSH_NUM"=${g} OR "GUSH"=${g} OR "gush_num"=${g} LIMIT 1`;
    const r = await get(
      `https://data.gov.il/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`,
      6000
    );
    const records = r.data?.result?.records;
    log.push({ sql_resource: rid, status: r.status, count: records?.length ?? 0, sample: records?.[0] });
    if (records?.length) {
      const rec = records[0];
      const x = num(rec.X || rec.x || rec.ITM_X || rec.Lon);
      const y = num(rec.Y || rec.y || rec.ITM_Y || rec.Lat);
      if (x && y) return res.json({ type: 'centroid', x, y, itm: x > 100000 });
    }
  }

  return res.status(404).json({ error: 'not found', log });
};

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

async function get(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'MeiHaGalil-GIS/1.0' },
    });
    clearTimeout(t);
    const text = await r.text();
    let data = null, preview = null;
    try { data = JSON.parse(text); } catch { preview = text.slice(0, 150); }
    return { status: r.status, data, preview };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, error: e.message };
  }
}
