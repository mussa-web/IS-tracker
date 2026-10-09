"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dotenv = require("dotenv");

function backupConfig(environment = process.env) {
  const intervalHours = Number(environment.BACKUP_INTERVAL_HOURS || 24);
  const retentionCount = Number(environment.BACKUP_RETENTION_COUNT || 14);
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 8760) {
    throw new Error("BACKUP_INTERVAL_HOURS must be a whole number from 1 to 8760.");
  }
  if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
    throw new Error("BACKUP_RETENTION_COUNT must be a whole number from 1 to 365.");
  }
  const defaultDirectory = environment.LOCALAPPDATA
    ? path.join(environment.LOCALAPPDATA, "Stockroom", "backups")
    : path.join(os.homedir(), ".stockroom", "backups");
  return {
    directory: path.resolve(environment.BACKUP_DIR || defaultDirectory),
    intervalMs: intervalHours * 60 * 60 * 1000,
    retentionCount,
    pgDumpPath: environment.PG_DUMP_PATH || "pg_dump",
  };
}

function databaseEnvironment(databaseUrl, environment) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL before a backup can run.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || parsed.pathname === "/") {
    throw new Error("DATABASE_URL must identify a PostgreSQL database before a backup can run.");
  }
  const childEnvironment = { ...environment };
  delete childEnvironment.PGPASSWORD;
  delete childEnvironment.PGHOST;
  delete childEnvironment.PGPORT;
  delete childEnvironment.PGUSER;
  delete childEnvironment.PGDATABASE;
  childEnvironment.PGHOST = parsed.hostname.replace(/^\[|\]$/g, "");
  childEnvironment.PGPORT = parsed.port || "5432";
  childEnvironment.PGDATABASE = decodeURIComponent(parsed.pathname.slice(1));
  if (parsed.username) childEnvironment.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) childEnvironment.PGPASSWORD = decodeURIComponent(parsed.password);
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) childEnvironment.PGSSLMODE = sslmode;
  return childEnvironment;
}

function backupFilename(date) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `stockroom-${timestamp}.dump`;
}

async function pruneBackups(directory, retentionCount) {
  const files = await fs.readdir(directory, { withFileTypes: true });
  const backups = files
    .filter((entry) => entry.isFile() && /^stockroom-\d{8}T\d{6}Z\.dump$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(backups.slice(retentionCount).map((filename) => fs.unlink(path.join(directory, filename))));
}

async function runDatabaseBackup({
  databaseUrl,
  environment = process.env,
  spawnProcess = spawn,
  now = new Date(),
} = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required to create a PostgreSQL backup.");
  const config = backupConfig(environment);
  const childEnvironment = databaseEnvironment(databaseUrl, environment);
  await fs.mkdir(config.directory, { recursive: true, mode: 0o700 });
  const filename = backupFilename(now);
  const destination = path.join(config.directory, filename);
  const temporary = `${destination}.${crypto.randomBytes(6).toString("hex")}.partial`;
  const args = [
    "--format=custom",
    "--no-password",
    "--file", temporary,
    "--host", childEnvironment.PGHOST,
    "--port", childEnvironment.PGPORT,
    ...(childEnvironment.PGUSER ? ["--username", childEnvironment.PGUSER] : []),
    "--dbname", childEnvironment.PGDATABASE,
  ];
  let stderr = "";
  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(config.pgDumpPath, args, {
          env: childEnvironment,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(error);
        return;
      }
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 12000) stderr += chunk.toString().slice(0, 12000 - stderr.length);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `pg_dump exited with code ${code}.`));
      });
    });
    const backup = await fs.stat(temporary);
    if (!backup.isFile() || backup.size === 0) throw new Error("pg_dump completed without creating a valid backup file.");
    await fs.rename(temporary, destination);
    await pruneBackups(config.directory, config.retentionCount);
    return { path: destination, size: backup.size };
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch((cleanupError) => {
      console.error("Could not remove an incomplete PostgreSQL backup:", cleanupError.message);
    });
    if (error.code === "ENOENT") {
      throw new Error(`Could not find pg_dump at "${config.pgDumpPath}". Install PostgreSQL command-line tools or set PG_DUMP_PATH in .env.`);
    }
    throw new Error(`PostgreSQL backup failed: ${error.message}`);
  }
}

function startBackupScheduler({ databaseUrl, environment = process.env, logger = console } = {}) {
  const config = backupConfig(environment);
  let running = false;
  const run = async () => {
    if (running) {
      logger.warn("Skipping scheduled PostgreSQL backup because the previous backup is still running.");
      return;
    }
    running = true;
    try {
      const result = await runDatabaseBackup({ databaseUrl, environment });
      logger.info(`PostgreSQL backup created: ${path.basename(result.path)} (${result.size} bytes).`);
    } catch (error) {
      logger.error(error.message);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, config.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

if (require.main === module) {
  dotenv.config({ path: path.join(__dirname, ".env") });
  runDatabaseBackup({ databaseUrl: process.env.DATABASE_URL })
    .then((result) => console.log(`PostgreSQL backup created: ${result.path} (${result.size} bytes).`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { backupConfig, databaseEnvironment, pruneBackups, runDatabaseBackup, startBackupScheduler };
