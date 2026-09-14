// Baixa o pacote oficial de binarios do PostgreSQL da EnterpriseDB (so as
// DLLs, sem instalar servidor nenhum) e extrai pra src-tauri/binaries/,
// de onde o Tauri empacota junto do postgrest.exe (que depende de libpq
// e das bibliotecas dela: libssl, libcrypto, libintl, icu, etc).
//
// Isso existe pra nao depender de uma instalacao local do Postgres na
// maquina de quem builda o instalador — ver project_desktop_windows_offline.md.
//
// Uso: node scripts/fetch-postgres-dlls.mjs
import { mkdtempSync, createWriteStream, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

// Link oficial da pagina https://www.enterprisedb.com/download-postgresql-binaries
// (versao 18.6 no momento em que isso foi escrito — atualizar se quebrar).
const PG_BINARIES_URL = "https://sbp.enterprisedb.com/getfile.jsp?fileid=1260488";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "src-tauri", "binaries");
const tmp = mkdtempSync(join(tmpdir(), "pg-binaries-"));
const zipPath = join(tmp, "pg-binaries.zip");

console.log(`[fetch-postgres-dlls] baixando ${PG_BINARIES_URL} ...`);
const res = await fetch(PG_BINARIES_URL);
if (!res.ok) {
  console.error(`[fetch-postgres-dlls] download falhou: HTTP ${res.status}`);
  process.exit(1);
}
await pipeline(res.body, createWriteStream(zipPath));
console.log(`[fetch-postgres-dlls] baixado em ${zipPath}`);

const extractDir = join(tmp, "extract");
execFileSync("unzip", ["-o", "-q", zipPath, "pgsql/bin/*.dll", "-d", extractDir]);

const binDir = join(extractDir, "pgsql", "bin");
const files = readdirSync(binDir).filter((f) => f.endsWith(".dll"));
for (const file of files) {
  copyFileSync(join(binDir, file), join(destDir, file));
}
console.log(`[fetch-postgres-dlls] ${files.length} DLLs copiadas pra ${destDir}`);

rmSync(tmp, { recursive: true, force: true });
console.log("[fetch-postgres-dlls] pronto.");
