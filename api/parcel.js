// Vercel serverless proxy — no CORS restrictions on server-side fetch
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

  const qs = new URLSearchParams({
    where:          `GUSH_NUM=${g} AND PARCEL_NUM=${h}`,
    outFields:      'GUSH_NUM,PARCEL_NUM,SHAPE_Area',
    returnGeometry: 'true',
    outSR:          '4326',
    f:              'json'
  });

  // Candidates — tried in parallel; first one with features wins
  const bases = [
    'https://www.govmap.gov.il/arcgis/rest/services/PARCELS/MapServer/0',
    'https://www.govmap.gov.il/arcgis/rest/services/CADASTRE/MapServer/0',
    'https://www.govmap.gov.il/arcgis/rest/services/GushHelka/MapServer/0',
    'https://www.govmap.gov.il/server/rest/services/PARCELS/MapServer/0',
    'https://ags.survey.gov.il/arcgis/rest/services/PARCELS/MapServer/0',
  ];

  async function attempt(base) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`${base}/query?${qs}`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'MeiHaGalil-GIS/1.0' }
      });
      clearTimeout(t);
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      if (!data.features || !data.features.length) throw new Error('empty');
      return data;
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }

  try {
    const data = await Promise.any(bases.map(attempt));
    return res.json(data);
  } catch {
    return res.status(404).json({ error: 'parcel not found in any source' });
  }
};
