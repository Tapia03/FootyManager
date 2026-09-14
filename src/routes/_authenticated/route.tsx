import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { isDesktopBuild, LOCAL_USER_ID } from "@/lib/desktop-mode";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Desktop: sem login real, o unico "usuario" ja e o perfil local fixo.
    if (isDesktopBuild) return { user: { id: LOCAL_USER_ID } };
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: () => <Outlet />,
});