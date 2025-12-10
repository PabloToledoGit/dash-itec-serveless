// /api/users.js
import { getAdminDb } from "./admin.js";

/**
 * GET /api/users
 * Query params:
 *  - pageSize (default 25, máx. 100)
 *  - pageToken (id do último doc)
 *  - sortField (default "createdAt")
 *  - sortDir ("asc" | "desc", default "desc")
 *  - q (filtro de substring aplicado em memória na página retornada)
 *
 * Observação:
 *  - Não há autenticação via x-api-key.
 *  - Recomendado limitar origens com ORIGIN_ALLOWLIST.
 */

// --- CORS (com allowlist simples por env)
function applyCors(req, res) {
  const reqOrigin = req.headers.origin || "";
  const allowlist = (process.env.ORIGIN_ALLOWLIST || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // Se não houver allowlist, libera amplo (dev). Em produção, configure ORIGIN_ALLOWLIST!
  const allowOrigin = allowlist.length
    ? (allowlist.includes(reqOrigin) ? reqOrigin : allowlist[0])
    : (reqOrigin || "*");

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

// Campos que vamos expor ao front (sanitização)
function projectUser(u) {
  return {
    id: u.id,
    email: u.email ?? null,
    name: u.name ?? null,
    phone: u.phone ?? null,
    source: u.source ?? null,
    createdAt: u.createdAt ?? null,
    agCount: u.agCount ?? 0,
    histTotal: u.histTotal ?? 0,
    histPend: u.histPend ?? 0,
    type: u.type ?? null,
    polo: u.polo ?? null,
  };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const db = getAdminDb();

    const pageSize = Math.min(100, parseInt(req.query.pageSize || "25", 10));
    const sortField = (req.query.sortField || "createdAt").toString();
    const sortDir = (req.query.sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const qtext = (req.query.q || "").toString().trim().toLowerCase();
    const pageToken = (req.query.pageToken || "").toString().trim();

    const usersCol = db
      .collection("artifacts")
      .doc("registro-itec-dcbc4")
      .collection("users");

    let queryRef = usersCol.orderBy(sortField, sortDir).limit(pageSize);

    if (pageToken) {
      const lastDoc = await usersCol.doc(pageToken).get();
      if (lastDoc.exists) queryRef = queryRef.startAfter(lastDoc);
    }

    const snap = await queryRef.get();
    const users = [];

    // Obs.: 3 consultas por usuário (agendamentos, historico total, historico pendente).
    // Para alto volume, considere pré-agregar contagens.
    for (const doc of snap.docs) {
      const data = doc.data();
      const id = doc.id;

      let agCount = 0;
      let histTotal = 0;
      let histPend = 0;

      try {
        const [agSnap, histAllSnap, histPendSnap] = await Promise.all([
          db.collectionGroup("agendamentos").where("idsAlunos", "array-contains", id).get(),
          db.collectionGroup("historico").where("userId", "==", id).get(),
          db.collectionGroup("historico").where("userId", "==", id).where("status", "==", "pendente").get()
        ]);
        agCount = agSnap.size;
        histTotal = histAllSnap.size;
        histPend = histPendSnap.size;
      } catch (err) {
        // Log silently or warn, but don't fail the request.
        // This is expected if indices are building or missing.
        console.warn(`[api/users] Failed to fetch stats for user ${id}: ${err.message}`);
      }

      users.push({
        id,
        email: data.email || null,
        name: data.name || data.userName || data.displayName || null,
        phone: data.phone || data.telefone || null,
        source: data.source || data.origem || null,
        type: data.type || null,
        polo: data.polo || null, // New field from index insights
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        agCount,
        histTotal,
        histPend
      });
    }

    // Filtro em memória (na página retornada)
    const filtered = qtext
      ? users.filter(u =>
        [u.email, u.name, u.phone, u.source]
          .some(v => String(v || "").toLowerCase().includes(qtext))
      )
      : users;

    const last = snap.docs[snap.docs.length - 1];

    res.status(200).json({
      items: filtered.map(projectUser),
      nextPageToken: last ? last.id : null,
      pageSize
    });
  } catch (err) {
    console.error("[/api/users] error:", err);
    res.status(500).json({ error: "server_error" });
  }
}
