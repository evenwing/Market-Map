import http from "http";
import https from "https";

const DEFAULT_MODEL = "gemini-3-flash-preview";
const MAX_ATTEMPTS = 1;
const THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET || 1024);
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 25000);
const TOTAL_TIMEOUT_MS = Number(process.env.GEMINI_TOTAL_TIMEOUT_MS || 55000);
const REQUEST_MIN_TIMEOUT_MS = 2000;
const SAFETY_MARGIN_MS = 1500;
const OVERLOAD_MAX_RETRIES = 0;
const OVERLOAD_BASE_DELAY_MS = 500;
const OVERLOAD_MAX_DELAY_MS = 6000;
const MODEL_FALLBACK_ORDER = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedModels = null;
let cachedModelsAt = 0;

export async function analyzeMarket(input, recordEvent, options = {}) {
  const preferredModel = sanitizeModelName(process.env.GEMINI_MODEL || DEFAULT_MODEL);
  const useTools =
    typeof options.useTools === "boolean" ? options.useTools : shouldUseGrounding(input);
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  return await analyzeWithRetry(input, recordEvent, 1, "", {
    model: preferredModel,
    triedFallback: false,
    triedNoTools: false,
    useTools,
    transientAttempt: 0,
    triedOverloadFallback: false,
    deadline,
    maxAttempts: options.maxAttempts
  });
}

export async function planMarket(input, recordEvent, options = {}) {
  const preferredModel = sanitizeModelName(process.env.GEMINI_MODEL || DEFAULT_MODEL);
  const useTools = typeof options.useTools === "boolean" ? options.useTools : true;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  return await analyzeWithRetry(input, recordEvent, 1, "", {
    model: preferredModel,
    triedFallback: false,
    triedNoTools: false,
    useTools,
    transientAttempt: 0,
    triedOverloadFallback: false,
    deadline,
    maxAttempts: options.maxAttempts || 2,
    promptBuilder: buildPlanPrompt,
    normalizeFn: normalizePlanOutput,
    validateFn: validatePlanOutput,
    context: options.context || {}
  });
}

export async function assessPlanChange(input, recordEvent, options = {}) {
  const preferredModel = sanitizeModelName(process.env.GEMINI_MODEL || DEFAULT_MODEL);
  const useTools = typeof options.useTools === "boolean" ? options.useTools : false;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  return await analyzeWithRetry(input || "plan change check", recordEvent, 1, "", {
    model: preferredModel,
    triedFallback: false,
    triedNoTools: false,
    useTools,
    transientAttempt: 0,
    triedOverloadFallback: false,
    deadline,
    maxAttempts: options.maxAttempts,
    promptBuilder: buildPlanChangePrompt,
    normalizeFn: normalizePlanChangeOutput,
    validateFn: validatePlanChangeOutput,
    context: options.context || {}
  });
}

export async function executeMarketPlan(input, recordEvent, options = {}) {
  const preferredModel = sanitizeModelName(process.env.GEMINI_MODEL || DEFAULT_MODEL);
  const useTools = typeof options.useTools === "boolean" ? options.useTools : true;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  return await analyzeWithRetry(input, recordEvent, 1, "", {
    model: preferredModel,
    triedFallback: false,
    triedNoTools: false,
    useTools,
    transientAttempt: 0,
    triedOverloadFallback: false,
    deadline,
    maxAttempts: options.maxAttempts || 2,
    promptBuilder: buildPlanExecutionPrompt,
    context: options.context || {}
  });
}

export async function repairCitations(input, recordEvent, options = {}) {
  const preferredModel = sanitizeModelName(process.env.GEMINI_MODEL || DEFAULT_MODEL);
  const useTools = typeof options.useTools === "boolean" ? options.useTools : true;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  return await analyzeWithRetry(input || "repair citations", recordEvent, 1, "", {
    model: preferredModel,
    triedFallback: false,
    triedNoTools: false,
    useTools,
    transientAttempt: 0,
    triedOverloadFallback: false,
    deadline,
    maxAttempts: options.maxAttempts,
    promptBuilder: buildCitationRepairPrompt,
    normalizeFn: normalizeRepairOutput,
    validateFn: validateRepairOutput,
    context: options.context || {}
  });
}

