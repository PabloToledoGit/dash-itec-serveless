// api/_lib/admin.js
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Inicializa e retorna o Firestore Admin como singleton.
 * Requer a variável de ambiente SA_KEY contendo o JSON da service account
 * em uma única linha (private_key com \\n).
 */
export function getAdminDb() {
  if (!getApps().length) {
    const sa = process.env.SA_KEY;
    if (!sa) throw new Error("SA_KEY not set");
    let creds;
    try {
      creds = JSON.parse(sa);
    } catch {
      throw new Error("SA_KEY must be valid JSON string");
    }
    initializeApp({ credential: cert(creds) });
  }
  return getFirestore();
}

/**
 * Valida o header x-api-key contra process.env.API_KEY
 */
export function assertApiKey(req) {
  const provided =
    req.headers["x-api-key"] ||
    req.headers["X-API-Key"] ||
    req.headers["x-API-key"] ||
    "";
  if (!process.env.API_KEY || provided !== process.env.API_KEY) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}
