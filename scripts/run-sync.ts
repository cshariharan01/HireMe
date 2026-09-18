// run-sync.ts — the sync orchestrator, run as a DETACHED process (spawned by src/lib/sync.ts).
//
// Why detached + DB-backed: the Next dev server recompiles routes on-demand, which wipes any
// in-memory state. So progress is written to the sync_runs table and the UI reads it from there;
// this process is independent of the Next server, so recompiles/restarts can't interrupt it.
//
// Usage: npx ts-node scripts/run-sync.ts <mode> <runId>
//   mode  = 'quick' | 'full'
//   runId = the sync_runs row id to write progress into

import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import path from 'path';

const VALID_MODES = ['linkedin', 'naukri', 'full', 'quick', 'rate'] as const;
type SyncMode = typeof VALID_MODES[number];
const arg = process.argv[2] as SyncMode;
const mode: SyncMode = VALID_MODES.includes(arg) ? arg : 'quick';
const runId = parseInt(process.argv[3] || '0', 10);

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
/** prune-stale's "refused to mass-expire" exit code — a warning, not a failure. */
const PRUNE_GUARD_EXIT = 2;
const PRUNE_STEP = 'prune';

const LINKEDIN = ['ingest:linkedin', 'embed'];
const NAUKRI = ['ingest:naukri', 'embed'];
const QUICK = ['embed', PRUNE_STEP, 'verify:links'];
const FULL = ['ingest:linkedin', 'ingest:naukri', 'embed', PRUNE_STEP, 'verify:links'];
const RATE = ['evaluate:top'];
const scripts =
  mode === 'linkedin' ? LINKEDIN :
  mode === 'naukri' ? NAUKRI :
  mode === 'full' ? FULL :
  mode === 'rate' ? RATE :
  QUICK;

const db = new Database(path.join(process.cwd(), 'data', 'hiresignal.db'));
db.pragma('journal_mode = WAL');
// Per-connection: the NORMAL set in src/lib/db.ts does not reach a standalone script, and
// better-sqlite3 defaults to FULL — one fsync per autocommit write.
db.pragma('synchronous = NORMAL');
for (const spec of ['current_step TEXT', 'step_index INTEGER DEFAULT 0', 'steps_json TEXT', 'log_tail TEXT', 'updated_at DATETIME', 'pid INTEGER', 'cancel_requested INTEGER DEFAULT 0']) {
  try { db.exec(`ALTER TABLE sync_runs ADD COLUMN ${spec}`); } catch (e) { if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e; }
}

type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
const steps = scripts.map((s) => ({ script: s, label: STEP_DEFS[s] || s, status: 'pending' as StepStatus }));
const logTail: string[] = [];
const LOG_CAP = 60;

function pushLog(line: string) {
  const t = line.replace(/\s+$/, '');
  if (!t) return;
  logTail.push(t);
  if (logTail.length > LOG_CAP) logTail.splice(0, logTail.length - LOG_CAP);
}

let lastWrite = 0;
function persist(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < 700) return;
  lastWrite = now;
  const stepIndex = Math.max(0, steps.findIndex((s) => s.status === 'running'));
  const done = steps.filter((s) => s.status === 'done').length;
  try {
    db.prepare(
      `UPDATE sync_runs SET current_step=?, step_index=?, steps_done=?, steps_total=?, steps_json=?, log_tail=?, updated_at=datetime('now') WHERE id=?`
    ).run(steps[stepIndex]?.label || null, stepIndex, done, steps.length, JSON.stringify(steps), JSON.stringify(logTail), runId);
  } catch { /* best-effort */ }
}

function isCancelled(): boolean {
  try { return !!(db.prepare('SELECT cancel_requested c FROM sync_runs WHERE id=?').get(runId) as { c: number } | undefined)?.c; }
  catch { return false; }
}

function runStep(script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(`npm run ${script}`, { cwd: process.cwd(), shell: true, windowsHide: true });
    const cancelTimer = setInterval(() => {
      if (isCancelled()) { try { if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); else child.kill(); } catch {} }
      persist(); // heartbeat even if the child is quiet
    }, 2000);
    child.stdout?.on('data', (d) => { String(d).split('\n').forEach(pushLog); persist(); });
    child.stderr?.on('data', (d) => { String(d).split('\n').forEach(pushLog); persist(); });
    child.on('close', (code) => { clearInterval(cancelTimer); resolve(code ?? 0); });
    child.on('error', (err) => { clearInterval(cancelTimer); pushLog(`spawn error: ${err.message}`); resolve(1); });
  });
}


async function main() {
  pushLog(`Starting ${mode} sync…`);
  persist(true);
  let hadError = false;
  for (let i = 0; i < steps.length; i++) {
    if (isCancelled()) break;
    steps[i].status = 'running';
    pushLog(`▶ ${steps[i].label}`);
    persist(true);
    const code = await runStep(steps[i].script);
    if (isCancelled()) { steps[i].status = 'skipped'; break; }
    if (code === 0) {
      steps[i].status = 'done';
    } else if (code === PRUNE_GUARD_EXIT && steps[i].script === PRUNE_STEP) {
      // prune-stale exits 2 when its mass-expiry guard trips — i.e. the age rules would retire
      // more than MAX_EXPIRY_RATIO of the corpus, which means ingest did not run. That guard
      // REFUSING to delete is the correct, safe outcome, not a pipeline failure. Treating it as
      // one aborted the whole loop, so in QUICK mode (embed → prune → verify:links → evaluate)
      // `verify:links` and `evaluate:top` silently never ran at all.
      steps[i].status = 'skipped';
      pushLog(`⚠ ${steps[i].label} skipped — nothing safe to prune (ingest likely didn't run)`);
    } else {
      steps[i].status = 'error';
      hadError = true;
      pushLog(`✗ ${steps[i].label} failed (exit ${code})`);
      break;
    }
    persist(true);
  }
  const cancelled = isCancelled();
  const status = cancelled ? 'cancelled' : hadError ? 'error' : 'done';
  const errMsg = hadError ? `A step failed — ${steps.find((s) => s.status === 'error')?.label}` : null;
  try {
    db.prepare(`UPDATE sync_runs SET status=?, error=?, finished_at=datetime('now'), updated_at=datetime('now'), steps_json=?, steps_done=? WHERE id=?`)
      .run(status, errMsg, JSON.stringify(steps), steps.filter((s) => s.status === 'done').length, runId);
  } catch { /* ignore */ }
  db.close();
  process.exit(0);
}

main();