export async function warmGemini(recordEvent) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  const preferredModel = sanitizeModelName(process.env.GEMINI_MODEL || DEFAULT_MODEL);
  const model = await pickPreferredModel(apiKey, preferredModel, recordEvent);

  try {
    await warmModel(apiKey, model);
    recordEvent?.("gemini_warmup", { model });
  } catch (err) {
    recordEvent?.("gemini_warmup_error", { message: err.message });
  }
}

async function analyzeWithRetry(input, recordEvent, attempt, lastError, options) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const model = sanitizeModelName(options?.model || DEFAULT_MODEL);
  const triedFallback = options?.triedFallback || false;
  const triedNoTools = options?.triedNoTools || false;
  const useTools = options?.useTools ?? false;
  const transientAttempt = options?.transientAttempt || 0;
  const triedOverloadFallback = options?.triedOverloadFallback || false;
  const deadline = options?.deadline || 0;
  const maxAttempts = options?.maxAttempts || MAX_ATTEMPTS;
  const promptBuilder = options?.promptBuilder || buildPrompt;
  const normalizeFn = options?.normalizeFn || normalizeOutput;
  const validateFn = options?.validateFn || validateOutput;
  const baseOptions = {
    model,
    triedFallback,
    triedNoTools,
    useTools,
    transientAttempt,
    triedOverloadFallback,
    deadline,
    maxAttempts,
    promptBuilder,
    normalizeFn,
    validateFn,
    context: options?.context || {}
  };
  if (deadline && deadline - Date.now() <= SAFETY_MARGIN_MS) {
    throw new Error("Gemini timeout before completion");
  }
  const prompt = promptBuilder(input, attempt, lastError, options?.context || {});
  const generationConfig = {
    temperature: 0.2
  };
  if (supportsThinkingConfig(model)) {
    generationConfig.thinkingConfig = {
      thinkingBudget: THINKING_BUDGET,
      includeThoughts: true
    };
  }

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig
  };
  if (useTools) {
    requestBody.tools = [{ google_search: {} }];
  }

  recordEvent?.("gemini_request", {
    model,
    attempt,
    use_tools: useTools,
    prompt_preview: prompt.slice(0, 800)
  });

  const requestTimeout = getRequestTimeout(deadline);
  if (requestTimeout <= 0) {
    throw new Error("Gemini timeout before request");
  }

  let response;
  try {
    response = await request(
      `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      },
      requestTimeout
    );
  } catch (err) {
    const message = err?.message || "Request failed";
    const timeout = isTimeoutError(err);
    recordEvent?.(timeout ? "gemini_timeout" : "gemini_error", {
      status: 0,
      message,
      model,
      timeout_ms: timeout ? requestTimeout : undefined
    });
    if (timeout && attempt < maxAttempts && hasTimeForRequest(deadline)) {
      recordEvent?.("gemini_timeout_retry", { attempt, model });
      return analyzeWithRetry(input, recordEvent, attempt + 1, "", {
        ...baseOptions,
        transientAttempt: transientAttempt + 1
      });
    }
    throw new Error(`Gemini request failed: ${message}`);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    payload = null;
  }
  const grounding = payload?.candidates?.[0]?.groundingMetadata || null;
  const rawText = extractText(payload);

  if (!response.ok) {
    const message = payload?.error?.message || response.status;
    recordEvent?.("gemini_error", { status: response.status, message });
    if (isOverloadedError(response.status, message)) {
      if (transientAttempt < OVERLOAD_MAX_RETRIES) {
        const delayMs = getRetryDelayMs(transientAttempt + 1);
        if (!hasTimeForRetry(deadline, delayMs)) {
          recordEvent?.("gemini_overloaded_retry_skipped", {
            reason: "deadline",
            time_left_ms: timeLeftMs(deadline)
          });
        } else {
        recordEvent?.("gemini_overloaded_retry", {
          status: response.status,
          message,
          attempt: transientAttempt + 1,
          delay_ms: delayMs,
          model
        });
        await sleep(delayMs);
        return analyzeWithRetry(input, recordEvent, attempt, lastError, {
          ...baseOptions,
          transientAttempt: transientAttempt + 1
        });
        }
      }
      if (!triedOverloadFallback && hasTimeForRequest(deadline)) {
        const fallbackModel = await pickOverloadFallbackModel(apiKey, model, recordEvent);
        if (fallbackModel && fallbackModel !== model) {
          recordEvent?.("gemini_overload_fallback", {
            from: model,
            to: fallbackModel,
            reason: message
          });
          return analyzeWithRetry(input, recordEvent, attempt, lastError, {
            ...baseOptions,
            model: fallbackModel,
            transientAttempt: 0,
            triedOverloadFallback: true
          });
        }
      }
    }
    if (!triedFallback && isModelError(response.status, message)) {
      const fallbackModel = await pickFallbackModel(apiKey, model, recordEvent);
      if (fallbackModel && fallbackModel !== model) {
        recordEvent?.("gemini_model_fallback", {
          from: model,
          to: fallbackModel,
          reason: message
        });
        return analyzeWithRetry(input, recordEvent, attempt, `Model fallback: ${message}`, {
          ...baseOptions,
          model: fallbackModel,
          triedFallback: true
        });
      }
      recordEvent?.("gemini_model_fallback", {
        from: model,
        to: DEFAULT_MODEL,
        reason: message
      });
      return analyzeWithRetry(input, recordEvent, attempt, `Model fallback: ${message}`, {
        ...baseOptions,
        model: DEFAULT_MODEL,
        triedFallback: true
      });
    }
    if (useTools && !triedNoTools && hasTimeForRequest(deadline)) {
      recordEvent?.("gemini_grounding_fallback", {
        from: "grounded",
        to: "ungrounded",
        reason: message,
        model
      });
      return analyzeWithRetry(input, recordEvent, attempt, "Retry without grounding.", {
        ...baseOptions,
        useTools: false,
        triedNoTools: true,
        transientAttempt: 0
      });
    }
    throw new Error(`Gemini error: ${message}`);
  }

  if (!payload) {
    throw new Error("Gemini response was not JSON");
  }

  const parsed = parseJson(rawText);
  if (!parsed) {
    recordEvent?.("gemini_parse_failed", {
      message: "Invalid JSON output"
    });
    if (useTools && !triedNoTools && hasTimeForRequest(deadline)) {
      recordEvent?.("gemini_grounding_fallback", {
        from: "grounded",
        to: "ungrounded",
        reason: "Invalid JSON output",
        model
      });
      return analyzeWithRetry(input, recordEvent, attempt, "Retry without grounding.", {
        ...baseOptions,
        useTools: false,
        triedNoTools: true,
        transientAttempt: 0
      });
    }
  } else {
    const thinkingSummary = safeString(parsed.thinking_summary);
    const safeSummary = thinkingSummary ? thinkingSummary.slice(0, 2000) : "";
    recordEvent?.("gemini_response", {
      status: response.status,
      grounding,
      thinking_summary: safeSummary
    });
  }

  if (!parsed) {
    if (attempt < maxAttempts) {
      return analyzeWithRetry(input, recordEvent, attempt + 1, "Invalid JSON output.", {
        ...baseOptions
      });
    }
    throw new Error("Gemini returned invalid JSON");
  }

  const normalized = normalizeFn(parsed);

  const errors = validateFn(normalized);

  if (errors.length) {
    if (attempt < maxAttempts) {
      return analyzeWithRetry(input, recordEvent, attempt + 1, errors.join(" | "), {
        ...baseOptions
      });
    }
  }

  return normalized;
}

function buildPrompt(input, attempt, lastError) {
  const base = [
    "You are a market research analyst for software categories.",
    "Task: infer the closest software market category for the user input, then list the top 3 players.",
    "Do not ask clarifying questions. Return mode=apology if the input is empty or unrelated to software (eg: emoji-only, random characters).",
    "Use Google Search grounding when the user asks for fresh data (mentions 2025, 2026, new, or latest). Otherwise do not use tools.",
    "Ranking priority: market share (revenue) -> valuation/market cap -> number of customers -> number of G2 ratings above 4.",
    "Provide exactly 3 companies. Each company must include at least 2 metrics and a differentiated value_prop statement.",
    "Value_prop statement should explain succinctly wihtout jargon why customers prefer this vendor uniquely over other options.",
    "Only include metrics backed by numeric evidence with citations from filings, company websites, press releases, G2, Gartner, Forrester, etc.",
    "Return at least 2 valid sources per company.",
    "Prefer citations from filings, G2, Gartner, and Forrester when listing sources.",
    "Include a top-level thinking_summary with 3-4 sentences that summarize key choices at a high level (category, ranking basis, company selection, and how sources/citations were chosen). Do not reveal chain-of-thought or step-by-step reasoning.",
    "Numbers must be plain numeric values (no commas). Put units in a separate unit field.",
    "Return JSON only, no markdown or extra commentary.",
    "",
    "Schema:",
    "{",
    "  \"mode\": \"results\" | \"apology\",",
    "  \"category\": string | null,",
    "  \"ranking_basis\": \"market_share_revenue\" | \"valuation\" | \"customers\" | \"g2_ratings_4plus\" | null,",
    "  \"thinking_summary\": string | null,",
    "  \"apology\": { \"title\": string, \"message\": string, \"hint\": string } | null,",
    "  \"companies\": [",
    "    {",
    "      \"name\": string,",
    "      \"rank\": number,",
    "      \"metrics\": [",
    "        { \"label\": string, \"value\": number, \"unit\": string, \"period\": string | null, \"source_name\": string, \"source_url\": string }",
    "      ],",
    "      \"value_prop\": string,",
    "      \"sources\": [ { \"name\": string, \"url\": string } ]",
    "    }",
    "  ]",
    "}",
    "",
    `User input: ${input}`
  ];

  if (attempt > 1 && lastError) {
    base.splice(5, 0, `Fix these issues from the previous attempt: ${lastError}`);
  }

  return base.join("\n");
}

function buildPlanPrompt(input, attempt, lastError) {
  const base = [
    "You are a market research analyst for software categories.",
    "Task: identify the closest software market category for the user input and draft a short research plan.",
    "The plan must include: sources you plan to use, metrics you will gather, and your ranking approach.",
    "Ask one clarifying question to refine the plan (region, segment, timeframe, customer size, etc.).",
    "Use Google Search grounding to ensure sources are fresh and relevant.",
    "Return JSON only, no markdown or extra commentary.",
    "",
    "Schema:",
    "{",
    "  \"mode\": \"plan\",",
    "  \"category\": string,",
    "  \"ranking_basis\": \"market_share_revenue\" | \"valuation\" | \"customers\" | \"g2_ratings_4plus\",",
    "  \"plan\": {",
    "    \"sources\": [string],",
    "    \"metrics\": [string],",
    "    \"approach\": string",
    "  },",
    "  \"clarifying_question\": string",
    "}",
    "",
    `User input: ${input}`
  ];

  if (attempt > 1 && lastError) {
    base.splice(4, 0, `Fix these issues from the previous attempt: ${lastError}`);
  }

  return base.join("\n");
}

function buildPlanChangePrompt(input, attempt, lastError, context) {
  const plan = context?.plan || {};
  const planDetails = plan?.plan || plan;
  const baseInput = safeString(context?.baseInput);
  const clarification = safeString(input || context?.clarification);
  const base = [
    "You are assessing whether a user's clarification requires a new market research plan.",
    "Return mode \"replan\" if the clarification changes the category, ranking basis, or scope enough to require different sources/metrics.",
    "Return mode \"keep\" if the existing plan can be executed with minor adjustments (timeframe, region, or small constraints).",
    "If the user confirms no changes, respond with \"keep\".",
    "Return JSON only, no markdown or extra commentary.",
    "",
    "Schema:",
    "{",
    "  \"mode\": \"keep\" | \"replan\",",
    "  \"reason\": string",
    "}",
    "",
    "Context:",
    `Original input: ${baseInput || "(none)"}`,
    `Clarification: ${clarification || "(none)"}`,
    `Current category: ${safeString(plan.category)}`,
    `Current ranking_basis: ${safeString(plan.ranking_basis)}`,
    `Planned sources: ${Array.isArray(planDetails.sources) ? planDetails.sources.join(", ") : ""}`,
    `Planned metrics: ${Array.isArray(planDetails.metrics) ? planDetails.metrics.join(", ") : ""}`,
    `Planned approach: ${safeString(planDetails.approach)}`,
    ""
  ];

  if (attempt > 1 && lastError) {
    base.splice(4, 0, `Fix these issues from the previous attempt: ${lastError}`);
  }

  return base.join("\n");
}

function buildPlanExecutionPrompt(input, attempt, lastError, context) {
  const plan = context?.plan || {};
  const planDetails = plan?.plan || plan;
  const baseInput = context?.baseInput || "";
  const clarification = input || context?.clarification || "";
  const base = [
    "You are a market research analyst for software categories.",
    "Task: execute the research plan below using fresh grounded sources.",
    "Incorporate the user's clarifications and adjust the plan if needed.",
    "Return top 3 companies with metrics, value prop, and citations.",
    "Use Google Search grounding for fresh sources.",
    "Do not ask clarifying questions in the response.",
    "Return JSON only, no markdown or extra commentary.",
    "",
    "Plan context:",
    `Category: ${safeString(plan.category) || safeString(context?.category) || "Software Market"}`,
    `Ranking basis: ${safeString(plan.ranking_basis) || "market_share_revenue"}`,
    `Planned sources: ${Array.isArray(planDetails.sources) ? planDetails.sources.join(", ") : ""}`,
    `Planned metrics: ${Array.isArray(planDetails.metrics) ? planDetails.metrics.join(", ") : ""}`,
    `Planned approach: ${safeString(planDetails.approach) || ""}`,
    `Original user input: ${baseInput}`,
    `User clarification: ${clarification}`,
    "",
    "Schema:",
    "{",
    "  \"mode\": \"results\",",
    "  \"category\": string | null,",
    "  \"ranking_basis\": \"market_share_revenue\" | \"valuation\" | \"customers\" | \"g2_ratings_4plus\" | null,",
    "  \"thinking_summary\": string | null,",
    "  \"apology\": { \"title\": string, \"message\": string, \"hint\": string } | null,",
    "  \"companies\": [",
    "    {",
    "      \"name\": string,",
    "      \"rank\": number,",
    "      \"metrics\": [",
    "        { \"label\": string, \"value\": number, \"unit\": string, \"period\": string | null, \"source_name\": string, \"source_url\": string }",
    "      ],",
    "      \"value_prop\": string,",
    "      \"sources\": [ { \"name\": string, \"url\": string } ]",
    "    }",
    "  ]",
    "}",
    ""
  ];

  if (attempt > 1 && lastError) {
    base.splice(6, 0, `Fix these issues from the previous attempt: ${lastError}`);
  }

  return base.join("\n");
}

function buildCitationRepairPrompt(input, attempt, lastError, context) {
  const category = safeString(context?.category) || "Software Market";
  const company = safeString(context?.company) || "Company";
  const items = Array.isArray(context?.items) ? context.items : [];
  const itemsText = items
    .map((item) => {
      const label = safeString(item.label || item.name || "");
      const type = safeString(item.type || "source");
      const url = safeString(item.url || "");
      return `- type: ${type}, label: ${label}, bad_url: ${url}`;
    })
    .join("\n");

  const base = [
    "You are fixing broken citations for a software market report.",
    "Find replacement sources for the broken citations below.",
    "Use Google Search grounding and prioritize authoritative, recent sources.",
    "Return JSON only, no markdown or extra commentary.",
    "",
    `Category: ${category}`,
    `Company: ${company}`,
    "Broken citations:",
    itemsText || "- None provided",
    "",
    "Schema:",
    "{",
    "  \"replacements\": [",
    "    { \"bad_url\": string, \"source\": { \"name\": string, \"url\": string } }",
    "  ]",
    "}",
    ""
  ];

  if (attempt > 1 && lastError) {
    base.splice(5, 0, `Fix these issues from the previous attempt: ${lastError}`);
  }

  return base.join("\n");
}

function extractText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => (part?.text ? part.text : "")).join("");
}

function parseJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const candidates = [];
  if (trimmed) candidates.push(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    const normalized = normalizeJsonCandidate(candidate);
    if (!normalized) continue;
    const direct = tryParseJson(normalized);
    if (direct) return direct;

    const extracted = extractJsonCandidates(normalized);
    for (const block of extracted) {
      const parsed = tryParseJson(block);
      if (parsed) return parsed;
    }
  }

  return null;
}

function normalizeJsonCandidate(value) {
  if (!value) return "";
  let cleaned = value;
  cleaned = cleaned.replace(/```(?:json)?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.replace(/[\u201c\u201d]/g, "\"");
  cleaned = cleaned.replace(/[\u2018\u2019]/g, "'");
  cleaned = cleaned.replace(/\u00a0/g, " ");
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  return cleaned.trim();
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function extractJsonCandidates(text) {
  const candidates = [];
  const stack = [];
  let inString = false;
  let stringChar = "";
  let escape = false;
  let startIndex = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = "";
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (stack.length === 0) {
        startIndex = i;
      }
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      if (!stack.length) continue;
      const last = stack[stack.length - 1];
      const match = (ch === "}" && last === "{") || (ch === "]" && last === "[");
      if (!match) {
        stack.length = 0;
        startIndex = -1;
        continue;
      }
      stack.pop();
      if (stack.length === 0 && startIndex !== -1) {
        candidates.push(text.slice(startIndex, i + 1));
        startIndex = -1;
      }
    }
  }

  return candidates;
}

