import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { MatchResult } from "@/game/types";
import { computeBallPosition, computePlayerPositions, currentCaption } from "@/game/live-positions";
import { liveMatchStats } from "@/game/live-stats";
import { clubColors } from "@/game/club-colors";
import { MatchPitch } from "@/components/match-pitch";
import { Match3DPitch, type CameraView, type WeatherType, type Match3DDot, type Match3DPitchHandle } from "@/components/match-3d-pitch";
import { MatchAudioEngine } from "@/lib/match-audio";
import { Button } from "@/components/ui/button";
import { Box, Square, Volume2, VolumeX } from "lucide-react";
import { useHighlightPlayback } from "@/hooks/use-highlight-playback";

const AUDIO_MUTED_LS_KEY = "footymanager-3d-muted";

// -----------------------------------------------------------------------------
// Envelope que decide entre o pitch 2D (match-pitch.tsx, leve, sempre
// disponível) e o 3D (match-3d-pitch.tsx, Three.js). O 2D continua dono do
// seu próprio relógio/replay/estatísticas — aqui só adicionamos a alternância
// e, pro modo 3D, um segundo relógio próprio mais simples (o 3D não precisa
// do relatório de estatísticas/notas, só da posição ao vivo).
//
// Nota: os componentes auxiliares (ratingBg, LiveRatingsRow) ficam definidos
// ANTES de quem os usa (Live3DView), mesmo já sendo hoisted em JS puro — o
// dev server deste projeto já mostrou "X is not defined" em runtime pra
// função definida depois do uso no arquivo (aconteceu com MatchDayScreen em
// saves.$saveId.tsx e de novo aqui com LiveRatingsRow), então não confiamos
// em hoisting aqui: declara tudo em ordem de uso.
// -----------------------------------------------------------------------------

export function MatchViewer({
  result, homeName, awayName, homeClubId, awayClubId,
  initialMinute = 0, maxMinute = 90, onReachMax,
}: {
  result: MatchResult;
  homeName: string;
  awayName: string;
  homeClubId?: string;
  awayClubId?: string;
  initialMinute?: number;
  maxMinute?: number;
  onReachMax?: () => void;
}) {
  const [mode, setMode] = useState<"2d" | "3d">("2d");

  const lineupIds = useMemo(
    () => [...(result.homeLineup ?? []), ...(result.awayLineup ?? [])].map((l) => l.playerId),
    [result.homeLineup, result.awayLineup],
  );

  // Também alimenta o 2D (cores reais do clube + número da camisa nas
  // fichas) — não só o 3D como antes — por isso não trava mais em `mode`.
  const colors = useQuery({
    queryKey: ["match-viewer-scene", homeClubId, awayClubId, lineupIds.length],
    enabled: !!homeClubId && !!awayClubId,
    queryFn: async () => {
      if (!homeClubId || !awayClubId) throw new Error("Clube ausente");
      const [{ data, error }, { data: players }] = await Promise.all([
        supabase.from("clubs").select("id, short_name, primary_color, secondary_color, stadium_capacity, captain_id")
          .in("id", [homeClubId, awayClubId]),
        lineupIds.length
          ? supabase.from("players").select("id, squad_number").in("id", lineupIds)
          : Promise.resolve({ data: [] as { id: string; squad_number: number | null }[] }),
      ]);
      if (error) throw error;
      const byId = new Map((data ?? []).map((c) => [c.id, c]));
      const homeC = byId.get(homeClubId) as { short_name?: string | null; stadium_capacity?: number; captain_id?: string | null } | undefined;
      const awayC = byId.get(awayClubId) as { short_name?: string | null; captain_id?: string | null } | undefined;
      return {
        home: clubColors(byId.get(homeClubId) ?? { id: homeClubId }),
        away: clubColors(byId.get(awayClubId) ?? { id: awayClubId }),
        homeAbbr: (homeC?.short_name || homeName.slice(0, 3)).toUpperCase(),
        awayAbbr: (awayC?.short_name || awayName.slice(0, 3)).toUpperCase(),
        homeCapacity: homeC?.stadium_capacity ?? 30000,
        homeCaptainId: homeC?.captain_id ?? null,
        awayCaptainId: awayC?.captain_id ?? null,
        numbers: new Map((players ?? []).map((p) => [p.id, p.squad_number ?? undefined] as const)),
      };
    },
  });

  const has3DData = !!(result.homeLineup?.length && result.awayLineup?.length && result.homeFormation && result.awayFormation);

  return (
    <div className="space-y-3">
      {has3DData && (
        <div className="flex justify-end">
          <div className="inline-flex rounded-md border overflow-hidden">
            <Button
              size="sm" variant={mode === "2d" ? "default" : "ghost"} className="rounded-none h-7 px-2.5 text-xs gap-1"
              onClick={() => setMode("2d")}
            >
              <Square className="size-3" /> 2D
            </Button>
            <Button
              size="sm" variant={mode === "3d" ? "default" : "ghost"} className="rounded-none h-7 px-2.5 text-xs gap-1"
              onClick={() => setMode("3d")}
            >
              <Box className="size-3" /> 3D
            </Button>
          </div>
        </div>
      )}

      {mode === "2d" || !has3DData ? (
        <MatchPitch
          result={result} homeName={homeName} awayName={awayName}
          homeColors={colors.data?.home} awayColors={colors.data?.away} numbers={colors.data?.numbers}
          initialMinute={initialMinute} maxMinute={maxMinute} onReachMax={onReachMax}
        />
      ) : !colors.data ? (
        <div className="flex h-[min(72vh,680px)] items-center justify-center rounded-md border text-sm text-muted-foreground">
          Preparando o estádio…
        </div>
      ) : (
        <Live3DView
          result={result} homeName={homeName} awayName={awayName}
          homeAbbr={colors.data.homeAbbr} awayAbbr={colors.data.awayAbbr}
          homeColors={colors.data.home} awayColors={colors.data.away}
          stadiumCapacity={colors.data.homeCapacity}
          homeCaptainId={colors.data.homeCaptainId} awayCaptainId={colors.data.awayCaptainId}
          numbers={colors.data.numbers}
          initialMinute={initialMinute} maxMinute={maxMinute} onReachMax={onReachMax}
          matchKey={`${homeClubId}-${awayClubId}`}
        />
      )}
    </div>
  );
}


