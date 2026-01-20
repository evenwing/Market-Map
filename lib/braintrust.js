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

  return {
    event(step, data) {
      events.push({
        step,
        data,
        ts: new Date().toISOString()
      });
    },
    async end(output, renderHtml) {
      if (!logger || typeof logger.log !== "function") return;
      await logger.log({
        input: { input, session_id: sessionId },
        output,
        metadata: {
          session_id: sessionId,
          render_html: renderHtml,
          events
        }
      });
      if (typeof logger.flush === "function") {
        await logger.flush();
      }
    },
    async error(err, renderHtml) {
      if (!logger || typeof logger.log !== "function") return;
      await logger.log({
        input: { input, session_id: sessionId },
        output: { error: err.message },
        metadata: {
          session_id: sessionId,
          render_html: renderHtml,
          events
        }
      });
      if (typeof logger.flush === "function") {
        await logger.flush();
      }
    }
  };
}
