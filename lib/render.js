export function renderHtml(payload) {
  if (!payload || payload.mode === "apology") {
    return renderApologyHtml(payload?.apology);
  }

  const category = escapeHtml(normalizeCategory(payload.category));
  const ranking = escapeHtml(formatRankingBasis(payload.ranking_basis));
  const columns = Array.isArray(payload.companies)
    ? payload.companies.map(renderCompany).join("")
    : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Market Map</title>
</head>
<body style="margin:0;background:#0b0b0b;color:#f2f2f2;font-family:Arial, sans-serif;">
  <div style="padding:24px 32px;">
    <h1 style="margin:12px 0 4px;font-size:40px;text-transform:uppercase;">${category}</h1>
    <div style="color:#7a7a7a;font-size:12px;">Ranking basis: ${ranking}</div>
  </div>
  <div style="display:flex;gap:16px;padding:0 32px 32px;flex-wrap:wrap;">
    ${columns}
  </div>
</body>
</html>`;
}

function renderCompany(company, index) {
  const name = escapeHtml(company.name || "Company");
  const rankLabel = String(company.rank || index + 1).padStart(2, "0");
  const metrics = Array.isArray(company.metrics)
    ? company.metrics.map(renderMetric).join("")
    : "";
  const valueProp = company.value_prop ? renderValueProp(company.value_prop) : "";
  const sourcesLine = Array.isArray(company.sources)
    ? renderSourcesLine(company.sources)
    : "";

  return `<div style="flex:1 1 240px;min-width:240px;border:1px solid #1b1b1b;padding:20px;background:rgba(10,10,10,0.8);">
    <div style="color:#00ff84;font-size:12px;letter-spacing:3px;">${rankLabel} / PLAYER</div>
    <div style="font-size:28px;font-weight:700;margin:10px 0 14px;">${name}</div>
    <div>${metrics}</div>
    <div style="margin-top:14px;font-size:13px;line-height:1.5;color:#cfcfcf;">${valueProp}</div>
    <div style="margin-top:14px;font-size:12px;color:#7a7a7a;">${sourcesLine}</div>
  </div>`;
}

function renderMetric(metric) {
  const label = escapeHtml(metric.label || "Metric");
  const value = formatValue(metric.value, metric.unit);
  const period = metric.period ? ` (${escapeHtml(metric.period)})` : "";

  return `<div style="display:flex;justify-content:space-between;gap:16px;border-top:1px solid #1b1b1b;padding:8px 0;">
    <div style="color:#7a7a7a;font-size:11px;letter-spacing:2px;text-transform:uppercase;">${label}${period}</div>
    <div style="font-size:14px;"><strong>${escapeHtml(value)}</strong></div>
  </div>`;
}

function renderValueProp(valueProp) {
  const safe = escapeHtml(valueProp || "");
  return highlightNumbers(safe);
}

function renderSourcesLine(sources) {
  const items = sources.map(renderSourceLink).filter(Boolean);
  if (!items.length) return "";
  return `Sources: ${items.join(", ")}`;
}

function renderSourceLink(source) {
  const name = escapeHtml(source.name || "Source");
  const url = escapeHtml(source.url || "");
  if (!url) return "";
  return `<a style="color:#7a7a7a;text-decoration:none;" href="${url}">${name}</a>`;
}

function renderApologyHtml(apology) {
  const title = escapeHtml(apology?.title || "Signal Lost");
  const message = escapeHtml(apology?.message || "Sorry - I analyze software markets only.");
  const hint = escapeHtml(apology?.hint || "Try: CRM, payments, video conferencing.");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Market Map</title>
</head>
<body style="margin:0;background:#0b0b0b;color:#f2f2f2;font-family:Arial, sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
  <div style="text-align:center;">
    <div style="font-size:36px;letter-spacing:4px;text-transform:uppercase;">${title}</div>
    <div style="margin-top:10px;font-size:14px;color:#9a9a9a;">${message}</div>
    <div style="margin-top:6px;font-size:12px;color:#00ff84;">${hint}</div>
  </div>
</body>
</html>`;
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

function normalizeCategory(value) {
  const fallback = "Software Market";
  if (!value) return fallback;
  const stripped = String(value)
    .replace(/monolith\\s*\\/\\/\\s*market_core\\s*/i, "")
    .replace(/^[-–—:\\s]+/, "")
    .trim();
  return stripped || fallback;
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

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightNumbers(text) {
  return text.replace(/\\d+(?:\\.\\d+)?%?/g, (match) => `<strong>${match}</strong>`);
}
