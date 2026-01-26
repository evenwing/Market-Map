import "dotenv/config";
import http from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import {
  analyzeMarket,
  warmGemini,
  planMarket,
  assessPlanChange,
  executeMarketPlan,
  repairCitations
} from "./lib/gemini.js";
import { renderHtml } from "./lib/render.js";
import { createTrace } from "./lib/braintrust.js";
import { withGeminiQueue } from "./lib/queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = process.env.PORT || 3000;
const uiMode = process.env.UI_MODE === "multi" ? "multi" : "single";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MINUTES || 15) * 60 * 1000;
const PLAN_TTL_MS = Number(process.env.PLAN_TTL_MINUTES || 30) * 60 * 1000;
const TRACE_TTL_MS = Number(process.env.TRACE_TTL_MINUTES || 45) * 60 * 1000;
const TRACE_FLUSH_TIMEOUT_MS = Number(process.env.TRACE_FLUSH_TIMEOUT_MS || 3000);
const inputCache = new Map();
const categoryCache = new Map();
const planStore = new Map();
const traceStore = new Map();

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

    if (req.method === "GET" && requestUrl.pathname === "/config.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      res.end(`window.__MM_CONFIG__ = { uiMode: ${JSON.stringify(uiMode)} };`);
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
  const input = requestUrl.searchParams.get("input")?.trim() || "";
  const stage = requestUrl.searchParams.get("stage") || "results";
  const conversationId = requestUrl.searchParams.get("conversation_id") || "";
  const planIdParam = requestUrl.searchParams.get("plan_id") || "";
  const sessionId = conversationId || crypto.randomUUID();
  const traceContext = await getOrCreateTraceContext({ input, sessionId, conversationId });
  const trace = traceContext.trace;
  trace.event("input_received", {
    input,
    streaming: true,
    stage,
    plan_id: planIdParam,
    conversation_id: conversationId || undefined
  });

  const fallback = buildApologyPayload();
  let closed = false;

  req.on("close", () => {
    closed = true;
  });

  startStream(res);

  if (!input && stage !== "execute") {
    sendStreamEvent(res, closed, "status", { message: "No market signal detected." });
    const html = renderHtml(fallback);
    await trace.end(fallback, html);
    if (traceContext.persistent) {
      traceStore.delete(conversationId);
    }
    sendStreamEvent(res, closed, "final", fallback);
    res.end();
    return;
  }

  if (stage === "plan") {
    sendStreamEvent(res, closed, "status", { message: "Drafting analysis plan..." });
    const planSpan = trace.startSpan({
      name: "plan.generate",
      type: "task",
      spanAttributes: { stage: "initial", streaming: true },
      event: {
        input: { input },
        metadata: { stage: "plan", plan_id: planIdParam || "" }
      }
    });
    try {
      const queued = await withGeminiQueue(
        () =>
          planMarket(
            input,
            (step, data) => {
              trace.event(step, data);
              const messages = summarizeEvent(step, data);
              messages.status.forEach((message) =>
                sendStreamEvent(res, closed, "status", { message })
              );
              messages.detail.forEach((message) =>
                sendStreamEvent(res, closed, "detail", { message })
              );
            },
            { useTools: true }
          ),
        {
          onQueue: (position) => {
            trace.event("queue_wait", { position });
            sendStreamEvent(res, closed, "status", {
              message: `Queued for planning (${position})...`
            });
          }
        }
      );

      if (queued.status === "timeout") {
        const errorPayload = {
          ...fallback,
          debug: { message: "Server busy. Please retry." }
        };
        if (traceContext.persistent) {
          traceStore.delete(conversationId);
        }
        const html = renderHtml(errorPayload);
        await trace.end(errorPayload, html);
        sendStreamEvent(res, closed, "debug", { message: errorPayload.debug.message });
        sendStreamEvent(res, closed, "final", errorPayload);
        res.end();
        return;
      }

      const planId = planIdParam || crypto.randomUUID();
      const planPayload = {
        ...queued.value,
        plan_id: planId,
        base_input: input
      };
      storePlan(planId, queued.value, input);
      planSpan?.log?.({
        output: planPayload,
        metadata: { plan_id: planId, stage: "initial" }
      });
      trace.event("plan_payload", {
        plan_id: planId,
        category: planPayload.category,
        ranking_basis: planPayload.ranking_basis
      });
      if (!traceContext.persistent) {
        const html = renderHtml(fallback);
        await trace.end(planPayload, html);
      }
      sendStreamEvent(res, closed, "final", planPayload);
      res.end();
      return;
    } catch (err) {
      const errorPayload = {
        ...fallback,
        debug: {
          message: err.message || "Unknown error"
        }
      };
      if (traceContext.persistent) {
        traceStore.delete(conversationId);
      }
      const html = renderHtml(errorPayload);
      trace.event("error", { message: err.message });
      await trace.error(err, html);
      sendStreamEvent(res, closed, "debug", { message: err.message || "Unknown error" });
      sendStreamEvent(res, closed, "final", errorPayload);
      res.end();
      return;
    } finally {
      planSpan?.end?.();
    }
  }

  if (stage === "execute") {
    const planEntry = getPlan(planIdParam);
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
      sendStreamEvent(res, closed, "final", errorPayload);
      res.end();
      return;
    }

    sendStreamEvent(res, closed, "status", { message: "Reviewing plan updates..." });
    let review = null;
    try {
      const queuedReview = await withGeminiQueue(
        () =>
          assessPlanChange(
            input,
            (step, data) => {
              trace.event(step, data);
            },
            {
              useTools: false,
              context: {
                plan: planEntry.plan,
                baseInput: planEntry.baseInput,
                clarification: input
              }
            }
          ),
        {
          onQueue: (position) => {
            trace.event("queue_wait", { position, stage: "plan_review" });
            sendStreamEvent(res, closed, "status", {
              message: `Queued for plan review (${position})...`
            });
          }
        }
      );

      if (queuedReview.status === "timeout") {
        trace.event("plan_review_timeout", { message: "Queue timeout" });
        sendStreamEvent(res, closed, "detail", {
          message: "Plan review skipped due to queue load."
        });
      } else {
        review = queuedReview.value;
        trace.event("plan_review", review);
      }
    } catch (err) {
      trace.event("plan_review_error", { message: err.message });
      sendStreamEvent(res, closed, "detail", {
        message: "Plan review failed. Proceeding with existing plan."
      });
    }

    if (review?.mode === "replan") {
      sendStreamEvent(res, closed, "status", { message: "Revising plan..." });
      const replanInput = buildReplanInput(planEntry.baseInput, input);
      const planSpan = trace.startSpan({
        name: "plan.generate",
        type: "task",
        spanAttributes: { stage: "replan", streaming: true },
        event: {
          input: { input: replanInput },
          metadata: { stage: "replan", plan_id: planIdParam || "" }
        }
      });
      try {
        const queuedPlan = await withGeminiQueue(
          () =>
            planMarket(
              replanInput,
              (step, data) => {
                trace.event(step, data);
                const messages = summarizeEvent(step, data);
                messages.status.forEach((message) =>
                  sendStreamEvent(res, closed, "status", { message })
                );
                messages.detail.forEach((message) =>
                  sendStreamEvent(res, closed, "detail", { message })
                );
              },
              { useTools: true }
            ),
          {
            onQueue: (position) => {
              trace.event("queue_wait", { position, stage: "replan" });
              sendStreamEvent(res, closed, "status", {
                message: `Queued for replanning (${position})...`
              });
            }
          }
        );

        if (queuedPlan.status === "timeout") {
          const errorPayload = {
            ...fallback,
            debug: { message: "Server busy. Please retry." }
          };
          const html = renderHtml(errorPayload);
          await trace.end(errorPayload, html);
          if (traceContext.persistent) {
            traceStore.delete(conversationId);
          }
          sendStreamEvent(res, closed, "debug", { message: errorPayload.debug.message });
          sendStreamEvent(res, closed, "final", errorPayload);
          res.end();
          return;
        }

        const planId = planIdParam || crypto.randomUUID();
        const planPayload = {
          ...queuedPlan.value,
          plan_id: planId,
          base_input: replanInput
        };
        storePlan(planId, queuedPlan.value, replanInput);
        planSpan?.log?.({
          output: planPayload,
          metadata: { plan_id: planId, stage: "replan", reason: review?.reason || "" }
        });
        trace.event("plan_payload", {
          plan_id: planId,
          category: planPayload.category,
          ranking_basis: planPayload.ranking_basis
        });
        if (!traceContext.persistent) {
          const html = renderHtml(fallback);
          await trace.end(planPayload, html);
        }
        sendStreamEvent(res, closed, "final", planPayload);
        res.end();
        return;
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
        if (traceContext.persistent) {
          traceStore.delete(conversationId);
        }
        sendStreamEvent(res, closed, "debug", { message: err.message || "Unknown error" });
        sendStreamEvent(res, closed, "final", errorPayload);
        res.end();
        return;
      } finally {
        planSpan?.end?.();
      }
    }

    sendStreamEvent(res, closed, "status", { message: "Executing plan..." });
    try {
      const queued = await withGeminiQueue(
        () =>
          executeMarketPlan(
            input,
            (step, data) => {
              trace.event(step, data);
              const messages = summarizeEvent(step, data);
              messages.status.forEach((message) =>
                sendStreamEvent(res, closed, "status", { message })
              );
              messages.detail.forEach((message) =>
                sendStreamEvent(res, closed, "detail", { message })
              );
            },
            {
              useTools: true,
              context: {
                plan: planEntry.plan,
                baseInput: planEntry.baseInput,
                clarification: input
              }
            }
          ),
        {
          onQueue: (position) => {
            trace.event("queue_wait", { position });
            sendStreamEvent(res, closed, "status", {
              message: `Queued for execution (${position})...`
            });
          }
        }
      );

      if (queued.status === "timeout") {
        const errorPayload = {
          ...fallback,
          debug: { message: "Server busy. Please retry." }
        };
        const html = renderHtml(errorPayload);
        await trace.end(errorPayload, html);
        if (traceContext.persistent) {
          traceStore.delete(conversationId);
        }
        sendStreamEvent(res, closed, "debug", { message: errorPayload.debug.message });
        sendStreamEvent(res, closed, "final", errorPayload);
        res.end();
        return;
      }

      let result = queued.value;
      sendStreamEvent(res, closed, "status", { message: "Checking citations..." });
      result = await verifyAndRepairCitations(result, {
        trace,
        res,
        closed
      });

      if (planIdParam) {
        planStore.delete(planIdParam);
      }

      const html = renderHtml(result);
      if (traceContext.persistent) {
        traceStore.delete(conversationId);
      }
      sendStreamEvent(res, closed, "final", result);
      await finalizeTrace(trace, result, html);
      res.end();
      return;
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
      if (traceContext.persistent) {
        traceStore.delete(conversationId);
      }
      sendStreamEvent(res, closed, "debug", { message: err.message || "Unknown error" });
      sendStreamEvent(res, closed, "final", errorPayload);
      res.end();
      return;
    }
  }

  const cached = findCachedPayload(input);

  if (cached) {
    trace.event("cache_hit", { key: cached.key, source: cached.source });
    sendStreamEvent(res, closed, "status", { message: "Cache hit. Returning cached results." });
    const html = renderHtml(cached.payload);
    sendStreamEvent(res, closed, "final", cached.payload);
    await finalizeTrace(trace, cached.payload, html);
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
        sendStreamEvent(res, closed, "final", stale.payload);
        await finalizeTrace(trace, stale.payload, html);
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
    storeCachedPayload(input, result);
    sendStreamEvent(res, closed, "final", result);
    await finalizeTrace(trace, result, html);
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
    if (traceContext.persistent) {
      traceStore.delete(conversationId);
    }
    sendStreamEvent(res, closed, "debug", { message: err.message || "Unknown error" });
    sendStreamEvent(res, closed, "final", errorPayload);
    res.end();
  }
}