function normalizeOutput(raw) {
  if (!raw || typeof raw !== "object") {
    return { mode: "apology", apology: buildDefaultApology() };
  }

  if (raw.mode === "apology") {
    return {
      mode: "apology",
      apology: {
        title: safeString(raw.apology?.title) || "Signal Lost",
        message: safeString(raw.apology?.message) || "Sorry - I analyze software markets only.",
        hint: safeString(raw.apology?.hint) || "Try: CRM, payments, video conferencing."
      }
    };
  }

  const companies = Array.isArray(raw.companies) ? raw.companies : [];

  return {
    mode: "results",
    category: safeString(raw.category) || "Software Market",
    ranking_basis: safeString(raw.ranking_basis) || null,
    companies: companies.map(normalizeCompany).filter(Boolean)
  };
}

function normalizePlanOutput(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      mode: "plan",
      category: "Software Market",
      ranking_basis: "market_share_revenue",
      plan: {
        sources: [],
        metrics: [],
        approach: ""
      },
      clarifying_question: "Any region, timeframe, or segment preferences?"
    };
  }

  const plan = raw.plan || {};
  const sources = Array.isArray(plan.sources)
    ? plan.sources.map(safeString).filter(Boolean).slice(0, 6)
    : [];
  const metrics = Array.isArray(plan.metrics)
    ? plan.metrics.map(safeString).filter(Boolean).slice(0, 6)
    : [];

  return {
    mode: "plan",
    category: safeString(raw.category) || "Software Market",
    ranking_basis: normalizeRankingBasis(raw.ranking_basis) || "market_share_revenue",
    plan: {
      sources,
      metrics,
      approach: safeString(plan.approach)
    },
    clarifying_question:
      safeString(raw.clarifying_question) ||
      "Any region, timeframe, or segment preferences?"
  };
}

