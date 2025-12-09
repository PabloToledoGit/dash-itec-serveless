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
  
  // ⬇️ INÍCIO DOS LOGS DE DEBUG ⬇️
  const expected = process.env.API_KEY || "";
  
  console.log("--- API Key Debug ---");
  // Exibe apenas o início da chave fornecida pelo cliente
  console.log("Key Fornecida (Provided):", provided ? provided.slice(0, 8) + "..." : "[Vazio]"); 
  // Exibe apenas o início da chave esperada do Vercel
  console.log("Key Esperada (process.env):", expected ? expected.slice(0, 8) + "..." : "[UNDEFINED]"); 
  // Resultado da comparação
  console.log("Keys são idênticas? (boolean):", provided === expected);
  console.log("--- FIM do Debug ---");
  // ⬆️ FIM DOS LOGS DE DEBUG ⬆️

  if (!expected || provided !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}