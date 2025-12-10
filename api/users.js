// /api/users.js
import { getAdminDb } from "./admin.js";

/**
 * GET /api/users
 * Query params:
 *  - pageSize (default 25, máx. 100)
 *  - pageToken (id do último doc; ignorado se all=1)
 *  - sortField (default "createdAt"; whitelist: "createdAt","__name__","email","name")
 *  - sortDir ("asc" | "desc", default "desc")
 *  - q (filtro substring aplicado em memória na página/result set)
 *  - all ("1" para trazer todas as páginas no backend)
 *
 * Observações:
 *  - Não há autenticação via x-api-key.
 *  - Recomendado limitar origens com ORIGIN_ALLOWLIST.
 *  - Os "counts" (agCount, histTotal, histPend) são consultados por usuário; para alto volume, prefira pré-agregação.
 */

// ---------- Utils de log ----------
const LOG_PREFIX = "[api/users]";
const VERBOSE = (process.env.LOG_VERBOSE || "1") !== "0"; // habilitado por padrão

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

  // Se não houver allowlist, libera amplo (dev). Em produção, configure ORIGIN_ALLOWLIST!
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

function normalizeCreatedAt(raw) {
  try {
    // Firestore Timestamp?
    if (raw && typeof raw.toDate === "function") return raw.toDate().toISOString();
    // Date JS?
    if (raw instanceof Date) return raw.toISOString();
    // ISO string válida?
    if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  } catch {}
  return null;
}

const ALLOWED_SORT = new Set(["createdAt", "__name__", "email", "name"]);

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
    // índices ausentes/emitindo ainda: não falhar a requisição
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

  if (t1 - t0 > 500) {
    // loga stats "lentas" para monitoramento
    log(`Stats latency for user=${id}: ${t1 - t0}ms`);
  }

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
    const pageToken = (req.query.pageToken || "").toString().trim();
    const fetchAll = (req.query.all || "") === "1";

    log("Request params", { pageSize, sortField, sortDir, qtext, pageToken, all: fetchAll });

    const usersCol = db
      .collection("artifacts")
      .doc("registro-itec-dcbc4")
      .collection("users");

    let items = [];
    let lastDoc = null;

    if (fetchAll) {
      // --------- Modo "trazer tudo" (itera no backend) ---------
      log("Fetch mode: ALL");
      let cursor = null;
      let pageIndex = 0;

      // Evita loop infinito por segurança
      const MAX_PAGES = 500;

      while (pageIndex < MAX_PAGES) {
        let q = usersCol.orderBy(sortField, sortDir).limit(pageSize);
        if (cursor) q = q.startAfter(cursor);

        console.time(`${LOG_PREFIX} pageFetch#${pageIndex}`);
        const pageSnap = await q.get();
        console.timeEnd(`${LOG_PREFIX} pageFetch#${pageIndex}`);

        if (pageSnap.empty) {
          log(`No more docs at page #${pageIndex}`);
          break;
        }

        // Mapear documentos -> usuários com stats
        console.time(`${LOG_PREFIX} mapUsers#${pageIndex}`);
        const mapped = [];
        for (const d of pageSnap.docs) {
          mapped.push(await mapDocToUser(db, d));
        }
        console.timeEnd(`${LOG_PREFIX} mapUsers#${pageIndex}`);

        items.push(...mapped);
        cursor = pageSnap.docs[pageSnap.docs.length - 1];
        lastDoc = cursor;

        log(`Accumulated users after page #${pageIndex}: ${items.length}`);

        if (pageSnap.size < pageSize) break; // terminou
        pageIndex += 1;
      }
    } else {
      // --------- Modo paginado padrão ---------
      let queryRef = usersCol.orderBy(sortField, sortDir).limit(pageSize);

      if (pageToken) {
        const tokenSnap = await usersCol.doc(pageToken).get();
        if (tokenSnap.exists) {
          queryRef = queryRef.startAfter(tokenSnap);
          log("Using pageToken startAfter", { pageToken });
        } else {
          warn("pageToken not found, ignoring", { pageToken });
        }
      }

      console.time(`${LOG_PREFIX} pageFetch`);
      const snap = await queryRef.get();
      console.timeEnd(`${LOG_PREFIX} pageFetch`);

      console.time(`${LOG_PREFIX} mapUsers`);
      const mapped = [];
      for (const d of snap.docs) {
        mapped.push(await mapDocToUser(db, d));
      }
      console.timeEnd(`${LOG_PREFIX} mapUsers`);

      items = mapped;
      lastDoc = snap.docs[snap.docs.length - 1] || null;
    }

    const beforeFilter = items.length;

    // Filtro em memória (substring) — em todo o result set (all=1) ou na página atual
    const filtered = qtext
      ? items.filter(u =>
          [u.email, u.name, u.phone, u.source]
            .some(v => String(v || "").toLowerCase().includes(qtext))
        )
      : items;

    const afterFilter = filtered.length;

    // Monta payload e registra log de saída
    const nextPageToken = fetchAll ? null : (lastDoc ? lastDoc.id : null);
    const responsePayload = {
      items: filtered.map(projectUser),
      nextPageToken,
      pageSize,
      returnedCount: filtered.length,
      hasMore: nextPageToken ? true : false
    };

    // ---------- LOG do payload enviado ----------
    // Para não expor PII completa nos logs, listamos apenas primeiros 5 IDs e e-mails.
    const sample = responsePayload.items.slice(0, 5).map(u => ({ id: u.id, email: u.email }));
    log("Response summary", {
      totalBeforeFilter: beforeFilter,
      totalAfterFilter: afterFilter,
      pageSize,
      nextPageToken,
      sampleFirst5: sample
    });

    const tAllEnd = Date.now();
    log("Total handler time (ms)", tAllEnd - tAllStart);

    // Cabeçalho auxiliar (opcional) — útil em inspeções no navegador
    res.setHeader("X-Returned-Count", String(responsePayload.returnedCount));
    res.setHeader("X-Has-More", responsePayload.hasMore ? "1" : "0");

    return res.status(200).json(responsePayload);
  } catch (err) {
    errlog("error:", err);
    return res.status(500).json({ error: "server_error" });
  }
}
