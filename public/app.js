// Set via /config.js (env: UI_MODE=multi) or defaults to single-turn.
const CONFIG = window.__MM_CONFIG__ || {};
const UI_MODE = CONFIG.uiMode === "multi" ? "multi" : "single";
const ASSISTANT_LABEL = "AGENT";

const form = document.getElementById("market-form");
const input = document.getElementById("market-input");
const status = document.getElementById("status");
const debugPanel = document.getElementById("debug-panel");
const debugMessage = document.getElementById("debug-message");
const results = document.getElementById("results");
const resultsPlaceholder = document.getElementById("results-placeholder");
const apology = document.getElementById("apology");
const loading = document.getElementById("loading");
const chatRail = document.getElementById("chat-rail");
const appRoot = document.querySelector(".app");
const quickPickButtons = document.querySelectorAll("[data-query]");
const apologyTitle = document.getElementById("apology-title");
const apologyMessage = document.getElementById("apology-message");
const apologyHint = document.getElementById("apology-hint");
const categoryTitle = document.getElementById("category-title");
const rankingBasis = document.getElementById("ranking-basis");
const inputPlaceholder = input?.getAttribute("placeholder") || "";
let placeholderCleared = false;
let eventSource = null;
let streamDone = false;
let isLoading = false;
let hasConversation = false;
let hasResults = false;
let awaitingPlanClarification = false;
let pendingPlanId = null;
let activeStream = null;
const statusLines = [];
const MAX_STATUS_LINES = 8;

const activeMode = UI_MODE === "multi" ? "multi" : "single";
if (appRoot) {
  appRoot.dataset.uiMode = activeMode;
}

const conversationId = (() => {
  if (activeMode !== "multi") return null;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `conv_${Date.now()}_${Math.random().toString(16).slice(2)}`;
})();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitQuery(input.value);
});

if (input) {
  input.addEventListener("input", () => {
    if (placeholderCleared) return;
    if ((input.value || "").trim().length > 0) {
      clearInputPlaceholder();
    }
  });
}

async function analyzeMarket(query, options = {}) {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: query,
      stage: options.stage,
      plan_id: options.planId,
      conversation_id: options.conversationId
    })
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    const status = response.status || 0;
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Request failed (${status})${suffix}`);
  }

  return await response.json();
}

async function readErrorDetail(response) {
  let text = "";
  try {
    text = await response.text();
  } catch (err) {
    return response.statusText || "";
  }

  const trimmed = (text || "").trim();
  if (!trimmed) {
    return response.statusText || "";
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.error === "string") return parsed.error;
      if (typeof parsed?.message === "string") return parsed.message;
      return JSON.stringify(parsed);
    } catch (err) {
      // Fall through to raw text.
    }
  }

  const maxLen = 240;
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}...` : trimmed;
}

function submitQuery(rawQuery) {
  const query = (rawQuery || "").trim();
  if (!query) {
    if (isMultiTurn() && awaitingPlanClarification) {
      startStream("No additional constraints.", { stage: "execute" });
      input.value = "";
      return;
    }
    renderApology({
      apology: {
        title: "Signal Lost",
        message: "Sorry - I analyze software markets only.",
        hint: "Try: CRM, payments, video conferencing."
      }
    });
    return;
  }
  if (isLoading) return;
  clearInputPlaceholder();
  const stage = isMultiTurn()
    ? awaitingPlanClarification && pendingPlanId
      ? "execute"
      : "plan"
    : "results";
  if (isMultiTurn() && stage === "plan") {
    pendingPlanId = null;
    awaitingPlanClarification = false;
  }
  startStream(query, { stage });
  input.value = "";
}

function clearInputPlaceholder() {
  if (!input || placeholderCleared) return;
  input.setAttribute("placeholder", "");
  placeholderCleared = true;
}

function isMultiTurn() {
  return activeMode === "multi";
}

function setConversationActive(isActive) {
  if (!appRoot) return;
  appRoot.classList.toggle("has-history", isActive);
}

function markConversationStarted() {
  if (!isMultiTurn() || hasConversation) return;
  hasConversation = true;
  setConversationActive(true);
}

