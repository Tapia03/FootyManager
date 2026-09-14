import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useMemo, useState, useEffect, useRef } from "react";
import { formationSlots, autoLineup, rateTacticalTeam, ratingToDisplay, familiarityFor, TACTIC_STYLES } from "@/game/tactics";
import { rolesForPosition, resolveRole, mirrorDiagramForCanonical, type RoleDef } from "@/game/roles";
import {
  DEFAULT_INSTRUCTIONS, normalizeInstructions, isDefaultInstructions, INSTRUCTION_META, ROAM_META,
  type PlayerInstructions, type InstructionLevel,
} from "@/game/player-instructions";
import { SET_PIECE_ROLES, suggestSetPieceTakers, type SetPieceRole } from "@/game/set-pieces";
import { toTacticExport, parseTacticExport, TacticImportError } from "@/game/tactic-export";
import {
  MATCH_GOAL_KINDS, MATCH_GOAL_HAS_THRESHOLD, matchGoalDefaultThreshold, matchGoalLabel,
  type MatchGoalKind, type PlayerMatchGoal,
} from "@/game/match-goals";
import { slotCoords } from "@/game/formation-layout";
import { checkAvailability } from "@/game/availability";
import { clubColors, contrastText } from "@/game/club-colors";
import { PageHeader, MeterBar, Pill, RatingBadge, ratingTone, TONE_TEXT } from "@/components/fm";
import type { FormationCode, GranularPosition, Mentality, PassingStyle, TeamFluidity } from "@/game/types";
import { positionLabel } from "@/game/types";
import { Star, Target, X, ArrowLeftRight, SlidersHorizontal, Download, Upload } from "lucide-react";

export const Route = createFileRoute("/_authenticated/saves/$saveId/tactics")({
  component: TacticsPage,
});

// Instantâneo de um esquema tático salvo (clubs.tactic_presets, jsonb[]) —
// ver comentário na migration 20260911180000_tactic_presets.sql.
interface TacticPreset {
  id: string;
  name: string;
  formation: FormationCode;
  mentality: Mentality;
  pressing: number;
  defensive_line: number;
  tempo: number;
  passing_style: PassingStyle;
  team_fluidity?: TeamFluidity;
  lineup: { slot: string; playerId: string; role: string; instructions?: PlayerInstructions }[];
}

// Snapshot completo (mesmo shape de TacticPreset, sem id/name) — usado tanto
// pra salvar um esquema novo quanto pro override "só pra próxima partida"
// (ver src/lib/live-match.ts::applyPendingOverride).
type TacticSnapshot = Omit<TacticPreset, "id" | "name">;

const FLUIDITY_OPTIONS: { value: TeamFluidity; label: string }[] = [
  { value: "structured", label: "Estruturado" },
  { value: "fluid", label: "Fluido" },
];

// Os 3 toggles de fase (Menos/Padrão/Mais) mapeiam pra um valor 1-5 real dos
// campos já existentes (pressão/linha/ritmo) — "Menos"=1, "Padrão"=3,
// "Mais"=5. Quem quiser o valor exato 2/4 ainda tem os sliders em "Ajustes
// finos" (ver SliderRow mais abaixo) — o toggle é só o atalho no estilo FM.
type DialLevel = "low" | "mid" | "high";
function dialLevel(n: number): DialLevel {
  return n <= 2 ? "low" : n >= 4 ? "high" : "mid";
}
function dialValue(level: DialLevel): number {
  return level === "low" ? 1 : level === "high" ? 5 : 3;
}
const LOW_MID_HIGH: { value: DialLevel; label: string }[] = [
  { value: "low", label: "Menos" }, { value: "mid", label: "Padrão" }, { value: "high", label: "Mais" },
];
const LINE_LEVELS: { value: DialLevel; label: string }[] = [
  { value: "low", label: "Recuada" }, { value: "mid", label: "Média" }, { value: "high", label: "Alta" },
];

const FORMATION_CODES: FormationCode[] = ["4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-3-2", "4-1-4-1"];
const MENTALITIES: { value: Mentality; label: string }[] = [
  { value: "defensive", label: "Defensiva" },
  { value: "balanced", label: "Equilibrada" },
  { value: "attacking", label: "Ofensiva" },
];
const PASSING_STYLES: { value: PassingStyle; label: string }[] = [
  { value: "short", label: "Passes curtos" },
  { value: "mixed", label: "Passe misto" },
  { value: "direct", label: "Jogo direto" },
];
// Taxonomia de função (nomes, elegibilidade por posição, atribuição,
// diagrama) mora inteira em src/game/roles.ts agora — ~38 famílias reais do
// FM (Zagueiro Construtor, Box-to-Box, Falso Nove...) × atribuição
// (Defender/Apoiar/Atacar), cada uma só oferecida nas posições em que faz
// sentido de verdade (rolesForPosition). Isso é o que resolve o pedido do
// user: um centroavante não aparece mais na lista de função de um zagueiro.

function RoleDiagram({ role, canonical }: { role: RoleDef; canonical: GranularPosition }) {
  const d = mirrorDiagramForCanonical(role.diagram, canonical);
  const x2 = Math.max(4, Math.min(96, d.x + d.dx));
  const y2 = Math.max(4, Math.min(136, d.y + d.dy));
  return (
    <svg viewBox="0 0 100 140" className="h-28 w-20 shrink-0 rounded border bg-[#154620]">
      <rect x="2" y="2" width="96" height="136" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
      <line x1="2" y1="70" x2="98" y2="70" stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
      <circle cx="50" cy="70" r="10" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
      <rect x="22" y="2" width="56" height="18" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
      <rect x="22" y="120" width="56" height="18" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
      <defs>
        <marker id="role-arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#eab308" />
        </marker>
      </defs>
      <line
        x1={d.x} y1={d.y} x2={x2} y2={y2}
        stroke="#eab308" strokeWidth="2.5" markerEnd="url(#role-arrow)"
      />
      <circle cx={d.x} cy={d.y} r="4" fill="#fff" stroke="#000" strokeWidth="0.5" />
    </svg>
  );
}

// Estrela pra ranquear CANDIDATOS a um slot (popup de troca de jogador) —
// antes de escolher função, então usa a MELHOR função legal daquela posição
// pro jogador (a que ele tem mais aptidão), não uma função específica.
function roleAbilityStars(player: any, canonical: GranularPosition): number {
  const fam = familiarityFor(player, canonical as any);
  const legal = rolesForPosition(canonical);
  const best = legal.length
    ? Math.max(...legal.map((r) => signatureFit(player, r.signature)))
    : (player.overall ?? 50) / 100;
  const score = best * fam.multiplier;
  return Math.max(1, Math.min(5, Math.round(score * 5)));
}

function signatureFit(player: any, signature: string[]): number {
  const a = player.attributes ?? {};
  const sigAvg = signature.length ? signature.reduce((s: number, k: string) => s + (a[k] ?? 10), 0) / signature.length : 10;
  return (sigAvg / 20) * 0.7 + ((player.overall ?? 50) / 100) * 0.3;
}

// Estrela pra uma função ESPECÍFICA (popup de função) — compara funções entre
// si pro mesmo jogador na mesma posição.
function roleFitStars(player: any, role: RoleDef, canonical: GranularPosition): number {
  const fam = familiarityFor(player, canonical as any);
  const score = signatureFit(player, role.signature) * fam.multiplier;
  return Math.max(1, Math.min(5, Math.round(score * 5)));
}

