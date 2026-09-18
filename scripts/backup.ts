// backup.ts — one-command backup to ship HireSignal (code + data) to another machine.
//
// What it does:
//   1. Checkpoints the SQLite WAL into the main .db file, so the copy is complete/consistent
//      (a raw copy of hiresignal.db WITHOUT flushing the -wal file ships stale/corrupt data).
//   2. Builds a timestamped tar.gz of the WHOLE project INCLUDING data/, résumé PDFs, and
//      .env.local (everything the target machine needs), EXCLUDING the regenerable bulk
//      (node_modules, .next, .git) and the backups/ folder itself.
//
// Usage:  npm run backup
// Output: backups/hiresignal-YYYYMMDD-HHMMSS.tgz
//
// NOTE: the tarball contains your Gemini key (inside the DB) + résumé PII — keep it private
// (USB / encrypted). This is deliberately the OPPOSITE of git: git ignores data/; this ships it.

import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const projectDir = process.cwd();
const projectName = path.basename(projectDir);
const parentDir = path.dirname(projectDir);
const backupsDir = path.join(projectDir, 'backups');
const dbPath = path.join(projectDir, 'data', 'hiresignal.db');

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// 1) Flush the WAL so the .db is a complete snapshot before we archive it.
if (fs.existsSync(dbPath)) {
  try {
    const db = new Database(dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('✓ Checkpointed SQLite WAL into hiresignal.db');
  } catch (e) {
    console.warn(`! Could not checkpoint the DB (${e instanceof Error ? e.message : e}). ` +
      'Close the app/dev server if it is running, then re-run. Archiving anyway.');
  }
} else {
  console.warn('! No data/hiresignal.db found — backing up code only.');
}

// 2) Build the archive.
fs.mkdirSync(backupsDir, { recursive: true });
const outFile = path.join(backupsDir, `hiresignal-${stamp()}.tgz`);

// Run tar from the PARENT dir and package the project folder by name, so paths inside the
// archive are `hiresignal-personal/...` (clean extract on the target). Exclude regenerable
// bulk + the backups folder itself (avoids packing prior archives / recursion).
// --force-local: on Windows, GNU tar otherwise reads an absolute path like `D:\...tgz`
// as a REMOTE host ("D:") in host:path syntax and fails ("Cannot connect to D:").
const args = [
  '--force-local',
  '--exclude=node_modules',
  '--exclude=.next',
  '--exclude=.git',
  `--exclude=${projectName}/backups`,
  '-czf', outFile,
  '-C', parentDir,
  projectName,
];

console.log(`→ Creating ${path.relative(projectDir, outFile)} …`);
const res = spawnSync('tar', args, { stdio: 'inherit' });

if (res.error) {
  console.error(`✗ tar failed to launch: ${res.error.message}`);
  console.error('  Windows 10/11 ships tar by default; ensure it is on PATH, or use 7-Zip manually.');
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`✗ tar exited with code ${res.status}. Backup not created.`);
  process.exit(res.status ?? 1);
}

const size = fs.statSync(outFile).size;
console.log(`\n✓ Backup created: ${outFile}`);
console.log(`  Size: ${humanSize(size)}  (includes data/, résumé PDFs, .env.local)`);
console.log('\nTo restore on the other machine:');
console.log(`  tar -xzf ${path.basename(outFile)}`);
console.log(`  cd ${projectName} && npm install`);
console.log('  # then install Ollama + `ollama pull nomic-embed-text` + `ollama pull llama3.2`, then `npm run dev`');
console.log('\n⚠  This file contains your Gemini key + résumé PII — keep it private (USB/encrypted), never commit it.');
