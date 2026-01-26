import "dotenv/config";
import crypto from "crypto";

import {
  analyzeMarket,
  planMarket,
  assessPlanChange,
  executeMarketPlan,
  repairCitations
} from "../lib/gemini.js";
import { renderHtml } from "../lib/render.js";
import { createTrace } from "../lib/braintrust.js";
import { withGeminiQueue } from "../lib/queue.js";

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MINUTES || 15) * 60 * 1000;
const PLAN_TTL_MS = Number(process.env.PLAN_TTL_MINUTES || 30) * 60 * 1000;
const TRACE_TTL_MS = Number(process.env.TRACE_TTL_MINUTES || 45) * 60 * 1000;
const inputCache = new Map();
const categoryCache = new Map();
const planStore = new Map();
const traceStore = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const body = await readBody(req);
  let input = "";
  let stage = "results";
  let planId = "";
  let conversationId = "";

  try {
    const parsed = JSON.parse(body || "{}");
    input = typeof parsed.input === "string" ? parsed.input.trim() : "";
    stage = typeof parsed.stage === "string" ? parsed.stage : "results";
    planId = typeof parsed.plan_id === "string" ? parsed.plan_id : "";
    conversationId = typeof parsed.conversation_id === "string" ? parsed.conversation_id : "";
  } catch (err) {
    input = "";
  }

  const sessionId = conversationId || crypto.randomUUID();
  const traceContext = await getOrCreateTraceContext({ input, sessionId, conversationId });
  const trace = traceContext.trace;
  trace.event("input_received", {
    input,
    stage,
    plan_id: planId,
    conversation_id: conversationId || undefined
  });

  const fallback = buildApologyPayload();

  if (!input && stage !== "execute") {
    const html = renderHtml(fallback);
    await trace.end(fallback, html);
    if (traceContext.persistent) {
      traceStore.delete(conversationId);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(fallback));
    return;
  }

  try {
    if (stage === "plan") {
      const planSpan = trace.startSpan({
        name: "plan.generate",
        type: "task",
        spanAttributes: { stage: "initial", streaming: false },
        event: {
          input: { input },
          metadata: { stage: "plan", plan_id: planId || "" }
        }
      });
      try {
        const queued = await withGeminiQueue(
          () =>
            planMarket(input, (step, data) => trace.event(step, data), {
              useTools: true
            }),
          {
            onQueue: (position) => trace.event("queue_wait", { position })
          }
        );

        if (queued.status === "timeout") {
          const errorPayload = { ...fallback, debug: { message: "Server busy. Please retry." } };
          if (traceContext.persistent) {
            traceStore.delete(conversationId);
          }
          const html = renderHtml(errorPayload);
          await trace.end(errorPayload, html);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(errorPayload));
          return;
        }

        const derivedPlanId = planId || crypto.randomUUID();
        const planPayload = {
          ...queued.value,
          plan_id: derivedPlanId
        };
        storePlan(derivedPlanId, queued.value, input);
        planSpan?.log?.({
          output: planPayload,
          metadata: { plan_id: derivedPlanId, stage: "initial" }
        });
        trace.event("plan_payload", {
          plan_id: derivedPlanId,
          category: planPayload.category,
          ranking_basis: planPayload.ranking_basis
        });
        if (!traceContext.persistent) {
          const html = renderHtml(fallback);
          await trace.end(planPayload, html);
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(planPayload));
        return;
      } finally {
        planSpan?.end?.();
      }
    }

    if (stage === "execute") {
      const planEntry = getPlan(planId);
      if (!planEntry) {
        const errorPayload = {
          ...fallback,
          debug: { message: "Plan expired. Please submit a new query." }
        };
        const html = renderHtml(errorPayload);
        await trace.end(errorPayload, html);
        if (traceContext.persistent) {
          traceStore.delete(conversationId);
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(errorPayload));
        return;
      }

      let review = null;
      try {
        const queuedReview = await withGeminiQueue(
          () =>
            assessPlanChange(input, (step, data) => trace.event(step, data), {
              useTools: false,
              context: {
                plan: planEntry.plan,
                baseInput: planEntry.baseInput,
                clarification: input
              }
            }),
          {
            onQueue: (position) => trace.event("queue_wait", { position, stage: "plan_review" })
          }
        );

        if (queuedReview.status === "timeout") {
          trace.event("plan_review_timeout", { message: "Queue timeout" });
        } else {
          review = queuedReview.value;
          trace.event("plan_review", review);
        }
      } catch (err) {
        trace.event("plan_review_error", { message: err.message });
      }

      if (review?.mode === "replan") {
        const replanInput = buildReplanInput(planEntry.baseInput, input);
        const planSpan = trace.startSpan({
          name: "plan.generate",
          type: "task",
          spanAttributes: { stage: "replan", streaming: false },
          event: {
            input: { input: replanInput },
            metadata: { stage: "replan", plan_id: planId || "" }
          }
        });
        try {
          const queuedPlan = await withGeminiQueue(
            () =>
              planMarket(replanInput, (step, data) => trace.event(step, data), { useTools: true }),
            {
              onQueue: (position) => trace.event("queue_wait", { position, stage: "replan" })
            }
          );

          if (queuedPlan.status === "timeout") {
            const errorPayload = { ...fallback, debug: { message: "Server busy. Please retry." } };
            if (traceContext.persistent) {
              traceStore.delete(conversationId);
            }
            const html = renderHtml(errorPayload);
            await trace.end(errorPayload, html);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(errorPayload));
            return;
          }

          const updatedPlanId = planId || crypto.randomUUID();
          const planPayload = {
            ...queuedPlan.value,
            plan_id: updatedPlanId
          };
          storePlan(updatedPlanId, queuedPlan.value, replanInput);
          planSpan?.log?.({
            output: planPayload,
            metadata: { plan_id: updatedPlanId, stage: "replan", reason: review?.reason || "" }
          });
          trace.event("plan_payload", {
            plan_id: updatedPlanId,
            category: planPayload.category,
            ranking_basis: planPayload.ranking_basis
          });
          if (!traceContext.persistent) {
            const html = renderHtml(fallback);
            await trace.end(planPayload, html);
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(planPayload));
          return;
        } finally {
          planSpan?.end?.();
        }
      }

      const queued = await withGeminiQueue(
        () =>
          executeMarketPlan(input, (step, data) => trace.event(step, data), {
            useTools: true,
            context: {
              plan: planEntry.plan,
              baseInput: planEntry.baseInput,
              clarification: input
            }
          }),
        {
          onQueue: (position) => trace.event("queue_wait", { position })
        }
      );

      if (queued.status === "timeout") {
        const errorPayload = { ...fallback, debug: { message: "Server busy. Please retry." } };
        const html = renderHtml(errorPayload);
        await trace.end(errorPayload, html);
        if (traceContext.persistent) {
          traceStore.delete(conversationId);
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(errorPayload));
        return;
      }

      let result = queued.value;
      result = await verifyAndRepairCitations(result, { trace });
      if (planId) {
        planStore.delete(planId);
      }
      const html = renderHtml(result);
      await trace.end(result, html);
      if (traceContext.persistent) {
        traceStore.delete(conversationId);
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }

    const cached = findCachedPayload(input);
    if (cached) {
      trace.event("cache_hit", { key: cached.key, source: cached.source });
      const html = renderHtml(cached.payload);
      await trace.end(cached.payload, html);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(cached.payload));
      return;
    }

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
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(stale.payload));
        return;
      }
      const errorPayload = { ...fallback, debug: { message: "Server busy. Please retry." } };
      const html = renderHtml(errorPayload);
      await trace.end(errorPayload, html);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(errorPayload));
      return;
    }

    const result = queued.value;
    const html = renderHtml(result);
    await trace.end(result, html);
    storeCachedPayload(input, result);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (err) {
    const errorPayload = { ...fallback, debug: { message: err.message || "Unknown error" } };
    const html = renderHtml(errorPayload);
    trace.event("error", { message: err.message });
    await trace.error(err, html);
    if (traceContext.persistent) {
      traceStore.delete(conversationId);
    }
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

function storePlan(planId, plan, baseInput) {
  if (!planId || !plan) return;
  planStore.set(planId, { plan, baseInput, timestamp: Date.now() });
}

function getPlan(planId) {
  if (!planId) return null;
  const entry = planStore.get(planId);
  if (!entry) return null;
  const ageMs = Date.now() - entry.timestamp;
  if (ageMs > PLAN_TTL_MS) {
    planStore.delete(planId);
    return null;
  }
  return entry;
}

function buildReplanInput(baseInput, clarification) {
  const base = (baseInput || "").trim();
  const detail = (clarification || "").trim();
  if (!detail) return base;
  if (!base) return detail;
  return `${base}\nClarification: ${detail}`;
}

function getStoredTrace(conversationId) {
  if (!conversationId) return null;
  const entry = traceStore.get(conversationId);
  if (!entry) return null;
  const ageMs = Date.now() - entry.timestamp;
  if (ageMs > TRACE_TTL_MS) {
    traceStore.delete(conversationId);
    return null;
  }
  entry.timestamp = Date.now();
  return entry.trace;
}

async function getOrCreateTraceContext({ input, sessionId, conversationId }) {
  if (!conversationId) {
    return {
      trace: await createTrace({ input, sessionId }),
      persistent: false
    };
  }
  const existing = getStoredTrace(conversationId);
  if (existing) {
    return { trace: existing, persistent: true };
  }
  const trace = await createTrace({ input, sessionId: conversationId });
  traceStore.set(conversationId, { trace, timestamp: Date.now() });
  return { trace, persistent: true };
}

async function verifyAndRepairCitations(payload, context = {}) {
  if (!payload || payload.mode !== "results") return payload;
  const items = collectCitationItems(payload);
  if (!items.length) return payload;

  const { trace, onStatus, onDetail } = context;
  const sendDetail = (message) => {
    if (typeof onDetail === "function") {
      onDetail(message);
    }
  };
  const sendStatus = (message) => {
    if (typeof onStatus === "function") {
      onStatus(message);
    }
  };

  sendStatus("Verifying citations...");
  const { invalidItems } = await checkCitations(items, { sendDetail, trace });
  if (!invalidItems.length) {
    sendDetail("Citations look good.");
    return payload;
  }

  const replacedUrls = new Set();
  const grouped = groupInvalidByCompany(invalidItems);
  for (const group of grouped) {
    sendStatus(`Repairing citations for ${group.companyName}...`);
    trace?.event("citation_repair_start", {
      company: group.companyName,
      count: group.items.length
    });

    let repair = null;
    try {
      repair = await repairCitations(
        "repair citations",
        (step, data) => {
          trace?.event(step, data);
        },
        {
          useTools: true,
          context: {
            category: payload.category,
            company: group.companyName,
            items: group.items.map((item) => ({
              type: item.type,
              label: item.label,
              url: item.url
            }))
          }
        }
      );
    } catch (err) {
      trace?.event("citation_repair_error", { message: err.message });
      sendDetail(`Citation repair failed for ${group.companyName}.`);
      continue;
    }

    const replacements = Array.isArray(repair?.replacements) ? repair.replacements : [];
    if (!replacements.length) {
      sendDetail(`No replacement citations found for ${group.companyName}.`);
      continue;
    }

    for (const replacement of replacements) {
      const badUrl = replacement.bad_url;
      const newSource = replacement.source || {};
      if (!badUrl || !newSource.url) continue;
      const check = await checkUrl(newSource.url);
      if (!check.ok) {
        sendDetail(`Replacement failed (${formatUrl(newSource.url)}).`);
        continue;
      }
      const affected = group.items.filter((item) => item.url === badUrl);
      if (!affected.length) continue;
      affected.forEach((item) => applyReplacement(payload, item, newSource));
      replacedUrls.add(badUrl);
      sendDetail(
        `Replaced citation for ${group.companyName}: ${formatUrl(badUrl)} -> ${formatUrl(
          newSource.url
        )}`
      );
    }
  }

  invalidItems.forEach((item) => {
    if (replacedUrls.has(item.url)) return;
    removeInvalidCitation(payload, item);
    sendDetail(`Removed invalid citation for ${item.companyName}: ${formatUrl(item.url)}`);
  });

  return payload;
}

function collectCitationItems(payload) {
  const items = [];
  const companies = Array.isArray(payload?.companies) ? payload.companies : [];
  companies.forEach((company, companyIndex) => {
    const companyName = company?.name || `Company ${companyIndex + 1}`;
    const metrics = Array.isArray(company?.metrics) ? company.metrics : [];
    metrics.forEach((metric, metricIndex) => {
      if (!metric?.source_url) return;
      items.push({
        type: "metric",
        companyIndex,
        metricIndex,
        companyName,
        label: metric.label || "Metric",
        url: metric.source_url,
        sourceName: metric.source_name || "Source"
      });
    });
    const sources = Array.isArray(company?.sources) ? company.sources : [];
    sources.forEach((source, sourceIndex) => {
      if (!source?.url) return;
      items.push({
        type: "source",
        companyIndex,
        sourceIndex,
        companyName,
        label: source.name || "Source",
        url: source.url,
        sourceName: source.name || "Source"
      });
    });
  });
  return items;
}

function groupInvalidByCompany(items) {
  const grouped = new Map();
  items.forEach((item) => {
    const key = item.companyName || "Company";
    if (!grouped.has(key)) {
      grouped.set(key, { companyName: key, items: [] });
    }
    grouped.get(key).items.push(item);
  });
  return Array.from(grouped.values());
}

async function checkCitations(items, context = {}) {
  const invalidItems = [];
  for (const item of items) {
    const check = await checkUrl(item.url);
    context.trace?.event("citation_check", { url: item.url, ...check });
    if (!check.ok) {
      if (check.status === 404) {
        invalidItems.push(item);
        if (context.sendDetail) {
          context.sendDetail(`Broken link (${formatUrl(item.url)}).`);
        }
      } else if (context.sendDetail) {
        context.sendDetail(`Citation check unavailable (${formatUrl(item.url)}).`);
      }
    }
  }
  return { invalidItems };
}

function applyReplacement(payload, item, newSource) {
  const companies = Array.isArray(payload?.companies) ? payload.companies : [];
  const company = companies[item.companyIndex];
  if (!company) return;

  if (item.type === "metric") {
    const metrics = Array.isArray(company.metrics) ? company.metrics : [];
    const metric = metrics[item.metricIndex];
    if (!metric) return;
    metric.source_name = newSource.name || metric.source_name;
    metric.source_url = newSource.url || metric.source_url;
  }

  if (item.type === "source") {
    const sources = Array.isArray(company.sources) ? company.sources : [];
    const source = sources[item.sourceIndex];
    if (!source) return;
    source.name = newSource.name || source.name;
    source.url = newSource.url || source.url;
  }
}

function removeInvalidCitation(payload, item) {
  const companies = Array.isArray(payload?.companies) ? payload.companies : [];
  const company = companies[item.companyIndex];
  if (!company) return;

  if (item.type === "metric") {
    const metrics = Array.isArray(company.metrics) ? company.metrics : [];
    const metric = metrics[item.metricIndex];
    if (!metric) return;
    metric.source_url = "";
    metric.source_name = metric.source_name || "Source";
  }

  if (item.type === "source") {
    const sources = Array.isArray(company.sources) ? company.sources : [];
    sources.splice(item.sourceIndex, 1);
  }
}

async function checkUrl(url) {
  if (!url) return { ok: false, status: 0 };
  try {
    const head = await fetchWithTimeout(url, { method: "HEAD" }, 8000);
    if (head.status === 405 || head.status === 403) {
      const getRes = await fetchWithTimeout(url, { method: "GET" }, 8000);
      if (getRes.status === 404) return { ok: false, status: 404 };
      return { ok: true, status: getRes.status };
    }
    if (head.status === 404) return { ok: false, status: 404 };
    return { ok: true, status: head.status };
  } catch (err) {
    return { ok: true, status: 0, error: true };
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch (err) {
    return url;
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
