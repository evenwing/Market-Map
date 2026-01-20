const form = document.getElementById("market-form");
const input = document.getElementById("market-input");
const status = document.getElementById("status");
const debugPanel = document.getElementById("debug-panel");
const debugMessage = document.getElementById("debug-message");
const results = document.getElementById("results");
const apology = document.getElementById("apology");
const loading = document.getElementById("loading");
const apologyTitle = document.getElementById("apology-title");
const apologyMessage = document.getElementById("apology-message");
const apologyHint = document.getElementById("apology-hint");
const categoryTitle = document.getElementById("category-title");
const rankingBasis = document.getElementById("ranking-basis");
let eventSource = null;
let streamDone = false;
const statusLines = [];
const MAX_STATUS_LINES = 8;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) {
    renderApology({
      apology: {
        title: "Signal Lost",
        message: "Sorry - I analyze software markets only.",
        hint: "Try: CRM, payments, video conferencing."
      }
    });
    return;
  }

  startStream(query);
});

async function analyzeMarket(query) {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: query })
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

function setLoading(isLoading) {
  form.querySelector("button").disabled = isLoading;
  if (!loading) return;
  loading.classList.toggle("hidden", !isLoading);
  loading.setAttribute("aria-busy", isLoading ? "true" : "false");
  loading.setAttribute("aria-hidden", isLoading ? "false" : "true");
}

function startStream(query) {
  clearPreviousView();
  setLoading(true);

  if (!window.EventSource) {
    runFallback(query);
    return;
  }

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  streamDone = false;
  clearStatus();
  setDebug("");

  const streamUrl = `/api/analyze/stream?input=${encodeURIComponent(query)}`;
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
    if (payload?.mode === "apology") {
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

async function runFallback(query) {
  clearPreviousView();
  setLoading(true);
  try {
    const payload = await analyzeMarket(query);
    if (payload.mode === "apology") {
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
  clearStatus();
  setDebug("");
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
  apologyTitle.textContent = content.title || "Signal Lost";
  apologyMessage.textContent =
    content.message || "Sorry - I analyze software markets only.";
  apologyHint.textContent =
    content.hint || "Try: CRM, payments, video conferencing.";
  setDebug(apologyPayload?.debug?.message || "");

  results.classList.add("hidden");
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
  statusLines.push({ message, type });
  if (statusLines.length > MAX_STATUS_LINES) {
    statusLines.shift();
  }
  renderStatusLines();
}

function renderStatusLines() {
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