async function handleAnalyze(req, res) {
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
    res.writeHead(200, { "Content-Type": "application/json" });
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
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(errorPayload));
          return;
        }

        const derivedPlanId = planId || crypto.randomUUID();
      const planPayload = {
        ...queued.value,
        plan_id: derivedPlanId,
        base_input: input
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
        res.writeHead(200, { "Content-Type": "application/json" });
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
        res.writeHead(200, { "Content-Type": "application/json" });
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
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(errorPayload));
            return;
          }

          const updatedPlanId = planId || crypto.randomUUID();
          const planPayload = {
            ...queuedPlan.value,
            plan_id: updatedPlanId,
            base_input: replanInput
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
          res.writeHead(200, { "Content-Type": "application/json" });
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(errorPayload));
        return;
      }

      let result = queued.value;
      result = await verifyAndRepairCitations(result, { trace });
      if (planId) {
        planStore.delete(planId);
      }
      const html = renderHtml(result);
      if (traceContext.persistent) {
        traceStore.delete(conversationId);
      }
      await finalizeTrace(trace, result, html);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    const cached = findCachedPayload(input);
    if (cached) {
      trace.event("cache_hit", { key: cached.key, source: cached.source });
      const html = renderHtml(cached.payload);
      await finalizeTrace(trace, cached.payload, html);
      res.writeHead(200, { "Content-Type": "application/json" });
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
        await finalizeTrace(trace, stale.payload, html);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stale.payload));
        return;
      }
      const errorPayload = { ...fallback, debug: { message: "Server busy. Please retry." } };
      const html = renderHtml(errorPayload);
      await trace.end(errorPayload, html);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorPayload));
      return;
    }

    const result = queued.value;
    const html = renderHtml(result);
    storeCachedPayload(input, result);
    await finalizeTrace(trace, result, html);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const errorPayload = { ...fallback, debug: { message: err.message || "Unknown error" } };
    const html = renderHtml(errorPayload);
    trace.event("error", { message: err.message });
    await trace.error(err, html);
    if (traceContext.persistent) {
      traceStore.delete(conversationId);
    }
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

