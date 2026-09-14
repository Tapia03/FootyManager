import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isDesktopBuild } from "@/lib/desktop-mode";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const navigate = useNavigate();
  useEffect(() => {
    // Desktop: sem login, direto pro dashboard (perfil local unico).
    if (isDesktopBuild) {
      navigate({ to: "/dashboard", replace: true });
      return;
    }
    supabase.auth.getUser().then(({ data }) => {
      navigate({ to: data.user ? "/dashboard" : "/auth", replace: true });
    });
  }, [navigate]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-muted-foreground">Carregando…</div>
    </div>
  );
}
