# Market Research Web App Plan (Gemini + Braintrust)

## Goal
Single-turn market research UI: user inputs a short string, app infers the closest software market category and renders top 3 players in three side-by-side columns with evidence-backed metrics and value props. No clarifying questions.

## Input handling
- Accept free-form short input.
- Classify input into:
  - Known company name -> map to its primary software category.
  - Market category term -> use as-is.
  - No software market/company reference -> show creative animated apology screen.
- The apology screen briefly states the app’s core task and suggests example queries without asking questions.

## Category inference
- Use a lightweight category classifier (Gemini) with a controlled taxonomy list.
- If the input resembles a company, resolve company -> category via grounded sources.
- Always output a single best category, no confirmation step.

## Data retrieval + grounding
- Use Gemini with Google Search grounding; invoke a tool call when needed to fetch sources.
- Prioritize authoritative sources: annual reports, investor relations, public filings, credible analyst reports, G2/TrustRadius/Capterra.
- Require every metric and value prop statement to include a numeric value and a cited source URL.

## Ranking logic (strict priority)
1) Market share in terms of revenue
2) Valuation or market cap
3) Number of customers
4) Number of G2 ratings above 4
- Select top 3 players using the highest available priority metric.
- If a candidate lacks any of the priority metrics, skip it and select the next best candidate; do not show missing-data notes.

## Metrics display rules
- Under each company name, list 2–4 metrics with **bold** numeric evidence.
- Metrics must be tied to sources; render sources on a single line separated by commas.
- Only render statements that include numeric evidence; omit any statement that cannot be supported.

## Value prop highlight
- One short statement per company: core differentiated value prop that supports market leadership.
- Example format: “Leads enterprise payments with **45**% revenue share and **2.3**B in annual volume.”
- Numeric evidence is always bolded.

## Output schema (for UI rendering)
- company: string
- rank: 1..3
- category: string
- metrics: [{ label, value, unit, period, source_name, source_url }]
- value_prop: string (with bold numbers)
- sources: [{ name, url }]

## UI and motion (style reference)
- Dark grid aesthetic with neon green accents and large, bold typography.
- 3-column layout on desktop; stacked cards on mobile.
- Subtle grain/noise overlay; thin divider lines.
- Staggered reveal animation on load; pulsing scanline on apology screen.

## Fallback: no market/company reference
- Render animated apology screen: “Sorry — I analyze software markets only.”
- Include a short hint line with example categories; no questions.

## Configuration
- Store API keys and Braintrust project settings in a local `.env` file.
- Add `.env` to `.gitignore` so secrets are never committed.

## Observability
- Log full session traces with Braintrust, including:
  - input, inferred category, retrieval queries, tool calls, model outputs, and render payload.
- Ensure the render payload is HTML viewable in Braintrust (store a sanitized HTML string as part of the trace).

## Testing checklist
- Inputs: company name, clear category, vague category, unrelated text.
- Verify: correct category inference, metric priority ordering, bold numeric evidence, sources present, value prop requirements met, apology screen triggers only for non-market inputs.
