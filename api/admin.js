import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function getAdminDb() {
  if (!getApps().length) {
    const sa = process.env.SA_KEY;
    if (!sa) throw new Error("SA_KEY not set");
    initializeApp({ credential: cert(JSON.parse(sa)) });
  }
  return getFirestore();
}

export function assertApiKey(req) {
  const provided = req.headers["x-api-key"] || req.headers["X-API-Key"] || "";
  if (!process.env.API_KEY || provided !== process.env.API_KEY) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}
