// Minimal Vercel-style req/res mocks for unit-testing the serverless handlers.
export function mockRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, ended: false };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[String(k).toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

export function mockReq(over = {}) {
  return { method: 'GET', query: {}, headers: {}, body: undefined, ...over };
}

// Builds a fetch() mock that routes by URL substring + HTTP method to canned
// responses. Each route: { match, method?, ok?, status?, json }.
export function routeFetch(routes) {
  const fn = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    for (const r of routes) {
      if (String(url).includes(r.match) && (!r.method || r.method === method)) {
        return {
          ok: r.ok !== false,
          status: r.status || 200,
          json: async () => r.json,
          text: async () => JSON.stringify(r.json),
        };
      }
    }
    throw new Error('unrouted fetch: ' + method + ' ' + url);
  };
  return fn;
}
