import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

// Config própria do projeto — sem depender de nenhum pacote da Lovable.
// O app agora é 100% desktop (Tauri + PGlite local), não existe mais build
// pra web/Cloudflare, então o build já sai sempre em modo estático (SPA):
// TanStack Start prerenderiza um `_shell.html` (ver scripts/build-desktop.mjs,
// que copia isso pra `index.html`, nome que o Tauri espera). Ver
// project_desktop_windows_offline.md na memória do projeto.
export default defineConfig(({ mode }) => {
  // Replica o comportamento padrão do Vite pra variáveis VITE_* — env vars
  // já definidas no processo (ex. passadas via spawnSync em build-desktop.mjs)
  // têm prioridade sobre o que estiver em arquivos .env, que é o mesmo
  // comportamento nativo do `loadEnv`.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const envDefine: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    envDefine[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  return {
    define: envDefine,
    css: { transformer: "lightningcss" },
    resolve: {
      alias: { "@": resolve(__dirname, "./src") },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
      ignoreOutdatedRequests: true,
    },
    server: { host: "::", port: 8080 },
    plugins: [
      tailwindcss(),
      tsConfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        importProtection: {
          behavior: "error",
          client: { files: ["**/server/**"], specifiers: ["server-only"] },
        },
        // Redireciona o entry de servidor do TanStack Start pro nosso
        // wrapper de erro (src/server.ts) — usado só durante o prerender
        // do build, não sobra servidor rodando em produção.
        server: { entry: "server" },
        // Gera um shell estático real (_shell.html) em vez de depender de
        // SSR sob demanda — é isso que o Tauri consegue empacotar dentro
        // do app nativo, sem precisar de servidor Node no runtime do usuário.
        spa: { enabled: true },
      }),
      viteReact(),
    ],
  };
});
