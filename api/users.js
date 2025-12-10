// /api/users.js
import { getAdminDb } from "./admin.js";

/**
 * GET /api/users
 * Query params:
 *  - pageSize (default 25, máx. 100)
 *  - pageToken (id do último doc)
 *  - pageCursor (cursor base64)
 *  - sortField (default "__name__")
 *  - sortDir ("asc" | "desc")
 *  - q (filtro substring em memória)
 *  - scope ("single" | "group", default "group")
 *  - all ("1" para buscar todas as páginas)
 *  - publicDocId (subdocumento dentro de artifacts)
 *
 * ENVs:
 *  - ARTIFACT_ID (default "registro-itec-dcbc4")
 *  - PUBLIC_DOC_ID (opcional)
 *  - ORIGIN_ALLOWLIST (CORS)
 */

const LOG_PREFIX = "[api/users]";
const VERBOSE = (process.env.LOG_VERBOSE || "1") !== "0";
const ARTIFACT_ID = process.env.ARTIFACT_ID || "registro-itec-dcbc4";
const PUBLIC_DOC_ID_DEFAULT = (process.env.PUBLIC_DOC_ID || "").trim();

function log(...args) { if (VERBOSE) console.log(LOG_PREFIX, ...args); }
function warn(...args) { console.warn(LOG_PREFIX, ...args); }
function errlog(...args) { console.error(LOG_PREFIX, ...args); }

// --- CORS básico
function applyCors(req, res) {
  const reqOrigin = req.headers.origin || "";
  const allowlist = (process.env.ORIGIN_ALLOWLIST || "")
    .split(",").map(s => s.trim()).filter(Boolean);

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

// ---- Normalização e sanitização
function normalizeCreatedAt(raw) {
  try {
    if (raw && typeof raw.toDate === "function") return raw.toDate().toISOString();
    if (raw instanceof Date) return raw.toISOString();
    if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  } catch {}
  return null;
}

// ---- Busca de estatísticas por usuário (agendamentos / históricos)
async function fetchStatsForUser(db, userId) {
  let agCount = 0, histTotal = 0, histPend = 0;
  try {
    const [agSnap, histAllSnap, histPendSnap] = await Promise.all([
      db.collectionGroup("agendamentos").where("idsAlunos", "array-contains", userId).get(),
      db.collectionGroup("historico").where("userId", "==", userId).get(),
      db.collectionGroup("historico").where("userId", "==", userId).where("status", "==", "pendente").get()
    ]);
    agCount = agSnap.size;
    histTotal = histAllSnap.size;
    histPend = histPendSnap.size;
  } catch (e) {
    warn(`Failed to fetch stats for user ${userId}: ${e.message}`);
  }
  return { agCount, histTotal, histPend };
}

// ---- Mapeamento do documento Firestore → objeto User
async function mapDocToUser(db, doc) {
  const data = doc.data() || {};
  const id = doc.id;

  const { agCount, histTotal, histPend } = await fetchStatsForUser(db, id);

  // 🔧 Mapeamento com fallbacks PT-BR
  const name =
    data.name ||
    data.nome ||
    data.userName ||
    data.displayName ||
    null;

  const createdAtIso = normalizeCreatedAt(
    data.createdAt ||
    data.dataRegistro || // timestamp do Firestore (em português)
    null
  );

  const source =
    data.source ||
    data.origem ||
    data.empresa ||
    null;

  const phone =
    data.phone ||
    data.telefone ||
    data.celular ||
    null;

  return {
    ...data,
    id,
    email: data.email || null,
    name,
    phone,
    source,
    type: data.type || null,
    polo: data.polo || null,
    createdAt: createdAtIso,
    agCount,
    histTotal,
    histPend,
  };
}

// ---- Utilitários de cursor (paginações com collectionGroup)
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}
function decodeCursor(s) {
  try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); }
  catch { return null; }
}

// ---- Resolve caminho da coleção (pública ou direta)
function getUsersCollection(db, artifactId, publicDocIdParam) {
  const baseDoc = db.collection("artifacts").doc(artifactId);
  const publicDocId = (publicDocIdParam || PUBLIC_DOC_ID_DEFAULT).trim();
  if (publicDocId) {
    const users = baseDoc.collection("public").doc(publicDocId).collection("users");
    return { usersColSingle: users, pathMode: "public", usedPublicDocId: publicDocId };
  }
  const users = baseDoc.collection("users");
  return { usersColSingle: users, pathMode: "direct", usedPublicDocId: "" };
}

// ---- Handler principal
export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const tStart = Date.now();

  try {
    const db = getAdminDb();

    const pageSize = Math.min(100, parseInt(req.query.pageSize || "25", 10));
    const sortField = (req.query.sortField || "__name__").toString();
    const sortDir = (req.query.sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const qtext = (req.query.q || "").toString().trim().toLowerCase();
    const scope = (req.query.scope || "group") === "single" ? "single" : "group";
    const fetchAll = (req.query.all || "") === "1";
    const pageToken = (req.query.pageToken || "").trim();
    const pageCursor = (req.query.pageCursor || "").trim();
    const publicDocId = (req.query.publicDocId || "").trim();

    const { usersColSingle, pathMode, usedPublicDocId } = getUsersCollection(db, ARTIFACT_ID, publicDocId);
    const usersGroup = db.collectionGroup("users");

    log("Request params", { pageSize, sortField, sortDir, scope, fetchAll, pathMode, usedPublicDocId });

    let items = [];
    let nextPageToken = null;
    let nextPageCursor = null;

    if (scope === "single") {
      let q = usersColSingle.orderBy(sortField, sortDir).limit(pageSize);
      if (pageToken) {
        const lastDoc = await usersColSingle.doc(pageToken).get();
        if (lastDoc.exists) q = q.startAfter(lastDoc);
      }

      const snap = await q.get();
      for (const d of snap.docs) items.push(await mapDocToUser(db, d));

      nextPageToken = (snap.size === pageSize && snap.docs.length)
        ? snap.docs[snap.docs.length - 1].id
        : null;

    } else {
      let q = usersGroup.orderBy(sortField, sortDir).limit(pageSize);
      if (pageCursor) {
        const cur = decodeCursor(pageCursor);
        if (cur && cur.nameKey) {
          q = q.startAfter(db.doc(cur.nameKey));
        }
      }

      const snap = await q.get();
      for (const d of snap.docs) items.push(await mapDocToUser(db, d));

      if (snap.size === pageSize && snap.docs.length) {
        const last = snap.docs[snap.docs.length - 1];
        nextPageCursor = encodeCursor({ nameKey: last.ref.path });
      }
    }

    // Filtro de busca textual (q)
    const filtered = qtext
      ? items.filter(u =>
          [u.email, u.name, u.phone, u.source]
            .some(v => String(v || "").toLowerCase().includes(qtext)))
      : items;

    const sample = filtered.slice(0, 5).map(u => ({ id: u.id, email: u.email, name: u.name }));
    log("Response summary", {
      scope,
      totalBeforeFilter: items.length,
      totalAfterFilter: filtered.length,
      sample
    });

    return res.status(200).json({
      items: filtered,
      nextPageToken,
      nextPageCursor,
      hasMore: !!(nextPageToken || nextPageCursor),
      pageSize,
    });

  } catch (err) {
    errlog("error:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    log("Total handler time (ms)", Date.now() - tStart);
  }
}
