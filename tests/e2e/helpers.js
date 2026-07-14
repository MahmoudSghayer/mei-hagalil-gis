// Shared helpers for the write-gated E2E specs (import-flow / table-flow /
// export-area / realtime). Read tests/e2e/rbac.spec.js and playwright.config.js
// first if you haven't — this file follows the same skip-without-secrets
// convention, just for a SECOND, stronger gate (admin creds AND an explicit
// opt-in), because these specs WRITE to the live production database.
//
// ── PRODUCTION-SAFETY CONTRACT (see project instructions) ──────────────────
//  1. Double-gated: every write spec calls writeGateReason() and test.skip()s
//     unless BOTH MGIS_ADMIN_EMAIL/MGIS_ADMIN_PASSWORD are set AND
//     MGIS_E2E_WRITE=1 is set.
//  2. Self-contained: every feature this suite creates carries asset_code
//     'E2E-<runId>-<i>' before the server re-synthesises it into
//     '<village-slug>-<category>-E2E-<runId>-<i>' (see
//     gis-engine/migrate.js:30 synthAssetCode — it uses properties.asset_code
//     as the "uid" verbatim when present), so every row this suite ever
//     touches contains the literal substring 'E2E-<runId>' in its asset_code.
//     cleanupE2E() below deletes ONLY rows matching that marker, never a
//     bulk/blind delete.
//  3. Tiny volumes: buildE2EFeatureCollection() always makes exactly 3 points.
//
// ── Why REST (not supabase-js) for setup/cleanup ────────────────────────────
// The binding rules for this worker forbid touching package.json, so
// @supabase/supabase-js is not available as a Node dependency here. Supabase's
// REST (PostgREST) and GoTrue (auth) endpoints are plain HTTP, so Playwright's
// built-in `request` fixture (APIRequestContext) is enough — no extra
// dependency, and it exercises the exact same RLS-gated endpoints the app's
// browser client (js/auth.js) talks to.
//
// SUPABASE_URL / SUPABASE_ANON_KEY below are copied verbatim from
// js/auth.js:6-7 — this is the public anon key Supabase issues for
// client-side use (every page in this app ships it in plain JS); it has no
// power beyond what RLS grants an authenticated/anon session, so committing
// it here is exactly as safe as it already being in js/auth.js.
const { expect } = require('@playwright/test');

const SUPABASE_URL = 'https://hlbogufrdxpviyxlwqtf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsYm9ndWZyZHhwdml5eGx3cXRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMjcyMzUsImV4cCI6MjA5MjkwMzIzNX0.8AvY5isXAJfa2mYC2keDBTlw4hv9mVwytH0oWxW3vKA';

// One of the 7 utility villages the app auto-detects uploads into (js/pages/upload.js
// VILLAGES[4] / js/gis-engine-sidebar.js VILLAGE_CENTERS['סחנין']) — coords are the
// village's exact detection anchor, so points offset by a few hundredths of a degree
// stay comfortably inside detectVillage()'s MAX_VILLAGE_DISTANCE (0.045) and its own
// radius (0.027), and are dominant (100%) for this village since they're nowhere near
// any other village's anchor.
const VILLAGE = { name: 'סחנין', slug: 'sakhnin', lat: 32.865, lng: 35.2978 };

const ADMIN_EMAIL = process.env.MGIS_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.MGIS_ADMIN_PASSWORD;
const WRITE_ENABLED = process.env.MGIS_E2E_WRITE === '1';

// Returns a human-readable skip reason, or null if the write-gate is open.
// Callers do: test.skip(!!writeGateReason(), writeGateReason() || '').
function writeGateReason() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return 'set MGIS_ADMIN_EMAIL / MGIS_ADMIN_PASSWORD to run (admin/engineer test account)';
  }
  if (!WRITE_ENABLED) {
    return 'set MGIS_E2E_WRITE=1 to opt into write specs (this suite creates + deletes real rows)';
  }
  return null;
}

