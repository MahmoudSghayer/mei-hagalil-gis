// Deterministic fixture generator for export-format tests. Produces GeoJSON
// features shaped like what fetchFeaturesForCats() in js/export-feature.js hands
// to the serializers: properties._category/._village stamped, WGS84 coordinates
// in the Galilee area, plus a few domain fields (LineDiamet, ManholeNum, TL,
// Depth) that the DXF attribute-label writer looks for.
export const CATS = ['water_meters', 'sewage_manholes', 'water_pipes', 'parcels'];

export function makeFeature(i, opts) {
  opts = opts || {};
  var cat = opts.category || CATS[i % CATS.length];
  var lon = 35.2 + (i % 500) * 0.0007;
  var lat = 32.9 + Math.floor(i / 500) * 0.0007;
  var geomType = opts.geometryType || (cat === 'water_pipes' ? 'LineString' : cat === 'parcels' ? 'Polygon' : 'Point');

  var geometry;
  if (geomType === 'Point') {
    geometry = { type: 'Point', coordinates: [lon, lat] };
  } else if (geomType === 'LineString') {
    geometry = { type: 'LineString', coordinates: [[lon, lat], [lon + 0.001, lat + 0.001]] };
  } else if (geomType === 'Polygon') {
    geometry = { type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.001, lat], [lon + 0.001, lat + 0.001], [lon, lat + 0.001], [lon, lat]]] };
  } else {
    geometry = { type: geomType, coordinates: opts.coordinates || [lon, lat] };
  }

  var properties = {
    _category: cat,
    _village: opts.village || 'כפר טסט',
    OBJECTID: i,
    GlobalID: 'GID-' + i,
    Text: 'Feature ' + i,
  };
  if (cat === 'water_pipes') properties.LineDiamet = 200;
  if (cat === 'sewage_manholes') { properties.ManholeNum = 'MH-' + i; properties.TL = 123.45; properties.Depth = 2.1; }
  if (opts.properties) Object.keys(opts.properties).forEach(function (k) { properties[k] = opts.properties[k]; });

  return { type: 'Feature', properties: properties, geometry: geometry };
}

export function makeFeatures(n, opts) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(makeFeature(i, opts));
  return out;
}
