# Integration tests

The runnable suite lives next to the unit tests (`src/docsearch/__tests__/`). Persistence is the JSON adapter (`index/` directory), not SQLite or PostgreSQL.

```powershell
cd src/docsearch
npm test
```

`cli-image-search.test.ts` is an optional CLI smoke test. It uses `npm run build` (not Docker, not pnpm).

Older notes about Testcontainers / PostgreSQL / SQLite adapters do not apply to this fork.
