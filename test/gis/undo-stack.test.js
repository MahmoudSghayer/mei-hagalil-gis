// Unit tests for window.GISEditHistory (extracted from js/gis-edit.js) — the
// bounded undo/redo stack of inverse operations over GIS.features. Loads the
// real browser-global script into a Node vm context (no build step in this
// codebase) with a mocked GIS.features so no network/Supabase calls happen.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function makeGIS() {
  var nextId = 1;
  return {
    features: {
      createFeature: vi.fn(async function (layerId, geometry, properties, assetCode) {
        return { id: 'new-' + (nextId++), layer_id: layerId, geometry: geometry, properties: properties, asset_code: assetCode };
      }),
      deleteFeature: vi.fn(async function (id) { return { id: id, deleted: true }; }),
      updateGeometry: vi.fn(async function (id, geometry) { return { id: id, geometry: geometry }; }),
    },
  };
}

function load(GIS) {
  return loadBrowserGlobals(['js/gis-edit.js'], { GIS: GIS });
}

describe('GISEditHistory (js/gis-edit.js)', () => {
  let GIS, ctx, History;

  beforeEach(() => {
    GIS = makeGIS();
    ctx = load(GIS);
    History = ctx.GISEditHistory;
  });

  it('exposes the history API on window.GISEditHistory, starting empty', () => {
    expect(History).toBeTruthy();
    expect(History.size()).toEqual({ undo: 0, redo: 0 });
    expect(History.canUndo()).toBe(false);
    expect(History.canRedo()).toBe(false);
    expect(History.max).toBe(50);
  });

  it('undo() and redo() no-op (return false) on an empty stack', async () => {
    expect(await History.undo()).toBe(false);
    expect(await History.redo()).toBe(false);
    expect(GIS.features.createFeature).not.toHaveBeenCalled();
    expect(GIS.features.deleteFeature).not.toHaveBeenCalled();
  });

  describe('create entry', () => {
    it('undo deletes the created feature by id', async () => {
      History.push({
        type: 'create', layerId: 'L1', id: 'f1',
        geometry: { type: 'Point', coordinates: [1, 2] }, properties: { p: 1 }, assetCode: 'A1',
      });
      expect(History.canUndo()).toBe(true);

      const ok = await History.undo();
      expect(ok).toBe(true);
      expect(GIS.features.deleteFeature).toHaveBeenCalledWith('f1');
      expect(GIS.features.createFeature).not.toHaveBeenCalled();
      expect(History.canUndo()).toBe(false);
      expect(History.canRedo()).toBe(true);
    });

    it('redo (after undo) re-creates the feature and remaps the entry id', async () => {
      History.push({
        type: 'create', layerId: 'L1', id: 'f1',
        geometry: { type: 'Point', coordinates: [1, 2] }, properties: { p: 1 }, assetCode: 'A1',
      });
      await History.undo();
      expect(History.peekRedo()[0].id).toBe('f1');   // unchanged by the delete

      const ok = await History.redo();
      expect(ok).toBe(true);
      expect(GIS.features.createFeature).toHaveBeenCalledWith(
        'L1', { type: 'Point', coordinates: [1, 2] }, { p: 1 }, 'A1'
      );
      const backOnUndo = History.peekUndo()[0];
      expect(backOnUndo.id).toBe('new-1');           // remapped to the freshly created id
      expect(backOnUndo.id).not.toBe('f1');
    });
  });

  describe('delete entry', () => {
    it('undo re-creates the captured feature (geometry + properties) and remaps the id', async () => {
      History.push({
        type: 'delete', layerId: 'L1', id: 'orig-1',
        geometry: { type: 'Point', coordinates: [3, 4] }, properties: { p: 2 }, assetCode: 'A2',
      });

      const ok = await History.undo();
      expect(ok).toBe(true);
      expect(GIS.features.createFeature).toHaveBeenCalledWith(
        'L1', { type: 'Point', coordinates: [3, 4] }, { p: 2 }, 'A2'
      );
      expect(GIS.features.deleteFeature).not.toHaveBeenCalled();
      const onRedo = History.peekRedo()[0];
      expect(onRedo.id).toBe('new-1');   // remapped from 'orig-1' (deleted row no longer exists)
    });

    it('redo (after undo) deletes the RECREATED row, not the original id', async () => {
      History.push({
        type: 'delete', layerId: 'L1', id: 'orig-1',
        geometry: { type: 'Point', coordinates: [3, 4] }, properties: { p: 2 }, assetCode: 'A2',
      });
      await History.undo();   // recreate → new id
      const ok = await History.redo();
      expect(ok).toBe(true);
      expect(GIS.features.deleteFeature).toHaveBeenCalledWith('new-1');
      expect(GIS.features.deleteFeature).not.toHaveBeenCalledWith('orig-1');
    });

    it('strips UI-only marker properties from a captured feature (asset_code / __id / __layer_id)', async () => {
      // Mirrors what confirmDelete captures from a features_geojson/getInBBox result.
      var rawProps = { material: 'PVC', asset_code: 'A2', __id: 'orig-1', __layer_id: 'L1' };
      var cleaned = {};
      Object.keys(rawProps).forEach(function (k) {
        if (k === '__id' || k === '__layer_id' || k === 'asset_code') return;
        cleaned[k] = rawProps[k];
      });
      History.push({ type: 'delete', layerId: 'L1', id: 'orig-1', geometry: { type: 'Point', coordinates: [0, 0] }, properties: cleaned, assetCode: 'A2' });
      await History.undo();
      const props = GIS.features.createFeature.mock.calls[0][2];
      expect(props).toEqual({ material: 'PVC' });
    });
  });

  describe('geometry entry', () => {
    it('undo restores the before-geometry; redo re-applies the after-geometry', async () => {
      const before = { type: 'Point', coordinates: [0, 0] };
      const after = { type: 'Point', coordinates: [9, 9] };
      History.push({ type: 'geometry', layerId: 'L1', id: 'f9', before: before, after: after });

      await History.undo();
      expect(GIS.features.updateGeometry).toHaveBeenLastCalledWith('f9', before);

      await History.redo();
      expect(GIS.features.updateGeometry).toHaveBeenLastCalledWith('f9', after);
      expect(GIS.features.updateGeometry).toHaveBeenCalledTimes(2);
    });
  });

  it('pushing a new entry clears the redo chain', async () => {
    History.push({ type: 'create', layerId: 'L1', id: 'f1', geometry: {}, properties: {}, assetCode: 'A1' });
    await History.undo();
    expect(History.canRedo()).toBe(true);

    History.push({ type: 'create', layerId: 'L1', id: 'f2', geometry: {}, properties: {}, assetCode: 'A2' });
    expect(History.canRedo()).toBe(false);
    expect(History.peekUndo().map(function (e) { return e.id; })).toEqual(['f2']);
  });

  it('bounds the undo stack at 50 — a 51st push evicts the oldest entry', () => {
    for (let i = 0; i < 51; i++) {
      History.push({ type: 'create', layerId: 'L1', id: 'f' + i, geometry: {}, properties: {}, assetCode: 'A' + i });
    }
    expect(History.size().undo).toBe(50);
    const stack = History.peekUndo();
    expect(stack[0].id).toBe('f1');                  // f0 evicted (oldest)
    expect(stack[stack.length - 1].id).toBe('f50');  // most recent kept
  });

  it('bounds the redo stack at 50 too', async () => {
    for (let i = 0; i < 51; i++) {
      History.push({ type: 'create', layerId: 'L1', id: 'f' + i, geometry: {}, properties: {}, assetCode: 'A' + i });
    }
    for (let i = 0; i < 51; i++) await History.undo();   // undo everything possible
    expect(History.size().redo).toBeLessThanOrEqual(50);
    expect(History.size().redo).toBe(50);
  });

  it('restores the entry (and reports failure) when the inverse call rejects', async () => {
    GIS.features.deleteFeature.mockRejectedValueOnce(new Error('[GIS] boom'));
    History.push({ type: 'create', layerId: 'L1', id: 'f1', geometry: {}, properties: {}, assetCode: 'A1' });

    const ok = await History.undo();
    expect(ok).toBe(false);
    expect(History.canUndo()).toBe(true);    // entry restored, not lost
    expect(History.canRedo()).toBe(false);   // never made it to the redo stack

    // A subsequent (successful) undo still works normally.
    const ok2 = await History.undo();
    expect(ok2).toBe(true);
    expect(History.canRedo()).toBe(true);
  });

  it('clear() empties both stacks', async () => {
    History.push({ type: 'create', layerId: 'L1', id: 'f1', geometry: {}, properties: {}, assetCode: 'A1' });
    await History.undo();
    expect(History.size()).toEqual({ undo: 0, redo: 1 });
    History.clear();
    expect(History.size()).toEqual({ undo: 0, redo: 0 });
  });

  describe('isEditableTarget (keyboard-shortcut focus guard)', () => {
    it('treats input/textarea/select and contenteditable elements as editable', () => {
      expect(History.isEditableTarget({ tagName: 'input' })).toBe(true);
      expect(History.isEditableTarget({ tagName: 'INPUT' })).toBe(true);
      expect(History.isEditableTarget({ tagName: 'textarea' })).toBe(true);
      expect(History.isEditableTarget({ tagName: 'select' })).toBe(true);
      expect(History.isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    });

    it('treats a plain element (e.g. the map container) as non-editable', () => {
      expect(History.isEditableTarget({ tagName: 'DIV' })).toBe(false);
      expect(History.isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
      expect(History.isEditableTarget(null)).toBe(false);
      expect(History.isEditableTarget(undefined)).toBe(false);
    });
  });
});