function LiveStatBar({ label, home, away, suffix = "" }: { label: string; home: number; away: number; suffix?: string }) {
  const total = home + away;
  const homePct = total > 0 ? (home / total) * 100 : 50;
  return (
    <div>
      <div className="flex items-center justify-between text-muted-foreground mb-0.5">
        <span className="font-mono font-semibold text-foreground">{home}{suffix}</span>
        <span>{label}</span>
        <span className="font-mono font-semibold text-foreground">{away}{suffix}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden bg-muted flex">
        <div className="h-full bg-blue-500" style={{ width: `${homePct}%` }} />
        <div className="h-full bg-rose-500" style={{ width: `${100 - homePct}%` }} />
      </div>
    </div>
  );
}

// Painel de estatísticas ao vivo — o 3D não tinha nenhum (só aparecia no
// resumo pós-jogo do 2D). Mesmos valores escalados de src/game/live-stats.ts.
function LiveStatsPanel({ result, minute }: { result: MatchResult; minute: number }) {
  const events = result.events ?? [];
  const stats = useMemo(() => liveMatchStats(result.stats, events, minute, 90), [result.stats, events, minute]);
  if (!result.stats) return null;
  return (
    <div className="space-y-1.5 text-xs border rounded-md p-3">
      <LiveStatBar label="Posse de bola" home={stats.possession} away={100 - stats.possession} suffix="%" />
      <LiveStatBar label="Chutes" home={stats.shotsHome} away={stats.shotsAway} />
      <LiveStatBar label="No alvo" home={stats.onTargetHome} away={stats.onTargetAway} />
      <LiveStatBar label="Escanteios" home={stats.cornersHome} away={stats.cornersAway} />
      <LiveStatBar label="Faltas" home={stats.foulsHome} away={stats.foulsAway} />
      {(stats.yellowHome + stats.yellowAway > 0) && (
        <LiveStatBar label="Cartões amarelos" home={stats.yellowHome} away={stats.yellowAway} />
      )}
      {(stats.redHome + stats.redAway > 0) && (
        <LiveStatBar label="Cartões vermelhos" home={stats.redHome} away={stats.redAway} />
      )}
    </div>
  );
}

// --- Overlays de transmissão (fora do canvas 3D) ---------------------------

function ColorChip({ color }: { color?: string }) {
  return <span className="inline-block size-3 rounded-[3px] border border-white/25" style={{ background: color ?? "#64748b" }} />;
}

