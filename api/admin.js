// /api/admin.js
// Runtime: Node.js (serverless) — NÃO usar Edge para firebase-admin
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/**
 * Inicialização do Firebase Admin
 * Suporta dois formatos:
 * 1) FIREBASE_SERVICE_ACCOUNT (JSON completo em uma env var)
 * 2) Variáveis individuais (PROJECT_ID, CLIENT_EMAIL, PRIVATE_KEY)
 *
 * Recomendado no Vercel: colocar o JSON do service account em
 * FIREBASE_SERVICE_ACCOUNT (com \n preservados na private_key).
 */
function initAdmin() {
  if (getApps().length) return getApp();

  let app;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (saJson) {
    // Serviço por JSON único
    const serviceAccount = JSON.parse(saJson);
    // Adapta quebra de linha se necessário
    if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    app = initializeApp({
      credential: cert(serviceAccount),
    });
  } else {
    // Serviço por variáveis avulsas (PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY)
    const {
      FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY,
    } = process.env;

    if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
      throw new Error(
        'Firebase Admin não configurado. Defina FIREBASE_SERVICE_ACCOUNT (JSON) ou FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.'
      );
    }

    const privateKey = FIREBASE_PRIVATE_KEY.includes('\\n')
      ? FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : FIREBASE_PRIVATE_KEY;

    app = initializeApp({
      credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
  }

  return app;
}

/**
 * Retorna o Firestore Admin (singleton)
 */
export function getAdminDb() {
  const app = initAdmin();
  return getFirestore(app);
}

/**
 * Lê header de forma compatível com Node (req.headers) e Edge (req.headers.get)
 */
export function readHeader(req, name) {
  // Edge/Web API
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

/**
 * Valida a API Key enviada no header 'x-api-key' contra process.env[expectedEnvName]
 * Lança erro 401 em caso de falha.
 */
export function assertApiKey(req, expectedEnvName = 'ADMIN_API_KEY') {
  const expected = process.env[expectedEnvName];
  const provided = readHeader(req, 'x-api-key');

  const safeProvided = provided ? `${provided.slice(0, 4)}…` : '[Vazio]';
  const safeExpected = expected ? `${expected.slice(0, 4)}…` : '[Vazio]';

  console.log('--- API Key Debug ---');
  console.log('Key Fornecida (Provided):', safeProvided);
  console.log('Key Esperada (process.env):', safeExpected);
  console.log('Keys são idênticas? (boolean):', !!provided && !!expected && provided === expected);
  console.log('--- FIM do Debug ---');

  if (!provided || !expected || provided !== expected) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}
