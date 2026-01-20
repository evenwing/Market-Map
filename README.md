# Market Map

Single-turn market research UI powered by Gemini with Google Search grounding and Braintrust logging.

## Getting started

```bash
npm install
```

Create a `.env` file (see `.env.example`):

```bash
cp .env.example .env
```

Optional performance tuning:

```bash
CACHE_TTL_MINUTES=15
GEMINI_WARMUP=true
```

Run the server:

```bash
npm run start
```

Then open `http://localhost:3000`.

## Configuration

```bash
GEMINI_API_KEY=your_key
GEMINI_MODEL=gemini-2.5-flash
BRAINTRUST_API_KEY=your_key
BRAINTRUST_PROJECT=project-name
```
