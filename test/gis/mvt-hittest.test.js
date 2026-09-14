// Local hit-testing over the vector tiles VectorGrid already holds in memory
// (js/gis-mvt-layer.js hitTest / _featureDistPx). This is what makes hover,
// click-to-identify and Edit Mode's click-to-select instant in MVT mode (no
// per-click DB round trip). Fakes mirror VectorGrid 1.3.0's internals:
// vg._vectorTiles[key] = renderer { _tileCoord, _size, _features: { id: { feature } } },
// feature._parts = [[L.Point…]] in TILE pixel space, feature._point for points.
import { describe, it, expect, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function P(x, y) {
  return { x, y,
    scaleBy(s) { return P(this.x * s.x, this.y * s.y); },
    subtract(o) { return P(this.x - o.x, this.y - o.y); },
    add(o) { return P(this.x + o.x, this.y + o.y); } };
}
class FakePolygon { constructor(parts, props) { this._parts = parts; this.properties = props; } }
class FakePolyline { constructor(parts, props) { this._parts = parts; this.properties = props; } }
function pointFeat(x, y, props) { return { _point: P(x, y), properties: props }; }

// Web-mercator-free fake map: "latlng" IS a world pixel position at zoom Z0
// (lng→x, lat→y) so project(latlng, z) = latlng * 2^(z - Z0). Tile size 256.
const Z0 = 16;
function fakeMap(zoom) {
  return {
    getZoom: () => zoom,
    project: (ll, z) => { const s = Math.pow(2, z - Z0); return P(ll.lng * s, ll.lat * s); },
  };
}
function fakeVg(tiles) { return { _vectorTiles: tiles, getTileSize: () => P(256, 256), on: vi.fn() }; }
function tile(z, x, y, features) {
  const f = {};
  Object.keys(features).forEach((id) => { f[id] = { feature: features[id] }; });
  return { _tileCoord: { x, y, z, scaleBy(s) { return P(x * s.x, y * s.y); } }, _size: P(256, 256), _features: f };
}

const settle = () => new Promise((r) => setTimeout(r, 0));   // create() builds its VectorGrid after authToken() resolves

function load(mapZoom, tiles) {
  const map = fakeMap(mapZoom);
  const vg = fakeVg(tiles);
  const L = {
    point: (x, y) => P(x, y),
    Polygon: FakePolygon,
    layerGroup: () => ({ addTo() { return this; }, addLayer: vi.fn(), removeLayer: vi.fn() }),
    vectorGrid: { protobuf: vi.fn(() => vg) },
    canvas: { tile: vi.fn() },
  };
  const gSb = { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } };
  const ctx = loadBrowserGlobals(['js/gis-mvt-layer.js'], { L, gSb, fetch: vi.fn() });
  return { ctx, map, vg, L };
}

describe('GISMvtLayer._featureDistPx (pure, tile-pixel space)', () => {
  it('line: distance to the nearest segment, not to a vertex', async () => {
    const { ctx } = load(16, {});
    const line = new FakePolyline([[P(0, 0), P(100, 0)]], {});
    expect(ctx.GISMvtLayer._featureDistPx(line, P(50, 3))).toBeCloseTo(3, 6);
    expect(ctx.GISMvtLayer._featureDistPx(line, P(120, 0))).toBeCloseTo(20, 6);
  });
  it('filled polygon: 0 inside, edge distance outside (closing edge included)', async () => {
    const { ctx } = load(16, {});
    const poly = new FakePolygon([[P(0, 0), P(100, 0), P(100, 100), P(0, 100)]], {});
    expect(ctx.GISMvtLayer._featureDistPx(poly, P(50, 50))).toBe(0);
    expect(ctx.GISMvtLayer._featureDistPx(poly, P(-10, 50))).toBeCloseTo(10, 6);   // closing edge (0,100)→(0,0)
  });
  it('point: distance to the centre', async () => {
    const { ctx } = load(16, {});
    expect(ctx.GISMvtLayer._featureDistPx(pointFeat(10, 10, {}), P(13, 14))).toBeCloseTo(5, 6);
  });
  it('symbolizer without parts is unreachable', async () => {
    const { ctx } = load(16, {});
    expect(ctx.GISMvtLayer._featureDistPx({ properties: {} }, P(0, 0))).toBe(Infinity);
  });
});

