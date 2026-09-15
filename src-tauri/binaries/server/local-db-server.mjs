import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// scripts/local-db-server.mjs
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { connect } from "node:net";
var scriptDir = dirname(fileURLToPath(import.meta.url));
var root = resolve(scriptDir, "..");
function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
var dataDir = resolve(argValue("--data-dir", join(root, ".local-db-data")));
var port = Number(argValue("--port", "54329"));
var packagedPgBin = join(scriptDir, "..", "pgsql", "bin");
var pgBinDir = existsSync(packagedPgBin) ? packagedPgBin : join(root, "src-tauri", "binaries", "pgsql", "bin");
var exe = (name) => join(pgBinDir, `${name}.exe`);
var AUTH_SHIM = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT '00000000-0000-0000-0000-000000000001'::uuid
$$;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'local@taticafc.app')
ON CONFLICT (id) DO NOTHING;
`;
var DESKTOP_PATCH = `
ALTER TABLE public.saves ALTER COLUMN user_id SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
`;
function psqlExec(sql) {
  execFileSync(exe("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "inherit" });
}
function psqlFile(path) {
  execFileSync(exe("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", path], { stdio: "inherit" });
}
async function waitReady(timeoutMs = 2e4) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve2) => {
      const sock = connect({ host: "127.0.0.1", port }, () => {
        sock.end();
        resolve2(true);
      });
      sock.on("error", () => resolve2(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`postgres nao ficou pronto em ${timeoutMs}ms (porta ${port})`);
}
async function ensureSchema() {
  const out = execFileSync(exe("psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-t",
    "-A",
    "-c",
    "SELECT to_regclass('public.saves') IS NOT NULL"
  ]).toString().trim();
  if (out === "t") {
    console.log("[local-db] schema ja existe, pulando migrations");
    return;
  }
  console.log("[local-db] primeira execucao: aplicando shim + migrations...");
  psqlExec(AUTH_SHIM);
  const packagedMigrations = join(scriptDir, "migrations");
  const migrationsDir = existsSync(packagedMigrations) ? packagedMigrations : join(root, "supabase", "migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) psqlFile(join(migrationsDir, file));
  console.log(`[local-db] ${files.length} migrations aplicadas`);
  console.log("[local-db] aplicando patch desktop (sem login: user_id ganha default)...");
  psqlExec(DESKTOP_PATCH);
}
var pgChild = null;
async function shutdown() {
  console.log("[local-db] encerrando...");
  try {
    execFileSync(exe("pg_ctl"), ["-D", dataDir, "stop", "-m", "fast"], { stdio: "inherit", timeout: 1e4 });
  } catch (e) {
    console.warn("[local-db] pg_ctl stop falhou, forcando kill:", e.message);
    pgChild?.kill();
  }
  process.exit(0);
}
async function main() {
  console.log(`[local-db] abrindo banco em ${dataDir}`);
  if (!existsSync(join(dataDir, "PG_VERSION"))) {
    console.log("[local-db] data-dir novo, rodando initdb...");
    execFileSync(exe("initdb"), ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "inherit" });
  }
  pgChild = spawn(exe("postgres"), ["-D", dataDir, "-p", String(port), "-h", "127.0.0.1"], { stdio: "inherit" });
  pgChild.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[local-db] postgres.exe saiu com codigo ${code}`);
      process.exit(1);
    }
  });
  await waitReady();
  console.log(`[local-db] postgres nativo ouvindo em 127.0.0.1:${port}`);
  await ensureSchema();
  console.log("LOCAL_DB_READY");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((err) => {
  console.error("[local-db] erro fatal:", err);
  process.exit(1);
});
