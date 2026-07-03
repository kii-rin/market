# market

Standalone no-account market data runner.

It collects public data, writes JSON logs into `data/`, and exposes one API endpoint:

```txt
GET /api/all
```

## Run in Codespaces

```bash
npm install
npm run update
npm start
```

Then call:

```bash
curl http://localhost:3000/api/all
```

## Commands

```bash
npm run update
npm run summary
npm start
npm run check
```

## Sources

- ECB daily euro foreign exchange reference XML
- FRED public graph CSV URLs
- Official RSS feeds where available

No API keys are required.
