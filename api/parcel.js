// Vercel serverless proxy — server-side fetch, no CORS
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

  // ── Query a layer after discovering its real field names ──────────────────
  async function queryLayer(base) {
    // Step 1: get schema
    const info = await get(`${base}?f=json`, 5000);
    const fieldNames = info.data?.fields?.map(f => f.name) || [];
    log.push({ schema: base, status: info.status, fields: fieldNames });

    if (!fieldNames.length) {
      // Grab one sample record so we can see what the service actually returns
      const sample = await get(
        `${base}/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=1&f=json`,
        4000
      );
      log.push({ sample_status: sample.status, sample_attrs: sample.data?.features?.[0]?.attributes, sample_preview: sample.preview });
      return null;
    }

    // Step 2: find gush + parcel fields by name pattern
    const gushF   = info.data.fields.find(f => /gush/i.test(f.name));
    const parcelF = info.data.fields.find(f => /parcel|helka|hlk/i.test(f.name));

    if (!gushF || !parcelF) {
      // Still grab a sample so we can see available field names & values
      const sample = await get(
        `${base}/query?where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=1&f=json`,
        4000
      );
      log.push({ msg: 'no gush/parcel field match', sample_attrs: sample.data?.features?.[0]?.attributes });
      return null;
    }

    // Step 3: query with real field names
    const where = `${gushF.name}=${g} AND ${parcelF.name}=${h}`;
    log.push({ where });
    const qs = new URLSearchParams({ where, outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json' });
    const result = await get(`${base}/query?${qs}`, 6000);
    log.push({ query_status: result.status, features: result.data?.features?.length ?? 0 });

    return result.data?.features?.length ? result.data : null;
  }

  // ── 1. Catalog discovery (log ALL service names) ──────────────────────────
  const catalogRoots = [
    'https://www.govmap.gov.il/arcgis/rest/services',
    'https://www.govmap.gov.il/server/rest/services',
    'https://mapi.gov.il/arcgis/rest/services',
  ];

  for (const root of catalogRoots) {
    const cat = await get(`${root}?f=json`, 5000);
    const allNames = (cat.data?.services || []).map(s => ({ name: s.name, type: s.type }));
    log.push({ catalog: root, status: cat.status, all_services: allNames });

    // Broad filter — include any service that might relate to land/survey/parcel
    const candidates = (cat.data?.services || []).filter(s =>
      /parcel|cadastr|gush|helk|kds|land|survey|meas|real.?est|מקרקע|קדסטר/i.test(s.name)
    );
    for (const svc of candidates) {
      for (const layer of [0, 1, 2]) {
        const data = await queryLayer(`${root}/${svc.name}/${svc.type}/${layer}`);
        if (data?.features?.length) return res.json({ type: 'polygon', features: data.features });
      }
    }
  }

  // ── 2. Known 200-returning bases — schema discovery ───────────────────────
  const knownBases = [
    'https://www.govmap.gov.il/arcgis/rest/services/PARCELS/MapServer/0',
    'https://www.govmap.gov.il/arcgis/rest/services/CADASTRE/MapServer/0',
    'https://www.govmap.gov.il/arcgis/rest/services/GushHelka/MapServer/0',
    'https://mapi.gov.il/arcgis/rest/services/PARCELS/MapServer/0',
  ];

  for (const base of knownBases) {
    const data = await queryLayer(base);
    if (data?.features?.length) return res.json({ type: 'polygon', features: data.features });
  }

  return res.status(404).json({ error: 'not found', log });
};

async function get(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'MeiHaGalil-GIS/1.0',
        Referer: 'https://www.govmap.gov.il/',
      },
    });
    clearTimeout(t);
    const text = await r.text();
    let data = null, preview = null;
    try { data = JSON.parse(text); } catch { preview = text.slice(0, 200); }
    return { status: r.status, data, preview };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, error: e.message };
  }
}
