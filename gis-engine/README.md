# GIS Engine Layer

A pure-JavaScript logic layer (ArcGIS-like "brain") that sits between the
Leaflet UI and Supabase. **The UI never calls Supabase directly** — it calls
`GIS.*`.

```
Frontend (Leaflet)  →  GIS Engine Layer  →  Supabase (PostgreSQL + PostGIS)
```

No build step, no framework. Plain `<script>` files attaching to a global
`GIS` object. Reuses the app's existing `gSb` Supabase client (from
`js/auth.js`) and respects Row Level Security.

---

## Folder structure

```
/gis-engine
  core.js         GIS namespace, gSb access, roles/permissions   (load FIRST)
  layers.js       GIS.layers    — layer definitions
  features.js     GIS.features  — pipes / valves / hydrants
  fields.js       GIS.fields    — attribute schema + calculated fields
  calculator.js   GIS.calculator— SAFE expression evaluator (no eval)
  queries.js      GIS.queries   — SQL-like attribute filtering
  spatial.js      GIS.spatial   — distance / buffer / intersects / withinRadius
  meters.js       GIS.meters    — Arad meter integration (admin only)
  villages.js     GIS.villages  — adapter for ALREADY-UPLOADED village GeoJSON
  /sql
    schema.sql    tables, RPCs, triggers, RLS   (run once in Supabase)
    seed.sql      example dataset
```

## Install

1. **Database** — Supabase → SQL Editor → run `sql/schema.sql`, then
   optionally `sql/seed.sql`.
2. **Scripts** — include after `js/auth.js` (which defines `gSb`). Order
   matters: `core.js` first; the rest can follow in any order.

```html
<!-- existing -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="js/auth.js"></script>
<!-- optional: enables spatial.buffer()/intersects() -->
<script src="https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js"></script>

<!-- GIS engine -->
<script src="gis-engine/core.js"></script>
<script src="gis-engine/spatial.js"></script>
<script src="gis-engine/layers.js"></script>
<script src="gis-engine/features.js"></script>
<script src="gis-engine/fields.js"></script>
<script src="gis-engine/calculator.js"></script>
<script src="gis-engine/queries.js"></script>
<script src="gis-engine/meters.js"></script>
```

## Roles

| Role       | GIS features | Meters | Schema (layers/fields) |
|------------|:------------:|:------:|:----------------------:|
| `admin`    | edit         | edit   | edit                   |
| `engineer` | edit         | read   | read                   |
| `office`   | read         | read   | read                   |

Enforced by RLS in the database; the engine also checks early to give a clear
error message. (`profiles.role` is extended to allow `engineer`/`office`.)

---

## Example — render a layer on the Leaflet map

```js
// WRONG:  supabase.from('features')...
// CORRECT:
async function loadLayer(map, layerId) {
  const fc = await GIS.features.getFeatures(layerId);   // GeoJSON FeatureCollection
  return L.geoJSON(fc, {
    onEachFeature: (feature, lyr) => {
      lyr.on('click', () => openAttributePanel(feature)); // your existing UI
    }
  }).addTo(map);
}

// list layers for a sidebar
const layers = await GIS.layers.getLayers();   // [{ id, name, geometry_type, fields:[...] }]
```

## Example — add a field (ArcGIS "Add Field")

```js
// structured field
await GIS.fields.addField(pipesLayerId, { name: 'material', type: 'text' });

// calculated field (expression validated up-front)
await GIS.fields.addField(pipesLayerId, {
  name: 'age', type: 'int', is_calculated: true, expression: '2026 - install_year'
});
```

## Example — calculate "age" across a layer and persist it

```js
// evaluate one feature
const f = (await GIS.features.getFeatures(pipesLayerId)).features[0];
GIS.calculator.evaluateExpression(f, '2026 - install_year');     // → 16
GIS.calculator.evaluateExpression(f, 'length(geometry)');        // → metres

// evaluate + store for the whole layer (writes properties.age)
await GIS.fields.calculate(pipesLayerId, 'age', '2026 - install_year');
await GIS.fields.calculate(pipesLayerId, 'risk_score', 'age * 0.5 + diameter * 0.01');
```

## Example — filter features (SQL-like)