function setResultsPlaceholderVisible(visible) {
  if (!resultsPlaceholder) return;
  resultsPlaceholder.classList.toggle("hidden", !visible);
}

function scrollChatToBottom() {
  if (!chatRail) return;
  requestAnimationFrame(() => {
    chatRail.scrollTop = chatRail.scrollHeight;
  });
}

function createChatShell(role, variant) {
  if (!isMultiTurn() || !chatRail) return null;
  const message = document.createElement("div");
  message.className = `chat-message ${role}`;
  if (variant) {
    variant
      .split(" ")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => message.classList.add(entry));
  }

  const label = document.createElement("div");
  label.className = "chat-label";
  label.textContent = role === "user" ? "You" : ASSISTANT_LABEL;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";

  message.appendChild(label);
  message.appendChild(bubble);
  chatRail.appendChild(message);
  return { message, bubble };
}

function appendChatMessage({ role, text, detail, variant }) {
  const shell = createChatShell(role, variant);
  if (!shell) return null;

  const mainText = document.createElement("div");
  mainText.className = "chat-text";
  mainText.textContent = text || "";
  shell.bubble.appendChild(mainText);

  if (detail) {
    const detailLine = document.createElement("div");
    detailLine.className = "chat-detail";
    detailLine.textContent = detail;
    shell.bubble.appendChild(detailLine);
  }

  scrollChatToBottom();
  return shell.message;
}

function appendUserMessage(text) {
  markConversationStarted();
  return appendChatMessage({ role: "user", text });
}

function appendAssistantMessage(text, detail) {
  return appendChatMessage({ role: "assistant", text, detail });
}

function ensureWelcomeMessage() {
  if (!isMultiTurn() || !chatRail) return;
  if (chatRail.children.length > 0) return;

  return;
}

function startStreamMessage(headlineText) {
  if (!isMultiTurn()) return;
  const shell = createChatShell("assistant", "stream-message is-loading");
  if (!shell) return;

  const headline = document.createElement("div");
  headline.className = "chat-text";
  headline.textContent = headlineText || "Tracing market signals.";

  const list = document.createElement("ul");
  list.className = "stream-list";

  const indicator = document.createElement("div");
  indicator.className = "status-dots stream-indicator";
  const dotOne = document.createElement("span");
  const dotTwo = document.createElement("span");
  const dotThree = document.createElement("span");
  indicator.appendChild(dotOne);
  indicator.appendChild(dotTwo);
  indicator.appendChild(dotThree);

  shell.bubble.appendChild(headline);
  shell.bubble.appendChild(list);
  shell.bubble.appendChild(indicator);

  activeStream = { message: shell.message, list, indicator };
  scrollChatToBottom();
}

function appendStreamLine(text, type) {
  if (!activeStream) {
    startStreamMessage();
  }
  if (!activeStream) return;
  const item = document.createElement("li");
  item.className = `stream-line ${type === "detail" ? "detail" : ""}`.trim();
  item.textContent = text;
  activeStream.list.appendChild(item);
  scrollChatToBottom();
}

function setStreamLoading(loadingState) {
  if (!activeStream) return;
  activeStream.message.classList.toggle("is-loading", loadingState);
  if (activeStream.indicator) {
    activeStream.indicator.style.display = loadingState ? "flex" : "none";
  }
}

function finalizeStreamMessage() {
  if (!activeStream) return;
  activeStream.message.classList.remove("is-loading");
  if (activeStream.indicator) {
    activeStream.indicator.remove();
  }
  activeStream = null;
}

function setLoading(loadingState) {
  isLoading = loadingState;
  form.querySelector("button").disabled = loadingState;
  if (loading) {
    loading.classList.toggle("hidden", !loadingState);
    loading.setAttribute("aria-busy", loadingState ? "true" : "false");
    loading.setAttribute("aria-hidden", loadingState ? "false" : "true");
  }
  if (isMultiTurn()) {
    setStreamLoading(loadingState);
  }
}

