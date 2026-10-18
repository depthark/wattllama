// The SQLite database (data/power.db), opened the careful way:
//   - only you can read it: data/ is 0700 and the files 0600 on Linux (install.ps1 sets the same
//     with an ACL on Windows); it is never served over HTTP
//   - WAL journal, NORMAL sync, busy timeout: crash-safe, readers never block the writer
//   - trusted_schema off, no extensions, no double-quoted string literals (node:sqlite defaults)
//   - a quick integrity check at start; a damaged file is moved aside, never written over
//   - schema changes are versioned (user_version) and run in one transaction
//   - the web page reads through a second, read-only connection (query_only): even a bug in a
//     query could not change or delete data
//   - a daily backup (VACUUM INTO data/backup/, last 7 kept) and a retention limit for events
//
// Tables: m (whole PC per minute), mm (each model per minute), runs, events (alerts), requests
// (llama.cpp per request). Never drop or change a column; add a migration below instead.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const POSIX = process.platform !== "win32";
const chmod = (p, mode) => { if (POSIX) { try { fs.chmodSync(p, mode); } catch {} } };

// Each entry runs once, in order, inside a transaction; user_version records how far we are.
// Entry 1 is the schema of all versions up to 0.3, written so that it also upgrades those
// databases (created before user_version was used) without touching their data.
const MIGRATIONS = [
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS m (
      ts INTEGER PRIMARY KEY, secs REAL, gpu_w REAL, cpu_w REAL, dram_w REAL, sys_w REAL,
      gpu_t REAL, gpu_tmax REAL, gpu_util REAL, cpu_util REAL, vram REAL,
      active_s REAL, wh REAL, wh_active REAL, wh_gpu REAL, gen_tok INTEGER, pp_tok INTEGER)`);
    db.exec(`CREATE TABLE IF NOT EXISTS mm (
      ts INTEGER, model TEXT, active_s REAL, wh REAL, gen_tok INTEGER, pp_tok INTEGER, req INTEGER DEFAULT 0, PRIMARY KEY (ts, model))`);
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      start INTEGER, end INTEGER, model TEXT, active_s REAL, wh REAL, gen_tok INTEGER, pp_tok INTEGER, req INTEGER DEFAULT 0, PRIMARY KEY (start, model))`);
    for (const [table, col, def] of [["mm", "req", "INTEGER DEFAULT 0"], ["runs", "req", "INTEGER DEFAULT 0"],
      ["m", "cpu_t", "REAL"], ["m", "cpu_tmax", "REAL"], ["m", "gpu_pl", "REAL"], ["m", "gpu_fan", "REAL"], ["m", "cpu_mhz", "REAL"], ["m", "ram_used", "REAL"]]) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS events (ts INTEGER, kind TEXT, key TEXT, level TEXT, title TEXT, message TEXT, sent INTEGER DEFAULT 0)`);
    db.exec(`CREATE INDEX IF NOT EXISTS events_ts ON events (ts)`);
    db.exec(`CREATE INDEX IF NOT EXISTS mm_model_ts ON mm (model, ts)`);
  },
  (db) => {
    // llama.cpp per request (from its log): prefill and generation speed against the context
    // depth, speculative-decoding acceptance. Numbers only, never text.
    db.exec(`CREATE TABLE IF NOT EXISTS requests (
      ts INTEGER, model TEXT, engine TEXT, ctx INTEGER, n_ctx INTEGER,
      pp_tok INTEGER, pp_ms REAL, gen_tok INTEGER, gen_ms REAL, draft_acc INTEGER, draft_gen INTEGER, cached INTEGER)`);
    db.exec(`CREATE INDEX IF NOT EXISTS requests_model_ts ON requests (model, ts)`);
  },
];

export const RETENTION = { events: 365, requests: 90 };       // days; minute rows are small and kept

function integrityOk(file, log) {
  if (!fs.existsSync(file)) return true;
  let probe;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const r = probe.prepare("PRAGMA quick_check").all().map((x) => Object.values(x)[0]);
    if (r.length === 1 && r[0] === "ok") return true;
    log(`database check failed: ${r.slice(0, 3).join("; ")}`);
  } catch (e) { log(`database check failed: ${e.message}`); }
  finally { try { probe?.close(); } catch {} }
  return false;
}

export function openDatabase({ dir, demo = false, log = () => {} }) {
  if (demo) {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    return { db, rdb: db, file: null, maintenance: () => {} };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmod(dir, 0o700);
  const file = path.join(dir, "power.db");
  if (!integrityOk(file, log)) {
    const aside = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    for (const ext of ["", "-wal", "-shm"]) { try { fs.renameSync(file + ext, aside + ext); } catch {} }
    log(`the damaged database was moved to ${path.basename(aside)}; starting a new one (backups are in data/backup)`);
  }
  const db = new DatabaseSync(file);
  for (const p of ["journal_mode = WAL", "synchronous = NORMAL", "busy_timeout = 5000", "trusted_schema = OFF",
    "foreign_keys = ON", "secure_delete = ON", "temp_store = MEMORY"]) db.exec(`PRAGMA ${p}`);
  migrate(db);
  for (const ext of ["", "-wal", "-shm"]) chmod(file + ext, 0o600);

  // The page's connection: read-only twice over (open flag and query_only).
  const rdb = new DatabaseSync(file, { readOnly: true });
  rdb.exec("PRAGMA busy_timeout = 5000");
  rdb.exec("PRAGMA query_only = ON");

  const maintenance = () => {
    try {
      // Daily backup, a consistent copy even while writing; the last 7 are kept.
      const bdir = path.join(dir, "backup");
      fs.mkdirSync(bdir, { recursive: true, mode: 0o700 });
      chmod(bdir, 0o700);
      const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const target = path.join(bdir, `power-${stamp}.db`);
      if (!fs.existsSync(target)) {
        db.prepare("VACUUM INTO ?").run(target);
        chmod(target, 0o600);
        const old = fs.readdirSync(bdir).filter((f) => /^power-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7);
        for (const f of old) fs.rmSync(path.join(bdir, f), { force: true });
      }
      const cut = (days) => Date.now() - days * 86400_000;
      db.prepare("DELETE FROM events WHERE ts < ?").run(cut(RETENTION.events));
      db.prepare("DELETE FROM requests WHERE ts < ?").run(cut(RETENTION.requests));
      db.exec("PRAGMA optimize");
    } catch (e) { log(`database maintenance: ${e.message}`); }
  };
  return { db, rdb, file, maintenance };
}

function migrate(db) {
  const have = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = have; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
}
