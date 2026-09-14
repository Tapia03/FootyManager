// Build estático do app (único build que existe agora — não tem mais versão
// web). Roda `vite build` e depois copia o shell pré-renderizado pra
// index.html, que é o nome que o Tauri espera encontrar em `frontendDist`.
// Ver project_desktop_windows_offline.md na memória do projeto.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync("npx", ["vite", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
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
