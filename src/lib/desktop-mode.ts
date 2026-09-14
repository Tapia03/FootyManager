// Deteccao de build desktop (Tauri + PGlite local, sem login de verdade —
// decisao confirmada com o usuario). Ver project_desktop_windows_offline.md
// na memoria do projeto pra arquitetura completa.
//
// VITE_DESKTOP_BUILD e definido em scripts/build-desktop.mjs só quando builda
// pro Tauri; no build web normal (Lovable) essa variavel nao existe e o app
// continua pedindo login normalmente.
import { supabase } from "@/integrations/supabase/client";

export const isDesktopBuild = import.meta.env.VITE_DESKTOP_BUILD === "1";

// Mesmo UUID fake criado pelo shim de auth.uid() em scripts/local-db-server.mjs.
// A coluna saves.user_id ja tem DEFAULT pra esse valor no banco local (ver
// DESKTOP_PATCH no mesmo script), mas mandamos explicito aqui tambem pra o
// codigo ficar claro sobre o que esta acontecendo.
export const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";

// Substitui `supabase.auth.getUser().data.user?.id` nos lugares que só
// precisam saber "quem é o usuário atual" — no desktop não existe sessão
// real pra consultar (o PostgREST local não expõe o schema `auth`).
export async function getCurrentUserId(): Promise<string | null> {
  if (isDesktopBuild) return LOCAL_USER_ID;
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}
