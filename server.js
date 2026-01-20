import "dotenv/config";
import http from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import { analyzeMarket, warmGemini } from "./lib/gemini.js";
import { renderHtml } from "./lib/render.js";
import { createTrace } from "./lib/braintrust.js";
import { withGeminiQueue } from "./lib/queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = process.env.PORT || 3000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MINUTES || 15) * 60 * 1000;
const inputCache = new Map();
const categoryCache = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && requestUrl.pathname === "/api/analyze/stream") {
      await handleAnalyzeStream(req, res, requestUrl);
      return;
    }

    if (req.method === "POST" && req.url === "/api/analyze") {
      await handleAnalyze(req, res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Server error" }));
  }
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

if (process.env.GEMINI_WARMUP !== "false") {
  warmGemini();
}

async function handleAnalyzeStream(req, res, requestUrl) {
  const sessionId = crypto.randomUUID();
  const input = requestUrl.searchParams.get("input")?.trim() || "";
  const trace = await createTrace({ input, sessionId });
  trace.event("input_received", { input, streaming: true });

  const fallback = buildApologyPayload();
  const cached = findCachedPayload(input);
  let closed = false;

  req.on("close", () => {
    closed = true;
  });

  startStream(res);

  if (!input) {
    sendStreamEvent(res, closed, "status", { message: "No market signal detected." });
    const html = renderHtml(fallback);
    await trace.end(fallback, html);
    sendStreamEvent(res, closed, "final", fallback);
    res.end();
    return;
  }

  if (cached) {
    trace.event("cache_hit", { key: cached.key, source: cached.source });
    sendStreamEvent(res, closed, "status", { message: "Cache hit. Returning cached results." });
    const html = renderHtml(cached.payload);
    await trace.end(cached.payload, html);
    sendStreamEvent(res, closed, "final", cached.payload);
    res.end();
    return;
  }

  sendStreamEvent(res, closed, "status", { message: "Analyzing input..." });

  try {
    const queued = await withGeminiQueue(
      () =>
        analyzeMarket(input, (step, data) => {
          trace.event(step, data);
          const messages = summarizeEvent(step, data);
          messages.status.forEach((message) =>
            sendStreamEvent(res, closed, "status", { message })
          );
          messages.detail.forEach((message) =>
            sendStreamEvent(res, closed, "detail", { message })
          );
        }),
      {
        onQueue: (position) => {
          trace.event("queue_wait", { position });
          sendStreamEvent(res, closed, "status", {
            message: `Queued for analysis (${position})...`
          });
        }
      }
    );

    if (queued.status === "timeout") {
      const stale = findCachedPayload(input, { allowStale: true });
      if (stale) {
        trace.event("queue_timeout_cache", {
          key: stale.key,
          source: stale.source,
          stale: stale.stale
        });
        sendStreamEvent(res, closed, "status", {
          message: "Queue timeout. Returning cached results."
        });
        const html = renderHtml(stale.payload);
        await trace.end(stale.payload, html);
        sendStreamEvent(res, closed, "final", stale.payload);
        res.end();
        return;
      }
      const errorPayload = {
        ...fallback,
        debug: { message: "Server busy. Please retry." }
      };
      const html = renderHtml(errorPayload);
      await trace.end(errorPayload, html);
      sendStreamEvent(res, closed, "debug", { message: errorPayload.debug.message });
      sendStreamEvent(res, closed, "final", errorPayload);
      res.end();
      return;
    }

    const result = queued.value;
    sendStreamEvent(res, closed, "status", { message: "Finalizing results..." });
    const html = renderHtml(result);
    await trace.end(result, html);
    storeCachedPayload(input, result);
    sendStreamEvent(res, closed, "final", result);
    res.end();
  } catch (err) {
    const errorPayload = {
      ...fallback,
      debug: {
        message: err.message || "Unknown error"
      }
    };
    const html = renderHtml(errorPayload);
    trace.event("error", { message: err.message });
    await trace.error(err, html);
    sendStreamEvent(res, closed, "debug", { message: err.message || "Unknown error" });
    sendStreamEvent(res, closed, "final", errorPayload);
    res.end();
  }
}

async function handleAnalyze(req, res) {
  const sessionId = crypto.randomUUID();
  const body = await readBody(req);
  let input = "";

  try {
    const parsed = JSON.parse(body || "{}");
    input = typeof parsed.input === "string" ? parsed.input.trim() : "";
  } catch (err) {
    input = "";
  }

  const trace = await createTrace({ input, sessionId });
  trace.event("input_received", { input });

  const fallback = buildApologyPayload();
  const cached = findCachedPayload(input);

  if (!input) {
    const html = renderHtml(fallback);
    await trace.end(fallback, html);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(fallback));
    return;
  }

  if (cached) {
    trace.event("cache_hit", { key: cached.key, source: cached.source });
    const html = renderHtml(cached.payload);
    await trace.end(cached.payload, html);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cached.payload));
    return;
  }

  try {
    const queued = await withGeminiQueue(
      () => analyzeMarket(input, (step, data) => trace.event(step, data)),
      {
        onQueue: (position) => trace.event("queue_wait", { position })
      }
    );

    if (queued.status === "timeout") {
      const stale = findCachedPayload(input, { allowStale: true });
      if (stale) {
        trace.event("queue_timeout_cache", {
          key: stale.key,
          source: stale.source,
          stale: stale.stale
        });
        const html = renderHtml(stale.payload);
        await trace.end(stale.payload, html);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stale.payload));
        return;
      }
      const errorPayload = {
        ...fallback,
        debug: {
          message: "Server busy. Please retry."
        }
      };
      const html = renderHtml(errorPayload);
      await trace.end(errorPayload, html);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorPayload));
      return;
    }

    const result = queued.value;
    const html = renderHtml(result);
    await trace.end(result, html);

    storeCachedPayload(input, result);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const errorPayload = {
      ...fallback,
      debug: {
        message: err.message || "Unknown error"
      }
    };
    const html = renderHtml(errorPayload);
    trace.event("error", { message: err.message });
    await trace.error(err, html);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errorPayload));
  }
}