function normalizePlanChangeOutput(raw) {
  if (!raw || typeof raw !== "object") {
    return { mode: "keep", reason: "" };
  }
  const modeRaw = safeString(raw.mode).toLowerCase();
  const mode = modeRaw === "replan" || modeRaw === "plan" ? "replan" : "keep";
  return {
    mode,
    reason: safeString(raw.reason)
  };
}

function normalizeRepairOutput(raw) {
  if (!raw || typeof raw !== "object") {
    return { replacements: [] };
  }
  const replacements = Array.isArray(raw.replacements) ? raw.replacements : [];
  const normalized = replacements
    .map((entry) => {
      const badUrl = safeString(entry?.bad_url);
      const source = entry?.source || {};
      const url = safeUrl(source.url);
      if (!badUrl || !url) return null;
      return {
        bad_url: badUrl,
        source: {
          name: safeString(source.name) || "Source",
          url
        }
      };
    })
    .filter(Boolean);
  return { replacements: normalized };
}

function normalizeCompany(company) {
  if (!company || typeof company !== "object") return null;
  const name = safeString(company.name);
  if (!name) return null;

  const metrics = Array.isArray(company.metrics)
    ? company.metrics.map(normalizeMetric).filter(Boolean).slice(0, 2)
    : [];

  const valueProp = safeString(company.value_prop);
  const sources = Array.isArray(company.sources)
    ? company.sources.map(normalizeSource).filter(Boolean).slice(0, 2)
    : [];

  return {
    name,
    rank: toNumber(company.rank) || 0,
    metrics,
    value_prop: valueProp,
    sources
  };
}

