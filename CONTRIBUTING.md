# Contributing to HireSignal

Thanks for your interest! HireSignal is a **single-user, local-first** job-search tool, and
contributions that keep it private, fast, and useful for individual job-seekers are very welcome.

## Ways to help

- 🐛 **Report bugs** — open an issue with steps to reproduce (see the templates).
- ✨ **Suggest features** — especially new job sources, ATS integrations, or matching improvements.
- 🔌 **Add a job source** — each lives in `scripts/ingest-*.ts`; follow an existing one as a pattern.
- 📝 **Improve docs** — the README, the in-app guide (`src/app/guide/page.tsx`), or `.env.example`.
- ⭐ **Star the repo** — it genuinely helps others find it.

## Dev setup

```bash
git clone https://github.com/vinaygiri/hiresignal-personal.git
cd hiresignal-personal
npm install
cp .env.example .env.local
ollama serve            # or set a cloud EMBEDDING_PROVIDER (see .env.example)
npm run dev             # http://localhost:3000
```

## Before you open a PR

- `npx tsc --noEmit` — must pass (CI runs this + `npm run build`).
- Keep changes focused; one topic per PR.
- **Never commit secrets or data.** `.env.local`, `data/`, and `*.pdf` are gitignored — keep it that way.
- Match the existing style. Note the intentional per-script duplication of the schema/ontology
  (see `CLAUDE.md` / the architecture notes) — keep `src/lib/*` and the scripts in sync when editing.

## Scope

HireSignal targets **technical roles** and stays **local/single-user by design** — no auth, no
hosted multi-tenant mode. Please keep PRs aligned with that. Bigger ideas? Open an issue to discuss
first.

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
