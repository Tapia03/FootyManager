// Servidor de banco local (Fase 3 do app desktop). Sobe um PGlite persistente
// e expõe ele como um Postgres de verdade via socket TCP, pra o PostgREST
// (rodando como outro processo) conseguir se conectar nele igual conectaria
// num Postgres na nuvem. Isso é o que permite os 41 arquivos que chamam
// supabase.from() continuarem exatamente iguais — só a URL muda.
//
// Uso: node scripts/local-db-server.mjs [--data-dir <caminho>] [--port <numero>]
// Ver project_desktop_windows_offline.md na memória do projeto.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const dataDir = resolve(argValue("--data-dir", join(root, ".local-db-data")));
const port = Number(argValue("--port", "54329"));

const AUTH_SHIM = `
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

// Patch pos-migrations pra versao desktop sem login (decisao ja confirmada
// com o usuario, ver project_desktop_windows_offline.md): saves.user_id
// e NOT NULL + FK pra auth.users, mas aqui so existe um usuario local
// (o proprio fake criado no shim acima). Em vez de mudar os 41 arquivos
// que chamam supabase.from() pra sempre mandar user_id, damos um DEFAULT
// pra essa coluna que aponta pro usuario local unico. `profiles` nao
// precisa de patch: a trigger handle_new_user() do proprio shim ja criou
// a linha correspondente quando inserimos o usuario fake acima.
const DESKTOP_PATCH = `
ALTER TABLE public.saves ALTER COLUMN user_id SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;
`;

async function ensureSchema(db) {
  const existing = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'saves'`,
  );
  if (existing.rows.length > 0) {
    console.log("[local-db] schema ja existe, pulando migrations");
    return;
  }
  console.log("[local-db] primeira execucao: aplicando shim + migrations...");
  await db.exec(AUTH_SHIM);
  // Em dev, o script mora em scripts/ e as migrations ficam em ../supabase/migrations.
  // Empacotado (bundle rodando via node.exe sidecar), o script mora em
  // server/local-db-server.mjs e o build-server-sidecar.mjs copia as
  // migrations pra server/migrations/ (irma do bundle, mesma pasta).
  const packagedMigrations = join(scriptDir, "migrations");
  const migrationsDir = existsSync(packagedMigrations)
    ? packagedMigrations
    : join(root, "supabase", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await db.exec(sql);
  }
  console.log(`[local-db] ${files.length} migrations aplicadas`);
  console.log("[local-db] aplicando patch desktop (sem login: user_id ganha default)...");
  await db.exec(DESKTOP_PATCH);
}

async function main() {
  console.log(`[local-db] abrindo banco em ${dataDir}`);
  const db = new PGlite(dataDir);
  await ensureSchema(db);

  const server = new PGLiteSocketServer({
    db,
    port,
    host: "127.0.0.1",
    maxConnections: 10,
    debug: process.env.LOCAL_DB_DEBUG === "1",
  });
  await server.start();
  console.log(`[local-db] socket Postgres ouvindo em 127.0.0.1:${port}`);
  // Marcador que o processo pai (Tauri / script de teste) usa pra saber
  // que ja pode conectar o PostgREST.
  console.log("LOCAL_DB_READY");

  const shutdown = async () => {
    console.log("[local-db] encerrando...");
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[local-db] erro fatal:", err);
  process.exit(1);
});
