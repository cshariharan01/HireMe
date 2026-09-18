# Security Policy

HireSignal runs **locally, for a single user**. It has **no authentication** and is not designed to
be exposed to a network or hosted as a multi-user service — please don't deploy it that way.

Your data (résumés, the SQLite database, and any API keys) stays on your machine. `.env.local`,
`data/`, and `*.pdf` are gitignored so they're never committed — keep them that way.

## Reporting a vulnerability

If you find a security issue (e.g. a way secrets could leak, or an injection in a scraper/parser),
please **report it privately** via GitHub's *Security → Report a vulnerability* (private advisory)
rather than opening a public issue. I'll respond as soon as I can.

Please do not include real API keys or personal data in any report.
