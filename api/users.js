// /api/users.js
import { getAdminDb } from "./admin.js";

/**
 * GET /api/users
 * Query params:
 *  - pageSize (default 25, máx. 100)
 *  - pageToken (id do último doc; apenas scope=single)
 *  - pageCursor (base64 JSON cursor; apenas scope=group)
 *  - sortField (default "createdAt"; whitelist: "createdAt","__name__","email","name")
 *  - sortDir ("asc" | "desc", default "desc")
 *  - q (filtro substring em memória)
 *  - all ("1" para trazer todas as páginas no backend)
 *  - scope ("single" | "group"; default "single")
 *
 * Observações:
 *  - Em scope=group, a paginação usa cursor robusto, não "pageToken".
 *  - Os "counts" (agCount, histTotal, histPend) são consultados por usuário; prefira pré-agregação em alto volume.
 */

// ---------- Utils de log ----------
const LOG_PREFIX = "[api/users]";
const VERBOSE = (process.env.LOG_VERBOSE || "1") !== "0";

function log(...args) {
  if (VERBOSE) console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function errlog(...args) {
  console.error(LOG_PREFIX, ...args);
}

// --- CORS (com allowlist simples por env)
function applyCors(req, res) {
  const reqOrigin = req.headers.origin || "";
  const allowlist = (process.env.ORIGIN_ALLOWLIST || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const allowOrigin = allowlist.length
    ? (allowlist.includes(reqOrigin) ? reqOrigin : allowlist[0])
    : (reqOrigin || "*");

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  log("CORS", { reqOrigin, allowOrigin, allowlist });

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
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

// ---- Stats por usuário (considerar pré-agregação)
async function fetchStatsForUser(db, userId) {
  let agCount = 0;
  let histTotal = 0;
  let histPend = 0;

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
    agCount,
    histTotal,
    histPend,
  };
}

// ---- Cursor helpers (scope=group)
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}
function decodeCursor(s) {
  try {
    const json = Buffer.from(s, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const tAllStart = Date.now();

  try {
    const db = getAdminDb();

    const rawPageSize = parseInt(req.query.pageSize || "25", 10);
    const pageSize = Math.min(100, Number.isFinite(rawPageSize) ? rawPageSize : 25);

    const requestedSort = (req.query.sortField || "createdAt").toString();
    const sortField = ALLOWED_SORT.has(requestedSort) ? requestedSort : "__name__";

    const sortDir = (req.query.sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const qtext = (req.query.q || "").toString().trim().toLowerCase();
    const pageToken = (req.query.pageToken || "").toString().trim();   // single
    const pageCursor = (req.query.pageCursor || "").toString().trim(); // group
    const fetchAll = (req.query.all || "") === "1";
    const scope = ((req.query.scope || "single").toString() === "group") ? "group" : "single";

    log("Request params", { pageSize, sortField, sortDir, qtext, pageToken, pageCursor, all: fetchAll, scope });

    // collection roots
    const usersColSingle = db
      .collection("artifacts")
      .doc("registro-itec-dcbc4")
      .collection("users");

    const usersGroup = db.collectionGroup("users");

    let items = [];
    let pageCount = 0;
    let nextPageToken = null;   // single
    let nextPageCursor = null;  // group

    if (scope === "single") {
      // ----------------- SINGLE SCOPE -----------------
      if (fetchAll) {
        log("Fetch mode: ALL (single)");
        let cursorDoc = null;
        let totalAccum = 0;
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

          totalAccum += snap.size;
          cursorDoc = snap.docs[snap.docs.length - 1];
          if (snap.size < pageSize) break;
        }
        pageCount = items.length; // para header
      } else {
        // página única
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
      // ----------------- GROUP SCOPE -----------------
      // ordenação: sortField + __name__ para cursor estável
      // Em collectionGroup, é permitido encadear orderBy.
      if (fetchAll) {
        log("Fetch mode: ALL (group)");
        let cursorVals = null; // { sortVal, nameKey }
        const MAX_PAGES = 500;
        let pageIndex = 0;

        while (pageIndex < MAX_PAGES) {
          let q = usersGroup.orderBy(sortField, sortDir).orderBy("__name__", sortDir).limit(pageSize);
          if (cursorVals) {
            q = q.startAfter(cursorVals.sortVal, db.doc(cursorVals.nameKey));
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
            sortVal: last.get(sortField) ?? null,
            nameKey: last.ref.path,
          };
          if (snap.size < pageSize) break;
          pageIndex += 1;
        }
        pageCount = items.length; // para header

      } else {
        // página única (com cursor de entrada opcional)
        let q = usersGroup.orderBy(sortField, sortDir).orderBy("__name__", sortDir).limit(pageSize);

        if (pageCursor) {
          const cur = decodeCursor(pageCursor);
          if (cur && "sortVal" in cur && "nameKey" in cur) {
            try {
              q = q.startAfter(cur.sortVal, db.doc(cur.nameKey));
              log("Using pageCursor startAfter (group)", cur);
            } catch (e) {
              warn("Invalid pageCursor, ignoring (group)", { error: e.message });
            }
          } else {
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
            sortVal: last.get(sortField) ?? null,
            nameKey: last.ref.path,
          });
        } else {
          nextPageCursor = null;
        }
      }
    }

    const beforeFilter = items.length;

    // Filtro substring em memória (sobre a página ou sobre o conjunto all=1)
    const filtered = qtext
      ? items.filter(u =>
          [u.email, u.name, u.phone, u.source]
            .some(v => String(v || "").toLowerCase().includes(qtext))
        )
      : items;

    const afterFilter = filtered.length;

    // Monta payload
    const responsePayload = {
      items: filtered.map(projectUser),
      pageSize,
      returnedCount: filtered.length,
      hasMore: scope === "single" ? Boolean(nextPageToken) : Boolean(nextPageCursor),
      // Retorna apenas o cursor aplicável ao escopo:
      nextPageToken: scope === "single" ? nextPageToken : null,
      nextPageCursor: scope === "group" ? nextPageCursor : null,
      scope
    };

    // Logs de saída (sem PII completa)
    const sample = responsePayload.items.slice(0, 5).map(u => ({ id: u.id, email: u.email }));
    log("Response summary", {
      scope,
      totalBeforeFilter: beforeFilter,
      totalAfterFilter: afterFilter,
      pageSize,
      pageCount,
      nextPageToken: responsePayload.nextPageToken,
      nextPageCursor: responsePayload.nextPageCursor,
      sampleFirst5: sample
    });

    const tAllEnd = Date.now();
    log("Total handler time (ms)", tAllEnd - tAllStart);

    // Cabeçalhos auxiliares para inspeção rápida
    res.setHeader("X-Returned-Count", String(responsePayload.returnedCount));
    res.setHeader("X-Has-More", responsePayload.hasMore ? "1" : "0");
    res.setHeader("X-Page-Count", String(pageCount));
    res.setHeader("X-Scope", scope);

    return res.status(200).json(responsePayload);
  } catch (err) {
    errlog("error:", err);
    return res.status(500).json({ error: "server_error" });
  }
}
