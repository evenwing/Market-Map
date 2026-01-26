import "dotenv/config";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const uiMode = process.env.UI_MODE === "multi" ? "multi" : "single";
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-store");
  res.end(`window.__MM_CONFIG__ = { uiMode: ${JSON.stringify(uiMode)} };`);
}
