// LayerNaming.fromRow (W5.2) — DB carries the layer identity.
//
// public.layers now has real village/category columns (backfilled + auto-
// maintained by a trigger — see
// gis-engine/sql/migrations/2026-07-15-layers-village-category.sql), but
// callers may still receive a layer row without them: an older client-side
// cache, an RPC whose select string doesn't enumerate the new columns, or a
// DB the migration hasn't been applied to yet. LayerNaming.fromRow(layer)
// is the single place that decides "row columns vs. re-parse the name" so
// every consumer stops duplicating that decision.
//
// This file tests:
//   1) LayerNaming.fromRow itself — prefers columns / falls back to
//      name-parse / handles a null category + entirely missing fields.
//   2) Per-consumer equivalence: for each of the listed consumers, the
//      row-preferring helper they now expose produces the IDENTICAL
//      downstream value whether the row carries village/category columns
//      or not (as long as the columns, when present, are consistent with
//      the name — exactly what a real backfilled DB row looks like).
import { describe, it, expect } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeAppDocument } from '../fixtures/export/stub-dom.mjs';

function loadLayerNaming() {
  return loadBrowserGlobals(['js/layer-naming.js']).LayerNaming;
}

describe('LayerNaming.fromRow', () => {
  const LayerNaming = loadLayerNaming();

  it('prefers layer.village/category columns when category is present', () => {
    const row = { name: 'סחנין · water_pipes', village: 'סחנין', category: 'water_pipes' };
    expect(LayerNaming.fromRow(row)).toEqual({ village: 'סחנין', category: 'water_pipes' });
  });

  it('prefers columns even when they disagree with name — columns are authoritative', () => {
    // Not a realistic DB state (the trigger keeps them in sync), but proves
    // fromRow actually READS the columns instead of silently re-deriving
    // from name whenever both are present.
    const row = { name: 'סחנין · water_pipes', village: 'עראבה', category: 'hydrants' };
    expect(LayerNaming.fromRow(row)).toEqual({ village: 'עראבה', category: 'hydrants' });
  });

  it('treats a null village column as village: null even when category is present (no-separator row)', () => {
    const row = { name: 'ignored-name', village: null, category: 'valves' };
    expect(LayerNaming.fromRow(row)).toEqual({ village: null, category: 'valves' });
  });

  it('treats an empty-string category column as PRESENT (not a fallback trigger)', () => {
    const row = { name: 'should not be parsed', village: null, category: '' };
    expect(LayerNaming.fromRow(row)).toEqual({ village: null, category: '' });
  });

  it('falls back to name-parse when category is explicitly null (migration not applied yet)', () => {
    const row = { name: 'סחנין · water_pipes', village: null, category: null };
    expect(LayerNaming.fromRow(row)).toEqual(LayerNaming.parse(row.name));
    expect(LayerNaming.fromRow(row)).toEqual({ village: 'סחנין', category: 'water_pipes' });
  });

  it('falls back to name-parse when village/category keys are entirely missing (older cache/RPC row)', () => {
    const row = { name: 'עראבה · hydrants' };
    expect(LayerNaming.fromRow(row)).toEqual({ village: 'עראבה', category: 'hydrants' });
  });

  it('falls back to name-parse for a no-separator name with no columns', () => {
    const row = { name: 'just_a_category' };
    expect(LayerNaming.fromRow(row)).toEqual({ village: null, category: 'just_a_category' });
  });

  it('handles a completely empty row (no name, no columns)', () => {
    expect(LayerNaming.fromRow({})).toEqual({ village: null, category: '' });
  });

  it('handles undefined/null input gracefully (parses an empty name)', () => {
    expect(LayerNaming.fromRow(undefined)).toEqual({ village: null, category: '' });
    expect(LayerNaming.fromRow(null)).toEqual({ village: null, category: '' });
  });
});

// ── per-consumer equivalence: columns present vs absent → identical result ──
// Two representative layer rows (separator present / absent), each built
// twice: once WITH village/category columns consistent with the name (the
// real post-migration DB shape) and once WITHOUT them at all (pre-migration
// / stale-cache shape). A consumer's row-preferring helper must return the
// same downstream value either way.
const ROWS = [
  {
    label: 'village · category',
    withColumns: { id: 'L1', name: 'סחנין · water_pipes', village: 'סחנין', category: 'water_pipes', geometry_type: 'LineString', color: '#1a7fc1' },
    withoutColumns: { id: 'L1', name: 'סחנין · water_pipes', geometry_type: 'LineString', color: '#1a7fc1' },
  },
  {
    label: 'no separator',
    withColumns: { id: 'L2', name: 'no_separator_category', village: null, category: 'no_separator_category', geometry_type: 'Point', color: '#0d3b5e' },
    withoutColumns: { id: 'L2', name: 'no_separator_category', geometry_type: 'Point', color: '#0d3b5e' },
  },
];

