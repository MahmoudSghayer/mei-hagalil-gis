// Vercel serverless proxy — server-side fetch has no CORS restrictions
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
  const log = [];   // collected for debugging in the 404 response

  const qs = new URLSearchParams({
    where:          `GUSH_NUM=${g} AND PARCEL_NUM=${h}`,
    outFields:      '*',
    returnGeometry: 'true',
    outSR:          '4326',
    f:              'json',
  });

  // ── 1. Try to discover the right service from the ArcGIS catalog ──────────
  const catalogRoots = [
    'https://www.govmap.gov.il/arcgis/rest/services',
    'https://www.govmap.gov.il/server/rest/services',
    'https://gisn.tel-aviv.gov.il/arcgis/rest/services',   // common Israeli ArcGIS host
  ];

  for (const root of catalogRoots) {
    const catalog = await get(`${root}?f=json`, 5000);
    log.push({ url: `${root}?f=json`, status: catalog.status });

    if (!catalog.data?.services) continue;

    const candidates = catalog.data.services.filter(s =>
      /parcel|cadastr|gush|helk/i.test(s.name)
    );
    log.push({ found_services: candidates.map(s => s.name) });

    for (const svc of candidates) {
      for (const layer of [0, 1, 2]) {
        const url = `${root}/${svc.name}/${svc.type}/${layer}/query?${qs}`;
        const r = await get(url, 6000);
        log.push({ url, status: r.status });
        if (r.data?.features?.length) {
          return res.json({ type: 'polygon', features: r.data.features });
        }
      }
    }
  }

  // ── 2. Try hardcoded ArcGIS service paths ─────────────────────────────────
  const arcgisBases = [
    'https://www.govmap.gov.il/arcgis/rest/services/PARCELS/MapServer/0',
    'https://www.govmap.gov.il/arcgis/rest/services/CADASTRE/MapServer/0',
    'https://www.govmap.gov.il/arcgis/rest/services/GushHelka/MapServer/0',
    'https://ags.survey.gov.il/arcgis/rest/services/PARCELS/MapServer/0',
    'https://ags2.survey.gov.il/arcgis/rest/services/PARCELS/MapServer/0',
    'https://mapi.gov.il/arcgis/rest/services/PARCELS/MapServer/0',
  ];

  for (const base of arcgisBases) {
    const url = `${base}/query?${qs}`;
    const r = await get(url, 5000);
    log.push({ url, status: r.status });
    if (r.data?.features?.length) {
      return res.json({ type: 'polygon', features: r.data.features });
    }
  }

  // ── 3. Try GovMap geocode API for centroid-only result ────────────────────
  const geocodeUrls = [
    `https://www.govmap.gov.il/govmap/api/GeoLocator/GeoSearch?types=12&gush=${g}&helka=${h}&lang=1`,
    `https://www.govmap.gov.il/govmap/api/GeoLocate?types=12&gush=${g}&helka=${h}&lang=1`,
    `https://www.govmap.gov.il/govmap/api/GeoLocator?gush=${g}&helka=${h}&lang=1`,
    `https://www.govmap.gov.il/api/GeoLocate?gush=${g}&helka=${h}&lang=1`,
    `https://www.govmap.gov.il/govmap/api/search?gush=${g}&helka=${h}&lang=1`,
  ];

  for (const url of geocodeUrls) {
    const r = await get(url, 5000);
    log.push({ url, status: r.status, preview: r.preview });
    if (r.data) {
      const item = Array.isArray(r.data) ? r.data[0] : r.data;
      const x = item?.X || item?.x;
      const y = item?.Y || item?.y;
      if (x && y) {
        return res.json({ type: 'centroid', x, y, itm: true });
      }
    }
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
    let data = null;
    let preview = null;
    try { data = JSON.parse(text); } catch { preview = text.slice(0, 120); }
    return { status: r.status, data, preview };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, error: e.message };
  }
}
