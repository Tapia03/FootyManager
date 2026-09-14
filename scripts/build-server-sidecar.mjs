// Empacota o local-db-server.mjs (+ dependencias @electric-sql/pglite e
// pglite-socket) num unico arquivo, pra rodar via node.exe portatil dentro
// do app Tauri, sem precisar de node_modules na maquina do usuario final.
//
// Os arquivos .wasm/.data do PGlite sao copiados do lado do bundle porque
// o PGlite localiza eles de forma relativa ao proprio arquivo JS (usa
// `import.meta.url` internamente) — testar empiricamente se a posicao
// relativa bate, ver o proprio erro do PGlite se nao bater.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "binaries", "server");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "scripts", "local-db-server.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(outDir, "local-db-server.mjs"),
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  // fs.readdirSync/readFileSync em supabase/migrations continuam apontando
  // pro caminho relativo ao projeto (--data-dir/migrations ficam fora do
  // bundle) — isso e resolvido copiando a pasta de migrations tambem.
});

const pgliteDist = join(root, "node_modules", "@electric-sql", "pglite", "dist");
for (const asset of ["pglite.wasm", "pglite.data", "initdb.wasm"]) {
  const src = join(pgliteDist, asset);
  if (existsSync(src)) {
    copyFileSync(src, join(outDir, asset));
    console.log(`[build-server-sidecar] copiado ${asset}`);
  } else {
    console.warn(`[build-server-sidecar] AVISO: nao achei ${asset} em ${pgliteDist}`);
  }
}

const migrationsSrc = join(root, "supabase", "migrations");
const migrationsOut = join(outDir, "migrations");
mkdirSync(migrationsOut, { recursive: true });
let copied = 0;
for (const file of readdirSync(migrationsSrc)) {
  if (!file.endsWith(".sql")) continue;
  copyFileSync(join(migrationsSrc, file), join(migrationsOut, file));
  copied++;
}
console.log(`[build-server-sidecar] ${copied} migrations copiadas pra ${migrationsOut}`);

console.log(`[build-server-sidecar] bundle pronto em ${outDir}`);
