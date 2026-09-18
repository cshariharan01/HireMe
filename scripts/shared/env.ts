// env.ts — load `.env.local` / `.env` for ts-node scripts.
//
// WHY: `next dev` loads .env.local automatically, but a script run via `npx ts-node` does not —
// so anything configured only in .env.local (FREEWAY_API_KEY, OLLAMA_BASE_URL, MATCH_LIMIT, ...)
// was invisible to the CLI pipeline while working fine in the app. `@next/env` is Next's own
// loader, so scripts see exactly the same values the app does, with the same file precedence.
//
// Import this FIRST, before any module that reads process.env at load time:
//   import './shared/env';   // or '../shared/env' depending on depth
//
// Note: when the sync orchestrator spawns these scripts from the running app, the env is
// already inherited from the Next process — this makes the standalone `npm run …` path match.

import { loadEnvConfig } from '@next/env';
import path from 'path';

// scripts/shared/env.ts -> project root is two levels up.
const projectRoot = path.resolve(__dirname, '..', '..');
loadEnvConfig(projectRoot, /* dev */ true, { info: () => {}, error: console.error });

export {};
