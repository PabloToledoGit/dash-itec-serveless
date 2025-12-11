import { getAdminDb } from "./admin.js";

const LOG_PREFIX = "[api/agendamentos]";
const ARTIFACT_ID = process.env.ARTIFACT_ID || "registro-itec-dcbc4";

function log(...args) {
    console.log(LOG_PREFIX, ...args);
}

function errlog(...args) {
    console.error(LOG_PREFIX, ...args);
}

// Reuse CORS logic from users.js to maintain consistency
function applyCors(req, res) {
    const reqOrigin = req.headers.origin || "";
    const allowlist = (process.env.ORIGIN_ALLOWLIST || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const allowOrigin = allowlist.length
        ? allowlist.includes(reqOrigin)
            ? reqOrigin
            : allowlist[0]
        : reqOrigin || "*";

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

export default async function handler(req, res) {
    if (applyCors(req, res)) return;

    if (req.method !== "GET") {
        return res.status(405).json({ error: "method_not_allowed" });
    }

    try {
        const db = getAdminDb();

        // Path based on user requirement: artifacts/registro-itec-dcbc4/public/data/agendamentos
        const agendamentosRef = db
            .collection("artifacts")
            .doc(ARTIFACT_ID)
            .collection("public")
            .doc("data")
            .collection("agendamentos");

        const snapshot = await agendamentosRef.get();

        const items = [];
        if (!snapshot.empty) {
            snapshot.forEach((doc) => {
                const data = doc.data();
                items.push({
                    id: doc.id,
                    ...data,
                    // Normalize dates to ISO string for JSON safety
                    dataAgendamento: normalizeDate(data.dataAgendamento),
                    timestampCriacao: normalizeDate(data.timestampCriacao),
                });
            });
        }

        log(`Fetched ${items.length} agendamentos`);

        return res.status(200).json({
            items,
            total: items.length,
        });
    } catch (error) {
        errlog("Error fetching agendamentos:", error);
        return res.status(500).json({ error: "server_error", message: error.message });
    }
}

function normalizeDate(val) {
    if (!val) return null;
    // If it's a Firestore Timestamp (has toDate)
    if (typeof val.toDate === "function") {
        return val.toDate().toISOString();
    }
    // If it's already a Date
    if (val instanceof Date) {
        return val.toISOString();
    }
    // If it's a string, try to parse
    if (typeof val === "string") {
        return val;
    }
    return null;
}
