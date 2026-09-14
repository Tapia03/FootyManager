import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { objectiveLabel } from "@/game/board";
import { PageHeader, MetricCard, MeterBar, Pill, EmptyState } from "@/components/fm";
import { Award, Trophy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/saves/$saveId/career")({
  component: CareerPage,
});

// -----------------------------------------------------------------------------
// Carreira do técnico — não introduz tabela nova pro histórico: season_objectives
// já registra (clube, temporada, resultado) toda vez que um clube é "meu" numa
// temporada (ver ensureSeasonObjective em src/lib/board.ts), incluindo trocas
// de clube no meio do caminho — então já É, de fato, a trajetória da carreira.
// -----------------------------------------------------------------------------
function CareerPage() {
  const { saveId } = useParams({ from: "/_authenticated/saves/$saveId/career" });
  const qc = useQueryClient();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const save = useQuery({
    queryKey: ["save", saveId],
    queryFn: async () => (await supabase.from("saves").select("*").eq("id", saveId).single()).data,
  });

  const timeline = useQuery({
    queryKey: ["career-timeline", saveId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("season_objectives")
        .select("*, clubs(name), competitions(name)")
        .eq("save_id", saveId)
        .neq("status", "in_progress")
        .order("season", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const saveName = useMutation({
    mutationFn: async (name: string) => {
      const { error } = await supabase.from("saves").update({ manager_name: name || "Técnico" }).eq("id", saveId);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Nome atualizado."); qc.invalidateQueries({ queryKey: ["save", saveId] }); setEditingName(false); },
  });

  const titles = (timeline.data ?? []).filter((h) => h.final_position === 1).length;
  const reputation = save.data?.manager_reputation ?? 50;

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Award}
        title={
          editingName ? (
            <span className="flex items-center gap-2">
              <input
                autoFocus
                className="h-8 rounded border bg-background px-2 text-lg font-bold"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
              />
              <Button size="sm" onClick={() => saveName.mutate(nameDraft)} disabled={saveName.isPending}>Salvar</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>Cancelar</Button>
            </span>
          ) : (
            <span
              className="cursor-pointer hover:underline"
              onClick={() => { setNameDraft(save.data?.manager_name ?? ""); setEditingName(true); }}
              title="Clique para editar"
            >
              {save.data?.manager_name ?? "Técnico"}
            </span>
          )
        }
        subtitle="Trajetória e reputação do técnico."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard label="Títulos de campeão" icon={Trophy} tone="warn" value={titles} hint="na carreira" />
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="fm-eyebrow">Reputação do técnico</span>
          </div>
          <div className="mb-2 font-display text-2xl font-bold text-primary">{reputation}</div>
          <MeterBar value={reputation} tone="ok" />
        </div>
      </div>

      <Card className="p-4">
        <div className="fm-eyebrow mb-3">Trajetória</div>
        <div className="space-y-2">
          {timeline.data?.map((h) => (
            <div key={h.id} className="flex items-center justify-between gap-2 border-t border-border/50 pt-2 text-sm first:border-t-0 first:pt-0">
              <div>
                <span className="font-medium">Temporada {h.season}</span>
                <span className="text-muted-foreground"> — {h.clubs?.name ?? "?"} · {h.competitions?.name ?? "?"}</span>
                <div className="text-muted-foreground">
                  {objectiveLabel({ kind: h.kind, target: h.target })} · terminou em {h.final_position}º
                  {h.final_position === 1 ? " 🏆" : ""}
                </div>
              </div>
              <Pill tone={h.status === "met" ? "ok" : "danger"}>{h.status === "met" ? "Batida" : "Não batida"}</Pill>
            </div>
          ))}
          {timeline.data?.length === 0 && <EmptyState icon={Award} title="Nenhuma temporada concluída ainda" />}
        </div>
      </Card>
    </div>
  );
}