function initializeMultiTurn() {
  if (!isMultiTurn()) return;
  hasConversation = false;
  hasResults = false;
  awaitingPlanClarification = false;
  pendingPlanId = null;
  setConversationActive(false);
  if (appRoot) {
    appRoot.classList.remove("has-results");
  }
  setResultsPlaceholderVisible(true);
  ensureWelcomeMessage();
}

function startStream(query, options = {}) {
  const stage = options.stage || "results";
  clearPreviousView();
  setLoading(true);
  appendUserMessage(query);
  if (isMultiTurn()) {
    const headline =
      stage === "plan"
        ? "Drafting your research plan."
        : stage === "execute"
          ? "Executing the updated plan."
          : "Tracing market signals.";
    startStreamMessage(headline);
  }

  if (!window.EventSource) {
    const fallbackMessage =
      stage === "plan"
        ? "Drafting analysis plan..."
        : stage === "execute"
          ? "Executing plan..."
          : "Analyzing input...";
    appendStreamLine(fallbackMessage, "status");
    runFallback(query, { stage });
    return;
  }

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  streamDone = false;
  clearStatus();
  setDebug("");

  const params = new URLSearchParams({ input: query });
  if (isMultiTurn()) {
    params.set("stage", stage);
    if (conversationId) {
      params.set("conversation_id", conversationId);
    }
    if (stage === "execute" && pendingPlanId) {
      params.set("plan_id", pendingPlanId);
    }
  }
  const streamUrl = `/api/analyze/stream?${params.toString()}`;
  const source = new EventSource(streamUrl);
  eventSource = source;

  source.addEventListener("status", (event) => {
    appendStatusLine(readMessage(event), "status");
  });

  source.addEventListener("detail", (event) => {
    appendStatusLine(readMessage(event), "detail");
  });

  source.addEventListener("debug", (event) => {
    const data = readData(event);
    if (data?.message) {
      setDebug(data.message);
    }
  });

  source.addEventListener("final", (event) => {
    streamDone = true;
    const payload = readData(event);
    if (payload?.mode === "plan") {
      renderPlan(payload);
    } else if (payload?.mode === "apology") {
      renderApology(payload);
    } else if (payload) {
      renderResults(payload);
    }
    source.close();
    setLoading(false);
  });

  source.addEventListener("error", () => {
    if (streamDone) return;
    source.close();
    renderApology({
      apology: {
        title: "Signal Lost",
        message: "Sorry - I analyze software markets only.",
        hint: "Try: CRM, payments, video conferencing."
      },
      debug: { message: "Stream connection error." }
    });
    setLoading(false);
  });
}

async function runFallback(query, options = {}) {
  try {
    const payload = await analyzeMarket(query, {
      stage: options.stage,
      planId: pendingPlanId,
      conversationId
    });
    if (payload.mode === "plan") {
      renderPlan(payload);
    } else if (payload.mode === "apology") {
      renderApology(payload);
    } else {
      renderResults(payload);
    }
  } catch (err) {
    renderApology({
      apology: {
        title: "Signal Lost",
        message: "Sorry - I analyze software markets only.",
        hint: "Try: CRM, payments, video conferencing."
      },
      debug: { message: err.message || "Request failed" }
    });
  } finally {
    setLoading(false);
  }
}

function clearPreviousView() {
  results.innerHTML = "";
  results.classList.add("hidden");
  apology.classList.add("hidden");
  if (isMultiTurn()) {
    finalizeStreamMessage();
    setResultsPlaceholderVisible(true);
  }
  clearStatus();
  setDebug("");
}

