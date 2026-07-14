// Unit tests for window.LayerNaming (js/layer-naming.js) — compose/parse of
// the engine layer-name convention "<village> · <category>".
import { describe, it, expect } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load() {
  return loadBrowserGlobals(['js/layer-naming.js']);
}

describe('LayerNaming (js/layer-naming.js)', () => {
  it('composes "village · category"', () => {
    const ctx = load();
    expect(ctx.LayerNaming.compose('סחנין', 'water_pipes')).toBe('סחנין · water_pipes');
  });

  it('parses a composed name back into { village, category }', () => {
    const ctx = load();
    expect(ctx.LayerNaming.parse('סחנין · water_pipes')).toEqual({ village: 'סחנין', category: 'water_pipes' });
  });

  it('round-trips compose -> parse for every village/category combo', () => {
    const ctx = load();
    const cases = [
      ['סחנין', 'water_pipes'],
      ['מגד אל-כרום', 'sewage_manholes'],
      ['דיר אל-אסד', 'other'],
    ];
    cases.forEach(([village, category]) => {
      const composed = ctx.LayerNaming.compose(village, category);
      expect(ctx.LayerNaming.parse(composed)).toEqual({ village, category });
    });
  });

  it('round-trips when the category itself contains spaces', () => {
    const ctx = load();
    const composed = ctx.LayerNaming.compose('עראבה', 'water pipes with spaces');
    expect(composed).toBe('עראבה · water pipes with spaces');
    expect(ctx.LayerNaming.parse(composed)).toEqual({ village: 'עראבה', category: 'water pipes with spaces' });
  });

  it('only splits on the FIRST separator — a category containing " · " again stays whole', () => {
    const ctx = load();
    const composed = ctx.LayerNaming.compose('נחף', 'sub · category · thing');
    expect(ctx.LayerNaming.parse(composed)).toEqual({ village: 'נחף', category: 'sub · category · thing' });
  });

  it('parse() is tolerant of a missing separator: { village: null, category: name }', () => {
    const ctx = load();
    expect(ctx.LayerNaming.parse('just_a_category')).toEqual({ village: null, category: 'just_a_category' });
    expect(ctx.LayerNaming.parse('')).toEqual({ village: null, category: '' });
  });

  it('parse(null/undefined) behaves like parse("")', () => {
    const ctx = load();
    expect(ctx.LayerNaming.parse(null)).toEqual({ village: null, category: '' });
    expect(ctx.LayerNaming.parse(undefined)).toEqual({ village: null, category: '' });
  });
});