describe('Per-consumer equivalence — layer.village/category columns present vs absent', () => {
  describe('GISEngineSidebar._rowVC (js/gis-engine-sidebar.js)', () => {
    const ctx = loadBrowserGlobals(['js/gis-engine-sidebar.js'], { LayerNaming: loadLayerNaming() });
    ROWS.forEach((r) => {
      it(`agrees for a ${r.label} row`, () => {
        expect(ctx.GISEngineSidebar._rowVC(r.withColumns)).toEqual(ctx.GISEngineSidebar._rowVC(r.withoutColumns));
      });
    });
  });

  describe('GISEdit._rowVC (js/gis-edit.js)', () => {
    const ctx = loadBrowserGlobals(['js/gis-edit.js'], { LayerNaming: loadLayerNaming() });
    ROWS.forEach((r) => {
      it(`agrees for a ${r.label} row`, () => {
        expect(ctx.GISEdit._rowVC(r.withColumns)).toEqual(ctx.GISEdit._rowVC(r.withoutColumns));
      });
    });
  });

  describe('GISAnalysis._rowVC (js/gis-analysis.js)', () => {
    const ctx = loadBrowserGlobals(['js/gis-analysis.js'], { LayerNaming: loadLayerNaming() });
    ROWS.forEach((r) => {
      it(`agrees for a ${r.label} row`, () => {
        expect(ctx.GISAnalysis._rowVC(r.withColumns)).toEqual(ctx.GISAnalysis._rowVC(r.withoutColumns));
      });
    });
  });

  describe('GISDashboard._rowVC (js/gis-dashboard.js)', () => {
    const ctx = loadBrowserGlobals(['js/gis-dashboard.js'], { LayerNaming: loadLayerNaming() });
    ROWS.forEach((r) => {
      it(`agrees for a ${r.label} row`, () => {
        expect(ctx.GISDashboard._rowVC(r.withColumns)).toEqual(ctx.GISDashboard._rowVC(r.withoutColumns));
      });
    });
  });

  describe('GISFlow._parseLayer (js/gis-flow.js)', () => {
    const ctx = loadBrowserGlobals(['js/gis-flow.js'], { LayerNaming: loadLayerNaming() });
    ROWS.forEach((r) => {
      it(`agrees for a ${r.label} row (incl. the village-falls-back-to-name quirk)`, () => {
        expect(ctx.GISFlow._parseLayer(r.withColumns)).toEqual(ctx.GISFlow._parseLayer(r.withoutColumns));
      });
    });

    it('preserves the no-separator quirk: village falls back to the FULL name, not null', () => {
      const noSep = ROWS[1];
      const parsed = ctx.GISFlow._parseLayer(noSep.withColumns);
      expect(parsed.village).toBe('no_separator_category');
      expect(parsed).toEqual(ctx.GISFlow._parseLayer(noSep.withoutColumns));
    });
  });

  describe('GISTrace._parseLayer (js/gis-network-trace.js)', () => {
    const ctx = loadBrowserGlobals(['js/gis-network-trace.js'], { LayerNaming: loadLayerNaming() });
    ROWS.forEach((r) => {
      it(`agrees for a ${r.label} row`, () => {
        expect(ctx.GISTrace._parseLayer(r.withColumns)).toEqual(ctx.GISTrace._parseLayer(r.withoutColumns));
      });
    });

    it('derives the same network role either way', () => {
      const water = ROWS[0];
      const withCols = ctx.GISTrace._parseLayer(water.withColumns);
      const withoutCols = ctx.GISTrace._parseLayer(water.withoutColumns);
      expect(withCols.role).toBe('water');
      expect(withCols.role).toBe(withoutCols.role);
    });
  });

  describe('GISSymbology._rowCategory / roleOf (js/gis-symbology.js)', () => {
    const ctx = loadBrowserGlobals(['js/gis-symbology.js'], { LayerNaming: loadLayerNaming() });
    ROWS.forEach((r) => {
      it(`_rowCategory agrees for a ${r.label} row`, () => {
        expect(ctx.GISSymbology._rowCategory(r.withColumns)).toBe(ctx.GISSymbology._rowCategory(r.withoutColumns));
      });
      it(`roleOf agrees for a ${r.label} row (no _cat set)`, () => {
        expect(ctx.GISSymbology.roleOf(r.withColumns)).toBe(ctx.GISSymbology.roleOf(r.withoutColumns));
      });
    });
  });

  describe('export-feature.js __exportTestHooks.rowVC', () => {
    // export-feature.js runs injectUI() (needs #map-wrap) and references the
    // LABELS global from export-formats.js at call time — same load pattern
    // as test/export/export-area.test.js's makeCtx().
    const ctx = loadBrowserGlobals(['js/export-formats.js', 'js/export-feature.js'], {
      LayerNaming: loadLayerNaming(),
      document: makeAppDocument(),
    });
    ROWS.forEach((r) => {
      it(`rowVC agrees for a ${r.label} row`, () => {
        expect(ctx.__exportTestHooks.rowVC(r.withColumns)).toEqual(ctx.__exportTestHooks.rowVC(r.withoutColumns));
      });
    });
  });
});