function newRunId() {
  return String(Date.now());
}

// Build a tiny (3-point) FeatureCollection inside VILLAGE, carrying a
// distinctive marker on every feature:
//   properties.Layer       — CAD-style "Layer" attribute upload.js's
//                             ImportPipeline.getLayerName() groups by (see
//                             js/import-pipeline.js:151-155) — becomes the
//                             single row in the upload page's layer-mapping
//                             table, and (unmatched by any global rule) maps
//                             to category 'other' by default — already the
//                             pre-selected option, no UI interaction needed.
//   properties.asset_code  — becomes the "uid" gis-engine/migrate.js:30-35
//                             synthAssetCode() uses verbatim, so the FINAL
//                             stored asset_code is
//                             '<village-slug>-other-E2E-<runId>-<i>' — always
//                             contains the literal 'E2E-<runId>' substring.
//   properties.note        — a plain, non-underscore-prefixed field so it
//                             survives ImportPipeline.validate()'s property
//                             sanitising and shows up as a real, editable
//                             column in the attribute table (js/gis-feature-table.js
//                             HIDE = /^_|^__/ only hides underscore-prefixed keys).
function buildE2EFeatureCollection(runId) {
  const features = [0, 1, 2].map((i) => ({
    type: 'Feature',
    properties: {
      Layer: `E2E-${runId}`,
      asset_code: `E2E-${runId}-${i}`,
      note: `e2e-${runId}-${i}`
    },
    geometry: {
      type: 'Point',
      // Small distinct offsets (~60m apart) so the 3 points are separable on
      // screen at a close zoom, but stay well inside the village's detection
      // radius and inside a tiny draw-scope rectangle for export-area.spec.js.
      coordinates: [VILLAGE.lng + i * 0.0006, VILLAGE.lat + i * 0.0006]
    }
  }));
  return { type: 'FeatureCollection', features };
}

// ── Supabase REST (PostgREST + GoTrue) — setup verification & cleanup ──────
async function restLogin(request, email, password) {
  const resp = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    data: { email, password }
  });
  if (!resp.ok()) {
    throw new Error(`REST login failed (${resp.status()}): ${await resp.text()}`);
  }
  const json = await resp.json();
  if (!json.access_token) throw new Error(`REST login: no access_token in response: ${JSON.stringify(json)}`);
  return json.access_token;
}

function restHeaders(token) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
}

// Every row this suite creates carries 'E2E-<runId>' inside asset_code (see
// buildE2EFeatureCollection's header comment) — PostgREST 'like' with '*'
// wildcards on both sides matches the substring anywhere in the column.
async function findE2EFeatures(request, token, runId) {
  const url = `${SUPABASE_URL}/rest/v1/features` +
    `?asset_code=like.*E2E-${runId}*` +
    `&select=id,layer_id,asset_code,properties`;
  const resp = await request.get(url, { headers: restHeaders(token) });
  if (!resp.ok()) throw new Error(`REST feature query failed (${resp.status()}): ${await resp.text()}`);
  return resp.json();
}

