// Build estático usado pelo app desktop (Tauri). Roda `vite build` com
// DESKTOP_BUILD=1 (ativa nitro:false + spa habilitado no vite.config.ts)
// e depois copia o shell pré-renderizado pra index.html, que é o nome
// que o Tauri espera encontrar em `frontendDist`.
// Ver project_desktop_windows_offline.md na memória do projeto.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// O client.ts do Supabase e gerado automaticamente pela Lovable ("nao
// editar diretamente") e le VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY
// do ambiente em build-time (Vite inlina isso no bundle). Em vez de editar
// o arquivo gerado, so apontamos essas variaveis pro PostgREST local nesse
// build especifico — os 41 arquivos que chamam supabase.from() continuam
// intocados, so o endereco muda. A "key" e so um header que o PostgREST
// local ignora (sem jwt-secret configurado), qualquer valor serve.
const result = spawnSync("npx", ["vite", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    DESKTOP_BUILD: "1",
    VITE_DESKTOP_BUILD: "1",
    VITE_SUPABASE_URL: "http://127.0.0.1:3111",
    VITE_SUPABASE_PUBLISHABLE_KEY: "desktop-local",
  },
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const shell = resolve(root, "dist/client/_shell.html");
const index = resolve(root, "dist/client/index.html");

if (!existsSync(shell)) {
  console.error(`[build-desktop] esperava ${shell}, mas nao existe. O nome do shell mudou?`);
  process.exit(1);
}

copyFileSync(shell, index);
console.log(`[build-desktop] copiado ${shell} -> ${index}`);
