import { describe, it, expect, afterEach, vi } from 'vitest';
import tiles from '../../api/tiles.js';
import { mockRes, mockReq } from '../helpers.mjs';

const OLD = { ...process.env };

describe('api/tiles', () => {
  afterEach(() => { process.env = { ...OLD }; vi.unstubAllGlobals(); });

  it('400 on missing/invalid tile coords', async () => {
    const res = mockRes();
    await tiles(mockReq({ query: { z: '1' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('503 when Supabase env is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    const res = mockRes();
    await tiles(mockReq({ query: { z: '10', x: '1', y: '2', layer: 'abc' } }), res);
    expect(res.statusCode).toBe(503);
  });

  it('echoes CORS only for an allowed origin', async () => {
    const ok = mockRes();
    await tiles(mockReq({ query: {}, headers: { origin: 'https://mei-hagalil-gis.vercel.app' } }), ok);
    expect(ok.headers['access-control-allow-origin']).toBe('https://mei-hagalil-gis.vercel.app');

    const bad = mockRes();
    await tiles(mockReq({ query: {}, headers: { origin: 'https://evil.example' } }), bad);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles OPTIONS preflight', async () => {
    const res = mockRes();
    await tiles(mockReq({ method: 'OPTIONS' }), res);
    expect(res.ended).toBe(true);
  });
});
