// Client do PostgREST local (banco do app desktop). Usa o pacote
// @supabase/supabase-js porque ele é só um client HTTP genérico pra
// qualquer servidor que fale o protocolo PostgREST — não tem nada de
// Supabase-a-nuvem envolvido aqui, é o mesmo PostgREST que roda embutido
// no app via sidecar (ver src-tauri/src/lib.rs e
// project_desktop_windows_offline.md na memória do projeto).
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// Endereço padrão: o PostgREST local que o app sobe sozinho (porta fixa em
// src-tauri/src/lib.rs, API_PORT). Dá pra sobrescrever via env var se um dia
// precisar rodar em outra porta.
const DEFAULT_URL = 'http://127.0.0.1:3111';
// O PostgREST local não tem jwt-secret configurado (trata tudo como o papel
// "authenticated"), então essa chave nunca é validada de verdade — só
// precisa existir pro client não reclamar.
const DEFAULT_KEY = 'local-desktop';

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    headers.set('apikey', supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createSupabaseClient() {
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || DEFAULT_URL;
  const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY;

  return createClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
    global: {
      fetch: createSupabaseFetch(SUPABASE_KEY),
    },
    auth: {
      // Sem sessão real — o app não tem login (ver src/lib/desktop-mode.ts).
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Importe assim: import { supabase } from "@/integrations/supabase/client";
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
