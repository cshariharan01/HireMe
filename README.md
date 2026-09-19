# HireMe — Personal AI Job Assistant

Your AI-powered job matching and auto-apply assistant. Runs 100% on your own laptop.  
No cloud, no shared accounts, no subscription fees. Each person uses their own profile & API key.

---

## ⚡ Quick Start

### Step 1 — Install Node.js (one-time)
Download the **LTS** version from https://nodejs.org and install it.

### Step 2 — Get a Free Gemini API Key (one-time)
1. Go to https://aistudio.google.com/apikey
2. Sign in with Google → click **"Create API key"** → copy it
3. You'll paste it into the app in Step 4 (no billing required, 1500 requests/day free)

### Step 3 — Run the App

**Windows** — double-click `start.bat`

**Mac / Linux** — open Terminal and run:
```bash
bash start.sh
```

> First launch takes ~2 minutes to install dependencies. After that it opens instantly.

The app opens automatically at **http://localhost:3000**

### Step 4 — First-Time Setup (the app guides you)

The app shows a setup banner with 3 steps:

1. **Add your Gemini API key** → click "Add Key" → Settings → Google Gemini → paste your key → Save
2. **Upload your resume** → PDF, Word, or plain text → the AI reads and understands it
3. **Run a Full sync** → fetches fresh jobs from LinkedIn & Naukri matched to YOUR profile

That's it — your personalised job matches appear automatically!

---

## What It Does

| Feature | Description |
|---|---|
| **Smart Job Matching** | Scores every job against your resume — shows your best fits first |
| **AI Resume Tailoring** | Rewrites your resume for each specific job |
| **Auto-Apply** | Fills LinkedIn Easy Apply & Naukri forms automatically |
| **Job Mode** | Smart Apply (score ≥ 60) or Apply All — your choice |
| **Application Tracker** | Kanban board tracks all your applications |
| **Cover Letters** | AI generates a tailored cover letter per job |

---

## Requirements

- **Node.js 18+** → https://nodejs.org
- **Free Gemini API key** → https://aistudio.google.com/apikey
- **Chrome browser** (used automatically for login sessions)

---

## Stopping the App

Press **Ctrl+C** in the terminal / command prompt window.

---

## Your Data — Stays on Your Computer

Everything is stored locally, nothing is sent to any external server except:
- AI API calls to Google Gemini (using **your own key**)
- Job scraping from LinkedIn & Naukri (reading public job listings)

| What | Where |
|---|---|
| Your resume & job matches | `data/hireme.db` |
| Your browser session | `data/playwright/` |
| Your API keys | Stored in `data/hireme.db` (on your machine only) |

---

## Updating to the Latest Version

```bash
git pull
start.bat   # (or bash start.sh)
```

Dependencies update automatically on next launch.

