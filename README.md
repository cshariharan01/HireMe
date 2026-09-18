# HireSignal — Personal Job Assistant

Your AI-powered job matching and auto-apply assistant. Runs 100% on your own laptop.
No cloud, no shared accounts, no subscription fees.

---

## Quick Start (Windows)

1. **Install Node.js** if you haven't already:
   → https://nodejs.org (download the **LTS** version)

2. **Double-click `start.bat`**
   - First launch installs everything automatically (~2 minutes)
   - The app opens at http://localhost:3000

3. **Upload your resume** (PDF, Word, or LaTeX)

4. **Get your free AI key** at https://aistudio.google.com/apikey
   - Sign in with Google → "Create API key" → copy it
   - Paste it in the app under Settings → Add Provider → Gemini

5. **Log into LinkedIn** (for job ingestion + Easy Apply):
   - In the terminal, run: `npm run login:naukri` for Naukri
   - LinkedIn login is handled automatically when you first use Apply

---

## Quick Start (Mac / Linux)

```bash
bash start.sh
```

Then open http://localhost:3000

---

## What It Does

| Feature | Description |
|---|---|
| **Job Matching** | Ingests jobs from LinkedIn & Naukri, scores them against your profile |
| **AI Resume Tailoring** | Rewrites your resume for each job using your actual experience |
| **Auto-Apply** | Fills LinkedIn Easy Apply forms automatically |
| **Kanban Tracker** | Tracks all your applications in one place |

---

## Requirements

- Node.js 18+ (https://nodejs.org)
- Your own free Gemini API key (https://aistudio.google.com/apikey)
- Chrome browser (for LinkedIn/Naukri login sessions)

---

## Stopping the App

Press **Ctrl+C** in the terminal window where `start.bat` / `start.sh` is running.

---

## Your Data

Everything stays on your computer:
- Your resume → `data/hiresignal.db`
- Your Chrome session → `data/playwright/`
- Your API keys → `data/hiresignal.db` (encrypted)

None of this is ever sent to any external server (except the AI API calls you configure).