function normalizeMetric(metric) {
  if (!metric || typeof metric !== "object") return null;
  const value = toNumber(metric.value);
  if (!Number.isFinite(value)) return null;

  const sourceUrl = safeUrl(metric.source_url);
  if (!sourceUrl) return null;

  return {
    label: safeString(metric.label) || "Metric",
    value,
    unit: safeString(metric.unit) || "",
    period: safeString(metric.period) || null,
    source_name: safeString(metric.source_name) || "Source",
    source_url: sourceUrl
  };
}

function normalizeSource(source) {
  if (!source || typeof source !== "object") return null;
  const url = safeUrl(source.url);
  if (!url) return null;
  return {
    name: safeString(source.name) || "Source",
    url
  };
}

function validateOutput(output) {
  const errors = [];
  if (!output || typeof output !== "object") {
    return ["Output is not an object"];
  }

  if (output.mode === "apology") {
    return errors;
  }

  if (!output.category) {
    errors.push("Missing category");
  }

  if (!Array.isArray(output.companies) || output.companies.length < 3) {
    errors.push("Need at least 3 companies");
    return errors;
  }

  output.companies.forEach((company, index) => {
    if (!company.name) {
      errors.push(`Company ${index + 1} missing name`);
    }
    if (!company.metrics || company.metrics.length < 2) {
      errors.push(`Company ${company.name || index + 1} needs 2 metrics`);
    }
  });

  return errors;
}

