let loggerPromise = null;

async function loadLogger() {
  if (!process.env.BRAINTRUST_API_KEY || !process.env.BRAINTRUST_PROJECT) {
    return null;
  }

  if (!loggerPromise) {
    loggerPromise = (async () => {
      try {
        const braintrust = await import("braintrust");
        if (typeof braintrust.initLogger !== "function") {
          throw new Error("Braintrust initLogger not available");
        }
        return braintrust.initLogger({
          projectName: process.env.BRAINTRUST_PROJECT,
          projectId: process.env.BRAINTRUST_PROJECT_ID,
          apiKey: process.env.BRAINTRUST_API_KEY
        });
      } catch (err) {
        console.warn("Braintrust logger unavailable:", err.message);
        return null;
      }
    })();
  }

  return loggerPromise;
}

export async function createTrace({ input, sessionId }) {
  const logger = await loadLogger();
  const events = [];
  const traceMetadata = {
    session_id: sessionId
  };
  let rootSpan = null;
  let llmSpan = null;
  const childSpans = new Set();

  if (logger && typeof logger.startSpan === "function") {
    rootSpan = logger.startSpan({
      name: "market_map_request",
      type: "task",
      spanAttributes: {
        app: "market-map"
      },
      event: {
        input: { input, session_id: sessionId },
        metadata: traceMetadata
      }
    });
  }

  const startLlmSpan = (data) => {
    if (!rootSpan || typeof rootSpan.startSpan !== "function") return;
    if (llmSpan && typeof llmSpan.end === "function") {
      llmSpan.end();
    }
    llmSpan = rootSpan.startSpan({
      name: "gemini.generate",
      type: "llm",
      spanAttributes: {
        provider: "google",
        model: data?.model || "unknown",
        grounding: Boolean(data?.use_tools)
      },
      event: {
        input: {
          model: data?.model,
          use_tools: Boolean(data?.use_tools),
          prompt_preview: data?.prompt_preview || ""
        }
      }
    });
  };

  const endLlmSpan = (payload) => {
    if (!llmSpan) return;
    const metrics = payload?.status ? { status: payload.status } : undefined;
    if (payload?.error) {
      llmSpan.log({
        error: payload.error,
        metadata: payload?.metadata || {},
        metrics
      });
    } else {
      llmSpan.log({
        output: payload?.output || {},
        metadata: payload?.metadata || {},
        metrics
      });
    }
    llmSpan.end();
    llmSpan = null;
  };

  const startSpan = (config = {}) => {
    if (!rootSpan || typeof rootSpan.startSpan !== "function") return null;
    const span = rootSpan.startSpan({
      name: config.name || "span",
      type: config.type || "task",
      spanAttributes: config.spanAttributes || {},
      event: config.event
    });
    if (span) {
      childSpans.add(span);
      if (typeof span.end === "function") {
        const originalEnd = span.end.bind(span);
        span.end = (...args) => {
          childSpans.delete(span);
          return originalEnd(...args);
        };
      }
    }
    return span;
  };

  return {
    event(step, data) {
      events.push({
        step,
        data,
        ts: new Date().toISOString()
      });

      if (!rootSpan) return;
      switch (step) {
        case "gemini_request":
          startLlmSpan(data);
          break;
        case "gemini_response":
          endLlmSpan({
            status: data?.status,
            output: { status: data?.status },
            metadata: {
              grounded: Boolean(data?.grounding),
              thinking_summary: data?.thinking_summary || ""
            }
          });
          break;
        case "gemini_parse_failed":
          endLlmSpan({
            error: data?.message || "Gemini parse failed"
          });
          break;
        case "gemini_error":
        case "gemini_timeout":
          endLlmSpan({
            status: data?.status,
            error: data?.message || "Gemini error"
          });
          break;
        default:
          break;
      }
    },
    async end(output, renderHtml) {
      if (!logger) return;
      const metadata = {
        ...traceMetadata,
        render_html: renderHtml,
        events
      };
      if (rootSpan) {
        endLlmSpan();
        childSpans.forEach((span) => span?.end?.());
        childSpans.clear();
        rootSpan.log({ output, metadata });
        rootSpan.end();
      } else if (typeof logger.log === "function") {
        await logger.log({
          input: { input, session_id: sessionId },
          output,
          metadata
        });
      }
      if (typeof logger.flush === "function") await logger.flush();
    },
    async error(err, renderHtml) {
      if (!logger) return;
      const metadata = {
        ...traceMetadata,
        render_html: renderHtml,
        events
      };
      if (rootSpan) {
        endLlmSpan();
        childSpans.forEach((span) => span?.end?.());
        childSpans.clear();
        rootSpan.log({ error: err.message, metadata });
        rootSpan.end();
      } else if (typeof logger.log === "function") {
        await logger.log({
          input: { input, session_id: sessionId },
          output: { error: err.message },
          metadata
        });
      }
      if (typeof logger.flush === "function") await logger.flush();
    },
    startSpan
  };
}
