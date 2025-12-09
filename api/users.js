// api/users.js
import { getAdminDb, assertApiKey } from "./_lib/admin.js";

/**
 * GET /api/users
 * Query params:
 *  - pageSize (default 25, máx. 100)
 *  - pageToken (id do último doc)
 *  - sortField (default "createdAt")
 *  - sortDir ("asc" | "desc", default "desc")
 *  - q (filtro de substring aplicado em memória na página retornada)
 */
export default async function handler(req, res) {
  try {
    assertApiKey(req);
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

    for (const doc of snap.docs) {
      const data = doc.data();
      const id = doc.id;

      // Contagens por collectionGroup (custo por leitura; otimizar com agregados se necessário)
      const [agSnap, histAllSnap, histPendSnap] = await Promise.all([
        db.collectionGroup("agendamentos").where("idsAlunos", "array-contains", id).get(),
        db.collectionGroup("historico").where("userId", "==", id).get(),
        db.collectionGroup("historico").where("userId", "==", id).where("status", "==", "pendente").get()
      ]);

      users.push({
        id,
        email: data.email || null,
        name: data.name || data.userName || data.displayName || null,
        phone: data.phone || data.telefone || null,
        source: data.source || data.origem || null,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        agCount: agSnap.size,
        histTotal: histAllSnap.size,
        histPend: histPendSnap.size
      });
    }

    // Filtro simples em memória na página corrente
    const filtered = qtext
      ? users.filter(u =>
          [u.email, u.name, u.phone, u.source]
            .some(v => String(v || "").toLowerCase().includes(qtext))
        )
      : users;

    const last = snap.docs[snap.docs.length - 1];

    res.status(200).json({
      items: filtered,
      nextPageToken: last ? last.id : null,
      pageSize
    });
  } catch (err) {
    console.error("[/api/users] error:", err);
    res.status(err.statusCode || 500).json({ error: err.message || "server_error" });
  }
}
