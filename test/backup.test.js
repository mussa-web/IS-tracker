"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { backupConfig, databaseEnvironment, runDatabaseBackup } = require("../backup");

test("backup configuration defaults to a local protected folder and daily retention", () => {
  const config = backupConfig({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
  assert.equal(config.directory, path.join("C:\\Users\\test\\AppData\\Local", "Stockroom", "backups"));
  assert.equal(config.intervalMs, 24 * 60 * 60 * 1000);
  assert.equal(config.retentionCount, 14);
  assert.throws(() => backupConfig({ BACKUP_INTERVAL_HOURS: "0" }), /BACKUP_INTERVAL_HOURS/);
  assert.throws(() => backupConfig({ BACKUP_RETENTION_COUNT: "366" }), /BACKUP_RETENTION_COUNT/);
});

test("database URL credentials are passed through libpq environment, not process arguments", () => {
  const result = databaseEnvironment(
    "postgres://stock%20user:p%40ss%3Aword@localhost:2510/IS%20tracker?sslmode=require",
    { PATH: "test-path", PGHOST: "old-host", PGPASSWORD: "old-password" },
  );
  assert.equal(result.PGHOST, "localhost");
  assert.equal(result.PGPORT, "2510");
  assert.equal(result.PGUSER, "stock user");
  assert.equal(result.PGPASSWORD, "p@ss:word");
  assert.equal(result.PGDATABASE, "IS tracker");
  assert.equal(result.PGSSLMODE, "require");
  assert.equal(result.PATH, "test-path");
});

test("database backup is atomically saved and retention only removes old Stockroom dumps", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stockroom-backup-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previousBackups = [
    "stockroom-20261001T120000Z.dump",
    "stockroom-20261002T120000Z.dump",
    "stockroom-20261003T120000Z.dump",
  ];
  for (const filename of previousBackups) await fs.writeFile(path.join(directory, filename), "old backup");
  await fs.writeFile(path.join(directory, "unrelated.dump"), "keep");
  let called;
  const result = await runDatabaseBackup({
    databaseUrl: "postgres://backup-user:secret-password@127.0.0.1:2510/stockroom",
    environment: { BACKUP_DIR: directory, BACKUP_RETENTION_COUNT: "2", PG_DUMP_PATH: "test-pg_dump", PATH: "test-path" },
    now: new Date("2026-10-09T14:00:00.000Z"),
    spawnProcess: (command, args, options) => {
      called = { command, args, options };
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      const file = args[args.indexOf("--file") + 1];
      setImmediate(async () => {
        await fs.writeFile(file, "valid custom format data");
        child.emit("close", 0);
      });
      return child;
    },
  });
  assert.equal(called.command, "test-pg_dump");
  assert.equal(called.options.env.PGPASSWORD, "secret-password");
  assert.ok(!called.args.join(" ").includes("secret-password"), "database password is not exposed in command arguments");
  assert.equal(result.path, path.join(directory, "stockroom-20261009T140000Z.dump"));
  assert.equal(result.size, 24);
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    "stockroom-20261003T120000Z.dump",
    "stockroom-20261009T140000Z.dump",
    "unrelated.dump",
  ]);
});

test("missing pg_dump reports installation guidance and leaves no partial backup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stockroom-backup-failure-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(runDatabaseBackup({
    databaseUrl: "postgres://localhost/stockroom",
    environment: { BACKUP_DIR: directory, PG_DUMP_PATH: "missing-pg_dump" },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        const error = new Error("not found");
        error.code = "ENOENT";
        child.emit("error", error);
      });
      return child;
    },
  }), /Install PostgreSQL command-line tools or set PG_DUMP_PATH/);
  assert.deepEqual(await fs.readdir(directory), []);
});