function validatePlanOutput(output) {
  const errors = [];
  if (!output || typeof output !== "object") {
    return ["Plan output is not an object"];
  }
  if (!output.category) {
    errors.push("Missing category");
  }
  if (!output.ranking_basis) {
    errors.push("Missing ranking_basis");
  }
  if (!output.plan || typeof output.plan !== "object") {
    errors.push("Missing plan");
  } else {
    if (!Array.isArray(output.plan.sources) || output.plan.sources.length < 2) {
      errors.push("Plan needs at least 2 sources");
    }
    if (!Array.isArray(output.plan.metrics) || output.plan.metrics.length < 2) {
      errors.push("Plan needs at least 2 metrics");
    }
  }
  if (!output.clarifying_question) {
    errors.push("Missing clarifying_question");
  }
  return errors;
}

function validatePlanChangeOutput(output) {
  const errors = [];
  if (!output || typeof output !== "object") {
    return ["Plan change output is not an object"];
  }
  if (!output.mode || !["keep", "replan"].includes(output.mode)) {
    errors.push("Missing mode");
  }
  return errors;
}

function validateRepairOutput(output) {
  const errors = [];
  if (!output || typeof output !== "object") {
    return ["Repair output is not an object"];
  }
  if (!Array.isArray(output.replacements)) {
    errors.push("Missing replacements array");
  }
  return errors;
}

