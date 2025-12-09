// api/health.js
export default async function handler(req, res) {
  res.status(200).json({
    ok: true,
    node: process.version,
    hasApiKey: Boolean(process.env.API_KEY),
    hasSaKey: Boolean(process.env.SA_KEY)
  });
}
