import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../../api/admin-create-user.js';
import { mockRes, mockReq, routeFetch } from '../helpers.mjs';

const OLD = { ...process.env };
function setEnv() {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
}

describe('api/admin-create-user (admin-gated user creation)', () => {
  beforeEach(setEnv);
  afterEach(() => { process.env = { ...OLD }; vi.unstubAllGlobals(); });

  it('rejects non-POST with 405', async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('401 when no bearer token', async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: {}, body: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('503 when server env is not configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer t' }, body: {} }), res);
    expect(res.statusCode).toBe(503);
  });

  it('401 when the caller token is invalid', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { match: '/auth/v1/user', ok: false, status: 401, json: {} },
    ]));
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer bad' }, body: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('403 when the caller is NOT an admin (viewer)', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { match: '/auth/v1/user', json: { id: 'u1' } },
      { match: '/rest/v1/profiles', json: [{ role: 'viewer', is_active: true }] },
    ]));
    const res = mockRes();
    await handler(mockReq({
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: { email: 'a@b.co', password: '12345678' },
    }), res);
    expect(res.statusCode).toBe(403);
  });

  it('403 when the caller is an editor (still not admin)', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { match: '/auth/v1/user', json: { id: 'u1' } },
      { match: '/rest/v1/profiles', json: [{ role: 'editor', is_active: true }] },
    ]));
    const res = mockRes();
    await handler(mockReq({
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: { email: 'a@b.co', password: '12345678' },
    }), res);
    expect(res.statusCode).toBe(403);
  });

  it('400 when an admin submits a bad email', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { match: '/auth/v1/user', json: { id: 'admin1' } },
      { match: '/rest/v1/profiles', method: 'GET', json: [{ role: 'admin', is_active: true }] },
    ]));
    const res = mockRes();
    await handler(mockReq({
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: { email: 'not-an-email', password: '12345678' },
    }), res);
    expect(res.statusCode).toBe(400);
  });

  it('400 when an admin submits a too-short password', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { match: '/auth/v1/user', json: { id: 'admin1' } },
      { match: '/rest/v1/profiles', method: 'GET', json: [{ role: 'admin', is_active: true }] },
    ]));
    const res = mockRes();
    await handler(mockReq({
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: { email: 'ok@user.co', password: 'short' },
    }), res);
    expect(res.statusCode).toBe(400);
  });

  it('200 and creates the user when the caller is an active admin', async () => {
    const fetchMock = vi.fn(routeFetch([
      { match: '/auth/v1/user', json: { id: 'admin1' } },
      { match: '/rest/v1/profiles', method: 'GET', json: [{ role: 'admin', is_active: true }] },
      { match: '/auth/v1/admin/users', method: 'POST', json: { id: 'new-user-1' } },
      { match: '/rest/v1/profiles', method: 'PATCH', json: {} },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();
    await handler(mockReq({
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: { email: 'new@user.co', password: '12345678', role: 'editor', full_name: 'New' },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 'new-user-1' });
    // the admin createUser endpoint must have actually been called
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/auth/v1/admin/users'))).toBe(true);
  });
});
