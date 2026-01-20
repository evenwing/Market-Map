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

  runAnalysis(query);
});

async function analyzeMarket(query) {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: query })
  });

  if (!response.ok) {
    throw new Error("Request failed");
  }

  return await response.json();
}

function setLoading(isLoading) {
  form.querySelector("button").disabled = isLoading;
  if (!loading) return;
  loading.classList.toggle("hidden", !isLoading);
  loading.setAttribute("aria-busy", isLoading ? "true" : "false");
  loading.setAttribute("aria-hidden", isLoading ? "false" : "true");
}

async function runAnalysis(query) {
  setLoading(true);
  status.innerHTML = "";
  setDebug("");
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
