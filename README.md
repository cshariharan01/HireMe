# HireMe — Personal AI Job Assistant

Your personal AI-powered job search, matching, and auto-apply assistant.  
Runs **100% locally on your computer** — no cloud, no shared accounts, no monthly subscription fees.

---

## ⚡ Quick Start (Setup in Under 3 Minutes)

> **No file copying or terminal configuration required!**  
> You do **not** need to touch `.env` files or edit code. All configuration is done directly through the friendly web UI.

### 1. Requirements
- **Node.js (v18 or higher)**: Download the LTS version from [nodejs.org](https://nodejs.org).
- **Google Chrome**: Already installed on your computer (HireMe automatically uses your system Chrome).

---

### 2. Clone and Start

Open your terminal (PowerShell, Command Prompt, or Terminal) and run:

```bash
git clone https://github.com/cshariharan01/HireMe.git
cd HireMe
npm install
npm run dev
```

> **Windows Shortcut:** You can also simply double-click `start.bat`!  
> **Mac / Linux Shortcut:** You can run `bash start.sh`!

Open your browser and navigate to:  
👉 **[http://localhost:3000](http://localhost:3000)** *(or `http://localhost:3001` if using `start.bat`)*

---

### 3. First-Time UI Setup (3 Simple Steps)

When you first open HireMe, everything is configured from the web interface:

1. **Add Your Free AI Key**:
   - Get a free key at [Google AI Studio](https://aistudio.google.com/apikey) *(No credit card needed — 1,500 free requests/day)*.
   - In HireMe, click **Settings** (in the top navigation bar).
   - Paste your key under **Google Gemini** and click **Add Provider** (or Save).
   - HireMe automatically validates the key, activates it, and configures the environment in the background!
2. **Upload Your Resume**:
   - Navigate to **Profile** (in the top navigation bar).
   - Upload your resume (`.pdf`, `.docx`, or `.txt`). HireMe will parse your experience, skills, and target roles automatically.
3. **Discover & Apply**:
   - Go to **Jobs** and hit **Sync** to fetch and match fresh job postings from LinkedIn & Naukri tailored specifically to your profile score!

---

## ❓ Frequently Asked Questions (FAQ)

### Do I need to copy or edit `.env` files?
**No.** You do **not** need to copy `.env.example` or edit `.env` manually. All API keys and settings are managed directly inside the application under the **Settings** page. The backend automatically synchronizes everything for you.

### Do I need to install Chromium or Playwright browsers?
**No.** HireMe automatically detects and connects to your existing **Google Chrome** installation. You do not need to download extra browser binaries. *(Playwright's bundled Chromium is only downloaded as an optional fallback if Google Chrome is not installed on your system).*

### Does the auto-apply steal focus while I am working?
**No.** The browser launches smoothly in the background. It will only come to the front once at the start or if manual action is needed (like solving an initial login CAPTCHA), leaving you free to work uninterrupted.

### Where is my data stored?
Everything is stored **100% locally on your own computer**:
- Database: `data/hireme.db` (SQLite)
- Browser sessions & cookies: `data/playwright/`
- Resume & profile data: Stored locally in your SQLite database.
- Nothing is sent to external servers except direct API calls to your configured AI provider using your own key.

---

## ✨ Features

- **Smart Resume-to-Job Matching**: Computes match scores and highlights missing keywords/skills for every job.
- **AI Resume Tailoring**: Automatically generates tailored versions of your resume tuned to specific job descriptions.
- **Tailored Cover Letters**: One-click AI generation of personalized cover letters.
- **Background Auto-Apply**: Streamlined application automation for LinkedIn Easy Apply and Naukri.
- **Interactive Kanban Tracker**: Track applications across *Discovered*, *Applied*, *Screening*, *Interviewing*, and *Offered*.
- **Multi-Model Support**: Works out-of-the-box with free Google Gemini, plus support for Anthropic Claude, OpenAI, and local Ollama.

---

## 🛠️ Handy Commands

| Action | Command |
|---|---|
| Start application | `npm run dev` (or `start.bat` on Windows) |
| Stop application | Press `Ctrl + C` in the terminal |
| Update to latest version | `git pull && npm install` |
| Run automated test suite | `npm test` |
| Reset local database | `npm run db:reset` |

---

## 📄 License

MIT License — free for personal use and modification.