// Placar estilo FM, canto superior esquerdo.
function Scoreboard({
  homeAbbr, awayAbbr, homeColor, awayColor, hs, as, clock, replay,
}: {
  homeAbbr: string; awayAbbr: string; homeColor?: string; awayColor?: string;
  hs: number; as: number; clock: string; replay: boolean;
}) {
  return (
    <div className="absolute left-3 top-3 z-30 flex items-stretch overflow-hidden rounded-md border border-white/10 bg-slate-950/80 text-white shadow-lg backdrop-blur-md">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <ColorChip color={homeColor} />
        <span className="font-mono text-xs font-bold tracking-wide">{homeAbbr}</span>
      </div>
      <div className="flex items-center bg-white/10 px-2.5 py-1.5 font-mono text-sm font-black tabular-nums">
        {hs} <span className="mx-1 text-white/40">-</span> {as}
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <span className="font-mono text-xs font-bold tracking-wide">{awayAbbr}</span>
        <ColorChip color={awayColor} />
      </div>
      <div className={`flex items-center border-l border-white/10 px-2.5 py-1.5 font-mono text-xs font-semibold tabular-nums ${replay ? "bg-amber-500 text-slate-950" : "text-emerald-300"}`}>
        {replay ? "REPRISE" : clock}
      </div>
    </div>
  );
}

// Banner de gol — desliza do topo durante a janela do gol / a reprise.
function GoalBanner({ scorer, hs, as, homeAbbr, awayAbbr }: {
  scorer: string; hs: number; as: number; homeAbbr: string; awayAbbr: string;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center">
      <div className="animate-in slide-in-from-top-4 fade-in flex items-center gap-3 rounded-lg border border-white/15 bg-gradient-to-r from-emerald-600 to-emerald-500 px-5 py-2.5 text-white shadow-2xl">
        <span className="font-display text-lg font-black tracking-wider">G O L !</span>
        <div className="leading-tight">
          <div className="text-sm font-bold">{scorer}</div>
          <div className="font-mono text-xs text-white/80 tabular-nums">{homeAbbr} {hs} – {as} {awayAbbr}</div>
        </div>
      </div>
    </div>
  );
}

const EVENT_META: Record<string, { icon: string; label: string; cls: string }> = {
  yellow: { icon: "🟨", label: "Cartão amarelo", cls: "border-amber-500/50 bg-amber-500/10" },
  red: { icon: "🟥", label: "Cartão vermelho", cls: "border-red-500/50 bg-red-500/10" },
  injury: { icon: "🩹", label: "Lesão", cls: "border-rose-500/50 bg-rose-500/10" },
  sub: { icon: "🔄", label: "Substituição", cls: "border-sky-500/50 bg-sky-500/10" },
};

