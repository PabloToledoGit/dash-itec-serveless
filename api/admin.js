// api/_lib/admin.js
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function getAdminDb() {
  const apps = getApps();
  if (!apps.length) {
    const saRaw = process.env.SA_KEY;
    if (!saRaw) throw new Error("SA_KEY not set");
    let creds;
    try {
      creds = JSON.parse(saRaw);
    } catch {
      throw new Error("SA_KEY must be a valid JSON string");
    }
    initializeApp({ credential: cert(creds) });
  }
  return getFirestore();
}

// Helper simples para validar API key
export function assertApiKey(req) {
  const provided = req.headers["x-api-key"] || req.headers["X-API-Key"] || "";
  if (!process.env.API_KEY || provided !== process.env.API_KEY) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}
