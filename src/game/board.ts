// -----------------------------------------------------------------------------
// Diretoria e objetivos — lógica pura (sem I/O).
//
// No início de cada temporada, a diretoria define uma meta pro clube do
// usuário com base na reputação (clube grande = objetivo ousado, clube
// pequeno = só não cair). No fim da temporada, bater ou não a meta empurra
// a confiança da diretoria pra cima ou pra baixo — confiança muito baixa é
// sinal de que o técnico está com o emprego em risco.
// -----------------------------------------------------------------------------

export type ObjectiveKind = "win_league" | "top_n" | "avoid_relegation";

export interface SeasonObjective {
  kind: ObjectiveKind;
  target: number; // win_league/top_n: posição-alvo · avoid_relegation: limite antes do rebaixamento
}

export function objectiveLabel(obj: SeasonObjective): string {
  if (obj.kind === "win_league") return "Vencer o campeonato";
  if (obj.kind === "top_n") return `Terminar entre os ${obj.target} primeiros`;
  return `Terminar até a ${obj.target}ª posição (evitar o rebaixamento)`;
}

export function generateObjective(clubReputation: number, leagueSize: number): SeasonObjective {
  if (clubReputation >= 80) return { kind: "win_league", target: 1 };
  if (clubReputation >= 65) return { kind: "top_n", target: Math.max(2, Math.round(leagueSize * 0.2)) };
  if (clubReputation >= 45) return { kind: "top_n", target: Math.max(4, Math.round(leagueSize * 0.5)) };
  return { kind: "avoid_relegation", target: Math.max(4, leagueSize - Math.max(2, Math.round(leagueSize * 0.15))) };
}

export function evaluateObjective(obj: SeasonObjective, finalPosition: number): "met" | "missed" {
  return finalPosition <= obj.target ? "met" : "missed";
}

/**
 * Quanto a confiança da diretoria muda no fim da temporada. Bater a meta com
 * folga rende bônus extra; ficar bem longe da meta dói mais que ficar por pouco.
 */
export function confidenceDelta(obj: SeasonObjective, finalPosition: number): number {
  const status = evaluateObjective(obj, finalPosition);
  if (status === "met") {
    const margin = Math.max(0, obj.target - finalPosition);
    return Math.min(30, 15 + margin * 2);
  }
  const shortfall = finalPosition - obj.target;
  return -Math.min(35, 12 + shortfall * 2);
}

export const BOARD_CONFIDENCE_CRITICAL = 25;

// -----------------------------------------------------------------------------
// Reputação do técnico — pessoal, separada da confiança da diretoria do
// clube atual (que reseta a cada troca de clube) e da reputação do clube.
// Se move mais devagar, ao longo de toda a carreira, e alimenta as
// sondagens de emprego (ver src/game/job-offers.ts).
// -----------------------------------------------------------------------------
export function managerReputationDelta(finalPosition: number, objectiveTarget: number, isChampion: boolean): number {
  if (isChampion) return 10;
  const met = finalPosition <= objectiveTarget;
  if (met) {
    const margin = Math.max(0, objectiveTarget - finalPosition);
    return Math.min(8, 3 + margin);
  }
  const shortfall = finalPosition - objectiveTarget;
  return -Math.min(8, 2 + Math.round(shortfall / 2));
}

// -----------------------------------------------------------------------------
// Reputação do CLUBE — diferente da reputação pessoal do técnico (que segue a
// carreira dele) e da confiança da diretoria (que reseta a cada demissão).
// Antes ficava travada no valor do seed pra sempre, pra qualquer clube (nem
// o do usuário mudava) — mesmo sendo usada o save inteiro por bilheteria,
// patrocínio, tática de IA, negociação de mercado e sondagem de emprego.
// Deriva devagar, pela posição final na tabela: campeão sobe, lanterna desce,
// meio de tabela quase não mexe. Ver src/lib/season-rollover.ts.
// -----------------------------------------------------------------------------
export function clubReputationDelta(finalPosition: number, leagueSize: number): number {
  if (leagueSize <= 1) return 0;
  const normalized = 1 - (2 * (finalPosition - 1)) / (leagueSize - 1); // topo=+1 .. lanterna=-1
  return Math.round(normalized * 3);
}

// -----------------------------------------------------------------------------
// Verba de transferência — aporte de fim de temporada, escalado pela
// reputação do clube. Sem isso, a verba de transferência de todo clube de IA
// só encolhe ou troca de mãos (negociação é soma zero entre eles — ver
// src/lib/ai-transfers.ts); o clube do usuário tem o pedido de verba avulso
// (evaluateBudgetRequest acima), a IA não tinha NADA recorrente. Ver
// src/lib/season-rollover.ts.
// -----------------------------------------------------------------------------
export function transferBudgetInjection(clubReputation: number): number {
  return Math.round(clubReputation * 8_000);
}