async function waitForE2EFeatures(request, token, runId, expectedCount, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  let last = [];
  while (Date.now() < deadline) {
    last = await findE2EFeatures(request, token, runId);
    if (last.length >= expectedCount) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForE2EFeatures: only found ${last.length}/${expectedCount} rows for E2E-${runId} after ${timeoutMs || 20000}ms`
  );
}

// Deletes ONLY the feature rows carrying this run's marker, then — for every
// layer_id those rows belonged to — deletes the layer too IFF it is now
// completely empty (so a pre-existing production "<village> · other" layer
// that our features happened to land in, per ensure_layer's upsert-by-name,
// is left alone; only a layer this run created outright, and left empty by
// this cleanup, is removed). Safe to call even if nothing was ever created
// (returns zero counts) — every test calls this in a finally/afterAll.
async function cleanupE2E(request, token, runId) {
  const rows = await findE2EFeatures(request, token, runId);
  if (!rows.length) return { deletedFeatures: 0, deletedLayers: 0 };

  const ids = rows.map((r) => r.id);
  const layerIds = [...new Set(rows.map((r) => r.layer_id))];

  const delResp = await request.delete(
    `${SUPABASE_URL}/rest/v1/features?id=in.(${ids.join(',')})`,
    { headers: { ...restHeaders(token), Prefer: 'return=minimal' } }
  );
  if (!delResp.ok()) {
    throw new Error(`cleanupE2E: feature delete failed (${delResp.status()}): ${await delResp.text()}`);
  }

  let deletedLayers = 0;
  for (const layerId of layerIds) {
    const remainResp = await request.get(
      `${SUPABASE_URL}/rest/v1/features?layer_id=eq.${layerId}&select=id&limit=1`,
      { headers: restHeaders(token) }
    );
    if (!remainResp.ok()) continue; // best-effort — feature rows are already gone either way
    const remaining = await remainResp.json();
    if (Array.isArray(remaining) && remaining.length === 0) {
      const layerDelResp = await request.delete(
        `${SUPABASE_URL}/rest/v1/layers?id=eq.${layerId}`,
        { headers: { ...restHeaders(token), Prefer: 'return=minimal' } }
      );
      if (layerDelResp.ok()) deletedLayers++;
    }
  }
  return { deletedFeatures: ids.length, deletedLayers };
}

// ── App UI helpers ──────────────────────────────────────────────────────────
// Mirrors tests/e2e/rbac.spec.js's login flow exactly (pages/login.html
// #email/#password/#login-btn — see that file).
async function loginUI(page, email, password) {
  await page.goto('/pages/login.html');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#login-btn');
  await page.waitForURL(/index|\/$/i, { timeout: 20000 }).catch(() => {});
}

// Drives pages/upload.html's real drop-zone flow (js/pages/upload.js) for a
// GeoJSON FeatureCollection built by buildE2EFeatureCollection(): sets the
// file on #file-input (js/pages/upload.js:44-48 <input id="file-input">),
// waits for the auto village-detection card to accept it
// (#detection-card.show, not .error — js/pages/upload.js renderDetection()),
// waits for the single-row layer-mapping table (#ms-total === '1', category
// defaults to 'other' — no dropdown interaction needed, see header comment
// on buildE2EFeatureCollection), then clicks #upload-btn (onclick="doUpload()")
// and waits for the exact success text doUpload() writes to #progress-text
// (js/pages/upload.js:757) once GIS.migrate.importFeatures has committed.
async function uploadE2ELayer(page, runId) {
  const fc = buildE2EFeatureCollection(runId);
  await page.goto('/pages/upload.html');
  await page.locator('#file-input').setInputFiles({
    name: `e2e-${runId}.geojson`,
    mimeType: 'application/geo+json',
    buffer: Buffer.from(JSON.stringify(fc))
  });

  await expect(page.locator('#detection-card')).toHaveClass(/\bshow\b/, { timeout: 20000 });
  await expect(page.locator('#detection-card')).not.toHaveClass(/\berror\b/);
  await expect(page.locator('#mapping-section')).toHaveClass(/\bshow\b/, { timeout: 20000 });
  await expect(page.locator('#ms-total')).toHaveText('1');

  await page.click('#upload-btn');
  await expect(page.locator('#progress-text')).toContainText('יובאו 3 אובייקטים', { timeout: 30000 });

  return fc;
}

// Finds the sidebar row for `layerId` (js/gis-engine-sidebar.js row() —
// `.ge-row[data-layer-id="<id>"]`), expanding its village block first if
// collapsed (villages start collapsed — js/gis-engine-sidebar.js:108
// `var openVillages = {}`), then clicks the row's "🔍 התמקד בשכבה" button
// (.ge-zoom — js/gis-engine-sidebar.js:790, zoomToLayer()) so the map flies
// to exactly this layer's extent — after this, our 3 E2E points fill (most
// of) the visible map viewport, which both clickMapPoint() and the
// export-area draw-rectangle helper rely on.
async function focusE2ELayerOnMap(page, layerId, village) {
  await page.goto('/');
  const row = page.locator(`.ge-row[data-layer-id="${layerId}"]`);
  await row.waitFor({ state: 'attached', timeout: 20000 });

  const villageWrap = page.locator(`.ge-village[data-village="${village}"]`);
  const collapsed = await villageWrap.evaluate((el) => el.classList.contains('collapsed'));
  if (collapsed) await villageWrap.locator('.ge-vhead').click();

  await row.scrollIntoViewIfNeeded();
  await row.locator('.ge-zoom').click();
  await page.waitForTimeout(1200); // flyToBounds runs an 800ms animation (js/gis-engine-sidebar.js:733)
  return row;
}

// Toggles a layer row's render checkbox on (js/gis-engine-sidebar.js row()
// `<input type="checkbox">` — the FIRST checkbox in the row; the row also has
// an `input[type=color]` picker, so `input[type=checkbox]` is unambiguous).
async function activateLayerRow(row) {
  const cb = row.locator('input[type=checkbox]');
  if (!(await cb.isChecked())) await cb.check();
}

// Projects a WGS84 [lat,lng] to a page-pixel coordinate via the live Leaflet
// map (window.gMap — set globally by js/pages/index.js, referenced the same
// way throughout the app, e.g. js/gis-edit.js/js/arcgis-ribbon.js) and clicks
// it. Used instead of guessing on-screen marker positions: after
// focusE2ELayerOnMap() has flown to our layer's exact extent, this reliably
// lands within GISEngineSidebar's click-hit-test tolerance
// (TOL_PX = 12 — js/gis-engine-sidebar.js:273) of one of our 3 points.
async function clickMapPoint(page, lat, lng) {
  const pt = await page.evaluate(([latArg, lngArg]) => {
    const p = window.gMap.latLngToContainerPoint([latArg, lngArg]);
    const rect = document.getElementById('map').getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }, [lat, lng]);
  await page.mouse.click(pt.x, pt.y);
}

// Opens the attribute table for one of our E2E points: click the point on
// the map → GISEngineSidebar.openPanelFor → GISPanel.open (js/gis-attribute-panel.js)
// → its footer's "📋 טבלת עריכה" button (#gp-table, only rendered when opened
// with a layerId — js/gis-attribute-panel.js:357,368-371) → GISTable.openLayer.
async function openE2ETable(page, layerId, village, feature) {
  const row = await focusE2ELayerOnMap(page, layerId, village);
  await activateLayerRow(row);
  await page.waitForTimeout(800); // let the (re)built tile/MVT layer render the point
  const [lng, lat] = feature.geometry.coordinates;
  await clickMapPoint(page, lat, lng);
  await expect(page.locator('#gp-table')).toBeVisible({ timeout: 10000 });
  await page.click('#gp-table');
  await expect(page.locator('#gis-tbl')).toHaveClass(/\bopen\b/, { timeout: 10000 });
  await expect(page.locator('.gt-pager')).toBeVisible({ timeout: 15000 });
}

// Reads a Playwright Download's full content as a UTF-8 string (works
// headless/CI without relying on download.path(), which can be null under
// some browser/OS combinations — createReadStream() always works).
async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  VILLAGE,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  WRITE_ENABLED,
  writeGateReason,
  newRunId,
  buildE2EFeatureCollection,
  restLogin,
  restHeaders,
  findE2EFeatures,
  waitForE2EFeatures,
  cleanupE2E,
  loginUI,
  uploadE2ELayer,
  focusE2ELayerOnMap,
  activateLayerRow,
  clickMapPoint,
  openE2ETable,
  readDownload
};
