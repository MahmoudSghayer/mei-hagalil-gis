import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../../api/admin-delete-user.js';
import { mockRes, mockReq, routeFetch } from '../helpers.mjs';

const OLD = { ...process.env };
const UID = '11111111-1111-1111-1111-111111111111';     // the calling admin
const TARGET = '22222222-2222-2222-2222-222222222222';  // the user being deleted

function setEnv() {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
}

// Routes that make the caller an active admin (JWT check + profile lookup).
const adminRoutes = [
  { match: '/auth/v1/user', json: { id: UID } },
  { match: '/rest/v1/profiles', method: 'GET', json: [{ role: 'admin', is_active: true }] },
];

describe('api/admin-delete-user (admin-gated user deletion)', () => {
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

  it('403 when the caller is NOT an admin (viewer)', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { match: '/auth/v1/user', json: { id: UID } },
      { match: '/rest/v1/profiles', json: [{ role: 'viewer', is_active: true }] },
    ]));
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { id: TARGET } }), res);
    expect(res.statusCode).toBe(403);
  });

  it('400 on an invalid user id', async () => {
    vi.stubGlobal('fetch', routeFetch(adminRoutes));
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { id: 'not-a-uuid' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('400 when an admin tries to delete themselves', async () => {
    vi.stubGlobal('fetch', routeFetch(adminRoutes));
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { id: UID } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('200 and deletes the auth user when the caller is an active admin', async () => {
    const fetchMock = vi.fn(routeFetch([
      ...adminRoutes,
      { match: '/auth/v1/admin/users', method: 'DELETE', json: {} },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { id: TARGET } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    // the admin deleteUser endpoint must have actually been called for the target
    expect(fetchMock.mock.calls.some((c) =>
      String(c[0]).includes('/auth/v1/admin/users/' + TARGET) && (c[1] || {}).method === 'DELETE')).toBe(true);
  });

  it('falls back to deleting the profile row when the auth user is already gone (404)', async () => {
    const fetchMock = vi.fn(routeFetch([
      ...adminRoutes,
      { match: '/auth/v1/admin/users', method: 'DELETE', ok: false, status: 404, json: {} },
      { match: '/rest/v1/profiles', method: 'DELETE', json: {} },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { id: TARGET } }), res);
    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls.some((c) =>
      String(c[0]).includes('/rest/v1/profiles') && (c[1] || {}).method === 'DELETE')).toBe(true);
  });

  it('surfaces the real status + message on an Admin API error', async () => {
    vi.stubGlobal('fetch', routeFetch([
      ...adminRoutes,
      { match: '/auth/v1/admin/users', method: 'DELETE', ok: false, status: 500, json: { message: 'Database error deleting user' } },
    ]));
    const res = mockRes();
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { id: TARGET } }), res);
    expect(res.statusCode).toBe(500);
    expect(String(res.body.error)).toContain('Database error deleting user');
  });
});
