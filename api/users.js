// /api/users.js
import { getAdminDb } from "./admin.js";

/**
 * GET /api/users
 * Query params:
 *  - pageSize (default 25, máx. 100)
 *  - pageToken (id do último doc; apenas scope=single)
 *  - pageCursor (base64 JSON cursor; apenas scope=group)
 *  - sortField (default "__name__"; whitelist: "createdAt","__name__","email","name")
 *  - sortDir ("asc" | "desc", default "desc")
 *  - q (filtro substring em memória)
 *  - all ("1" para trazer todas as páginas no backend)
 *  - scope ("single" | "group"; default "group")
 *  - publicDocId (opcional) -> usa artifacts/{artifactId}/public/{publicDocId}/users (prioridade sobre env)
 *
 * ENVs:
 *  - ARTIFACT_ID (default: "registro-itec-dcbc4")
 *  - PUBLIC_DOC_ID (opcional; se setado vira default do caminho public/{PUBLIC_DOC_ID}/users)
 *  - ORIGIN_ALLOWLIST (CORS)
 *  - LOG_VERBOSE ("1" default)
 */

const LOG_PREFIX = "[api/users]";
const VERBOSE = (process.env.LOG_VERBOSE || "1") !== "0";
const ARTIFACT_ID = process.env.ARTIFACT_ID || "registro-itec-dcbc4";
const PUBLIC_DOC_ID_DEFAULT = (process.env.PUBLIC_DOC_ID || "").trim();

function log(...args) { if (VERBOSE) console.log(LOG_PREFIX, ...args); }
function warn(...args) { console.warn(LOG_PREFIX, ...args); }
function errlog(...args) { console.error(LOG_PREFIX, ...args); }

// --- CORS (allowlist simples)
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

  log("CORS", { reqOrigin, allowOrigin, allowlist });

  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

// ---- Sanitização + normalização
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
function normalizeCreatedAt(raw) {
  try {
    if (raw && typeof raw.toDate === "function") return raw.toDate().toISOString();
    if (raw instanceof Date) return raw.toISOString();
    if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  } catch {}
  return null;
}
const ALLOWED_SORT = new Set(["createdAt", "__name__", "email", "name"]);

// ---- Stats por usuário (considere pré-agregação para alta escala)
async function fetchStatsForUser(db, userId) {
  let agCount = 0, histTotal = 0, histPend = 0;
  try {
    const [agSnap, histAllSnap, histPendSnap] = await Promise.all([
      db.collectionGroup("agendamentos").where("idsAlunos", "array-contains", userId).get(),
      db.collectionGroup("historico").where("userId", "==", userId).get(),
      db.collectionGroup("historico").where("userId", "==", userId).where("status", "==", "pendente").get()
    ]);
    agCount = agSnap.size; histTotal = histAllSnap.size; histPend = histPendSnap.size;
  } catch (e) { warn(`Failed to fetch stats for user ${userId}: ${e.message}`); }
  return { agCount, histTotal, histPend };
}
async function mapDocToUser(db, doc) {
  const data = doc.data() || {};
  const id = doc.id;
  const t0 = Date.now();
  const { agCount, histTotal, histPend } = await fetchStatsForUser(db, id);
  const t1 = Date.now();
  if (t1 - t0 > 500) log(`Stats latency for user=${id}: ${t1 - t0}ms`);
  return {
    ...data,
    id,
    email: data.email || null,
    name: data.name || data.userName || data.displayName || null,
    phone: data.phone || data.telefone || null,
    source: data.source || data.origem || null,
    type: data.type || null,
    polo: data.polo || null,
    createdAt: normalizeCreatedAt(data.createdAt),
    agCount, histTotal, histPend,
  };
}

// ---- Cursor helpers (scope=group)
function encodeCursor(obj) { return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url"); }
function decodeCursor(s) {
  try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); }
  catch { return null; }
}

