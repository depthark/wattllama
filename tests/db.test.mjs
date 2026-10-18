// The database layer: migrations from older versions, the read-only connection, damaged
// files, backups and permissions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, RETENTION } from "../db.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-db-"));
const close = (...dbs) => { for (const d of dbs) try { d.close(); } catch {} };

test("upgrades a database from v0.1 (no user_version, fewer columns) and keeps its data", () => {
  const dir = tmp();
  const old = new DatabaseSync(path.join(dir, "power.db"));
  old.exec(`CREATE TABLE m (ts INTEGER PRIMARY KEY, secs REAL, gpu_w REAL, cpu_w REAL, dram_w REAL, sys_w REAL,
    gpu_t REAL, gpu_tmax REAL, gpu_util REAL, cpu_util REAL, vram REAL, active_s REAL, wh REAL, wh_active REAL, wh_gpu REAL, gen_tok INTEGER, pp_tok INTEGER)`);
  old.exec(`CREATE TABLE mm (ts INTEGER, model TEXT, active_s REAL, wh REAL, gen_tok INTEGER, pp_tok INTEGER, PRIMARY KEY (ts, model))`);
  old.prepare("INSERT INTO m (ts, secs, wh, gen_tok) VALUES (?,?,?,?)").run(1000, 60, 2.5, 300);
  old.prepare("INSERT INTO mm VALUES (?,?,?,?,?,?)").run(1000, "qwen", 30, 1.2, 300, 40);
  old.close();
  const { db, rdb } = openDatabase({ dir });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(db.prepare("SELECT gen_tok FROM m WHERE ts = 1000").get().gen_tok, 300);
    assert.equal(db.prepare("SELECT req FROM mm WHERE model = 'qwen'").get().req, 0, "new column with its default");
    const cols = db.prepare("PRAGMA table_info(m)").all().map((c) => c.name);
    assert.ok(["cpu_t", "gpu_pl", "ram_used"].every((c) => cols.includes(c)));
    for (const t of ["runs", "events", "requests"]) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t), t);
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA trusted_schema").get().trusted_schema, 0);
  } finally { close(rdb, db); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("opening again changes nothing (migrations run once)", () => {
  const dir = tmp();
  let x = openDatabase({ dir });
  x.db.prepare("INSERT INTO m (ts, secs) VALUES (1, 60)").run();
  close(x.rdb, x.db);
  x = openDatabase({ dir });
  try { assert.equal(x.db.prepare("SELECT COUNT(*) n FROM m").get().n, 1); }
  finally { close(x.rdb, x.db); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the page's connection cannot write", () => {
  const dir = tmp();
  const { db, rdb } = openDatabase({ dir });
  try {
    db.prepare("INSERT INTO m (ts, secs) VALUES (1, 60)").run();
    assert.equal(rdb.prepare("SELECT COUNT(*) n FROM m").get().n, 1, "it sees the writer's data");
    assert.throws(() => rdb.prepare("DELETE FROM m").run(), /readonly|read-only|query_only|attempt to write/i);
    assert.throws(() => rdb.exec("DROP TABLE m"), /readonly|read-only|query_only|attempt to write/i);
    assert.throws(() => rdb.exec("ATTACH DATABASE 'x.db' AS x"), /./);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM m").get().n, 1);
  } finally { close(rdb, db); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a damaged file is moved aside, not overwritten", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "power.db"), "SQLite format 3\0" + "garbage".repeat(500));
  const logs = [];
  const { db, rdb } = openDatabase({ dir, log: (m) => logs.push(m) });
  try {
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("power.db.damaged-")), "kept for recovery");
    assert.ok(logs.some((l) => /moved/.test(l)));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM m").get().n, 0, "a fresh database works");
  } finally { close(rdb, db); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("maintenance: daily backup that opens, the last 7 kept, old events and requests removed", () => {
  const dir = tmp();
  const { db, rdb, maintenance } = openDatabase({ dir });
  try {
    db.prepare("INSERT INTO m (ts, secs, wh) VALUES (1, 60, 3)").run();
    const old = Date.now() - (RETENTION.events + 5) * 86400_000;
    db.prepare("INSERT INTO events (ts, kind, title) VALUES (?, 'x', 'old')").run(old);
    db.prepare("INSERT INTO events (ts, kind, title) VALUES (?, 'x', 'new')").run(Date.now());
    db.prepare("INSERT INTO requests (ts, model) VALUES (?, 'q')").run(Date.now() - (RETENTION.requests + 1) * 86400_000);
    const bdir = path.join(dir, "backup");
    fs.mkdirSync(bdir);
    for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(bdir, `power-2020-01-0${i}.db`), "");
    maintenance();
    const files = fs.readdirSync(bdir).sort();
    assert.equal(files.length, 7);
    const today = files.at(-1);
    const copy = new DatabaseSync(path.join(bdir, today), { readOnly: true });
    try { assert.equal(copy.prepare("SELECT wh FROM m").get().wh, 3, "the backup is a working database"); } finally { copy.close(); }
    assert.deepEqual(db.prepare("SELECT title FROM events").all().map((r) => r.title), ["new"]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM requests").get().n, 0);
    maintenance();
    assert.equal(fs.readdirSync(bdir).length, 7, "one backup per day");
  } finally { close(rdb, db); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only you can read it (Linux)", { skip: process.platform === "win32" && "Windows uses an ACL, set by install.ps1" }, () => {
  const dir = path.join(tmp(), "data");
  const { db, rdb } = openDatabase({ dir });
  try {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, "power.db")).mode & 0o777, 0o600);
  } finally { close(rdb, db); fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test("demo mode stays in memory", () => {
  const { db, rdb, file } = openDatabase({ dir: "/nonexistent", demo: true });
  assert.equal(file, null);
  assert.equal(db, rdb);
  db.close();
});
