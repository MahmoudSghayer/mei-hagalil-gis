// Unit tests for the pure logic in js/pages/reports.js (Worker W4.2 —
// management reporting MVP: incidents per village/month, MTTR, CSV export).
//
// The module is a plain-browser-global IIFE (no exports, no build step), so
// it's loaded into a Node vm context via test/helpers/load-browser-global.mjs
// and exercised through the test-only `window.__reportsTest` hooks it
// exposes (computeDatePreset, dateRangeTimestamps, buildRpcParams,
// monthRange, bucketMonthly, sortVillageCounts, priorityPercentages,
// formatMTTR, daysOpen, formatDateShort, statusLabel, priorityLabel,
// csvEscapeCell, buildReportCSV, paginate). Those hooks have no runtime
// callers of their own — the page's DOM/network glue (init/loadReport/
// renderTable/exportCSV/...) calls the very same functions directly, so
// these tests exercise real logic, not a parallel copy.
//
// The module also registers `window.addEventListener('load', init)` at
// top level (guarded on `document.getElementById` existing, which the
// shared harness's stub document provides), so a no-op `addEventListener`
// extra is supplied purely so the module loads without throwing — init()
// itself is never invoked (no 'load' event is ever dispatched), so no real
// DOM/network glue runs during these tests.
import { describe, it, expect } from 'vitest';
import { loadBrowserGlobals } from '../helpers/load-browser-global.mjs';

function load() {
  const ctx = loadBrowserGlobals(['js/pages/reports.js'], {
    addEventListener: () => {},
  });
  return ctx.window.__reportsTest;
}

describe('reports: VILLAGES (canonical list)', () => {
  it('has exactly the 7 villages used elsewhere (js/pages/index.js / js/gis-field.js)', () => {
    const T = load();
    expect(T.VILLAGES).toEqual(['מגד אל-כרום', 'בענה', 'דיר אל-אסד', 'נחף', 'סחנין', 'דיר חנא', 'עראבה']);
  });
});

describe('reports: computeDatePreset (quick-range buttons)', () => {
  it('30 ימים — from is 29 days before to, anchored on the given "now"', () => {
    const T = load();
    const now = new Date(2026, 6, 14); // 2026-07-14 (local midnight)
    expect(T.computeDatePreset(30, now)).toEqual({ from: '2026-06-15', to: '2026-07-14' });
  });

  it('90 ימים — crosses a month boundary correctly', () => {
    const T = load();
    const now = new Date(2026, 6, 14);
    expect(T.computeDatePreset(90, now)).toEqual({ from: '2026-04-16', to: '2026-07-14' });
  });

  it('365 ימים — crosses a year boundary correctly', () => {
    const T = load();
    const now = new Date(2026, 6, 14);
    expect(T.computeDatePreset(365, now)).toEqual({ from: '2025-07-15', to: '2026-07-14' });
  });

  it('degenerate days<=0 clamps to a single-day range (from === to)', () => {
    const T = load();
    const now = new Date(2026, 6, 14);
    expect(T.computeDatePreset(0, now)).toEqual({ from: '2026-07-14', to: '2026-07-14' });
  });
});