function Stars({ n }: { n: number }) {
  return (
    <div className="flex gap-[1px]">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} className={`size-3 ${i < n ? "fill-warn text-warn" : "text-muted-foreground/30"}`} />
      ))}
    </div>
  );
}

function initialsOf(name: string) {
  return name.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

function conditionColor(v: number) {
  return v >= 80 ? "text-ok" : v >= 50 ? "text-warn" : "text-danger";
}

function TacticsPage() {
  const { saveId } = useParams({ from: "/_authenticated/saves/$saveId/tactics" });
  const qc = useQueryClient();

  const save = useQuery({
    queryKey: ["save", saveId],
    queryFn: async () => (await supabase.from("saves").select("*").eq("id", saveId).single()).data,
  });
  const clubId = save.data?.my_club_id ?? null;
  const todayISO = save.data?.game_date as string | undefined;

  const club = useQuery({
    queryKey: ["club-tactics", clubId],
    enabled: !!clubId,
    queryFn: async () => (await supabase.from("clubs").select("*").eq("id", clubId!).single()).data,
  });
  const players = useQuery({
    queryKey: ["players", clubId],
    enabled: !!clubId,
    queryFn: async () => (await supabase.from("players").select("*").eq("club_id", clubId!)).data ?? [],
  });
  const lineup = useQuery({
    queryKey: ["lineup", clubId],
    enabled: !!clubId,
    queryFn: async () => (await supabase.from("tactic_lineups").select("*").eq("club_id", clubId!)).data ?? [],
  });

  const [formation, setFormation] = useState<FormationCode>("4-4-2");
  const [mentality, setMentality] = useState<Mentality>("balanced");
  const [pressing, setPressing] = useState(3);
  const [defLine, setDefLine] = useState(3);
  const [tempo, setTempo] = useState(3);
  const [passing, setPassing] = useState<PassingStyle>("mixed");
  const [fluidity, setFluidity] = useState<TeamFluidity>("structured");
  // Escopo do "Salvar" (estilo FM: "Aplicar a: Todas as partidas / Só a
  // próxima") — "next" não toca nas colunas permanentes de `clubs` nem em
  // `tactic_lineups`, só grava um snapshot em `clubs.pending_override` (ver
  // src/lib/live-match.ts::applyPendingOverride, que aplica isso por cima na
  // hora de simular e o limpa sozinho depois — src/lib/advance-day.ts).
  const [scope, setScope] = useState<"permanent" | "next">("permanent");
  const [slotAssign, setSlotAssign] = useState<Record<string, { playerId: string; role: string; instructions?: PlayerInstructions }>>({});
  // Slot aberto no seletor de jogador (clique no boneco, estilo "Swap X
  // with..." do FM) — alternativa ao arrastar, mais fácil de descobrir e de
  // usar num elenco grande. Os dois caminhos levam à mesma função de troca.
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  // Slot com o popup de FUNÇÃO aberto — lista de funções com estrelas
  // (na função, pro jogador ATUAL do slot) + descrição, estilo FM.
  const [roleSlot, setRoleSlot] = useState<string | null>(null);
  // Slot com o popup de INSTRUÇÕES DE JOGADOR aberto — a 3ª camada além de
  // Função+Atribuição (pressão/entradas/marcação/liberdade de movimento/
  // passe/drible/finalização/risco), ver src/game/player-instructions.ts.
  const [instructionsSlot, setInstructionsSlot] = useState<string | null>(null);
  // Cobradores de bola parada — "" = deixar o motor escolher o melhor do XI.
  const [takers, setTakers] = useState<Record<SetPieceRole, string>>({
    penalty: "", free_kick: "", corner: "", captain: "",
  });
  // Esquemas táticos salvos em paralelo ("1 / 2 / +" do FM) — cada um é um
  // instantâneo autocontido (formação+instruções+escalação) guardado em
  // `clubs.tactic_presets` (jsonb). Independente da tática ATIVA (que
  // continua sendo os campos soltos de `clubs` + `tactic_lineups`, lidos
  // pelo motor de simulação) — presets são só ponto de partida pra carregar
  // por cima do estado local, nada muda de verdade até apertar "Salvar".
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [newPresetOpen, setNewPresetOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const presets: TacticPreset[] = (club.data as any)?.tactic_presets ?? [];

  useEffect(() => {
    if (!club.data) return;
    setFormation(club.data.formation as FormationCode);
    setMentality(club.data.mentality as Mentality);
    setPressing(club.data.pressing);
    setDefLine(club.data.defensive_line);
    setTempo(club.data.tempo);
    setPassing(club.data.passing_style as PassingStyle);
    setFluidity(((club.data as any).team_fluidity as TeamFluidity) ?? "structured");
    setTakers({
      penalty: (club.data as any).penalty_taker_id ?? "",
      free_kick: (club.data as any).free_kick_taker_id ?? "",
      corner: (club.data as any).corner_taker_id ?? "",
      captain: (club.data as any).captain_id ?? "",
    });
  }, [club.data]);

  useEffect(() => {
    if (!lineup.data || !players.data) return;
    if (lineup.data.length > 0) {
      const map: typeof slotAssign = {};
      for (const l of lineup.data) map[l.slot] = { playerId: l.player_id, role: l.role ?? "", instructions: normalizeInstructions((l as any).instructions) };
      setSlotAssign(map);
    }
  }, [lineup.data, players.data]);

  const slots = useMemo(() => formationSlots(formation), [formation]);

  function autoFill() {
    if (!players.data || !todayISO) return;
    // autoLineup() não filtra disponibilidade sozinho (confia em quem
    // recebe) — sem isso, "Auto-escalar" podia colocar direto um jogador
    // lesionado/suspenso no XI titular, que ia pra partida de verdade (ver
    // changeHalftimeFormation em src/lib/live-match.ts, que já filtra certo).
    const available = (players.data as any[]).filter((p) => checkAvailability(p, todayISO).available);
    const xi = autoLineup(available as any, formation);
    const map: typeof slotAssign = {};
    for (const e of xi.entries) map[e.slot.slot] = { playerId: e.player.id, role: e.slot.defaultRole };
    setSlotAssign(map);
  }

  // Põe `playerId` no `targetSlot` — se ele já estava em OUTRO slot, os dois
  // trocam de lugar (em vez do slot de origem ficar vazio). Usada tanto pelo
  // drag&drop quanto pelo seletor de clique (`pickerSlot`), pra não ter duas
  // lógicas de troca divergindo com o tempo.
  function assignPlayerToSlot(targetSlot: string, playerId: string) {
    setSlotAssign((prev) => {
      const next = { ...prev };
      const sourceSlotEntry = Object.entries(prev).find(([slot, v]) => slot !== targetSlot && v.playerId === playerId);
      const targetEntry = prev[targetSlot];
      if (sourceSlotEntry) {
        const [sourceSlot] = sourceSlotEntry;
        if (targetEntry) next[sourceSlot] = targetEntry; else delete next[sourceSlot];
      }
      next[targetSlot] = { playerId, role: prev[targetSlot]?.role ?? "", instructions: prev[targetSlot]?.instructions };
      return next;
    });
  }

  // Carrega um preset salvo pro estado de trabalho local — não persiste
  // sozinho, só troca o que a tela mostra (igual trocar de aba no FM: o
  // usuário ainda decide se aperta "Salvar" depois, ou só está espiando).
  function loadPreset(preset: TacticPreset) {
    setFormation(preset.formation);
    setMentality(preset.mentality);
    setPressing(preset.pressing);
    setDefLine(preset.defensive_line);
    setTempo(preset.tempo);
    setPassing(preset.passing_style);
    setFluidity(preset.team_fluidity ?? "structured");
    const map: typeof slotAssign = {};
    for (const l of preset.lineup) map[l.slot] = { playerId: l.playerId, role: l.role, instructions: normalizeInstructions(l.instructions) };
    setSlotAssign(map);
    setActivePresetId(preset.id);
  }

  // Aplica um arquivo importado (item 05 do backlog FootSim) — mesmo
  // espírito do loadPreset (só troca o rascunho, "Salvar" é que aplica de
  // verdade), mas SEM playerId (o arquivo nunca carrega isso, ver
  // src/game/tactic-export.ts) — os slots entram com função+instruções
  // prontas, sem jogador escalado; quem importou escala pelos próprios
  // meios (Auto-escalar ou clicar em cada boneco) igual já faz ao trocar de
  // formação hoje.
  function applyTacticImport(parsed: ReturnType<typeof parseTacticExport>) {
    setFormation(parsed.formation);
    setMentality(parsed.mentality);
    setPressing(parsed.pressing);
    setDefLine(parsed.defensive_line);
    setTempo(parsed.tempo);
    setPassing(parsed.passing_style);
    setFluidity(parsed.team_fluidity);
    const map: typeof slotAssign = {};
    for (const s of parsed.slots) map[s.slot] = { playerId: "", role: s.role, instructions: s.instructions };
    setSlotAssign(map);
    setActivePresetId(null);
  }

  function exportCurrentTactic() {
    const data = toTacticExport(currentTacticSnapshot());
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tatica-${formation}-${mentality}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportFile(file: File) {
    try {
      const text = await file.text();
      const parsed = parseTacticExport(JSON.parse(text));
      applyTacticImport(parsed);
      toast.success("Tática importada — revise a escalação e clique em Salvar pra aplicar de verdade.");
    } catch (e) {
      const msg = e instanceof TacticImportError ? e.message
        : e instanceof SyntaxError ? "Arquivo não é um JSON válido."
        : "Falha ao importar arquivo.";
      toast.error(msg);
    }
  }

  const presetsMutation = useMutation({
    mutationFn: async (next: TacticPreset[]) => {
      if (!clubId) return;
      const { error } = await supabase.from("clubs").update({ tactic_presets: next } as any).eq("id", clubId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["club-tactics", clubId] }),
    onError: (e: any) => toast.error(e.message ?? "Erro ao salvar esquemas"),
  });

  // Escalação atual no shape salvo (TacticSnapshot["lineup"]) — reaproveitado
  // pelo preset novo E pelo override "só pra próxima partida".
  function currentLineupSnapshot() {
    return Object.entries(slotAssign)
      .filter(([, v]) => v.playerId)
      .map(([slot, v]) => ({
        slot, playerId: v.playerId, role: v.role || slots.find((s) => s.slot === slot)?.defaultRole || "",
        instructions: normalizeInstructions(v.instructions),
      }));
  }

  function currentTacticSnapshot(): TacticSnapshot {
    return {
      formation, mentality, pressing, defensive_line: defLine, tempo, passing_style: passing,
      team_fluidity: fluidity, lineup: currentLineupSnapshot(),
    };
  }

  function saveCurrentAsNewPreset(name: string) {
    const id = `${Date.now()}`;
    const preset: TacticPreset = {
      id, name: name.trim() || `Esquema ${presets.length + 1}`,
      ...currentTacticSnapshot(),
    };
    presetsMutation.mutate([...presets, preset]);
    setActivePresetId(id);
  }

  function deletePreset(id: string) {
    presetsMutation.mutate(presets.filter((p) => p.id !== id));
    if (activePresetId === id) setActivePresetId(null);
  }

  // Metas individuais por partida (backlog FootSim #06) — some sozinho
  // depois que a próxima partida resolve, ver advance-day.ts.
  const matchGoals: PlayerMatchGoal[] = (club.data as any)?.player_match_goals ?? [];
  const matchGoalsMutation = useMutation({
    mutationFn: async (next: PlayerMatchGoal[]) => {
      if (!clubId) return;
      const { error } = await supabase.from("clubs").update({ player_match_goals: next } as any).eq("id", clubId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["club-tactics", clubId] }),
    onError: (e: any) => toast.error(e.message ?? "Erro ao salvar metas"),
  });
  const [goalPlayerId, setGoalPlayerId] = useState("");
  const [goalKind, setGoalKind] = useState<MatchGoalKind>("score_goals");
  const [goalThreshold, setGoalThreshold] = useState<number | undefined>(matchGoalDefaultThreshold("score_goals"));

  function addMatchGoal() {
    if (!goalPlayerId) return;
    const playerName = playerNameById(goalPlayerId);
    const next: PlayerMatchGoal = { playerId: goalPlayerId, playerName, kind: goalKind, threshold: goalThreshold };
    matchGoalsMutation.mutate([...matchGoals.filter((g) => g.playerId !== goalPlayerId), next]);
    setGoalPlayerId("");
  }

  function removeMatchGoal(playerId: string) {
    matchGoalsMutation.mutate(matchGoals.filter((g) => g.playerId !== playerId));
  }

  const save_ = useMutation({
    mutationFn: async () => {
      if (!clubId) return;

      // Cobradores de bola parada/capitão são sempre permanentes — não fazem
      // parte do escopo "só a próxima partida" (são mais um papel fixo do
      // elenco do que uma escolha tática de uma partida específica).
      await supabase.from("clubs").update({
        penalty_taker_id: takers.penalty || null,
        free_kick_taker_id: takers.free_kick || null,
        corner_taker_id: takers.corner || null,
        captain_id: takers.captain || null,
      }).eq("id", clubId);

      if (scope === "next") {
        // "Só a próxima partida" — não toca nas colunas permanentes de
        // `clubs` nem em `tactic_lineups`; só grava o snapshot inteiro em
        // `pending_override` (ver src/lib/live-match.ts::applyPendingOverride,
        // que aplica isso na hora de simular e limpa sozinho depois do jogo —
        // src/lib/advance-day.ts).
        const { error } = await supabase.from("clubs")
          .update({ pending_override: currentTacticSnapshot() } as any).eq("id", clubId);
        if (error) throw error;
        return;
      }

      // "Todas as partidas" (permanente, comportamento de sempre) — limpa
      // qualquer override pendente: a mudança permanente já substitui a
      // intenção de "só dessa vez".
      await supabase.from("clubs").update({
        formation, mentality, pressing, defensive_line: defLine, tempo, passing_style: passing,
        team_fluidity: fluidity, pending_override: null,
      } as any).eq("id", clubId);
      await supabase.from("tactic_lineups").delete().eq("club_id", clubId);
      const rows = slots
        .filter((s) => slotAssign[s.slot]?.playerId)
        .map((s) => ({
          save_id: saveId, club_id: clubId,
          player_id: slotAssign[s.slot].playerId,
          slot: s.slot,
          role: slotAssign[s.slot].role || s.defaultRole,
          instructions: normalizeInstructions(slotAssign[s.slot].instructions),
          is_starter: true,
        }));
      if (rows.length > 0) {
        // "instructions" ainda não está nos tipos gerados do Supabase
        // (mesmo padrão de tactic_presets/penalty_taker_id) — `as any`.
        const { error } = await supabase.from("tactic_lineups").insert(rows as any);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(scope === "next" ? "Tática salva — vale só pra próxima partida" : "Tática salva");
      qc.invalidateQueries({ queryKey: ["club-tactics", clubId] });
      qc.invalidateQueries({ queryKey: ["lineup", clubId] });
      qc.invalidateQueries({ queryKey: ["club", clubId] });
    },
    onError: (e: any) => toast.error(e.message ?? "Erro ao salvar tática"),
  });

  if (!clubId || club.isLoading || players.isLoading) {
    return <div className="text-muted-foreground">Carregando…</div>;
  }

  const allPlayers = (players.data ?? []) as any[];
  const usedIds = new Set(Object.values(slotAssign).map((v) => v.playerId).filter(Boolean));

  // Cores do uniforme do clube — os tokens dos jogadores no campo usam elas
  // (mesma ideia do protótipo do AI Studio que o usuário curtiu).
  const kit = clubColors(club.data as any);
  const kitText = contrastText(kit.primary);

  const filledEntries = slots
    .map((s) => ({ slot: s, player: slotAssign[s.slot] ? allPlayers.find((p) => p.id === slotAssign[s.slot].playerId) : undefined }))
    .filter((e) => e.player);

  // XI atual (pela escalação no campo) + sugestão automática de cobradores.
  const xiPlayers = filledEntries.map((e) => e.player);
  const suggested = suggestSetPieceTakers(xiPlayers as any);
  const suggestedByRole: Record<SetPieceRole, string | null> = {
    penalty: suggested.penalty_taker_id, free_kick: suggested.free_kick_taker_id,
    corner: suggested.corner_taker_id, captain: suggested.captain_id,
  };
  const playerNameById = (id: string) => allPlayers.find((p) => p.id === id)?.name ?? "—";
  const effectiveCaptainId = takers.captain || suggestedByRole.captain || "";
  const avgFamiliarity = filledEntries.length > 0
    ? filledEntries.reduce((acc, e) => acc + familiarityFor(e.player, e.slot.canonical).multiplier, 0) / filledEntries.length
    : 0;
  const familiarityPct = Math.round(avgFamiliarity * 100);
  const intensityPct = Math.round(((pressing + tempo) / 10) * 100);

  // Força do time — mesma conta que o motor de simulação faz de verdade
  // (rateTacticalTeam, com os modificadores táticos já aplicados), pra dar
  // ao usuário uma prévia do ataque/meio/defesa antes de entrar em campo.
  const savedLineupForRating = Object.entries(slotAssign)
    .filter(([, v]) => v.playerId)
    .map(([slot, v]) => ({ player_id: v.playerId, slot, role: v.role || null, instructions: v.instructions }));
  const teamRating = rateTacticalTeam(
    allPlayers,
    { formation, mentality, pressing, defensive_line: defLine, tempo, passing_style: passing },
    savedLineupForRating,
    todayISO,
  );
  const ratingPct = (v: number) => Math.max(4, ratingToDisplay(v));

  // Template ativo — só marca destaque quando os 5 campos batem EXATAMENTE
  // com um estilo catalogado; qualquer ajuste manual depois desmarca (o
  // template é só um atalho de partida, não um "modo" que trava a tela).
  const activeStyleKey = TACTIC_STYLES.find((t) =>
    t.mentality === mentality && t.pressing === pressing && t.defensive_line === defLine && t.tempo === tempo && t.passing_style === passing,
  )?.key ?? null;
  function applyTacticStyle(style: (typeof TACTIC_STYLES)[number]) {
    setMentality(style.mentality);
    setPressing(style.pressing);
    setDefLine(style.defensive_line);
    setTempo(style.tempo);
    setPassing(style.passing_style);
  }

  return (
   <div className="space-y-4">
    <PageHeader
      icon={Target}
      title="Quadro tático & escalação"
      subtitle="Esquema, mentalidade e instruções — arraste jogadores no campo pra montar o XI."
      actions={
        <>
          <Button size="sm" variant="outline" onClick={autoFill}>Auto-escalar</Button>
          <select
            className="h-8 rounded border bg-background px-2 text-xs"
            value={scope}
            onChange={(e) => setScope(e.target.value as "permanent" | "next")}
            title="Aplicar mudança tática a"
          >
            <option value="permanent">Todas as partidas</option>
            <option value="next">Só a próxima partida</option>
          </select>
          <Button size="sm" className="font-semibold" onClick={() => save_.mutate()} disabled={save_.isPending}>
            {save_.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </>
      }
    />

    <div className="grid gap-4 xl:grid-cols-[260px_1fr_360px]">
      <Card className="p-4 space-y-4 h-fit">
        <div>
          <div className="fm-eyebrow mb-1.5">Esquemas salvos</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {presets.map((p, i) => (
              <div key={p.id} className="group relative">
                <button
                  type="button"
                  onClick={() => loadPreset(p)}
                  title={p.name}
                  className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-semibold transition-colors ${
                    activePresetId === p.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {i + 1}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deletePreset(p.id); }}
                  title={`Excluir "${p.name}"`}
                  className="absolute -right-1 -top-1 hidden size-3.5 items-center justify-center rounded-full bg-danger text-[8px] text-white group-hover:flex"
                >
                  <X className="size-2.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => { setNewPresetName(""); setNewPresetOpen(true); }}
              title="Salvar esquema atual como novo"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
            >
              +
            </button>
          </div>
          {presets.length > 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Clique num número pra carregar o esquema (só troca a tela — "Salvar" embaixo é que aplica de verdade).
            </p>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={exportCurrentTactic}
              title="Exportar tática atual como arquivo .json"
              className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Download className="size-3" /> Exportar
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              title="Importar tática de um arquivo .json (formação + função + instruções, sem escalação)"
              className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Upload className="size-3" /> Importar
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImportFile(f);
                e.target.value = "";
              }}
            />
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Importar traz formação, função e instruções por posição — nunca jogadores específicos (só existem no save de origem). Escale o elenco depois.
          </p>
        </div>

        <div>
          <div className="fm-eyebrow mb-1">Estilo tático</div>
          <select
            className="w-full h-9 px-2 rounded border bg-background text-sm font-semibold"
            value={formation} onChange={(e) => setFormation(e.target.value as FormationCode)}
          >
            {FORMATION_CODES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        <div>
          <div className="fm-eyebrow mb-1.5">Mentalidade</div>
          <div className="grid grid-cols-3 gap-1">
            {MENTALITIES.map((m) => (
              <button
                key={m.value}
                onClick={() => setMentality(m.value)}
                className={`text-[11px] py-1.5 rounded border transition-colors ${
                  mentality === m.value
                    ? "bg-primary text-primary-foreground border-primary font-semibold"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="fm-eyebrow mb-1.5">Estilo de jogo</div>
          <div className="grid grid-cols-2 gap-1">
            {TACTIC_STYLES.map((style) => (
              <button
                key={style.key}
                type="button"
                title={style.desc}
                onClick={() => applyTacticStyle(style)}
                className={`rounded border px-1.5 py-1.5 text-left text-[10px] font-semibold leading-tight transition-colors ${
                  activeStyleKey === style.key
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {style.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Aplica mentalidade/pressão/linha/ritmo/passe de uma vez, coerentes com a filosofia — não mexe em formação nem escalação.
          </p>
        </div>

        <div>
          <div className="fm-eyebrow mb-1.5">Fluidez do time</div>
          <div className="grid grid-cols-2 gap-1">
            {FLUIDITY_OPTIONS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFluidity(f.value)}
                title="O quanto o time se solta da posição fixa em campo — fluido troca mais de zona, estruturado fica mais disciplinado."
                className={`text-[11px] py-1.5 rounded border transition-colors ${
                  fluidity === f.value
                    ? "bg-primary text-primary-foreground border-primary font-semibold"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <PhaseSection title="Em posse">
          <ToggleRow label="Passe" value={passing} onChange={setPassing} options={PASSING_STYLES} />
          <ToggleRow label="Ritmo" value={dialLevel(tempo)} onChange={(v) => setTempo(dialValue(v))} options={LOW_MID_HIGH} />
        </PhaseSection>
        <PhaseSection title="Em transição">
          <ToggleRow label="Contrapressão" value={dialLevel(pressing)} onChange={(v) => setPressing(dialValue(v))} options={LOW_MID_HIGH} />
        </PhaseSection>
        <PhaseSection title="Sem a bola">
          <ToggleRow label="Pressão" value={dialLevel(pressing)} onChange={(v) => setPressing(dialValue(v))} options={LOW_MID_HIGH} />
          <ToggleRow label="Linha defensiva" value={dialLevel(defLine)} onChange={(v) => setDefLine(dialValue(v))} options={LINE_LEVELS} />
        </PhaseSection>

        <details className="pt-2 border-t">
          <summary className="fm-eyebrow cursor-pointer select-none">Ajustes finos (valor exato 1-5)</summary>
          <div className="mt-2 space-y-3">
            <SliderRow label="Pressão" value={pressing} onChange={setPressing} />
            <SliderRow label="Linha defensiva" value={defLine} onChange={setDefLine} />
            <SliderRow label="Ritmo" value={tempo} onChange={setTempo} />
          </div>
        </details>
      </Card>

      <div className="space-y-3">
        <Card className="p-3">
          <div className="grid grid-cols-2 gap-4">
            <MeterBar label="Familiaridade tática" value={familiarityPct} showValue tone="ok" />
            <MeterBar label="Intensidade" value={intensityPct} showValue tone="warn" />
          </div>
        </Card>

        <Card className="p-3">
          <div className="fm-eyebrow mb-2 flex items-center justify-between">
            <span>Força do time com esta escalação/tática</span>
            {Math.abs(teamRating.chemistry - 1) >= 0.005 && (
              <Pill tone={teamRating.chemistry > 1 ? "ok" : "warn"} title="Química de elenco: quanto mais tempo os titulares já jogam juntos neste clube, maior o ganho (e vice-versa).">
                Química {teamRating.chemistry > 1 ? "+" : ""}{Math.round((teamRating.chemistry - 1) * 100)}%
              </Pill>
            )}
          </div>
          <div className="grid grid-cols-3 gap-4">
            <MeterBar label={<span className="flex w-full justify-between"><span>Ataque</span><span className="font-semibold text-foreground">{ratingToDisplay(teamRating.attack)}</span></span>} value={ratingPct(teamRating.attack)} tone="danger" />
            <MeterBar label={<span className="flex w-full justify-between"><span>Meio</span><span className="font-semibold text-foreground">{ratingToDisplay(teamRating.midfield)}</span></span>} value={ratingPct(teamRating.midfield)} tone="info" />
            <MeterBar label={<span className="flex w-full justify-between"><span>Defesa</span><span className="font-semibold text-foreground">{ratingToDisplay(teamRating.defense)}</span></span>} value={ratingPct(teamRating.defense)} tone="ok" />
          </div>
        </Card>

        <Card className="p-3">
          <div
            className="relative mx-auto rounded-md overflow-hidden border border-border"
            style={{
              aspectRatio: "3 / 4",
              maxHeight: "560px",
              width: "100%",
              maxWidth: "420px",
              background: "repeating-linear-gradient(to bottom, #1e6b3a 0, #1e6b3a 12.5%, #1a5f33 12.5%, #1a5f33 25%)",
            }}
            onDragOver={(e) => e.preventDefault()}
          >
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox="0 0 300 400"
              preserveAspectRatio="none"
            >
              <g fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5">
                {/* contorno do campo */}
                <rect x="8" y="8" width="284" height="384" rx="2" />
                {/* linha de meio-campo */}
                <line x1="8" y1="200" x2="292" y2="200" />
                {/* círculo e marca central */}
                <circle cx="150" cy="200" r="40" />
                <circle cx="150" cy="200" r="2" fill="rgba(255,255,255,0.4)" stroke="none" />

                {/* grande área — gol de cima (ataque) */}
                <rect x="70" y="8" width="160" height="70" />
                {/* pequena área — gol de cima */}
                <rect x="115" y="8" width="70" height="25" />
                {/* marca de pênalti — gol de cima */}
                <circle cx="150" cy="58" r="2" fill="rgba(255,255,255,0.4)" stroke="none" />
                {/* semicírculo da grande área — gol de cima */}
                <path d="M 115.4 78 A 40 40 0 0 0 184.6 78" />
                {/* trave — gol de cima */}
                <rect x="135" y="2" width="30" height="6" />

                {/* grande área — gol de baixo (defesa) */}
                <rect x="70" y="322" width="160" height="70" />
                {/* pequena área — gol de baixo */}
                <rect x="115" y="367" width="70" height="25" />
                {/* marca de pênalti — gol de baixo */}
                <circle cx="150" cy="342" r="2" fill="rgba(255,255,255,0.4)" stroke="none" />
                {/* semicírculo da grande área — gol de baixo */}
                <path d="M 115.4 322 A 40 40 0 0 1 184.6 322" />
                {/* trave — gol de baixo */}
                <rect x="135" y="392" width="30" height="6" />

                {/* arcos de escanteio */}
                <path d="M 8 18 A 10 10 0 0 0 18 8" />
                <path d="M 282 8 A 10 10 0 0 0 292 18" />
                <path d="M 8 382 A 10 10 0 0 1 18 392" />
                <path d="M 292 382 A 10 10 0 0 0 282 392" />
              </g>
            </svg>

            {slots.map((s, idx) => {
              const coord = slotCoords(formation, s.slot);
              const cur = slotAssign[s.slot];
              const curPlayer = cur ? allPlayers.find((p) => p.id === cur.playerId) : undefined;
              const fam = curPlayer ? familiarityFor(curPlayer, s.canonical) : null;
              const ringColor = !fam ? "ring-white/40" :
                fam.level === "natural" ? "ring-ok" :
                fam.level === "proficiente" ? "ring-warn" : "ring-danger";
              return (
                <div
                  key={s.slot}
                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5"
                  style={{ left: `${coord.x}%`, top: `${coord.y}%` }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const raw = e.dataTransfer.getData("text/plain");
                    if (!raw) return;
                    const data = JSON.parse(raw) as { from: "bench" | "slot"; playerId: string; slotId?: string };
                    assignPlayerToSlot(s.slot, data.playerId);
                  }}
                >
                  <div
                    className={`relative flex size-10 items-center justify-center rounded-md ring-2 ${ringColor} shadow-lg`}
                  >
                    {/* Camisa — clip-path em vez de rounded-full: gola em V +
                        ombros/mangas anguladas, estilo o boneco do FM (o anel
                        de familiaridade fica no wrapper de fora, sem clip, pra
                        não cortar junto com a gola). */}
                    <div
                      draggable={!!curPlayer}
                      onDragStart={(e) => {
                        if (!curPlayer) return;
                        e.dataTransfer.setData("text/plain", JSON.stringify({ from: "slot", slotId: s.slot, playerId: curPlayer.id }));
                      }}
                      onClick={() => setPickerSlot(s.slot)}
                      className={`flex size-9 cursor-pointer select-none items-center justify-center text-[10px] font-bold hover:brightness-110 ${
                        curPlayer ? "" : "bg-white/10 text-white/50"
                      }`}
                      style={{
                        clipPath: "polygon(35% 0%, 65% 0%, 100% 22%, 85% 38%, 85% 100%, 15% 100%, 15% 38%, 0% 22%)",
                        ...(curPlayer ? { backgroundColor: kit.primary, color: kitText } : {}),
                      }}
                      title={curPlayer ? `${curPlayer.name} — ${s.slot} (${s.canonical}) — clique pra trocar` : `${s.slot} (${s.canonical}) — clique pra escalar`}
                    >
                      {curPlayer ? (curPlayer.squad_number ?? initialsOf(curPlayer.name)) : idx + 1}
                    </div>
                    {curPlayer && curPlayer.id === effectiveCaptainId && (
                      <span
                        className="absolute -top-1 -left-1 flex size-3 items-center justify-center rounded-full bg-warn text-[7px] font-black text-black border border-black/60 z-10"
                        title="Capitão"
                      >
                        C
                      </span>
                    )}
                    {curPlayer && (
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-black/60 ${
                          (curPlayer.condition ?? 100) >= 80 ? "bg-ok" : (curPlayer.condition ?? 100) >= 55 ? "bg-warn" : "bg-danger"
                        }`}
                        title={`Condição ${curPlayer.condition ?? 100}%`}
                      />
                    )}
                  </div>
                  <div className="text-[9px] leading-tight text-white font-medium bg-black/75 rounded px-1 whitespace-nowrap max-w-[80px] truncate">
                    {curPlayer ? curPlayer.name.split(" ").slice(-1)[0] : s.slot}
                  </div>
                  {curPlayer && (
                    <div className={`text-[8px] font-bold leading-none ${TONE_TEXT[ratingTone(curPlayer.overall)]}`}>
                      {resolveRole(cur?.role, s.canonical).shortCode} • {curPlayer.overall}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="fm-eyebrow mt-2 text-center">
            Clique num boneco pra escalar/trocar, ou arraste do banco
          </p>
        </Card>
      </div>

      {pickerSlot && (() => {
        const slot = slots.find((s) => s.slot === pickerSlot);
        if (!slot) return null;
        const curId = slotAssign[pickerSlot]?.playerId;
        const candidates = allPlayers
          .filter((pl) => pl.id !== curId)
          .map((pl) => ({
            player: pl,
            fam: familiarityFor(pl, slot.canonical),
            stars: roleAbilityStars(pl, slot.canonical),
            avail: todayISO ? checkAvailability(pl, todayISO) : { available: true, label: "" },
          }))
          .sort((a, b) => b.stars - a.stars || b.player.overall - a.player.overall);
        const curPlayer = curId ? allPlayers.find((pl) => pl.id === curId) : undefined;
        return (
          <Dialog open onOpenChange={(open) => !open && setPickerSlot(null)}>
            <DialogContent className="max-h-[80vh] max-w-lg overflow-hidden p-0">
              <DialogHeader className="border-b px-4 py-3">
                <DialogTitle className="flex items-center gap-2 text-sm">
                  <ArrowLeftRight className="size-4 text-primary" />
                  {slot.slot} ({positionLabel(slot.canonical)})
                  {curPlayer && <span className="font-normal text-muted-foreground">— trocar {curPlayer.name}</span>}
                </DialogTitle>
              </DialogHeader>
              <div className="max-h-[65vh] overflow-y-auto">
                {candidates.map(({ player, stars, avail }) => (
                  <button
                    key={player.id}
                    type="button"
                    disabled={!avail.available}
                    onClick={() => { assignPlayerToSlot(pickerSlot, player.id); setPickerSlot(null); }}
                    className={`flex w-full items-center gap-2 border-b px-4 py-2 text-left text-xs last:border-b-0 ${
                      avail.available ? "hover:bg-elevated/60 cursor-pointer" : "cursor-not-allowed opacity-50"
                    }`}
                  >
                    <span className="w-16 shrink-0 text-muted-foreground">
                      {positionLabel(player.natural_position ?? player.position)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {player.squad_number ? `${player.squad_number} · ` : ""}{player.name}
                    </span>
                    <Stars n={stars} />
                    <RatingBadge value={player.overall} className="w-8 shrink-0" />
                    <span className={`w-8 shrink-0 text-right ${conditionColor(player.condition ?? 100)}`}>
                      {player.condition ?? 100}
                    </span>
                    {!avail.available && (
                      <span className="shrink-0 text-[10px] text-danger" title={avail.label}>
                        {avail.reason === "injured" ? "🩹" : avail.reason === "doubtful" ? "❓" : "🚫"}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 border-t px-4 py-2">
                <span className="text-[10px] text-muted-foreground">Ordenado por habilidade na função</span>
                <Button size="sm" variant="ghost" onClick={() => setPickerSlot(null)}>
                  <X className="size-3.5" /> Fechar
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}

      {roleSlot && (() => {
        const slot = slots.find((s) => s.slot === roleSlot);
        if (!slot) return null;
        const cur = slotAssign[roleSlot];
        const curPlayer = cur ? allPlayers.find((pl) => pl.id === cur.playerId) : undefined;
        const currentRole = resolveRole(cur?.role, slot.canonical);
        // Só as funções LEGAIS pra essa posição — é isso que impede um
        // centroavante de virar "Zagueiro Construtor".
        const legalRoles = rolesForPosition(slot.canonical);
        return (
          <Dialog open onOpenChange={(open) => !open && setRoleSlot(null)}>
            <DialogContent className="max-h-[80vh] max-w-lg overflow-hidden p-0">
              <DialogHeader className="border-b px-4 py-3">
                <DialogTitle className="text-sm">
                  Função — {slot.slot} ({positionLabel(slot.canonical)})
                  {curPlayer && <span className="font-normal text-muted-foreground"> · {curPlayer.name}</span>}
                </DialogTitle>
              </DialogHeader>
              <div className="max-h-[65vh] overflow-y-auto">
                {legalRoles.map((role) => {
                  const stars = curPlayer ? roleFitStars(curPlayer, role, slot.canonical) : 0;
                  const active = role.key === currentRole.key;
                  return (
                    <button
                      key={role.key}
                      type="button"
                      onClick={() => {
                        setSlotAssign((prev) => ({ ...prev, [roleSlot]: { playerId: prev[roleSlot]?.playerId ?? "", role: role.key } }));
                        setRoleSlot(null);
                      }}
                      className={`flex w-full items-center gap-3 border-b px-4 py-2.5 text-left last:border-b-0 hover:bg-elevated/60 ${active ? "bg-primary/10" : ""}`}
                    >
                      <RoleDiagram role={role} canonical={slot.canonical} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-sm font-medium ${active ? "text-primary" : ""}`}>
                            {role.label}
                            {active && " ✓"}
                          </span>
                          {curPlayer && <Stars n={stars} />}
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{role.desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-2 border-t px-4 py-2">
                <span className="text-[10px] text-muted-foreground">
                  {curPlayer ? "Estrelas: o quanto o perfil dele combina com cada função" : "Sem jogador no slot — escolha só define a função padrão"}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setRoleSlot(null)}>
                  <X className="size-3.5" /> Fechar
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}

      {instructionsSlot && (() => {
        const slot = slots.find((s) => s.slot === instructionsSlot);
        if (!slot) return null;
        const cur = slotAssign[instructionsSlot];
        const curPlayer = cur ? allPlayers.find((pl) => pl.id === cur.playerId) : undefined;
        const ins = normalizeInstructions(cur?.instructions);
        const setIns = (patch: Partial<PlayerInstructions>) => {
          setSlotAssign((prev) => ({
            ...prev,
            [instructionsSlot]: {
              playerId: prev[instructionsSlot]?.playerId ?? "",
              role: prev[instructionsSlot]?.role ?? "",
              instructions: { ...normalizeInstructions(prev[instructionsSlot]?.instructions), ...patch },
            },
          }));
        };
        const toggleKeys = Object.keys(INSTRUCTION_META) as (keyof typeof INSTRUCTION_META)[];
        const levels: InstructionLevel[] = [-1, 0, 1];
        return (
          <Dialog open onOpenChange={(open) => !open && setInstructionsSlot(null)}>
            <DialogContent className="max-h-[85vh] max-w-lg overflow-hidden p-0">
              <DialogHeader className="border-b px-4 py-3">
                <DialogTitle className="text-sm">
                  Instruções — {slot.slot} ({positionLabel(slot.canonical)})
                  {curPlayer && <span className="font-normal text-muted-foreground"> · {curPlayer.name}</span>}
                </DialogTitle>
              </DialogHeader>
              <div className="max-h-[68vh] space-y-4 overflow-y-auto p-4">
                <div>
                  <div className="fm-eyebrow mb-1">Liberdade de movimento</div>
                  <p className="mb-2 text-[11px] text-muted-foreground">{ROAM_META.desc}</p>
                  <div className="mx-auto grid w-32 grid-cols-3 gap-1 rounded-2xl border border-border bg-elevated/40 p-2">
                    {levels.map((y) =>
                      levels.map((x) => {
                        const active = ins.roamDepth === -y && ins.roamWidth === x;
                        return (
                          <button
                            key={`${x}-${y}`}
                            type="button"
                            onClick={() => setIns({ roamDepth: (-y) as InstructionLevel, roamWidth: x })}
                            title={`${y === -1 ? ROAM_META.depth.high : y === 1 ? ROAM_META.depth.low : "Padrão"} · ${x === 1 ? ROAM_META.width.high : x === -1 ? ROAM_META.width.low : "Padrão"}`}
                            className={`aspect-square rounded-full border transition-colors ${
                              active ? "border-primary bg-primary" : "border-border bg-white/10 hover:border-primary/50 hover:bg-white/20"
                            }`}
                          />
                        );
                      }),
                    )}
                  </div>
                  <div className="mx-auto mt-1 flex w-32 justify-between text-[9px] text-muted-foreground">
                    <span>{ROAM_META.width.low}</span>
                    <span>{ROAM_META.width.high}</span>
                  </div>
                  <p className="mt-1 text-center text-[9px] text-muted-foreground">
                    {ROAM_META.depth.high} (cima) ↔ {ROAM_META.depth.low} (baixo)
                  </p>
                </div>

                {toggleKeys.map((key) => {
                  const meta = INSTRUCTION_META[key];
                  const value = ins[key];
                  return (
                    <div key={key}>
                      <div className="mb-0.5 text-xs font-semibold">{meta.label}</div>
                      <p className="mb-1 text-[10px] text-muted-foreground">{meta.desc}</p>
                      <div className="grid grid-cols-3 gap-1">
                        {levels.map((lvl) => (
                          <button
                            key={lvl}
                            type="button"
                            onClick={() => setIns({ [key]: lvl } as Partial<PlayerInstructions>)}
                            className={`rounded border py-1 text-[11px] transition-colors ${
                              value === lvl
                                ? "border-primary bg-primary text-primary-foreground font-semibold"
                                : "border-border text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {lvl === -1 ? meta.low : lvl === 1 ? meta.high : "Padrão"}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-2 border-t px-4 py-2">
                <Button
                  size="sm" variant="ghost"
                  onClick={() => setSlotAssign((prev) => ({
                    ...prev,
                    [instructionsSlot]: { playerId: prev[instructionsSlot]?.playerId ?? "", role: prev[instructionsSlot]?.role ?? "", instructions: { ...DEFAULT_INSTRUCTIONS } },
                  }))}
                >
                  Restaurar padrão
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setInstructionsSlot(null)}>
                  <X className="size-3.5" /> Fechar
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}

      <Dialog open={newPresetOpen} onOpenChange={setNewPresetOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Salvar esquema atual como novo</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={`Esquema ${presets.length + 1}`}
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { saveCurrentAsNewPreset(newPresetName); setNewPresetOpen(false); }
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            Guarda a formação, mentalidade, instruções e escalação atuais como um esquema separado — dá pra voltar a eles depois clicando no número.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setNewPresetOpen(false)}>Cancelar</Button>
            <Button size="sm" onClick={() => { saveCurrentAsNewPreset(newPresetName); setNewPresetOpen(false); }}>
              Salvar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Card className="p-0 overflow-hidden h-fit">
        <div className="grid grid-cols-[52px_1fr_60px_28px_28px] gap-1 px-3 py-2 fm-eyebrow border-b border-border bg-elevated/60">
          <div>POS</div>
          <div>JOGADOR / FUNÇÃO</div>
          <div>HAB.</div>
          <div>CON</div>
          <div>MO</div>
        </div>

        <div
          className="max-h-[420px] overflow-y-auto"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const raw = e.dataTransfer.getData("text/plain");
            if (!raw) return;
            const data = JSON.parse(raw) as { from: "bench" | "slot"; playerId: string; slotId?: string };
            if (data.from === "slot" && data.slotId) {
              setSlotAssign((prev) => {
                const next = { ...prev };
                delete next[data.slotId!];
                return next;
              });
            }
          }}
        >
          {slots.map((s) => {
            const cur = slotAssign[s.slot];
            const curPlayer = cur ? allPlayers.find((p) => p.id === cur.playerId) : undefined;
            const stars = curPlayer ? roleAbilityStars(curPlayer, s.canonical) : 0;
            const hasCustomInstructions = !isDefaultInstructions(normalizeInstructions(cur?.instructions));
            return (
              <div
                key={s.slot}
                draggable={!!curPlayer}
                onDragStart={(e) => {
                  if (!curPlayer) return;
                  e.dataTransfer.setData("text/plain", JSON.stringify({ from: "slot", slotId: s.slot, playerId: curPlayer.id }));
                }}
                className="grid grid-cols-[52px_1fr_60px_28px_28px] gap-1 px-3 py-1.5 items-center text-xs border-b border-border/50 hover:bg-elevated/50 cursor-grab active:cursor-grabbing"
              >
                <div className="font-mono text-muted-foreground">{s.slot}</div>
                <div className="min-w-0">
                  {curPlayer ? (
                    <>
                      <div className="font-medium truncate flex items-center gap-1">
                        {curPlayer.name}
                        {(() => {
                          const avail = todayISO ? checkAvailability(curPlayer, todayISO) : { available: true };
                          if (avail.available) return null;
                          return (
                            <span title={avail.label} className={avail.reason === "injured" ? "text-danger" : "text-warn"}>
                              {avail.reason === "injured" ? "🩹" : avail.reason === "doubtful" ? "❓" : "🚫"}
                            </span>
                          );
                        })()}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setRoleSlot(s.slot); }}
                          className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded border bg-background px-1 py-0.5 text-[10px] text-left hover:border-primary/50"
                        >
                          <span className="truncate">{resolveRole(cur.role, s.canonical).label}</span>
                          <span className="shrink-0 text-muted-foreground">▾</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setInstructionsSlot(s.slot); }}
                          title={hasCustomInstructions ? "Instruções individuais (personalizadas)" : "Instruções individuais"}
                          className={`shrink-0 rounded border p-1 ${
                            hasCustomInstructions ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <SlidersHorizontal className="size-3" />
                        </button>
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground italic">vazio</span>
                  )}
                </div>
                <div>{curPlayer && <Stars n={stars} />}</div>
                <div className={curPlayer ? conditionColor(curPlayer.condition ?? 100) : ""}>
                  {curPlayer ? `${curPlayer.condition ?? 100}` : "-"}
                </div>
                <div className={curPlayer ? conditionColor(curPlayer.morale ?? 70) : ""}>
                  {curPlayer ? `${curPlayer.morale ?? 70}` : "-"}
                </div>
              </div>
            );
          })}
        </div>

        <div className="fm-eyebrow px-3 py-2 border-y border-border bg-elevated/60">Reservas</div>
        <div className="max-h-[260px] overflow-y-auto">
          {allPlayers
            .filter((p) => !usedIds.has(p.id))
            .sort((a, b) => b.overall - a.overall)
            .map((p) => {
              const avail = todayISO ? checkAvailability(p, todayISO) : { available: true };
              return (
                <div
                  key={p.id}
                  draggable={avail.available}
                  onDragStart={(e) => {
                    if (!avail.available) return;
                    e.dataTransfer.setData("text/plain", JSON.stringify({ from: "bench", playerId: p.id }));
                  }}
                  className={`flex items-center justify-between gap-2 px-3 py-1.5 text-xs border-b border-border/50 ${
                    avail.available ? "hover:bg-elevated/50 cursor-grab active:cursor-grabbing" : "opacity-50 cursor-not-allowed"
                  }`}
                  title={avail.available ? undefined : avail.label}
                >
                  <div className="min-w-0 truncate">
                    <span className="font-medium">{p.name}</span>{" "}
                    <span className="text-muted-foreground">{positionLabel(p.natural_position ?? p.position)}</span>
                  </div>
                  {avail.available ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <Stars n={roleAbilityStars(p, (p.natural_position ?? p.position) as GranularPosition)} />
                      <RatingBadge value={p.overall} />
                    </div>
                  ) : (
                    <span className={`shrink-0 ${avail.reason === "injured" ? "text-danger" : "text-warn"}`}>
                      {avail.reason === "injured" ? "🩹" : avail.reason === "doubtful" ? "❓" : "🚫"} {avail.label}
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      </Card>
    </div>

    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="fm-eyebrow">Bola parada & capitão</div>
        <Button
          size="sm" variant="outline"
          onClick={() => setTakers({
            penalty: suggestedByRole.penalty ?? "", free_kick: suggestedByRole.free_kick ?? "",
            corner: suggestedByRole.corner ?? "", captain: suggestedByRole.captain ?? "",
          })}
        >
          Sugerir
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SET_PIECE_ROLES.map((role) => {
          const sug = suggestedByRole[role.id];
          const cur = takers[role.id];
          return (
            <div key={role.id} className="space-y-1">
              <div className="text-xs font-semibold">{role.label}</div>
              <div className="text-[10px] text-muted-foreground">{role.desc}</div>
              <select
                className="w-full h-8 px-2 rounded border bg-background text-xs"
                value={cur}
                onChange={(e) => setTakers((t) => ({ ...t, [role.id]: e.target.value }))}
              >
                <option value="">Automático{sug ? ` (${playerNameById(sug).split(" ").slice(-1)[0]})` : ""}</option>
                {xiPlayers.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.squad_number ? `${p.squad_number} · ` : ""}{p.name}{p.id === sug ? " ★" : ""}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <p className="fm-eyebrow mt-3">
        ★ = melhor do XI pra função. "Automático" segue esse melhor a cada jogo; escolher um nome fixa a preferência.
        Se o escolhido não jogar (lesão/poupado), o motor volta ao automático.
      </p>
    </Card>

    <Card className="p-4">
      <div className="fm-eyebrow mb-3">Metas da próxima partida</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] items-end">
        <div className="space-y-1">
          <div className="text-xs font-semibold">Jogador</div>
          <select
            className="w-full h-8 px-2 rounded border bg-background text-xs"
            value={goalPlayerId}
            onChange={(e) => setGoalPlayerId(e.target.value)}
          >
            <option value="">Selecione…</option>
            {xiPlayers.map((p: any) => (
              <option key={p.id} value={p.id}>{p.squad_number ? `${p.squad_number} · ` : ""}{p.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold">Meta</div>
          <select
            className="w-full h-8 px-2 rounded border bg-background text-xs"
            value={goalKind}
            onChange={(e) => {
              const kind = e.target.value as MatchGoalKind;
              setGoalKind(kind);
              setGoalThreshold(matchGoalDefaultThreshold(kind));
            }}
          >
            {MATCH_GOAL_KINDS.map((k) => (
              <option key={k} value={k}>{matchGoalLabel(k, matchGoalDefaultThreshold(k))}</option>
            ))}
          </select>
        </div>
        {MATCH_GOAL_HAS_THRESHOLD[goalKind] && (
          <div className="space-y-1">
            <div className="text-xs font-semibold">Limiar</div>
            <input
              type="number" min={goalKind === "good_rating" ? 1 : 1} step={goalKind === "good_rating" ? 0.5 : 1}
              className="w-20 h-8 px-2 rounded border bg-background text-xs"
              value={goalThreshold ?? matchGoalDefaultThreshold(goalKind) ?? 1}
              onChange={(e) => setGoalThreshold(Number(e.target.value))}
            />
          </div>
        )}
        <Button size="sm" onClick={addMatchGoal} disabled={!goalPlayerId}>Adicionar</Button>
      </div>
      {matchGoals.length > 0 && (
        <div className="mt-3 space-y-1">
          {matchGoals.map((g) => (
            <div key={g.playerId} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs">
              <span><strong>{playerNameById(g.playerId)}</strong> — {matchGoalLabel(g.kind, g.threshold)}</span>
              <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => removeMatchGoal(g.playerId)}>✕</Button>
            </div>
          ))}
        </div>
      )}
      <p className="fm-eyebrow mt-3">
        Vale só pra próxima partida do time — depois de resolvida, some sozinho e o resultado vai pro inbox.
      </p>
    </Card>
   </div>
  );
}

// Seção de fase (Em Posse / Em Transição / Sem a Bola, estilo FM
// "TEAM SELECTION") — troca os TagSection somente-leitura antigos por
// toggles de verdade, clicáveis, ligados direto aos campos que o motor usa.
function PhaseSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="fm-eyebrow mb-1.5">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function ToggleRow<T extends string>({
  label, value, options, onChange,
}: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="block space-y-1 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded border py-1 text-[10px] transition-colors ${
              value === o.value
                ? "border-primary bg-primary text-primary-foreground font-semibold"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </label>
  );
}

function SliderRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block space-y-1 text-xs">
      <div className="flex justify-between text-muted-foreground">
        <span>{label}</span>
        <span>{value}/5</span>
      </div>
      <input type="range" min={1} max={5} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </label>
  );
}