describe('GISMvtLayer.create() — the tile canvas must NOT be interactive', () => {
  it('passes interactive:false to VectorGrid so the canvas never fakeStop()s the map click that identify / Edit Mode rely on', async () => {
    const { ctx, map, L } = load(16, {});
    ctx.GISMvtLayer.create({ map, layerId: 'L1', onClick: vi.fn() }); await settle();
    expect(L.vectorGrid.protobuf).toHaveBeenCalledTimes(1);
    const opts = L.vectorGrid.protobuf.mock.calls[0][1];
    expect(opts.interactive).toBe(false);
  });
});

describe('GISMvtLayer.create().hitTest — nearest feature across the in-memory tiles', () => {
  // world px at Z0=16: tile (2,3) covers x∈[512,768), y∈[768,1024)
  const lineA = new FakePolyline([[P(10, 128), P(200, 128)]], { __id: 'A', asset_code: 'PIPE-A' });   // y=128 in tile → world y=896
  const pointB = pointFeat(240, 20, { __id: 'B', asset_code: 'VALVE-B' });                              // world (752, 788)
  const tiles = { '2:3:16': tile(16, 2, 3, { A: lineA, B: pointB }) };

  it('returns the nearest feature within tolerance with its props and a SCREEN-pixel distance', async () => {
    const { ctx, map } = load(16, tiles);
    const ctl = ctx.GISMvtLayer.create({ map, layerId: 'L1' }); await settle();
    const hit = ctl.hitTest({ lng: 600, lat: 900 }, 12);   // 4px below line A
    expect(hit).toBeTruthy();
    expect(hit.id).toBe('A');
    expect(hit.props.asset_code).toBe('PIPE-A');
    expect(hit.distPx).toBeCloseTo(4, 6);
  });
  it('returns null when nothing is within tolerance', async () => {
    const { ctx, map } = load(16, tiles);
    const ctl = ctx.GISMvtLayer.create({ map, layerId: 'L1' }); await settle();
    expect(ctl.hitTest({ lng: 600, lat: 950 }, 12)).toBeNull();   // 54px away
  });
  it('prefers the closer of two candidates', async () => {
    const { ctx, map } = load(16, tiles);
    const ctl = ctx.GISMvtLayer.create({ map, layerId: 'L1' }); await settle();
    const hit = ctl.hitTest({ lng: 752, lat: 790 }, 12);   // 2px from point B, far from line A
    expect(hit.id).toBe('B');
  });
  it('is overzoom-safe: tolerance is applied in SCREEN pixels when the map is zoomed past the tile zoom', async () => {
    const { ctx, map } = load(18, tiles);   // map at z18, tile is z16 → 4 screen px per tile px
    const ctl = ctx.GISMvtLayer.create({ map, layerId: 'L1' }); await settle();
    // 4 tile px below the line = 16 screen px → beyond a 12px tolerance
    expect(ctl.hitTest({ lng: 600, lat: 900 }, 12)).toBeNull();
    // 2 tile px = 8 screen px → within
    const hit = ctl.hitTest({ lng: 600, lat: 898 }, 12);
    expect(hit.id).toBe('A');
    expect(hit.distPx).toBeCloseTo(8, 6);
  });
  it('skips tiles the point is not in and survives renderers without features', async () => {
    const { ctx, map } = load(16, {
      '9:9:16': { _tileCoord: { x: 9, y: 9, z: 16, scaleBy(s) { return P(9 * s.x, 9 * s.y); } }, _size: P(256, 256), _features: null },
      ...tiles,
    });
    const ctl = ctx.GISMvtLayer.create({ map, layerId: 'L1' }); await settle();
    expect(ctl.hitTest({ lng: 600, lat: 900 }, 12).id).toBe('A');
  });
});