// ---- Resolve CollectionReference dos usuários, conforme publicDocId
function getUsersCollection(db, artifactId, publicDocIdParam) {
  const baseDoc = db.collection("artifacts").doc(artifactId);
  const publicDocId = (publicDocIdParam || PUBLIC_DOC_ID_DEFAULT).trim();
  if (publicDocId) {
    // artifacts/{artifactId}/public/{publicDocId}/users
    const users = baseDoc.collection("public").doc(publicDocId).collection("users");
    return { usersColSingle: users, pathMode: "public", usedPublicDocId: publicDocId };
  }
  // artifacts/{artifactId}/users
  const users = baseDoc.collection("users");
  return { usersColSingle: users, pathMode: "direct", usedPublicDocId: "" };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const tAllStart = Date.now();

  try {
    const db = getAdminDb();

    const rawPageSize = parseInt(req.query.pageSize || "25", 10);
    const pageSize = Math.min(100, Number.isFinite(rawPageSize) ? rawPageSize : 25);

    // Default = "__name__" para não excluir docs sem createdAt
    const requestedSort = (req.query.sortField || "__name__").toString();
    const sortField = ALLOWED_SORT.has(requestedSort) ? requestedSort : "__name__";

    const sortDir = (req.query.sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const qtext = (req.query.q || "").toString().trim().toLowerCase();
    const pageToken = (req.query.pageToken || "").toString().trim();   // single
    const pageCursor = (req.query.pageCursor || "").toString().trim(); // group
    const fetchAll = (req.query.all || "") === "1";
    // Default agora é "group"
    const scope = ((req.query.scope || "group").toString() === "single") ? "single" : "group";
    const publicDocIdQuery = (req.query.publicDocId || "").toString().trim();

    log("Request params", {
      pageSize, sortField, sortDir, qtext, pageToken, pageCursor, all: fetchAll, scope,
      publicDocIdQuery, PUBLIC_DOC_ID_DEFAULT
    });

    const { usersColSingle, pathMode, usedPublicDocId } = getUsersCollection(db, ARTIFACT_ID, publicDocIdQuery);
    const usersGroup = db.collectionGroup("users"); // escopo agregado

    let items = [];
    let pageCount = 0;
    let nextPageToken = null;   // single
    let nextPageCursor = null;  // group

    if (scope === "single") {
      // ----------------- SINGLE SCOPE -----------------
      if (fetchAll) {
        log(`Fetch mode: ALL (single, ${pathMode}, publicDocId=${usedPublicDocId || "-"})`);
        let cursorDoc = null;
        const MAX_PAGES = 500;

        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
          let q = usersColSingle.orderBy(sortField, sortDir).limit(pageSize);
          if (cursorDoc) q = q.startAfter(cursorDoc);

          console.time(`${LOG_PREFIX} pageFetch#${pageIndex}`);
          const snap = await q.get();
          console.timeEnd(`${LOG_PREFIX} pageFetch#${pageIndex}`);
          if (snap.empty) break;

          console.time(`${LOG_PREFIX} mapUsers#${pageIndex}`);
          for (const d of snap.docs) items.push(await mapDocToUser(db, d));
          console.timeEnd(`${LOG_PREFIX} mapUsers#${pageIndex}`);

          cursorDoc = snap.docs[snap.docs.length - 1];
          if (snap.size < pageSize) break;
        }
        pageCount = items.length;

      } else {
        let q = usersColSingle.orderBy(sortField, sortDir).limit(pageSize);
        if (pageToken) {
          const tokenSnap = await usersColSingle.doc(pageToken).get();
          if (tokenSnap.exists) {
            q = q.startAfter(tokenSnap);
            log("Using pageToken startAfter (single)", { pageToken });
          } else {
            warn("pageToken not found, ignoring (single)", { pageToken });
          }
        }

        console.time(`${LOG_PREFIX} pageFetch`);
        const snap = await q.get();
        console.timeEnd(`${LOG_PREFIX} pageFetch`);
        pageCount = snap.size;

        console.time(`${LOG_PREFIX} mapUsers`);
        for (const d of snap.docs) items.push(await mapDocToUser(db, d));
        console.timeEnd(`${LOG_PREFIX} mapUsers`);

        // só há próxima página se esta veio "cheia"
        nextPageToken = (pageCount === pageSize && snap.docs.length)
          ? snap.docs[snap.docs.length - 1].id
          : null;
      }

    } else {
      // ----------------- GROUP SCOPE (DEFAULT) -----------------
      // Ordenação principal por sortField; se sortField != "__name__", encadeamos "__name__" como desempate estável.
      const buildGroupQuery = () => {
        let q = usersGroup.orderBy(sortField, sortDir);
        if (sortField !== "__name__") q = q.orderBy("__name__", sortDir);
        return q.limit(pageSize);
      };

      if (fetchAll) {
        log("Fetch mode: ALL (group)");
        let cursorVals = null; // { sortVal, nameKey }
        const MAX_PAGES = 500;
        let pageIndex = 0;

        while (pageIndex < MAX_PAGES) {
          let q = buildGroupQuery();
          if (cursorVals) {
            if (sortField === "__name__") {
              q = q.startAfter(db.doc(cursorVals.nameKey));
            } else {
              q = q.startAfter(cursorVals.sortVal ?? null, db.doc(cursorVals.nameKey));
            }
          }

          console.time(`${LOG_PREFIX} pageFetch#${pageIndex}`);
          const snap = await q.get();
          console.timeEnd(`${LOG_PREFIX} pageFetch#${pageIndex}`);
          if (snap.empty) break;

          console.time(`${LOG_PREFIX} mapUsers#${pageIndex}`);
          for (const d of snap.docs) items.push(await mapDocToUser(db, d));
          console.timeEnd(`${LOG_PREFIX} mapUsers#${pageIndex}`);

          const last = snap.docs[snap.docs.length - 1];
          cursorVals = {
            sortVal: sortField === "__name__" ? null : (last.get(sortField) ?? null),
            nameKey: last.ref.path,
          };
          if (snap.size < pageSize) break;
          pageIndex += 1;
        }
        pageCount = items.length;

      } else {
        let q = buildGroupQuery();

        if (pageCursor) {
          const cur = decodeCursor(pageCursor);
          if (cur && "nameKey" in cur) {
            try {
              if (sortField === "__name__") {
                q = q.startAfter(db.doc(cur.nameKey));
              } else {
                q = q.startAfter(cur.sortVal ?? null, db.doc(cur.nameKey));
              }
              log("Using pageCursor startAfter (group)", cur);
            } catch (e) {
              warn("Invalid pageCursor, ignoring (group)", { error: e.message });
            }
          } else if (pageCursor) {
            warn("Malformed pageCursor, ignoring (group)");
          }
        }

        console.time(`${LOG_PREFIX} pageFetch`);
        const snap = await q.get();
        console.timeEnd(`${LOG_PREFIX} pageFetch`);
        pageCount = snap.size;

        console.time(`${LOG_PREFIX} mapUsers`);
        for (const d of snap.docs) items.push(await mapDocToUser(db, d));
        console.timeEnd(`${LOG_PREFIX} mapUsers`);

        if (snap.size === pageSize && snap.docs.length) {
          const last = snap.docs[snap.docs.length - 1];
          nextPageCursor = encodeCursor({
            sortVal: sortField === "__name__" ? null : (last.get(sortField) ?? null),
            nameKey: last.ref.path,
          });
        } else {
          nextPageCursor = null;
        }
      }
    }

    const beforeFilter = items.length;
    const filtered = (qtext
      ? items.filter(u =>
          [u.email, u.name, u.phone, u.source]
            .some(v => String(v || "").toLowerCase().includes(qtext)))
      : items);

    const responsePayload = {
      items: filtered.map(projectUser),
      pageSize,
      returnedCount: filtered.length,
      hasMore: scope === "single" ? Boolean(nextPageToken) : Boolean(nextPageCursor),
      nextPageToken: scope === "single" ? nextPageToken : null,
      nextPageCursor: scope === "group" ? nextPageCursor : null,
      scope,
    };

    // logs de saída (sem PII completa)
    const sample = responsePayload.items.slice(0, 5).map(u => ({ id: u.id, email: u.email }));
    log("Response summary", {
      scope,
      pathMode,
      usedPublicDocId,
      totalBeforeFilter: beforeFilter,
      totalAfterFilter: filtered.length,
      pageSize,
      nextPageToken: responsePayload.nextPageToken,
      nextPageCursor: responsePayload.nextPageCursor,
      sampleFirst5: sample
    });

    // headers úteis
    res.setHeader("X-Returned-Count", String(responsePayload.returnedCount));
    res.setHeader("X-Has-More", responsePayload.hasMore ? "1" : "0");
    res.setHeader("X-Scope", scope);
    res.setHeader("X-Path-Mode", pathMode);
    res.setHeader("X-Public-DocId", usedPublicDocId || "-");

    return res.status(200).json(responsePayload);
  } catch (err) {
    errlog("error:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    log("Total handler time (ms)", Date.now() - tAllStart);
  }
}
