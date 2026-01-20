import "dotenv/config";
import crypto from "crypto";

import { analyzeMarket } from "../../lib/gemini.js";
import { renderHtml } from "../../lib/render.js";
import { createTrace } from "../../lib/braintrust.js";
import { withGeminiQueue } from "../../lib/queue.js";

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MINUTES || 15) * 60 * 1000;
const inputCache = new Map();
const categoryCache = new Map();

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const input = requestUrl.searchParams.get("input")?.trim() || "";
  const sessionId = crypto.randomUUID();
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
      () => analyzeMarket(input, (step, data) => trace.event(step, data)),
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
