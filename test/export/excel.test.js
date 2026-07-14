import { describe, it, expect, vi } from 'vitest';
import proj4 from 'proj4';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';
import { makeAppDocument } from '../fixtures/export/stub-dom.mjs';
import { makeFeatures, makeFeature } from '../fixtures/export/generate-features.mjs';

describe('buildExcelRows (pure data prep, chunked)', () => {
  const ctx = loadBrowserGlobals(['js/export-formats.js'], { proj4 });

  it('groups rows by category with first-coordinate columns and flattened attributes', async () => {
    const byCat = await ctx.buildExcelRows(makeFeatures(6), null); // cycles all 4 fixture categories
    expect(Object.keys(byCat).sort()).toEqual(['parcels', 'sewage_manholes', 'water_meters', 'water_pipes'].sort());
    byCat.water_meters.forEach((r) => {
      expect(r).toHaveProperty('village');
      expect(r).toHaveProperty('category', 'water_meters');
      expect(r).toHaveProperty('lon');
      expect(r).toHaveProperty('lat');
      expect(r).toHaveProperty('geometry_type', 'Point');
      expect(r).not.toHaveProperty('_category');
      expect(r.geometry_wkt).toBeUndefined(); // WKT option defaults OFF
    });
  });

  it('adds a geometry_wkt cell per row when opts.wkt is true', async () => {
    const f = makeFeature(0, { category: 'water_meters', geometryType: 'Point' });
    const byCat = await ctx.buildExcelRows([f], null, { wkt: true });
    expect(byCat.water_meters[0].geometry_wkt).toBe('POINT (' + f.geometry.coordinates[0] + ' ' + f.geometry.coordinates[1] + ')');
  });

  it('reports cumulative progress across categories, not reset per category', async () => {
    const calls = [];
    await ctx.buildExcelRows(makeFeatures(10), (done, total) => calls.push([done, total]));
    calls.forEach(([done, total]) => { expect(total).toBe(10); expect(done).toBeLessThanOrEqual(10); });
    expect(calls[calls.length - 1]).toEqual([10, 10]);
  });
});

describe('exportExcel (integration: export-formats.js + export-feature.js, fake XLSX captures sheets)', () => {
  it('writes one sheet per category with expected headers/rows, including the WKT-on case', async () => {
    const sheets = []; // { name, rows }
    const XLSX = {
      utils: {
        book_new: () => ({}),
        json_to_sheet: (rows) => ({ __rows: rows }),
        book_append_sheet: (wb, ws, name) => sheets.push({ name, rows: ws.__rows }),
      },
      writeFile: vi.fn(),
    };
    const ctx = loadBrowserGlobals(['js/export-formats.js', 'js/export-feature.js'], {
      proj4,
      document: makeAppDocument(),
      XLSX,
    });
    ctx.__exportTestHooks.gExp.wkt = true; // exercise the WKT-on case through the real wizard state

    await ctx.__exportTestHooks.exportExcel(makeFeatures(5), 'test-export'); // 4 categories

    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    expect(XLSX.writeFile.mock.calls[0][1]).toBe('test-export.xlsx');
    expect(sheets.length).toBe(4);

    const wm = sheets.find((s) => s.rows.some((r) => r.category === 'water_meters'));
    expect(wm).toBeTruthy();
    wm.rows.forEach((r) => {
      expect(Object.keys(r)).toEqual(expect.arrayContaining(['village', 'category', 'lon', 'lat', 'geometry_type', 'geometry_wkt']));
      expect(r.geometry_wkt).toMatch(/^POINT \(/);
    });
  });
});
