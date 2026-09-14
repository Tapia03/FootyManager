// -----------------------------------------------------------------------------
// Treino — lógica pura (sem I/O).
//
// Cada foco treina um conjunto de atributos (ver src/game/attributes.ts pro
// catálogo completo). A cada dia avançado, cada atributo do foco tem uma
// pequena chance de subir +1 (limite 20), chance essa que depende da idade do
// jogador (jovens evoluem bem mais rápido que veteranos) e da nota do
// treinador contratado (ver src/game/staff.ts — sem treinador, o treino roda
// no ritmo básico, nunca trava).
//
// Treino pesado também carrega um pequeno risco de lesão (maior em foco
// físico) — ver rollInjuryType/buildInjuryPatch em src/game/medical.ts, que
// já são reaproveitados aqui pra manter o mesmo catálogo de lesões da
// partida.
// -----------------------------------------------------------------------------

import { rollInjuryType, type InjuryTypeKey } from "./medical";
import type { AttributeKey, PlayerAttributes } from "./attributes";

export type TrainingFocus = "attack" | "defense" | "physical" | "technical" | "goalkeeping" | "balanced";

export const TRAINING_FOCUS_OPTIONS: TrainingFocus[] = ["balanced", "attack", "defense", "physical", "technical", "goalkeeping"];

export const TRAINING_FOCUS_LABELS: Record<TrainingFocus, string> = {
  balanced: "Equilibrado",
  attack: "Ataque",
  defense: "Defesa",
  physical: "Físico",
  technical: "Técnica",
  goalkeeping: "Goleiros",
};

const ATTACK_ATTRS: AttributeKey[] = ["finishing", "dribbling", "off_the_ball", "composure", "technique"];
const DEFENSE_ATTRS: AttributeKey[] = ["tackling", "marking", "positioning", "anticipation"];
const PHYSICAL_ATTRS: AttributeKey[] = ["pace", "acceleration", "stamina", "strength"];
const TECHNICAL_ATTRS: AttributeKey[] = ["passing", "vision", "first_touch", "decisions"];
const GK_ATTRS: AttributeKey[] = ["reflexes", "handling", "one_on_ones", "command_of_area", "positioning"];
const BALANCED_ATTRS: AttributeKey[] = [...ATTACK_ATTRS, ...DEFENSE_ATTRS, ...PHYSICAL_ATTRS, ...TECHNICAL_ATTRS];

const FOCUS_ATTRS: Record<TrainingFocus, AttributeKey[]> = {
  attack: ATTACK_ATTRS,
  defense: DEFENSE_ATTRS,
  physical: PHYSICAL_ATTRS,
  technical: TECHNICAL_ATTRS,
  goalkeeping: GK_ATTRS,
  balanced: BALANCED_ATTRS,
};

const BASE_DAILY_CHANCE = 0.02; // 2%/dia por atributo no foco, antes de idade/treinador

function ageFactor(age: number): number {
  if (age <= 20) return 1.6;
  if (age <= 24) return 1.2;
  if (age <= 29) return 0.8;
  if (age <= 32) return 0.4;
  return 0.15;
}

// Risco de lesão por dia de treino, antes de idade — físico é o foco mais
// puxado fisicamente, por isso o maior risco.
const FOCUS_INJURY_RISK: Record<TrainingFocus, number> = {
  physical: 0.006, attack: 0.003, defense: 0.003, technical: 0.002, goalkeeping: 0.002, balanced: 0.0025,
};

function injuryAgeFactor(age: number): number {
  if (age >= 32) return 1.6;
  if (age >= 29) return 1.2;
  if (age <= 21) return 0.8;
  return 1;
}

export interface TrainablePlayer {
  id: string;
  age: number;
  position: string;
  attributes: PlayerAttributes;
  individual_training_focus?: TrainingFocus | null;
  injured_until?: string | null;
}

export interface TrainingPatch {
  id: string;
  attrDeltas: Partial<Record<AttributeKey, number>>;
  overallDelta: number;
  injury?: { type: InjuryTypeKey; days: number };
}

export function applyTraining(
  players: TrainablePlayer[],
  clubFocus: TrainingFocus,
  days: number,
  speedMultiplier: number,
  todayISO: string,
  rng: () => number = Math.random,
): TrainingPatch[] {
  const patches: TrainingPatch[] = [];
  for (const p of players) {
    // Foco individual (ver ficha do jogador) sobrescreve o foco do time
    // inteiro só pra esse jogador — ver src/routes/.../players.$playerId.tsx.
    const focus = p.individual_training_focus ?? clubFocus;
    const attrs = FOCUS_ATTRS[focus];

    // Jogador já lesionado está em repouso/reabilitação, não treino pesado
    // — sem risco extra de lesão nova.
    const alreadyInjured = !!p.injured_until && p.injured_until >= todayISO;
    let injury: TrainingPatch["injury"];
    if (!alreadyInjured) {
      const dailyRisk = FOCUS_INJURY_RISK[focus] * injuryAgeFactor(p.age ?? 24);
      const cumulativeRisk = 1 - Math.pow(1 - Math.min(dailyRisk, 1), days);
      if (rng() < cumulativeRisk) {
        const rolled = rollInjuryType(rng);
        injury = { type: rolled.type, days: rolled.days };
      }
    }

    if (focus === "goalkeeping" && p.position !== "GK") {
      if (injury) patches.push({ id: p.id, attrDeltas: {}, overallDelta: 0, injury });
      continue;
    }
    if (focus !== "goalkeeping" && p.position === "GK") {
      if (injury) patches.push({ id: p.id, attrDeltas: {}, overallDelta: 0, injury });
      continue; // goleiro só evolui nos atributos de goleiro
    }
    const chancePerAttr = BASE_DAILY_CHANCE * ageFactor(p.age ?? 24) * speedMultiplier;
    const cumulative = 1 - Math.pow(1 - Math.min(chancePerAttr, 1), days);
    const deltas: Partial<Record<AttributeKey, number>> = {};
    for (const attr of attrs) {
      const cur = p.attributes?.[attr] ?? 10;
      if (cur >= 20) continue;
      if (rng() < cumulative) deltas[attr] = 1;
    }
    const gained = Object.keys(deltas).length;
    if (gained > 0 || injury) {
      // Overall só sente quando pelo menos 2 atributos do foco avançam no
      // mesmo avanço — evita inflar o overall a cada tiquinho de atributo.
      patches.push({ id: p.id, attrDeltas: deltas, overallDelta: gained >= 2 ? 1 : 0, injury });
    }
  }
  return patches;
}
