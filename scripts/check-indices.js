// import "dotenv/config"; // Removed to avoid dependency

import { getAdminDb } from "../api/admin.js";

async function checkIndices() {
    console.log("Initializing Firestore...");
    // Manually load env if needed, but we used .env.local.
    // We'll rely on the user running this with `node --env-file=.env.local` (Node 20+) or manually setting vars.
    // Or better, let's just parse the .env.local file here quickly to be safe/easy for the user.

    const fs = await import("fs");
    const path = await import("path");
    try {
        const envPath = path.resolve(process.cwd(), ".env.local");
        const envContent = fs.readFileSync(envPath, "utf8");
        envContent.split("\n").forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                let value = match[2].trim();
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1).replace(/\\n/g, "\n");
                }
                process.env[key] = value;
            }
        });
        console.log("Loaded .env.local");
    } catch (e) {
        console.warn("Could not load .env.local, assuming env vars are set:", e.message);
    }

    const db = getAdminDb();
    const dummyId = "test_user_id";

    console.log("\n--- Checking Index 1: agendamentos.where('idsAlunos', 'array-contains') ---");
    try {
        await db.collectionGroup("agendamentos").where("idsAlunos", "array-contains", dummyId).limit(1).get();
        console.log("✅ Index 1 seems OK (or not required yet).");
    } catch (err) {
        console.error("❌ Index 1 Error:", err.message);
    }

    console.log("\n--- Checking Index 2: historico.where('userId') ---");
    try {
        await db.collectionGroup("historico").where("userId", "==", dummyId).limit(1).get();
        console.log("✅ Index 2 seems OK.");
    } catch (err) {
        console.error("❌ Index 2 Error:", err.message);
    }

    console.log("\n--- Checking Index 3: historico.where('userId').where('status') ---");
    try {
        await db.collectionGroup("historico").where("userId", "==", dummyId).where("status", "==", "pendente").limit(1).get();
        console.log("✅ Index 3 seems OK.");
    } catch (err) {
        console.error("❌ Index 3 Error:", err.message);
    }
}

checkIndices().catch(console.error);