function buildDefaultApology() {
  return {
    title: "Signal Lost",
    message: "Sorry - I analyze software markets only.",
    hint: "Try: CRM, payments, video conferencing."
  };
}

function safeString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeRankingBasis(value) {
  const normalized = safeString(value);
  switch (normalized) {
    case "market_share_revenue":
    case "valuation":
    case "customers":
    case "g2_ratings_4plus":
      return normalized;
    default:
      return "";
  }
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function safeUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return "";
  return unwrapRedirectUrl(trimmed) || trimmed;
}

function unwrapRedirectUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!isVertexRedirect(parsed)) {
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

function isVertexRedirect(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  return host.includes("vertexaisearch");
}

function sanitizeModelName(value) {
  if (typeof value !== "string") return DEFAULT_MODEL;
  return value.trim().replace(/^models\//, "") || DEFAULT_MODEL;
}

function supportsThinkingConfig(model) {
  if (typeof model !== "string") return false;
  return model.startsWith("gemini-2.5") || model.startsWith("gemini-3");
}

function shouldUseGrounding(input) {
  if (!input) return false;
  const trimmed = input.trim();
  if (!trimmed) return false;
  return /\b(2025|2026)\b/i.test(trimmed) || /\blatest\b/i.test(trimmed);
}

function isModelError(status, message) {
  if (status === 404 || status === 400) return true;
  if (typeof message !== "string") return false;
  const lowered = message.toLowerCase();
  return (
    lowered.includes("model") &&
    (lowered.includes("not found") ||
      lowered.includes("not supported") ||
      lowered.includes("permission") ||
      lowered.includes("access"))
  );
}

function isOverloadedError(status, message) {
  if (status === 429 || status === 503) return true;
  if (typeof message !== "string") return false;
  const lowered = message.toLowerCase();
  return lowered.includes("overloaded") || lowered.includes("try again later");
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  const message = String(err.message || "");
  return message.toLowerCase().includes("timeout");
}

function timeLeftMs(deadline) {
  if (!deadline) return Infinity;
  return Math.max(0, deadline - Date.now());
}

function hasTimeForRetry(deadline, delayMs) {
  if (!deadline) return true;
  return timeLeftMs(deadline) > delayMs + REQUEST_MIN_TIMEOUT_MS + SAFETY_MARGIN_MS;
}

function hasTimeForRequest(deadline) {
  if (!deadline) return true;
  return timeLeftMs(deadline) > REQUEST_MIN_TIMEOUT_MS + SAFETY_MARGIN_MS;
}

function getRequestTimeout(deadline) {
  if (!deadline) return REQUEST_TIMEOUT_MS;
  const timeLeft = timeLeftMs(deadline);
  if (timeLeft <= SAFETY_MARGIN_MS) return 0;
  return Math.min(
    REQUEST_TIMEOUT_MS,
    Math.max(REQUEST_MIN_TIMEOUT_MS, timeLeft - SAFETY_MARGIN_MS)
  );
}

function getRetryDelayMs(attempt) {
  const baseDelay = Math.min(
    OVERLOAD_MAX_DELAY_MS,
    OVERLOAD_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1))
  );
  return baseDelay + Math.floor(Math.random() * 300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickFallbackModel(apiKey, currentModel, recordEvent) {
  const models = await listModels(apiKey, recordEvent);
  return pickNextModelInOrder(currentModel, models);
}

async function pickOverloadFallbackModel(apiKey, currentModel, recordEvent) {
  const models = await listModels(apiKey, recordEvent);
  return pickNextModelInOrder(currentModel, models);
}

async function pickPreferredModel(apiKey, preferredModel, recordEvent) {
  const models = await listModels(apiKey, recordEvent);
  const normalizedPreferred = sanitizeModelName(preferredModel || DEFAULT_MODEL);
  if (!models.length || models.includes(normalizedPreferred)) {
    return normalizedPreferred;
  }
  return pickFirstAvailableInOrder(models);
}

function orderedFallbackModels() {
  return MODEL_FALLBACK_ORDER.map(sanitizeModelName).filter(Boolean);
}

function pickFirstAvailableInOrder(models) {
  const order = orderedFallbackModels();
  if (!models.length) {
    return order[0] || DEFAULT_MODEL;
  }
  for (const candidate of order) {
    if (models.includes(candidate)) {
      return candidate;
    }
  }
  return order[0] || DEFAULT_MODEL;
}

function pickNextModelInOrder(currentModel, models) {
  const order = orderedFallbackModels();
  const normalizedCurrent = sanitizeModelName(currentModel || DEFAULT_MODEL);
  const currentIndex = order.indexOf(normalizedCurrent);
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;

  for (let i = startIndex; i < order.length; i += 1) {
    const candidate = order[i];
    if (!models.length || models.includes(candidate)) {
      return candidate;
    }
  }

  return normalizedCurrent;
}

async function listModels(apiKey, recordEvent) {
  const now = Date.now();
  if (cachedModels && now - cachedModelsAt < MODEL_CACHE_TTL_MS) {
    return cachedModels;
  }

  const response = await request(`${GEMINI_ENDPOINT}?key=${apiKey}`, { method: "GET" });
  if (!response.ok) {
    recordEvent?.("gemini_models_error", { status: response.status });
    return cachedModels || [];
  }

  const payload = await response.json();
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const supported = models
    .filter((model) =>
      Array.isArray(model.supportedGenerationMethods) &&
      model.supportedGenerationMethods.includes("generateContent")
    )
    .map((model) => sanitizeModelName(model.name))
    .filter(Boolean);

  cachedModels = supported;
  cachedModelsAt = now;
  recordEvent?.("gemini_models_available", { count: supported.length, models: supported.slice(0, 5) });

  return supported;
}

async function warmModel(apiKey, model) {
  const generationConfig = { temperature: 0 };
  if (supportsThinkingConfig(model)) {
    generationConfig.thinkingConfig = {
      thinkingBudget: THINKING_BUDGET,
      includeThoughts: true
    };
  }

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: "ping" }]
      }
    ],
    generationConfig
  };

  const response = await request(
    `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Warmup failed: ${response.status} ${text}`);
  }
}

function request(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (typeof fetch === "function") {
    return fetchWithTimeout(url, options, timeoutMs);
  }
  return fetchWithNode(url, options, timeoutMs);
}

function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
}

function fetchWithNode(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        method: options?.method || "GET",
        hostname: target.hostname,
        path: target.pathname + target.search,
        headers: options?.headers || {}
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          clearTimeout(timeoutId);
          resolve(buildResponse(res.statusCode || 0, res.headers, data));
        });
      }
    );
    const timeoutId = setTimeout(() => {
      req.destroy(new Error("Request timeout"));
    }, timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
    if (options?.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function buildResponse(status, headers, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    }
  };
}
