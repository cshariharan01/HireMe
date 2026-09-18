// In-app job sync — DB-backed + detached, so live progress survives Next dev recompiles/restarts.
//
// startSync() creates a sync_runs row and spawns scripts/run-sync.ts as a DETACHED process that
// runs the pipeline and writes progress into that row. getSyncStatus() reads the row from the DB
// (no in-memory state to lose). cancelSync() flags the row + kills the orchestrator's process tree.

import { spawn } from 'child_process';
import path from 'path';
import db from './db';

export type SyncMode = 'linkedin' | 'naukri' | 'full' | 'quick' | 'rate';
type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

const STEP_DEFS: Record<string, string> = {
  'ingest:linkedin': 'Fetching LinkedIn Easy Apply jobs',
  'ingest:naukri': 'Scanning Naukri Direct Apply jobs',
  'ingest:all': 'Fetching jobs from sources',
  discover: 'Discovering company career pages',
  embed: 'Embedding new jobs',
  prune: 'Pruning stale & dead jobs',
  'verify:links': 'Verifying job links',
  'evaluate:top': 'Rating top matches',
};
// Platform-specific and combined sync pipelines
const LINKEDIN = ['ingest:linkedin', 'embed'];
const NAUKRI = ['ingest:naukri', 'embed'];
const QUICK = ['embed', 'prune', 'verify:links'];
const FULL = ['ingest:linkedin', 'ingest:naukri', 'embed', 'prune', 'verify:links'];
const RATE = ['evaluate:top'];

// A run whose heartbeat (updated_at) is older than this is considered dead, not running.
const STALE_MS = 120_000;

interface SyncRow {
  id: number; mode: string; status: string; started_at: string; finished_at: string | null;
  steps_done: number; steps_total: number; error: string | null;
  current_step: string | null; step_index: number | null; steps_json: string | null;
  log_tail: string | null; updated_at: string | null; pid: number | null; cancel_requested: number | null;
}

// SQLite UTC "YYYY-MM-DD HH:MM:SS" → epoch ms
function sqlMs(s: string | null): number {
  if (!s) return 0;
  const t = new Date(s.replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(t) ? t : 0;
}

function latestRow(): SyncRow | undefined {
  try { return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as SyncRow | undefined; }
  catch { return undefined; }
}

export function startSync(mode: SyncMode): { ok: boolean; error?: string } {
  const latest = latestRow();
  if (latest && latest.status === 'running' && Date.now() - sqlMs(latest.updated_at) < STALE_MS) {
    return { ok: false, error: 'A sync is already running.' };
  }
  const names =
    mode === 'linkedin' ? LINKEDIN :
    mode === 'naukri' ? NAUKRI :
    mode === 'full' ? FULL :
    mode === 'rate' ? RATE :
    QUICK;
  const steps = names.map((s) => ({ script: s, label: STEP_DEFS[s] || s, status: 'pending' as StepStatus }));

  let runId: number;
  try {
    const info = db.prepare(
      `INSERT INTO sync_runs (mode, status, started_at, updated_at, steps_total, step_index, steps_json, log_tail, cancel_requested)
       VALUES (?, 'running', datetime('now'), datetime('now'), ?, 0, ?, '[]', 0)`
    ).run(mode, steps.length, JSON.stringify(steps));
    runId = Number(info.lastInsertRowid);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to create sync run' };
  }

  try {
    // Run the orchestrator as a hidden background process. shell:true so `npx` resolves on
    // Windows; windowsHide:true so NO console window appears (nothing for the user to close).
    // We do NOT use detached:true — that would spawn a visible console window on Windows, and
    // it's unnecessary: the child survives Next dev route-recompiles anyway (only a full server
    // restart would end it). unref() lets the server not wait on it. Progress lives in the DB.
    const child = spawn(`npx ts-node scripts/run-sync.ts ${mode} ${runId}`, {
      cwd: process.cwd(),
      shell: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.pid) db.prepare('UPDATE sync_runs SET pid = ? WHERE id = ?').run(child.pid, runId);
    child.unref();
  } catch (e) {
    db.prepare("UPDATE sync_runs SET status='error', error=?, finished_at=datetime('now') WHERE id=?")
      .run(e instanceof Error ? e.message : 'spawn failed', runId);
    return { ok: false, error: 'Failed to start sync process' };
  }
  return { ok: true };
}

export function cancelSync(): boolean {
  const latest = latestRow();
  if (!latest || latest.status !== 'running') return false;
  try { db.prepare('UPDATE sync_runs SET cancel_requested = 1 WHERE id = ?').run(latest.id); } catch { /* ignore */ }
  try {
    if (process.platform === 'win32') {
      // pid /T kills the orchestrator tree; the command-line match sweeps any nested-shell
      // grandchildren (embed/ingest/etc.) that /T can miss on Windows.
      if (latest.pid) spawn('taskkill', ['/pid', String(latest.pid), '/T', '/F']);
      spawn('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'run-sync\\.ts|scripts[\\\\/](ingest|embed|discover|prune|verify|evaluate)' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"]);
    } else if (latest.pid) {
      process.kill(-latest.pid, 'SIGTERM'); // negative = process group (detached)
    }
  } catch { /* already gone */ }
  try { db.prepare("UPDATE sync_runs SET status='cancelled', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(latest.id); } catch { /* ignore */ }
  return true;
}

interface DbCounts { active: number; embedded: number; evaluated: number; }
function dbCounts(): DbCounts {
  try {
    const active = (db.prepare("SELECT COUNT(*) n FROM job_postings WHERE expired_at IS NULL AND (url_status IS NULL OR url_status != 'dead')").get() as { n: number }).n;
    const embedded = (db.prepare('SELECT COUNT(*) n FROM job_postings WHERE embedding IS NOT NULL AND expired_at IS NULL').get() as { n: number }).n;
    const evaluated = (db.prepare('SELECT COUNT(*) n FROM job_evaluations').get() as { n: number }).n;
    return { active, embedded, evaluated };
  } catch { return { active: 0, embedded: 0, evaluated: 0 }; }
}

function lastSyncedAt(): string | null {
  try {
    const row = db.prepare("SELECT finished_at FROM sync_runs WHERE status='done' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").get() as { finished_at: string } | undefined;
    return row?.finished_at ?? null;
  } catch { return null; }
}

export function getSyncStatus() {
  const row = latestRow();
  const counts = dbCounts();
  const lastSynced = lastSyncedAt();
  if (!row) return { running: false, run: null, lastSyncedAt: lastSynced, counts };

  const fresh = Date.now() - sqlMs(row.updated_at) < STALE_MS;
  const running = row.status === 'running' && fresh;
  let steps: Array<{ script: string; label: string; status: StepStatus }> = [];
  try { steps = row.steps_json ? JSON.parse(row.steps_json) : []; } catch { /* ignore */ }
  let logTail: string[] = [];
  try { logTail = row.log_tail ? JSON.parse(row.log_tail) : []; } catch { /* ignore */ }

  // Surface a stalled run (status still "running" but heartbeat dead) as an error.
  const status = row.status === 'running' && !fresh ? 'error' : row.status;
  const error = status === 'error' && !row.error ? 'Sync stopped unexpectedly.' : row.error;

  return {
    running,
    run: {
      mode: row.mode,
      status,
      steps,
      stepIndex: row.step_index ?? 0,
      error,
      logTail,
      startedAt: row.started_at ? new Date(row.started_at.replace(' ', 'T') + 'Z').toISOString() : undefined,
    },
    lastSyncedAt: lastSynced,
    counts,
  };
}
