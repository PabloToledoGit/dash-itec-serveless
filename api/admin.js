// api/admin.js
export function readHeader(req, name) {
  // Edge/Web API (Request)
  if (req?.headers && typeof req.headers.get === 'function') {
    return req.headers.get(name);
  }
  // Node/Express-like
  if (req?.headers) {
    const key = name.toLowerCase();
    return req.headers[key] ?? req.headers[name] ?? undefined;
  }
  return undefined;
}

export function assertApiKey(req, expectedEnvName = 'ADMIN_API_KEY') {
  const expected = process.env[expectedEnvName];
  const provided = readHeader(req, 'x-api-key');

  const safeProvided = provided ? `${provided.slice(0, 4)}…` : '[Vazio]';
  const safeExpected = expected ? `${expected.slice(0, 4)}…` : '[Vazio]';
  console.log('[API Key Debug]', { provided: safeProvided, expected: safeExpected, eq: !!provided && !!expected && provided === expected });

  if (!provided || !expected || provided !== expected) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}
