import "dotenv/config";
import crypto from "crypto";

import { analyzeMarket } from "../lib/gemini.js";
import { renderHtml } from "../lib/render.js";
import { createTrace } from "../lib/braintrust.js";

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MINUTES || 15) * 60 * 1000;
const inputCache = new Map();
const categoryCache = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

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
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(fallback));
    return;
  }

  if (cached) {
    trace.event("cache_hit", { key: cached.key, source: cached.source });
    const html = renderHtml(cached.payload);
    await trace.end(cached.payload, html);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(cached.payload));
    return;
  }

  try {
    const result = await analyzeMarket(input, (step, data) => trace.event(step, data));
    const html = renderHtml(result);
    await trace.end(result, html);
    storeCachedPayload(input, result);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
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

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(errorPayload));
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

function normalizeKey(value) {
  return value.trim().toLowerCase();
}

function getCachedEntry(cacheMap, key) {
  const entry = cacheMap.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cacheMap.delete(key);
    return null;
  }
  return entry.payload;
}

function findCachedPayload(input) {
  if (!input) return null;
  const key = normalizeKey(input);
  const inputHit = getCachedEntry(inputCache, key);
  if (inputHit) {
    return { payload: inputHit, key, source: "input" };
  }
  const categoryHit = getCachedEntry(categoryCache, key);
  if (categoryHit) {
    return { payload: categoryHit, key, source: "category" };
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