async function verifyAndRepairCitations(payload, context = {}) {
  if (!payload || payload.mode !== "results") return payload;
  const items = collectCitationItems(payload);
  if (!items.length) return payload;

  const { res, closed, trace } = context;
  const sendDetail = (message) => {
    if (res) {
      sendStreamEvent(res, closed, "detail", { message });
    }
  };
  const sendStatus = (message) => {
    if (res) {
      sendStreamEvent(res, closed, "status", { message });
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
        `Replaced citation for ${group.companyName}: ${formatUrl(badUrl)} → ${formatUrl(
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

async function logCitationPages(payload, trace) {
  if (!payload || payload.mode !== "results") return;
  const pages = await fetchCitationPages(payload, { perCompany: 2 });
  if (!pages.length) return;
  if (trace?.addMetadata) {
    trace.addMetadata({ citation_pages: pages });
  }
}

async function finalizeTrace(trace, payload, html) {
  if (!trace || typeof trace.end !== "function") return;
  try {
    await withTimeout(trace.end(payload, html), TRACE_FLUSH_TIMEOUT_MS);
  } catch (err) {
    // Swallow errors to avoid crashing the request.
  }
}

function withTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  const guarded = Promise.resolve(promise).catch(() => null);
  return Promise.race([
    guarded,
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function fetchCitationPages(payload, options = {}) {
  const perCompany = Number(options.perCompany || 2);
  const companies = Array.isArray(payload?.companies) ? payload.companies : [];
  const requests = [];

  companies.forEach((company) => {
    const citations = collectCompanyCitations(company, perCompany);
    citations.forEach((citation) => {
      requests.push(
        fetchPageExcerpt(citation.url).then((result) => ({
          company: citation.company,
          name: citation.name,
          url: citation.url,
          type: citation.type,
          status: result.status,
          excerpt: result.excerpt,
          error: result.error
        }))
      );
    });
  });

  if (!requests.length) return [];
  const settled = await Promise.allSettled(requests);
  return settled
    .map((entry) => (entry.status === "fulfilled" ? entry.value : null))
    .filter(Boolean);
}

function collectCompanyCitations(company, perCompany) {
  const companyName = safeString(company?.name) || "Company";
  const seen = new Set();
  const citations = [];

  const addCitation = (url, name, type) => {
    if (citations.length >= perCompany) return;
    const normalized = normalizeCitationUrl(url);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    citations.push({
      company: companyName,
      name: safeString(name) || "Source",
      url: normalized,
      type
    });
  };

  const sources = Array.isArray(company?.sources) ? company.sources : [];
  sources.forEach((source) => addCitation(source.url, source.name, "source"));

  const metrics = Array.isArray(company?.metrics) ? company.metrics : [];
  metrics.forEach((metric) =>
    addCitation(metric.source_url, metric.source_name || metric.label, "metric")
  );

  return citations;
}

function normalizeCitationUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch (err) {
    return "";
  }
}

function safeString(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

async function fetchPageExcerpt(url) {
  if (!url) return { status: 0, excerpt: "", error: "missing_url" };
  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, 8000);
    const raw = await response.text();
    const extracted = extractReadableText(raw);
    const excerpt = extracted.slice(0, 1000).replace(/<[^>]*$/, "").trim();
    return { status: response.status, excerpt, error: null };
  } catch (err) {
    return { status: 0, excerpt: "", error: err.message || "fetch_failed" };
  }
}

function extractReadableText(html) {
  if (!html) return "";
  let cleaned = String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, " ");

  const mainMatch = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  let candidate = cleaned;
  if (mainMatch?.[1]) {
    candidate = mainMatch[1];
  } else if (articleMatch?.[1]) {
    candidate = articleMatch[1];
  }

  candidate = candidate.replace(/<(header|nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");

  return candidate
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
        url: source.url
      });
    });
  });
  return items;
}

async function checkCitations(items, context = {}) {
  const { sendDetail, trace } = context;
  const urlMap = new Map();
  items.forEach((item) => {
    if (!item.url) return;
    if (!urlMap.has(item.url)) urlMap.set(item.url, []);
    urlMap.get(item.url).push(item);
  });

  const invalidItems = [];
  for (const [url, grouped] of urlMap.entries()) {
    const check = await checkUrl(url);
    trace?.event("citation_check", { url, ok: check.ok, status: check.status });
    if (check.error) {
      sendDetail?.(`Citation check unavailable: ${formatUrl(url)}`);
      continue;
    }
    if (check.ok) {
      sendDetail?.(`Citation OK: ${formatUrl(url)}`);
    } else {
      sendDetail?.(`Citation 404: ${formatUrl(url)}`);
      invalidItems.push(...grouped);
    }
  }

  return { invalidItems };
}

function groupInvalidByCompany(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = item.companyIndex;
    if (!map.has(key)) {
      map.set(key, { companyIndex: key, companyName: item.companyName, items: [] });
    }
    map.get(key).items.push(item);
  });
  return Array.from(map.values());
}

function applyReplacement(payload, item, newSource) {
  const company = payload?.companies?.[item.companyIndex];
  if (!company) return;
  const safeNewSource = {
    name: newSource.name || "Source",
    url: newSource.url
  };

  if (item.type === "metric") {
    const metric = company.metrics?.[item.metricIndex];
    if (metric) {
      metric.source_url = safeNewSource.url;
      metric.source_name = safeNewSource.name;
    }
  }

  if (item.type === "source") {
    const source = company.sources?.[item.sourceIndex];
    if (source) {
      source.url = safeNewSource.url;
      source.name = safeNewSource.name;
    }
  }

  if (Array.isArray(company.sources)) {
    const existing = company.sources.find((src) => src.url === safeNewSource.url);
    if (!existing) {
      company.sources.push({ ...safeNewSource });
    }
    company.sources = company.sources.filter((src) => src.url);
  }
}

function removeInvalidCitation(payload, item) {
  const company = payload?.companies?.[item.companyIndex];
  if (!company) return;
  if (item.type === "metric") {
    const metric = company.metrics?.[item.metricIndex];
    if (metric) {
      metric.source_url = "";
      metric.source_name = "";
    }
    return;
  }
  if (item.type === "source" && Array.isArray(company.sources)) {
    company.sources = company.sources.filter((source, index) => index !== item.sourceIndex);
  }
}

async function checkUrl(url) {
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

function storePlan(planId, plan, baseInput) {
  if (!planId || !plan) return;
  planStore.set(planId, { plan, baseInput, timestamp: Date.now() });
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

function buildReplanInput(baseInput, clarification) {
  const base = (baseInput || "").trim();
  const detail = (clarification || "").trim();
  if (!detail) return base;
  if (!base) return detail;
  return `${base}\nClarification: ${detail}`;
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