// -----------------------------------------------------------------------------
// Pedido de verba extra à diretoria — quanto maior a confiança e a
// reputação do clube, mais generoso (e mais provável) o aporte.
// -----------------------------------------------------------------------------
export interface BudgetRequestResult {
  approved: boolean;
  grantedAmount: number;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function budgetCeiling(boardConfidence: number, clubReputation: number): number {
  return clubReputation * 20_000 * clamp(boardConfidence / 60, 0.3, 1.8);
}

export function evaluateBudgetRequest(
  amountRequested: number,
  boardConfidence: number,
  clubReputation: number,
): BudgetRequestResult {
  const ceiling = budgetCeiling(boardConfidence, clubReputation);
  if (amountRequested > ceiling * 1.4) return { approved: false, grantedAmount: 0 };
  const grantRatio = clamp(boardConfidence / 100, 0.35, 1);
  const grantedAmount = Math.round(Math.min(amountRequested, ceiling) * grantRatio);
  return { approved: grantedAmount > 0, grantedAmount };
}

// Valor "de bom senso" pra pré-preencher o campo de pedido de verba — o teto
// que evaluateBudgetRequest() realmente respeita, não um número fixo que
// pode já nascer acima do teto (rejeitado na hora) ou bem abaixo dele
// (deixando verba na mesa) dependendo do clube.
export function suggestedBudgetRequest(boardConfidence: number, clubReputation: number): number {
  return Math.round(budgetCeiling(boardConfidence, clubReputation));
}

// -----------------------------------------------------------------------------
// Instalações (CT e base) — nível 1-5, 3 é o padrão neutro. O CT afeta o ritmo
// de treino/recuperação (ver src/lib/advance-day.ts); a base afeta a qualidade
// dos juniores (ver src/game/youth.ts). Melhoradas pelo catálogo de pedidos.
// -----------------------------------------------------------------------------
export function facilityFactor(level: number): number {
  return clamp(1 + (level - 3) * 0.12, 0.7, 1.3); // nível 5 = +24% no efeito
}

// -----------------------------------------------------------------------------
// Catálogo de pedidos à diretoria (estilo FM). Cada item tem pré-requisito de
// confiança e (quando custa do caixa) de liquidez. Aplicado em src/lib/board.ts,
// tela em src/routes/_authenticated/saves.$saveId.board.tsx.
// -----------------------------------------------------------------------------
export type BoardRequestKind =
  | "verba_transferencia" | "teto_salarial" | "melhorar_ct" | "melhorar_base" | "ampliar_estadio";

export interface BoardRequestItem {
  kind: BoardRequestKind;
  title: string;
  description: string;
  benefit: string;
  minConfidence: number;
  cashCost: number; // 0 = aporte da diretoria (não sai do caixa)
}

const CT_COST = 18_000_000;
const BASE_COST = 15_000_000;
const STADIUM_COST = 35_000_000;
const STADIUM_SEATS = 6_000;

export const BOARD_REQUEST_CATALOG: BoardRequestItem[] = [
  { kind: "verba_transferencia", title: "Injeção de verba para contratações", description: "Aporte extraordinário direto no orçamento de transferências.", benefit: "+ verba de transferências, escalada pela reputação do clube.", minConfidence: 55, cashCost: 0 },
  { kind: "teto_salarial", title: "Aumento do teto salarial", description: "Amplia a margem da folha para renovações e reforços de peso.", benefit: "+ caixa operacional para acomodar salários.", minConfidence: 50, cashCost: 0 },
  { kind: "melhorar_ct", title: "Modernização do Centro de Treinamento", description: "Novos campos, biometria e equipamentos de recuperação muscular.", benefit: "CT +1 estrela — treino e recuperação física mais rápidos.", minConfidence: 62, cashCost: CT_COST },
  { kind: "melhorar_base", title: "Investimento na categoria de base", description: "Mais olheiros mirins e melhor estrutura para as divisões de base.", benefit: "Base +1 estrela — juniores nascem mais fortes e com mais potencial.", minConfidence: 58, cashCost: BASE_COST },
  { kind: "ampliar_estadio", title: "Ampliação do estádio", description: "Novas arquibancadas e camarotes premium.", benefit: `+ ${STADIUM_SEATS.toLocaleString("pt-BR")} lugares — mais receita de bilheteria por jogo em casa.`, minConfidence: 70, cashCost: STADIUM_COST },
];

export const MAX_BOARD_REQUESTS_PER_SEASON = 3;

export interface BoardRequestEffects {
  transfer_budget_delta?: number;
  budget_delta?: number;
  training_facilities_delta?: number;
  youth_facilities_delta?: number;
  stadium_capacity_delta?: number;
  board_confidence_delta?: number;
}
export interface BoardRequestOutcome {
  approved: boolean;
  response: string;
  effects: BoardRequestEffects;
}

const brl = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `R$ ${(n / 1_000_000).toFixed(1)}M` : `R$ ${(n / 1_000).toFixed(0)}k`;

export function evaluateBoardRequest(
  kind: BoardRequestKind,
  ctx: {
    boardConfidence: number; cash: number; clubReputation: number;
    requestsThisSeason: number; trainingFacilities: number; youthFacilities: number;
  },
): BoardRequestOutcome {
  const item = BOARD_REQUEST_CATALOG.find((i) => i.kind === kind);
  if (!item) return { approved: false, response: "Pedido inválido.", effects: {} };

  if (ctx.requestsThisSeason >= MAX_BOARD_REQUESTS_PER_SEASON) {
    return { approved: false, response: "A diretoria já atendeu vários pedidos nesta temporada — trabalhe com o que tem até a próxima.", effects: {} };
  }
  if (ctx.boardConfidence < item.minConfidence) {
    return { approved: false, response: `O Conselho quer resultados mais consistentes antes de assumir esse compromisso (confiança mínima: ${item.minConfidence}%).`, effects: {} };
  }
  if (item.cashCost > 0 && ctx.cash < item.cashCost * 0.6) {
    return { approved: false, response: "Recusado por liquidez: o caixa atual não comporta este desembolso agora.", effects: {} };
  }

  switch (kind) {
    case "verba_transferencia": {
      // Aporte próprio do catálogo (curva mais generosa que a de fim de
      // temporada em transferBudgetInjection, que roda pra liga inteira).
      const amount = Math.round(ctx.clubReputation ** 2 * 320 * clamp(ctx.boardConfidence / 70, 0.5, 1.6));
      return { approved: true, response: `Aprovado. A diretoria liberou ${brl(amount)} para o orçamento de transferências.`, effects: { transfer_budget_delta: amount, board_confidence_delta: 1 } };
    }
    case "teto_salarial": {
      const amount = Math.round(ctx.clubReputation ** 2 * 190 * clamp(ctx.boardConfidence / 70, 0.5, 1.5));
      return { approved: true, response: `Aprovado. O caixa operacional foi reforçado em ${brl(amount)} para acomodar a folha.`, effects: { budget_delta: amount, board_confidence_delta: 1 } };
    }
    case "melhorar_ct": {
      if (ctx.trainingFacilities >= 5) return { approved: false, response: "O CT já é de primeira linha — não há o que melhorar por ora.", effects: {} };
      return { approved: true, response: "Excelente visão de longo prazo. As obras de modernização do CT foram autorizadas.", effects: { training_facilities_delta: 1, budget_delta: -CT_COST, board_confidence_delta: 3 } };
    }
    case "melhorar_base": {
      if (ctx.youthFacilities >= 5) return { approved: false, response: "A estrutura de base já é de elite.", effects: {} };
      return { approved: true, response: "Aprovado com louvor. Fortalecer a base é essencial para a sustentabilidade do clube.", effects: { youth_facilities_delta: 1, budget_delta: -BASE_COST, board_confidence_delta: 3 } };
    }
    case "ampliar_estadio": {
      return { approved: true, response: `Aprovada a expansão do estádio em ${STADIUM_SEATS.toLocaleString("pt-BR")} novos assentos! A bilheteria vai crescer.`, effects: { stadium_capacity_delta: STADIUM_SEATS, budget_delta: -STADIUM_COST, board_confidence_delta: 4 } };
    }
  }
}

// -----------------------------------------------------------------------------
// Patrocínio — renda mensal automática (dia 1 de cada mês, junto da folha
// salarial), escalada pela reputação do clube. Sem negociação por ora, é
// só um fluxo de caixa recorrente — ver src/lib/advance-day.ts.
// -----------------------------------------------------------------------------
export function sponsorIncome(clubReputation: number): number {
  return Math.round(clubReputation * 12_000);
}

// -----------------------------------------------------------------------------
// Bilheteria — antes era um valor fixo aleatório igual pra qualquer clube;
// agora depende da capacidade real do estádio (já existe em clubs.stadium_capacity,
// só nunca tinha sido usada) e da reputação (público maior em clube grande),
// com bônus extra em clássico. Ver src/lib/advance-day.ts.
// -----------------------------------------------------------------------------
const TICKET_PRICE = 45;

export function gateIncome(
  stadiumCapacity: number,
  clubReputation: number,
  isDerby: boolean,
  rng: () => number = Math.random,
): { attendance: number; amount: number } {
  const baseOccupancy = clamp(0.35 + clubReputation / 130, 0.4, 0.95);
  const derbyBoost = isDerby ? 1.15 : 1;
  const variance = 0.9 + rng() * 0.2; // ±10%
  const occupancy = clamp(baseOccupancy * derbyBoost * variance, 0, 1);
  const attendance = Math.round(stadiumCapacity * occupancy);
  const amount = Math.round(attendance * TICKET_PRICE);
  return { attendance, amount };
}
