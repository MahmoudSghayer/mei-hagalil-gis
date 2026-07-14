// Layer-naming consolidation (Wave 2 / W2.5).
//
// js/gis-engine-sidebar.js, js/gis-edit.js, js/gis-network-trace.js,
// js/gis-analysis.js, and js/gis-symbology.js each used to split/compose the
// engine's "<village> · <category>" layer-name convention inline (duplicated
// `indexOf(' · ')` / `.split(' · ')` logic in five places). They now delegate
// to window.LayerNaming (js/layer-naming.js) when it's loaded, falling back
// to an inline parse written to be semantically IDENTICAL to LayerNaming's
// own algorithm — script load order on index.html isn't something these
// files can assume, so each must degrade safely if LayerNaming hasn't loaded
// yet.
//
// This test loads each refactored file TWICE — once with a real
// window.LayerNaming injected, once without (window.LayerNaming absent, as
// in a bad load-order) — and asserts the parsed result is identical in both
// modes, for a representative set of layer names: a plain Hebrew village +
// category, a Hebrew village containing a hyphen, a category containing
// spaces, a name with no separator at all, and the empty string.
import { describe, it, expect } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function loadLayerNaming() {
  return loadBrowserGlobals(['js/layer-naming.js']).LayerNaming;
}

const NAMES = [
  'סחנין · water_pipes',              // plain Hebrew village + category
  'מגד אל-כרום · sewage_manholes',    // Hebrew village containing a hyphen
  'עראבה · water pipes with spaces',  // category containing spaces
  'just_a_category_no_separator',     // no separator at all
  '',                                 // empty name
];

// Loads `file` twice — with and without a real LayerNaming global — and runs
// `fn(ctx)` against each context, returning { withLN, withoutLN }.
function withAndWithoutLayerNaming(file, fn) {
  const withLN = fn(loadBrowserGlobals([file], { LayerNaming: loadLayerNaming() }));
  const withoutLN = fn(loadBrowserGlobals([file], {}));
  return { withLN, withoutLN };
}

describe('Layer-naming consolidation — parse identical with/without window.LayerNaming', () => {
  describe('GISEngineSidebar._parseLayerName (js/gis-engine-sidebar.js)', () => {
    NAMES.forEach((name) => {
      it(`parses ${JSON.stringify(name)} identically in both modes`, () => {
        const { withLN, withoutLN } = withAndWithoutLayerNaming(
          'js/gis-engine-sidebar.js',
          (ctx) => ctx.GISEngineSidebar._parseLayerName(name)
        );
        expect(withLN).toEqual(withoutLN);
      });
    });

    it('LayerNaming-backed mode actually matches LayerNaming.parse() (not just self-consistent)', () => {
      const ln = loadLayerNaming();
      const ctx = loadBrowserGlobals(['js/gis-engine-sidebar.js'], { LayerNaming: ln });
      NAMES.forEach((name) => {
        expect(ctx.GISEngineSidebar._parseLayerName(name)).toEqual(ln.parse(name));
      });
    });
  });

  describe('GISEdit._parseLayerName (js/gis-edit.js)', () => {
    NAMES.forEach((name) => {
      it(`parses ${JSON.stringify(name)} identically in both modes`, () => {
        const { withLN, withoutLN } = withAndWithoutLayerNaming(
          'js/gis-edit.js',
          (ctx) => ctx.GISEdit._parseLayerName(name)
        );
        expect(withLN).toEqual(withoutLN);
      });
    });
  });

  describe('GISTrace._parseLayer (js/gis-network-trace.js)', () => {
    NAMES.forEach((name) => {
      it(`parses a layer named ${JSON.stringify(name)} identically in both modes`, () => {
        const layer = { id: 'L1', name, color: '#1a7fc1' };
        const { withLN, withoutLN } = withAndWithoutLayerNaming(
          'js/gis-network-trace.js',
          (ctx) => ctx.GISTrace._parseLayer(layer)
        );
        expect(withLN).toEqual(withoutLN);
      });
    });

    it('derives the network role from the parsed category the same way in both modes', () => {
      const layer = { id: 'L1', name: 'סחנין · water_pipes', color: '#1a7fc1' };
      const { withLN, withoutLN } = withAndWithoutLayerNaming(
        'js/gis-network-trace.js',
        (ctx) => ctx.GISTrace._parseLayer(layer).role
      );
      expect(withLN).toBe('water');
      expect(withLN).toBe(withoutLN);
    });
  });

  describe('GISAnalysis._parseLayerName (js/gis-analysis.js)', () => {
    NAMES.forEach((name) => {
      it(`parses ${JSON.stringify(name)} identically in both modes`, () => {
        const { withLN, withoutLN } = withAndWithoutLayerNaming(
          'js/gis-analysis.js',
          (ctx) => ctx.GISAnalysis._parseLayerName(name)
        );
        expect(withLN).toEqual(withoutLN);
      });
    });
  });

  describe('GISSymbology._layerCategory / roleOf (js/gis-symbology.js)', () => {
    NAMES.forEach((name) => {
      it(`extracts the category from ${JSON.stringify(name)} identically in both modes`, () => {
        const { withLN, withoutLN } = withAndWithoutLayerNaming(
          'js/gis-symbology.js',
          (ctx) => ctx.GISSymbology._layerCategory(name)
        );
        expect(withLN).toBe(withoutLN);
      });

      it(`roleOf() for a layer named ${JSON.stringify(name)} agrees in both modes`, () => {
        const layer = { name, geometry_type: 'LineString' };
        const { withLN, withoutLN } = withAndWithoutLayerNaming(
          'js/gis-symbology.js',
          (ctx) => ctx.GISSymbology.roleOf(layer)
        );
        expect(withLN).toBe(withoutLN);
      });
    });

    it('roleOf() still resolves a known category to its network role without LayerNaming', () => {
      const ctx = loadBrowserGlobals(['js/gis-symbology.js'], {});
      expect(ctx.GISSymbology.roleOf({ name: 'סחנין · hydrants', geometry_type: 'Point' })).toBe('hydrant');
    });
  });
});
