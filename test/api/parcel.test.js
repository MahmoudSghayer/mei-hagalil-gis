import { describe, it, expect, afterEach, vi } from 'vitest';
import parcel from '../../api/parcel.js';
import { mockRes, mockReq } from '../helpers.mjs';

describe('api/parcel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('400 when gush/helka are missing', async () => {
    const res = mockRes();
    await parcel(mockReq({ query: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('400 when gush/helka are non-numeric', async () => {
    const res = mockRes();
    await parcel(mockReq({ query: { gush: 'abc', helka: 'x' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('echoes CORS only for an allowed origin', async () => {
    const ok = mockRes();
    await parcel(mockReq({ query: {}, headers: { origin: 'https://mei-hagalil-gis.vercel.app' } }), ok);
    expect(ok.headers['access-control-allow-origin']).toBe('https://mei-hagalil-gis.vercel.app');

    const bad = mockRes();
    await parcel(mockReq({ query: {}, headers: { origin: 'https://evil.example' } }), bad);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles OPTIONS preflight', async () => {
    const res = mockRes();
    await parcel(mockReq({ method: 'OPTIONS' }), res);
    expect(res.ended).toBe(true);
  });

  it('returns 404 when no parcel dataset matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ result: { results: [] } }),
    })));
    const res = mockRes();
    await parcel(mockReq({ query: { gush: '17001', helka: '5' } }), res);
    expect(res.statusCode).toBe(404);
  });
});