function renderPlan(payload) {
  if (!isMultiTurn()) return;
  finalizeStreamMessage();
  setResultsPlaceholderVisible(true);
  pendingPlanId = payload.plan_id || pendingPlanId;
  awaitingPlanClarification = true;

  const shell = createChatShell("assistant", "plan-message");
  if (!shell) return;

  const title = document.createElement("div");
  title.className = "chat-text plan-title";
  const category = payload.category || "this market";
  const ranking = formatRankingBasis(payload.ranking_basis || "market_share_revenue");
  title.textContent = `Plan for ${category}: ranking by ${ranking}.`;

  shell.bubble.appendChild(title);

  const plan = payload.plan || {};
  if (Array.isArray(plan.sources) && plan.sources.length) {
    const label = document.createElement("div");
    label.className = "chat-detail plan-section-label";
    label.textContent = "Planned sources";
    const list = document.createElement("ul");
    list.className = "stream-list plan-list";
    plan.sources.forEach((source) => {
      const item = document.createElement("li");
      item.className = "stream-line plan-line";
      item.textContent = source;
      list.appendChild(item);
    });
    shell.bubble.appendChild(label);
    shell.bubble.appendChild(list);
  }

  if (Array.isArray(plan.metrics) && plan.metrics.length) {
    const label = document.createElement("div");
    label.className = "chat-detail plan-section-label";
    label.textContent = "Metrics to gather";
    const list = document.createElement("ul");
    list.className = "stream-list plan-list";
    plan.metrics.forEach((metric) => {
      const item = document.createElement("li");
      item.className = "stream-line plan-line";
      item.textContent = metric;
      list.appendChild(item);
    });
    shell.bubble.appendChild(label);
    shell.bubble.appendChild(list);
  }

  if (plan.approach) {
    const approach = document.createElement("div");
    approach.className = "chat-detail plan-approach";
    approach.textContent = plan.approach;
    shell.bubble.appendChild(approach);
  }

  const question = document.createElement("div");
  question.className = "chat-text plan-question";
  question.textContent =
    payload.clarifying_question ||
    "Any constraints or preferences before I proceed?";
  shell.bubble.appendChild(question);
  scrollChatToBottom();
}

function renderResults(payload) {
  results.innerHTML = "";
  setDebug("");
  apology.classList.add("hidden");
  results.classList.remove("hidden");

  categoryTitle.textContent = (payload.category || "Market Map").toUpperCase();
  rankingBasis.textContent = `Ranking basis: ${formatRankingBasis(payload.ranking_basis)}`;

  const companies = Array.isArray(payload.companies) ? payload.companies : [];
  companies.forEach((company, index) => {
    const card = document.createElement("article");
    card.className = "company-card";
    card.style.animationDelay = `${index * 120}ms`;

    const rank = document.createElement("div");
    rank.className = "company-rank";
    rank.textContent = `${String(company.rank || index + 1).padStart(2, "0")} / PLAYER`;

    const name = document.createElement("h2");
    name.className = "company-name";
    name.textContent = company.name || "Company";

    const metricsWrap = document.createElement("div");
    metricsWrap.className = "metrics";
    const metrics = Array.isArray(company.metrics) ? company.metrics : [];
    metrics.forEach((metric) => {
      metricsWrap.appendChild(renderMetric(metric));
    });

    const valueProp = document.createElement("div");
    valueProp.className = "value-prop";
    if (company.value_prop) {
      valueProp.appendChild(renderValueProp(company.value_prop));
    }

    const sources = document.createElement("div");
    sources.className = "sources";
    const sourceItems = Array.isArray(company.sources) ? company.sources : [];
    if (sourceItems.length) {
      sources.appendChild(renderSourcesLine(sourceItems));
    }

    card.appendChild(rank);
    card.appendChild(name);
    card.appendChild(metricsWrap);
    card.appendChild(valueProp);
    card.appendChild(sources);
    results.appendChild(card);
  });

  if (isMultiTurn()) {
    setResultsPlaceholderVisible(false);
    finalizeStreamMessage();
    awaitingPlanClarification = false;
    pendingPlanId = null;
    hasResults = true;
    if (appRoot) {
      appRoot.classList.add("has-results");
    }
    const title = payload.category ? `${payload.category} ready.` : "Market map ready.";
    appendAssistantMessage(title);
  }
}

function renderMetric(metric) {
  const row = document.createElement("div");
  row.className = "metric";

  const label = document.createElement("div");
  label.className = "metric-label";
  label.textContent = metric.label || "Metric";

  const value = document.createElement("div");
  value.className = "metric-value";
  const strong = document.createElement("strong");
  strong.textContent = formatValue(metric.value, metric.unit);
  value.appendChild(strong);

  row.appendChild(label);
  row.appendChild(value);
  return row;
}