async function serveStatic(req, res) {
  const urlPath = (req.url || "/").split("?")[0];
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(publicDir, decodeURIComponent(safePath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "application/javascript";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/plain";
  }
}

function buildApologyPayload() {
  return {
    mode: "apology",
    apology: {
      title: "Signal Lost",
      message: "Sorry - I analyze software markets only.",
      hint: "Try: CRM, payments, video conferencing."
    }
  };
}

function startStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write("\n");
}

function sendStreamEvent(res, closed, event, data) {
  if (closed || res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function summarizeEvent(step, data) {
  const status = [];
  const detail = [];

  switch (step) {
    case "gemini_request": {
      const model = data?.model ? ` (${data.model})` : "";
      const grounding = data?.use_tools ? " with grounding" : " without grounding";
      status.push(`Calling Gemini${model}${grounding}...`);
      break;
    }
    case "gemini_response": {
      status.push(data?.grounding ? "Received grounded response." : "Received response.");
      const { queries, sources } = extractGrounding(data?.grounding);
      if (queries.length) {
        detail.push(`Search queries: ${queries.join(", ")}`);
      }
      if (sources.length) {
        detail.push(`Sources: ${sources.join(", ")}`);
      }
      break;
    }
    case "gemini_model_fallback": {
      if (data?.from && data?.to) {
        detail.push(`Model fallback: ${data.from} -> ${data.to}`);
      }
      break;
    }
    case "gemini_tools_fallback": {
      detail.push("Retrying with Google Search grounding.");
      break;
    }
    default:
      break;
  }

  return { status, detail };
}

function extractGrounding(grounding) {
  const queries = [];
  const sources = [];

  const queryItems = Array.isArray(grounding?.webSearchQueries)
    ? grounding.webSearchQueries
    : [];
  queryItems.forEach((item) => {
    if (typeof item === "string") {
      queries.push(item);
    } else if (item?.searchQuery) {
      queries.push(item.searchQuery);
    }
  });

  const chunks = Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks : [];
  chunks.forEach((chunk) => {
    const uri = chunk?.web?.uri || chunk?.uri;
    if (typeof uri === "string") {
      const cleaned = unwrapRedirectUrl(uri) || uri;
      const domain = toDomain(cleaned);
      if (domain) sources.push(domain);
    }
  });

  return {
    queries: unique(queries).slice(0, 5),
    sources: unique(sources).slice(0, 5)
  };
}

function toDomain(uri) {
  try {
    const parsed = new URL(uri);
    return parsed.hostname;
  } catch (err) {
    return "";
  }
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function unwrapRedirectUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    if (!parsed.hostname.toLowerCase().includes("vertexaisearch")) {
      return value;
    }
    const candidates = [
      "url",
      "u",
      "target",
      "target_url",
      "targetUrl",
      "dest",
      "destination",
      "redirect",
      "redirect_url"
    ];
    for (const key of candidates) {
      const candidate = parsed.searchParams.get(key);
      const normalized = normalizeRedirectCandidate(candidate);
      if (normalized) return normalized;
    }
    return value;
  } catch (err) {
    return value;
  }
}

function normalizeRedirectCandidate(value) {
  if (!value) return "";
  let decoded = value;
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (err) {
      break;
    }
  }
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
    return decoded;
  }
  return "";
}

function normalizeKey(value) {
  return value.trim().toLowerCase();
}

function getCachedEntry(cacheMap, key, allowStale = false) {
  const entry = cacheMap.get(key);
  if (!entry) return null;
  const ageMs = Date.now() - entry.timestamp;
  const isStale = ageMs > CACHE_TTL_MS;
  if (isStale && !allowStale) {
    cacheMap.delete(key);
    return null;
  }
  return { payload: entry.payload, stale: isStale };
}

function findCachedPayload(input, options = {}) {
  if (!input) return null;
  const allowStale = Boolean(options.allowStale);
  const key = normalizeKey(input);
  const inputHit = getCachedEntry(inputCache, key, allowStale);
  if (inputHit) {
    return { payload: inputHit.payload, stale: inputHit.stale, key, source: "input" };
  }
  const categoryHit = getCachedEntry(categoryCache, key, allowStale);
  if (categoryHit) {
    return { payload: categoryHit.payload, stale: categoryHit.stale, key, source: "category" };
  }
  return null;
}

function storeCachedPayload(input, payload) {
  if (!payload || payload.mode !== "results") return;
  const inputKey = normalizeKey(input);
  inputCache.set(inputKey, { payload, timestamp: Date.now() });
  if (payload.category) {
    const categoryKey = normalizeKey(payload.category);
    categoryCache.set(categoryKey, { payload, timestamp: Date.now() });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
