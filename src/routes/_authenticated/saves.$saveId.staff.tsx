import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/game-hooks";
import { ensureCandidatePool, hireStaff, fireStaff } from "@/lib/staff";
import { STAFF_ROLES, STAFF_ROLE_LABELS, STAFF_ROLE_DESCRIPTIONS, type StaffRole } from "@/game/staff";
import { TRAINING_FOCUS_OPTIONS, TRAINING_FOCUS_LABELS, type TrainingFocus } from "@/game/training";
import { PageHeader } from "@/components/fm";
import { Briefcase } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/saves/$saveId/staff")({
  component: StaffPage,
});

function StaffPage() {
  const { saveId } = useParams({ from: "/_authenticated/saves/$saveId/staff" });
  const qc = useQueryClient();
  const [focus, setFocus] = useState<TrainingFocus | null>(null);

  const save = useQuery({
    queryKey: ["save", saveId],
    queryFn: async () => (await supabase.from("saves").select("*").eq("id", saveId).single()).data,
  });
  const myClubId = save.data?.my_club_id;
  const today = save.data?.game_date;

  const club = useQuery({
    queryKey: ["club-training", myClubId],
    enabled: !!myClubId,
    queryFn: async () => (await supabase.from("clubs").select("training_focus").eq("id", myClubId!).single()).data,
  });
  useEffect(() => {
    if (club.data?.training_focus && focus === null) setFocus(club.data.training_focus as TrainingFocus);
  }, [club.data, focus]);

  const pool = useQuery({
    queryKey: ["staff", saveId, myClubId],
    enabled: !!myClubId,
    queryFn: async () => {
      await ensureCandidatePool(saveId);
      const { data, error } = await supabase.from("staff").select("*").eq("save_id", saveId).or(`club_id.eq.${myClubId},club_id.is.null`);
      if (error) throw error;
      return data ?? [];
    },
  });

  const hire = useMutation({
    mutationFn: (vars: { staffId: string; role: StaffRole }) => hireStaff(saveId, myClubId!, vars.staffId, vars.role, today!),
    onSuccess: () => { toast.success("Contratado."); qc.invalidateQueries(); },
    onError: (e: any) => toast.error(e.message ?? "Falha"),
  });
  const fire = useMutation({
    mutationFn: (staffId: string) => fireStaff(staffId),
    onSuccess: () => { toast.info("Demitido."); qc.invalidateQueries(); },
  });

  const saveFocus = useMutation({
    mutationFn: async () => {
      if (!focus) return;
      const { error } = await supabase.from("clubs").update({ training_focus: focus }).eq("id", myClubId!);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Foco de treino salvo."); qc.invalidateQueries(); },
  });

  const mine = (role: StaffRole) => (pool.data ?? []).find((s) => s.club_id === myClubId && s.role === role);
  const candidatesFor = (role: StaffRole) => (pool.data ?? []).filter((s) => s.club_id === null && s.role === role);

  return (
    <div className="space-y-4">
      <PageHeader icon={Briefcase} title="Comissão técnica" subtitle="Contrate auxiliares e defina o foco de treino do time." />
      <div className="grid md:grid-cols-3 gap-4">
        {STAFF_ROLES.map((role) => {
          const hired = mine(role);
          return (
            <Card key={role} className="p-4">
              <div className="font-semibold">{STAFF_ROLE_LABELS[role]}</div>
              <p className="text-xs text-muted-foreground mb-3">{STAFF_ROLE_DESCRIPTIONS[role]}</p>
              {hired ? (
                <div className="space-y-2">
                  <div className="font-medium">{hired.name}</div>
                  <div className="text-sm text-muted-foreground">Nota {hired.skill}/20 · {formatMoney(hired.wage)}/quinzena</div>
                  <Button size="sm" variant="destructive" onClick={() => fire.mutate(hired.id)} disabled={fire.isPending}>
                    Demitir
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {candidatesFor(role).map((c) => (
                    <div key={c.id} className="flex items-center justify-between border rounded-md p-2 text-sm">
                      <div>
                        <div className="font-medium">{c.name}</div>
                        <div className="text-xs text-muted-foreground">Nota {c.skill}/20 · {formatMoney(c.wage)}/quinzena</div>
                      </div>
                      <Button size="sm" onClick={() => hire.mutate({ staffId: c.id, role })} disabled={hire.isPending}>
                        Contratar
                      </Button>
                    </div>
                  ))}
                  {candidatesFor(role).length === 0 && <div className="text-sm text-muted-foreground">Nenhum candidato disponível.</div>}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="p-4">
        <div className="fm-eyebrow mb-3">Foco de treino</div>
        <div className="flex flex-wrap gap-2">
          {TRAINING_FOCUS_OPTIONS.map((f) => (
            <button
              key={f}
              onClick={() => setFocus(f)}
              className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                focus === f ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"
              }`}
            >
              {TRAINING_FOCUS_LABELS[f]}
            </button>
          ))}
        </div>
        <Button className="mt-3" size="sm" onClick={() => saveFocus.mutate()} disabled={saveFocus.isPending || !focus || focus === club.data?.training_focus}>
          Salvar
        </Button>
      </Card>
    </div>
  );
}