function EventToast({ ev }: { ev: { type: string; text: string; playerName?: string } }) {
  const m = EVENT_META[ev.type];
  if (!m) return null;
  const body = ev.text.replace(/^\d+'\s*[^\s]*\s*/, "");
  return (
    <div className={`animate-in slide-in-from-left-3 fade-in absolute bottom-3 left-3 z-30 flex max-w-[70%] items-start gap-2 rounded-md border px-3 py-2 text-white shadow-lg backdrop-blur-md ${m.cls} bg-slate-950/70`}>
      <span className="text-base leading-none">{m.icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wide text-white/60">{m.label}</div>
        <div className="truncate text-xs">{ev.playerName ? <b>{ev.playerName}</b> : null} {body}</div>
      </div>
    </div>
  );
}

function ratingChipBg(r: number): string {
  if (r >= 8) return "bg-emerald-500 text-emerald-950";
  if (r >= 7) return "bg-lime-500 text-lime-950";
  if (r >= 6.2) return "bg-slate-400 text-slate-950";
  if (r >= 5.4) return "bg-amber-500 text-amber-950";
  return "bg-red-500 text-red-950";
}

// Barra "Tática & Subs" — o XI de cada lado com número + nota ao vivo.
function LiveTacticsBar({ result, side, abbr, color, numbers }: {
  result: MatchResult; side: "home" | "away"; abbr: string; color?: string;
  numbers?: Map<string, number | undefined>;
}) {
  const lineup = side === "home" ? result.homeLineup : result.awayLineup;
  const byId = useMemo(() => new Map((result.ratings ?? []).map((r) => [r.playerId, r])), [result.ratings]);
  if (!lineup?.length) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border bg-elevated/40 px-2 py-1.5">
      <div className="flex shrink-0 items-center gap-1.5 pr-1">
        <ColorChip color={color} />
        <span className="font-mono text-[11px] font-bold">{abbr}</span>
      </div>
      <div className="flex flex-1 gap-1.5 overflow-x-auto">
        {lineup.map((l) => {
          const r = byId.get(l.playerId);
          const num = numbers?.get(l.playerId);
          return (
            <div key={l.playerId} className="flex shrink-0 flex-col items-center gap-0.5" style={{ width: 46 }}>
              <div className={`flex size-6 items-center justify-center rounded-full text-[10px] font-bold ${r ? ratingChipBg(r.rating) : "bg-muted text-muted-foreground"}`}>
                {r ? r.rating.toFixed(1) : "–"}
              </div>
              <div className="w-full truncate text-center text-[9px] text-muted-foreground">
                {num != null ? `${num} ` : ""}{l.playerName.split(" ").pop()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Live3DView({
  result, homeName, awayName, homeAbbr, awayAbbr, homeColors, awayColors, stadiumCapacity,
  homeCaptainId, awayCaptainId, numbers, initialMinute, maxMinute, onReachMax, matchKey,
}: {
  result: MatchResult;
  homeName: string;
  awayName: string;
  homeAbbr: string;
  awayAbbr: string;
  homeColors?: { primary: string; secondary: string };
  awayColors?: { primary: string; secondary: string };
  stadiumCapacity?: number;
  homeCaptainId?: string | null;
  awayCaptainId?: string | null;
  numbers?: Map<string, number | undefined>;
  initialMinute: number;
  maxMinute: number;
  onReachMax?: () => void;
  matchKey: string;
}) {
  const events = result.events ?? [];
  const homePossessionPct = result.stats?.possession ?? 50;

  const [camera, setCamera] = useState<CameraView>("tv");
  const [weather, setWeather] = useState<WeatherType>("noite");
  const audioFiredRef = useRef<Set<string>>(new Set());
  const lastReplayGoalRef = useRef<number | null>(null);
  const audioPrevMinRef = useRef(initialMinute);

  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem(AUDIO_MUTED_LS_KEY) === "1"; } catch { return false; }
  });
  const audioRef = useRef<MatchAudioEngine | null>(null);
  if (!audioRef.current) audioRef.current = new MatchAudioEngine();
  // `dots`/`ball` chegam no `Match3DPitch` por este handle imperativo, não
  // por props — ver o comentário grande em match-3d-pitch.tsx. Como props,
  // forçavam esse componente (câmeras/zoom/clima/qualidade) a re-renderizar
  // a árvore inteira de JSX 60x/s só porque a posição de alguém mudou; era
  // a causa real da trava progressiva em partidas longas.
  const pitchRef = useRef<Match3DPitchHandle>(null);

  const playerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of [...(result.homeLineup ?? []), ...(result.awayLineup ?? [])]) m.set(l.playerId, l.playerName);
    return m;
  }, [result.homeLineup, result.awayLineup]);

  const {
    segments, segIndex, minute, effMin, playing, setPlaying, phase, replay,
    skipToNext: skipToNextRaw, rewatch: rewatchRaw,
  } = useHighlightPlayback({
    events, initialMinute, maxMinute, onReachMax,
    resolveScorer: (playerId, fallback) => (playerId && playerNameById.get(playerId)) || fallback,
  });

  // Áudio sintetizado (torcida/apito/gol) — ver src/lib/match-audio.ts.
  // `start()` é chamado de novo (idempotente) nos cliques de play/mudo, que
  // com certeza são gesto do usuário — alguns navegadores exigem isso.
  useEffect(() => {
    if (!segments.length) return; // "sem lances" — nem liga o áudio
    const engine = audioRef.current!;
    engine.setMuted(muted);
    engine.start();
    engine.whistle(); // apito de início do trecho ao vivo
    return () => engine.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { audioRef.current?.setMuted(muted); }, [muted]);
  useEffect(() => { audioRef.current?.setCrowdFill(Math.max(0.4, Math.min(1, (stadiumCapacity ?? 30000) / 45000))); }, [stadiumCapacity]);

  // Apito (cartão) e sininho (sub) pros eventos cruzados durante um lance —
  // nunca pra eventos "pulados" no corte entre lances (o corte já adianta
  // o relógio pro início do próximo lance antes do salto).
  useEffect(() => {
    if (phase !== "playing" || replay) { audioPrevMinRef.current = minute; return; }
    const from = audioPrevMinRef.current;
    for (const e of events) {
      if (e.minute <= from || e.minute > minute) continue;
      if (e.type !== "yellow" && e.type !== "red" && e.type !== "sub") continue;
      const key = `${e.type}-${e.minute}`;
      if (audioFiredRef.current.has(key)) continue;
      audioFiredRef.current.add(key);
      if (e.type === "sub") audioRef.current?.subChime();
      else audioRef.current?.whistle(e.type === "red");
    }
    audioPrevMinRef.current = minute;
  }, [minute, phase, replay, events]);

  // Estouro de torcida na reprise de gol (uma vez por gol distinto).
  useEffect(() => {
    if (replay && replay.goalMin !== lastReplayGoalRef.current) {
      lastReplayGoalRef.current = replay.goalMin;
      audioRef.current?.setTension(1);
      audioRef.current?.goalBurst();
    }
  }, [replay]);

  function skipToNext() {
    audioRef.current?.start();
    skipToNextRaw();
  }

  function rewatch() {
    audioFiredRef.current.clear();
    lastReplayGoalRef.current = null;
    rewatchRaw();
    audioRef.current?.whistle();
  }

  const ball = useMemo(
    () => computeBallPosition(
      events, effMin, homePossessionPct,
      result.homeLineup ?? [], result.awayLineup ?? [], result.homeFormation, result.awayFormation,
    ),
    [events, effMin, homePossessionPct, result],
  );
  const dots: Match3DDot[] = useMemo(() => {
    const live = computePlayerPositions(
      result.homeLineup ?? [], result.awayLineup ?? [],
      result.homeFormation!, result.awayFormation!,
      effMin, events, homePossessionPct, result.texture ?? [],
    );
    return live.map((d) => ({
      id: d.playerId, playerName: d.playerName, side: d.side, slot: d.slot, x: d.x, y: d.y,
      number: numbers?.get(d.playerId), anim: d.anim,
    }));
  }, [result, effMin, events, homePossessionPct, numbers]);

  // Empurra a posição pro 3D via ref (não via props — ver comentário de
  // `pitchRef` acima). `dots`/`ball` continuam recalculados a cada tick pelo
  // `useMemo`s acima; só a ENTREGA pro canvas 3D deixou de passar pelo ciclo
  // de props/render do React.
  useEffect(() => {
    pitchRef.current?.update({ dots, ball });
  }, [dots, ball]);

  const goalEvtNow = useMemo(
    () => events.find((e) => e.type === "goal" && effMin >= e.minute && effMin <= e.minute + 2.6),
    [events, effMin],
  );
  const goalWindow = !!goalEvtNow || !!replay;
  const chanceWindow = useMemo(
    () => events.some((e) => e.type === "chance" && effMin >= e.minute - 1 && effMin <= e.minute + 0.3),
    [events, effMin],
  );

  // Tensão da torcida (áudio) — sobe rápido em lance perigoso/gol, desce
  // devagar; só dispara de novo quando o booleano muda (ver setTension).
  useEffect(() => {
    audioRef.current?.setTension(goalWindow ? 1 : chanceWindow ? 0.4 : 0);
  }, [goalWindow, chanceWindow]);

  const liveHome = useMemo(() => events.filter((e) => e.type === "goal" && e.side === "home" && e.minute <= effMin).length, [events, effMin]);
  const liveAway = useMemo(() => events.filter((e) => e.type === "goal" && e.side === "away" && e.minute <= effMin).length, [events, effMin]);

  const recentEvent = useMemo(() => {
    let found: { type: string; text: string; playerName?: string } | null = null;
    for (const e of events) {
      if ((e.type === "yellow" || e.type === "red" || e.type === "injury" || e.type === "sub")
        && e.minute <= effMin && effMin - e.minute < 3.5) {
        found = { type: e.type, text: e.text, playerName: e.playerId ? playerNameById.get(e.playerId) : undefined };
      }
    }
    return found;
  }, [events, effMin, playerNameById]);

  const caption = useMemo(
    () => (effMin < maxMinute && !goalWindow ? currentCaption(events, effMin, homeName, awayName, homePossessionPct) : null),
    [events, effMin, maxMinute, homeName, awayName, homePossessionPct, goalWindow],
  );

  const bannerScorer = replay?.scorer
    ?? (goalEvtNow?.playerId ? playerNameById.get(goalEvtNow.playerId) : undefined)
    ?? "Gol";
  const bannerHs = replay ? replay.hs : liveHome;
  const bannerAs = replay ? replay.as : liveAway;

  const nextCutClock = phase === "cut" && segments[segIndex + 1]
    ? `${Math.floor(segments[segIndex + 1].start)}'` : "";
  const lastGoodMin = maxMinute >= 45 && initialMinute >= 45 ? "no 2º tempo" : "até aqui";

  // Nenhum lance decisivo neste período — nem monta a cena 3D.
  if (phase === "empty") {
    return (
      <div className="space-y-3">
        <div className="flex h-[min(56vh,460px)] flex-col items-center justify-center gap-3 rounded-md border bg-elevated/20 text-center text-sm text-muted-foreground">
          <span className="text-2xl">😴</span>
          <span>Sem lances de perigo {lastGoodMin}.</span>
          {onReachMax && <Button size="sm" onClick={onReachMax}>Continuar</Button>}
        </div>
        <LiveStatsPanel result={result} minute={maxMinute} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative w-full h-[min(72vh,680px)] rounded-md overflow-hidden border">
        <Scoreboard
          homeAbbr={homeAbbr} awayAbbr={awayAbbr}
          homeColor={homeColors?.primary} awayColor={awayColors?.primary}
          hs={liveHome} as={liveAway}
          clock={`${Math.min(maxMinute, Math.floor(effMin))}'`}
          replay={!!replay}
        />
        {caption && phase === "playing" && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-[60%] truncate rounded-full bg-blue-600/85 px-3 py-1 text-center text-[11px] font-medium text-white shadow">
            {caption}
          </div>
        )}
        {goalWindow && <GoalBanner scorer={bannerScorer} hs={bannerHs} as={bannerAs} homeAbbr={homeAbbr} awayAbbr={awayAbbr} />}
        {recentEvent && !goalWindow && <EventToast ev={recentEvent} />}

        {phase === "cut" && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm">
            <span className="font-mono text-sm tracking-wider text-white/70">{nextCutClock}</span>
          </div>
        )}

        <Match3DPitch
          ref={pitchRef}
          homePrimaryColor={homeColors?.primary ?? "#10b981"}
          homeSecondaryColor={homeColors?.secondary ?? "#0f172a"}
          awayPrimaryColor={awayColors?.primary ?? "#ef4444"}
          awaySecondaryColor={awayColors?.secondary ?? "#0f172a"}
          isGoalHappening={goalWindow}
          isDangerousMoment={chanceWindow}
          stadiumCapacity={stadiumCapacity}
          homeCaptainId={homeCaptainId}
          awayCaptainId={awayCaptainId}
          activeCamera={camera}
          onCameraChange={setCamera}
          weather={weather}
          onWeatherChange={setWeather}
          matchSpeed={replay ? 1 : 1.4}
          tickerText={goalWindow ? "⚽  G O O O A L  ⚽  G O O O A L  ⚽" : `★ TÁTICAFC ★ ${homeAbbr} x ${awayAbbr} ★`}
          matchKey={matchKey}
        />
      </div>

      <LiveTacticsBar result={result} side="home" abbr={homeAbbr} color={homeColors?.primary} numbers={numbers} />
      <LiveTacticsBar result={result} side="away" abbr={awayAbbr} color={awayColors?.primary} numbers={numbers} />

      <LiveStatsPanel result={result} minute={minute} />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button
          size="sm" variant="outline"
          onClick={() => {
            audioRef.current?.start();
            if (phase === "done") rewatch(); else setPlaying((p) => !p);
          }}
          disabled={!!replay || phase === "cut"}
        >
          {phase === "done" ? "Rever lances" : playing ? "Pausar" : "Assistir"}
        </Button>
        <Button
          size="sm" variant="ghost"
          onClick={skipToNext}
          disabled={!!replay || phase !== "playing" || segIndex + 1 >= segments.length}
        >
          Próximo lance ⏭
        </Button>
        <Button
          size="sm" variant="ghost" className="px-2"
          onClick={() => {
            audioRef.current?.start();
            setMuted((m) => {
              const next = !m;
              try { localStorage.setItem(AUDIO_MUTED_LS_KEY, next ? "1" : "0"); } catch { /* ignore */ }
              return next;
            });
          }}
          title={muted ? "Ativar som" : "Silenciar"}
        >
          {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
        </Button>
        <span className="ml-auto font-mono text-muted-foreground">
          {phase === "done"
            ? "lances encerrados"
            : `Lance ${Math.min(segIndex + 1, segments.length)} / ${segments.length}`}
        </span>
      </div>
    </div>
  );
}