```js
let fc = await GIS.queries.queryFeatures(pipesLayerId, "material = 'PVC'");
fc     = await GIS.queries.queryFeatures(pipesLayerId, 'install_year < 2000');
fc     = await GIS.queries.queryFeatures(pipesLayerId, "diameter > 100 AND status = 'active'");

// inspect the safe parsed form (this structure — not raw SQL — goes to the DB)
GIS.queries.parseFilterToSQL("diameter > 100 AND status = 'active'");
// → { logic:'and', conditions:[ {field:'diameter',op:'>',value:100},
//                                {field:'status',op:'=',value:'active'} ] }

L.geoJSON(fc).addTo(map);   // render the filtered result
```

## Example — import Arad meters (admin only)

```js
// data parsed from CSV/JSON upload; field aliases are auto-normalised
await GIS.meters.importMeters([
  { arad_meter_id: 'ARAD-900100', customer_id: 'CUST-777', asset_code: 'PIPE-1001',
    lng: 35.297, lat: 32.8655, last_reading: 1200, consumption: 14.2 }
]);   // → { inserted, updated, total }

// link a meter to a feature by asset_code (primary key)
const pipe = await GIS.features.getFeatureById(pipeId);
await GIS.meters.linkMeterToFeature({ arad_meter_id: 'ARAD-900100' }, pipe);

// render meters + flag anomalies
const meters = await GIS.meters.getMeters();
L.geoJSON(meters).addTo(map);
const anomalies = await GIS.meters.getAnomalies();   // consumption > 1.5× avg

// future-ready: pull from Arad API (set GIS.config.aradSyncUrl first)
await GIS.meters.syncMeters();
```

## Example — work with already-uploaded village data (no migration)

The 7 villages were uploaded as flat GeoJSON in Storage (indexed by
`village_layers`, categorised by `properties._category`). `GIS.villages` brings
them under the engine without moving them into PostGIS. It reuses the features
`index.js` already loaded (`window.gVillageFeatures`) or fetches from Storage,
and synthesises a stable `asset_code` on read. Filtering + the calculator run
client-side (this data isn't in PostGIS).

```js
const villages = await GIS.villages.getVillages();          // village_layers rows
const cats = await GIS.villages.getCategories(villages[0].village_id);
// → [{ category:'water_pipes', count: 18121 }, ...]

// all features (asset_code synthesised), or just one category
const fc   = await GIS.villages.getFeatures(vid);
const pipes = await GIS.villages.getFeatures(vid, { category: 'water_pipes' });

// same SQL-like filter syntax, evaluated client-side
const old = await GIS.villages.query(vid, "install_year < 2000", { category: 'water_pipes' });

// same field calculator
const ages = await GIS.villages.calculate(vid, '2026 - install_year', { category: 'water_pipes' });

// click a village feature → shared attribute panel
GIS.villages.openInPanel(fc.features[0]);
```

---

## Internal Supabase calls (reference)

The engine uses these — the UI should not.

| Engine call | Supabase under the hood |
|---|---|
| `GIS.features.getFeatures` | `rpc('features_geojson', { p_layer_id })` |
| `GIS.queries.queryFeatures` | `rpc('query_features', { p_layer_id, p_conditions, p_logic })` |
| `GIS.features.createFeature` | `rpc('create_feature', ...)` (geometry from GeoJSON) |
| `GIS.features.updateFeature` | `from('features').update({ properties }).eq('id', …)` |
| `GIS.meters.getMeters` | `rpc('meters_geojson')` |
| `GIS.meters.importMeters` | `rpc('import_meters', { p_meters })` |
| `GIS.meters.getAnomalies` | `from('v_meter_anomalies').select('*')` |
| `GIS.layers.getLayers` | `from('layers').select(...)` + `from('fields').select(...)` |

## Design notes

- **Safety:** the calculator and the filter parser never use `eval`/
  `new Function`. Expressions are tokenized → parsed to an AST → validated
  against a field/function whitelist → interpreted. Filters are sent to the DB
  as a structured array; the RPC whitelists operators, regex-checks field
  names, and quotes values.
- **`asset_code`** is the primary link key across GIS features, Arad meters,
  and external data. Every feature must have one.
- **Reads return GeoJSON** so results drop straight into `L.geoJSON(...)`.
- **Auto-calc:** a DB trigger fills `length_m` (lines), `age` (from
  `install_year`), and a default `status` on every insert/update.
```