function renderValueProp(valueProp) {
  return renderEvidenceText(valueProp || "");
}

function renderSourcesLine(sources) {
  const line = document.createElement("div");
  line.className = "sources-line";
  line.append("Sources: ");

  sources.forEach((source, index) => {
    if (index > 0) {
      line.append(", ");
    }
    line.appendChild(renderSourceLink(source));
  });

  return line;
}

function renderSourceLink(source) {
  if (!source?.url) {
    return document.createTextNode(source?.name || "Source");
  }
  const link = document.createElement("a");
  link.className = "source-item";
  link.href = source.url || "#";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = `${source.name || "Source"}`;
  return link;
}

function renderApology(apologyPayload) {
  const content = apologyPayload?.apology || {};
  const message = content.message || "Sorry - I analyze software markets only.";
  const hint = content.hint || "Try: CRM, payments, video conferencing.";
  setDebug(apologyPayload?.debug?.message || "");

  results.classList.add("hidden");

  if (isMultiTurn()) {
    finalizeStreamMessage();
    setResultsPlaceholderVisible(true);
    awaitingPlanClarification = false;
    pendingPlanId = null;
    appendAssistantMessage(content.title || "Signal Lost", `${message} ${hint}`.trim());
    apology.classList.add("hidden");
    return;
  }

  apologyTitle.textContent = content.title || "Signal Lost";
  apologyMessage.textContent = message;
  apologyHint.textContent = hint;
  apology.classList.remove("hidden");
}

function formatRankingBasis(value) {
  switch (value) {
    case "market_share_revenue":
      return "Market share (revenue)";
    case "valuation":
      return "Valuation / market cap";
    case "customers":
      return "Customer count";
    case "g2_ratings_4plus":
      return "G2 ratings above 4";
    default:
      return "Evidence-weighted";
  }
}

function formatValue(value, unit) {
  const num = formatNumber(value);
  const unitText = unit ? ` ${unit}` : "";
  return `${num}${unitText}`.trim();
}

function formatNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "string") return value;
  return "";
}

function setDebug(message) {
  if (!debugPanel || !debugMessage) return;
  if (!message) {
    debugMessage.textContent = "";
    debugPanel.classList.add("hidden");
    return;
  }
  debugMessage.textContent = message;
  debugPanel.classList.remove("hidden");
}

function renderEvidenceText(text) {
  const fragment = document.createDocumentFragment();
  const regex = /\\d+(?:\\.\\d+)?%?/g;
  let lastIndex = 0;
  let match = regex.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      fragment.append(text.slice(lastIndex, match.index));
    }
    const strong = document.createElement("strong");
    strong.textContent = match[0];
    fragment.appendChild(strong);
    lastIndex = match.index + match[0].length;
    match = regex.exec(text);
  }

  if (lastIndex < text.length) {
    fragment.append(text.slice(lastIndex));
  }

  return fragment;
}

function appendStatusLine(message, type) {
  if (!message) return;
  if (isMultiTurn()) {
    appendStreamLine(message, type);
    return;
  }
  statusLines.push({ message, type });
  if (statusLines.length > MAX_STATUS_LINES) {
    statusLines.shift();
  }
  renderStatusLines();
}

function renderStatusLines() {
  if (isMultiTurn()) return;
  status.innerHTML = "";
  statusLines.forEach((line) => {
    const item = document.createElement("div");
    item.className = `status-line ${line.type === "detail" ? "status-detail" : ""}`.trim();
    item.textContent = line.message;
    status.appendChild(item);
  });
}

function clearStatus() {
  statusLines.length = 0;
  status.innerHTML = "";
}

function readMessage(event) {
  const data = readData(event);
  return data?.message || "";
}

function readData(event) {
  if (!event?.data) return null;
  try {
    return JSON.parse(event.data);
  } catch (err) {
    return null;
  }
}

quickPickButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const query = button.dataset.query || button.textContent || "";
    if (!query.trim()) return;
    input.value = query;
    clearInputPlaceholder();
    submitQuery(query);
  });
});

initializeMultiTurn();