describe('reports: dateRangeTimestamps (query day-boundary helper)', () => {
  it('produces an exclusive upper bound the day after "to"', () => {
    const T = load();
    expect(T.dateRangeTimestamps('2026-07-01', '2026-07-14')).toEqual({
      start: '2026-07-01T00:00:00.000Z',
      endExclusive: '2026-07-15T00:00:00.000Z',
    });
  });

  it('rolls over a month boundary', () => {
    const T = load();
    expect(T.dateRangeTimestamps('2026-07-01', '2026-07-31').endExclusive).toBe('2026-08-01T00:00:00.000Z');
  });

  it('rolls over a year boundary', () => {
    const T = load();
    expect(T.dateRangeTimestamps('2026-12-01', '2026-12-31').endExclusive).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('reports: buildRpcParams (filter state -> incidents_report RPC params)', () => {
  it('empty filters -> all-null/default params', () => {
    const T = load();
    expect(T.buildRpcParams({})).toEqual({ p_from: null, p_to: null, p_villages: null, p_status: 'all' });
  });

  it('an empty villages selection means "all villages" -> p_villages is null, not []', () => {
    const T = load();
    const params = T.buildRpcParams({ from: '2026-01-01', to: '2026-07-14', villages: [], status: 'open' });
    expect(params.p_villages).toBeNull();
  });

  it('a non-empty villages selection is passed through as-is', () => {
    const T = load();
    const params = T.buildRpcParams({ from: '2026-01-01', to: '2026-07-14', villages: ['סחנין', 'בענה'], status: 'closed' });
    expect(params).toEqual({ p_from: '2026-01-01', p_to: '2026-07-14', p_villages: ['סחנין', 'בענה'], p_status: 'closed' });
  });
});

describe('reports: monthRange / bucketMonthly (aggregate -> chart-model transform)', () => {
  it('monthRange lists every month in the span, inclusive', () => {
    const T = load();
    expect(T.monthRange('2026-05-01', '2026-07-14')).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('monthRange rolls a year over', () => {
    const T = load();
    expect(T.monthRange('2025-11-01', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('bucketMonthly fills months missing from the RPC response with zeros', () => {
    const T = load();
    const sparse = [{ month: '2026-06', total: 5, open: 2, closed: 3 }];
    expect(T.bucketMonthly(sparse, '2026-05-01', '2026-07-14')).toEqual([
      { month: '2026-05', total: 0, open: 0, closed: 0 },
      { month: '2026-06', total: 5, open: 2, closed: 3 },
      { month: '2026-07', total: 0, open: 0, closed: 0 },
    ]);
  });

  it('bucketMonthly with a completely empty aggregate returns all-zero months, not an empty array', () => {
    const T = load();
    const result = T.bucketMonthly([], '2026-05-01', '2026-06-01');
    expect(result).toEqual([
      { month: '2026-05', total: 0, open: 0, closed: 0 },
      { month: '2026-06', total: 0, open: 0, closed: 0 },
    ]);
  });
});

describe('reports: sortVillageCounts (village bar-chart ordering)', () => {
  it('sorts by count descending', () => {
    const T = load();
    const input = [{ village: 'א', count: 3 }, { village: 'ב', count: 10 }, { village: 'ג', count: 1 }];
    expect(T.sortVillageCounts(input).map((r) => r.village)).toEqual(['ב', 'א', 'ג']);
  });

  it('breaks ties alphabetically (Hebrew collation)', () => {
    const T = load();
    const input = [{ village: 'עראבה', count: 5 }, { village: 'בענה', count: 5 }];
    expect(T.sortVillageCounts(input).map((r) => r.village)).toEqual(['בענה', 'עראבה']);
  });

  it('does not mutate the input array', () => {
    const T = load();
    const input = [{ village: 'א', count: 1 }, { village: 'ב', count: 2 }];
    const copy = input.slice();
    T.sortVillageCounts(input);
    expect(input).toEqual(copy);
  });
});

describe('reports: priorityPercentages (priority donut/stacked-bar model)', () => {
  it('computes percentages that reflect each share of the total', () => {
    const T = load();
    const result = T.priorityPercentages([{ priority: 'high', count: 2 }, { priority: 'medium', count: 3 }, { priority: 'low', count: 5 }]);
    expect(result.high).toEqual({ count: 2, pct: 20 });
    expect(result.medium).toEqual({ count: 3, pct: 30 });
    expect(result.low).toEqual({ count: 5, pct: 50 });
  });

  it('an empty/zero-total input yields 0% everywhere, no NaN or divide-by-zero', () => {
    const T = load();
    const result = T.priorityPercentages([]);
    expect(result).toEqual({
      high: { count: 0, pct: 0 },
      medium: { count: 0, pct: 0 },
      low: { count: 0, pct: 0 },
    });
  });

  it('rounds to one decimal place instead of a long float', () => {
    const T = load();
    const result = T.priorityPercentages([{ priority: 'high', count: 1 }, { priority: 'medium', count: 1 }, { priority: 'low', count: 1 }]);
    expect(result.high.pct).toBeCloseTo(33.3, 1);
  });
});

describe('reports: formatMTTR (KPI card formatting)', () => {
  it('formats a fractional day count to one decimal with the Hebrew unit', () => {
    const T = load();
    expect(T.formatMTTR(3.44)).toBe('3.4 ימים');
    expect(T.formatMTTR(3.46)).toBe('3.5 ימים');
  });

  it('null/undefined/NaN (no closed incidents in range) render as an em dash', () => {
    const T = load();
    expect(T.formatMTTR(null)).toBe('—');
    expect(T.formatMTTR(undefined)).toBe('—');
    expect(T.formatMTTR(NaN)).toBe('—');
  });

  it('zero is a legitimate value, not treated as "no data"', () => {
    const T = load();
    expect(T.formatMTTR(0)).toBe('0.0 ימים');
  });
});

describe('reports: daysOpen (table "ימים פתוחה" column)', () => {
  it('computes whole/fractional days between created_at and closed_at', () => {
    const T = load();
    expect(T.daysOpen('2026-07-01T00:00:00.000Z', '2026-07-04T12:00:00.000Z')).toBe(3.5);
  });

  it('uses the injected "now" for still-open incidents', () => {
    const T = load();
    const now = new Date('2026-07-10T00:00:00.000Z');
    expect(T.daysOpen('2026-07-01T00:00:00.000Z', null, now)).toBe(9);
  });

  it('never returns a negative number', () => {
    const T = load();
    // closed_at before created_at should not happen, but the column must stay sane if it does
    expect(T.daysOpen('2026-07-10T00:00:00.000Z', '2026-07-01T00:00:00.000Z')).toBe(0);
  });

  it('a missing created_at is treated as zero days', () => {
    const T = load();
    expect(T.daysOpen(null, null, new Date())).toBe(0);
  });
});

describe('reports: formatDateShort / statusLabel / priorityLabel (display helpers)', () => {
  it('formats an ISO timestamp as DD/MM/YYYY', () => {
    const T = load();
    expect(T.formatDateShort('2026-01-05T10:00:00.000Z')).toBe('05/01/2026');
  });

  it('an empty/invalid date formats to an empty string', () => {
    const T = load();
    expect(T.formatDateShort('')).toBe('');
    expect(T.formatDateShort('not-a-date')).toBe('');
  });

  it('maps known status/priority values to Hebrew labels, and falls back to the raw value otherwise', () => {
    const T = load();
    expect(T.statusLabel('open')).toBe('פתוחה');
    expect(T.statusLabel('in_progress')).toBe('בטיפול');
    expect(T.statusLabel('closed')).toBe('סגורה');
    expect(T.statusLabel('weird')).toBe('weird');
    expect(T.priorityLabel('high')).toBe('גבוהה');
    expect(T.priorityLabel('low')).toBe('נמוכה');
  });
});

describe('reports: csvEscapeCell (formula-injection guard, CWE-1236)', () => {
  it('prefixes a leading = + - @ TAB or CR with a single-quote to force plain text', () => {
    const T = load();
    expect(T.csvEscapeCell('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(T.csvEscapeCell('+1234')).toBe('"\'+1234"');
    expect(T.csvEscapeCell('-1234')).toBe('"\'-1234"');
    expect(T.csvEscapeCell('@cmd')).toBe('"\'@cmd"');
    expect(T.csvEscapeCell('\tstuff')).toBe('"\'\tstuff"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    const T = load();
    expect(T.csvEscapeCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('leaves an ordinary value untouched apart from quoting', () => {
    const T = load();
    expect(T.csvEscapeCell('דליפת מים')).toBe('"דליפת מים"');
  });

  it('null/undefined become an empty quoted cell', () => {
    const T = load();
    expect(T.csvEscapeCell(null)).toBe('""');
    expect(T.csvEscapeCell(undefined)).toBe('""');
  });
});

describe('reports: buildReportCSV (full export serialization)', () => {
  it('emits the Hebrew header row followed by one guarded row per incident', () => {
    const T = load();
    const rows = [
      { title: 'דליפה', village: 'סחנין', priority: 'high', status: 'closed', created_at: '2026-07-01T00:00:00.000Z', closed_at: '2026-07-03T00:00:00.000Z' },
    ];
    const csv = T.buildReportCSV(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('"כותרת","ישוב","עדיפות","סטטוס","נפתח","נסגר","ימים פתוחה"');
    expect(lines[1]).toBe('"דליפה","סחנין","גבוהה","סגורה","01/07/2026","03/07/2026","2"');
  });

  it('an incident whose title starts with "=" is guarded against formula injection in the real CSV output', () => {
    const T = load();
    const rows = [
      { title: '=cmd|calc', village: 'בענה', priority: 'low', status: 'closed', created_at: '2026-07-01T00:00:00.000Z', closed_at: '2026-07-01T00:00:00.000Z' },
    ];
    const csv = T.buildReportCSV(rows);
    expect(csv).toContain('"\'=cmd|calc"');
  });

  it('an empty row set still produces just the header line', () => {
    const T = load();
    expect(T.buildReportCSV([])).toBe('"כותרת","ישוב","עדיפות","סטטוס","נפתח","נסגר","ימים פתוחה"');
  });
});

describe('reports: paginate (client-side table pagination, <=50/page)', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: i }));

  it('slices the requested page at the given page size', () => {
    const T = load();
    const pg = T.paginate(rows, 0, 50);
    expect(pg.items).toHaveLength(50);
    expect(pg.items[0]).toEqual({ id: 0 });
    expect(pg.totalPages).toBe(3);
    expect(pg.total).toBe(120);
  });

  it('the last page has the remainder', () => {
    const T = load();
    const pg = T.paginate(rows, 2, 50);
    expect(pg.items).toHaveLength(20);
    expect(pg.items[0]).toEqual({ id: 100 });
  });

  it('an out-of-range page clamps to the last valid page instead of returning empty', () => {
    const T = load();
    const pg = T.paginate(rows, 99, 50);
    expect(pg.page).toBe(2);
    expect(pg.items).toHaveLength(20);
  });

  it('zero rows is page 1 of 1 with no items (empty state, not an error)', () => {
    const T = load();
    const pg = T.paginate([], 0, 50);
    expect(pg).toEqual({ page: 0, totalPages: 1, items: [], total: 0 });
  });
});
