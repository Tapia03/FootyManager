import { describe, expect, it } from "vitest";
import {
  generateObjective, objectiveLabel, evaluateObjective, confidenceDelta, managerReputationDelta,
  sponsorObjectiveBonus, fanTemperamentFromClubId, gateIncome, FAN_TEMPERAMENT_LABEL,
} from "../board";

const LEAGUE_SIZE = 20;
const RELEGATION_SLOTS = 4; // tamanho típico de zona de rebaixamento numa liga de 20

describe("generateObjective — faixas por rank de reputação (item 12 do backlog FootSim)", () => {
  it("o clube #1 da liga recebe a meta de vencer o campeonato", () => {
    const obj = generateObjective(1, LEAGUE_SIZE, RELEGATION_SLOTS);
    expect(obj.kind).toBe("win_league");
    expect(obj.target).toBe(1);
  });
  it("um clube bem no topo (mas não o #1) recebe G-4", () => {
    const obj = generateObjective(3, LEAGUE_SIZE, RELEGATION_SLOTS);
    expect(obj.kind).toBe("top4");
    expect(obj.target).toBeGreaterThanOrEqual(4);
  });
  it("um clube um pouco mais abaixo recebe G-6", () => {
    const obj = generateObjective(7, LEAGUE_SIZE, RELEGATION_SLOTS);
    expect(obj.kind).toBe("top6");
  });
  it("um clube de meio-alta tabela recebe primeira metade", () => {
    const obj = generateObjective(10, LEAGUE_SIZE, RELEGATION_SLOTS);
    expect(obj.kind).toBe("top_half");
  });
  it("um clube médio recebe campanha de meio de tabela", () => {
    const obj = generateObjective(14, LEAGUE_SIZE, RELEGATION_SLOTS);
    expect(obj.kind).toBe("mid_table");
  });
  it("um clube fraco (mas não o pior) recebe fugir do Z-4", () => {
    const obj = generateObjective(17, LEAGUE_SIZE, RELEGATION_SLOTS);
    expect(obj.kind).toBe("avoid_relegation");
    expect(obj.target).toBe(LEAGUE_SIZE - RELEGATION_SLOTS);
  });
  it("o clube mais fraco da liga recebe lutar contra o rebaixamento", () => {
    const obj = generateObjective(20, LEAGUE_SIZE, RELEGATION_SLOTS);
    expect(obj.kind).toBe("fight_relegation");
    expect(obj.target).toBe(LEAGUE_SIZE - RELEGATION_SLOTS); // mesmo alvo numérico do avoid_relegation — só muda a expectativa
  });
  it("sem divisão abaixo (relegationSlots=0), nunca sugere meta de rebaixamento — cai pra meio de tabela", () => {
    const obj = generateObjective(20, LEAGUE_SIZE, 0);
    expect(obj.kind).toBe("mid_table");
  });
  it("caso real achado com o Al-Hilal: 3º colocado por causa de empate/desempate, mas a 1 ponto do líder — ainda é favorito ao título, não G-4", () => {
    const obj = generateObjective(3, 14, 0, 1); // reputationGapToLeader=1 (71 vs 70)
    expect(obj.kind).toBe("win_league");
  });
  it("mas um 3º colocado de verdade distante do líder (gap grande) recebe G-4 normalmente", () => {
    const obj = generateObjective(3, 14, 0, 15);
    expect(obj.kind).toBe("top4");
  });
  it("sem informar o gap pro líder (chamada antiga, 3 argumentos), o comportamento continua o de antes — só rank 1 é elite", () => {
    const obj = generateObjective(2, LEAGUE_SIZE, RELEGATION_SLOTS);
    expect(obj.kind).not.toBe("win_league");
  });
  it("nunca sugere um alvo fora da faixa 1..leagueSize", () => {
    for (let rank = 1; rank <= LEAGUE_SIZE; rank++) {
      const obj = generateObjective(rank, LEAGUE_SIZE, RELEGATION_SLOTS);
      expect(obj.target).toBeGreaterThanOrEqual(1);
      expect(obj.target).toBeLessThanOrEqual(LEAGUE_SIZE);
    }
  });
});

describe("objectiveLabel", () => {
  it("gera um rótulo distinto pra cada faixa", () => {
    const kinds = ["win_league", "top4", "top6", "top_half", "mid_table", "avoid_relegation", "fight_relegation"] as const;
    const labels = kinds.map((kind) => objectiveLabel({ kind, target: 5 }));
    expect(new Set(labels).size).toBe(kinds.length);
  });
});

describe("evaluateObjective", () => {
  it("bate a meta quando termina na posição alvo ou melhor", () => {
    expect(evaluateObjective({ kind: "top4", target: 4 }, 4)).toBe("met");
    expect(evaluateObjective({ kind: "top4", target: 4 }, 2)).toBe("met");
  });
  it("não bate quando termina pior que o alvo", () => {
    expect(evaluateObjective({ kind: "top4", target: 4 }, 5)).toBe("missed");
  });
});

describe("confidenceDelta — bônus/punição assimétrica pra lutar contra o rebaixamento", () => {
  it("bater a meta de sobrevivência (fight_relegation) rende bônus extra sobre a mesma folga numa faixa normal", () => {
    const underdog = confidenceDelta({ kind: "fight_relegation", target: 16 }, 14);
    const normal = confidenceDelta({ kind: "avoid_relegation", target: 16 }, 14);
    expect(underdog).toBeGreaterThan(normal);
  });
  it("cair (missed) numa meta de sobrevivência dói menos do que decepcionar numa faixa normal", () => {
    const underdog = confidenceDelta({ kind: "fight_relegation", target: 16 }, 19);
    const normal = confidenceDelta({ kind: "avoid_relegation", target: 16 }, 19);
    expect(Math.abs(underdog)).toBeLessThan(Math.abs(normal));
  });
});

describe("managerReputationDelta", () => {
  it("campeão sempre rende o bônus máximo, mesmo se a meta era só top_half", () => {
    expect(managerReputationDelta(1, 10, true)).toBe(10);
  });
  it("bater a meta rende reputação positiva", () => {
    expect(managerReputationDelta(3, 4, false)).toBeGreaterThan(0);
  });
  it("não bater a meta rende reputação negativa", () => {
    expect(managerReputationDelta(8, 4, false)).toBeLessThan(0);
  });
});

describe("sponsorObjectiveBonus — item 13 do backlog FootSim", () => {
  it("não paga nada quando a meta não é batida", () => {
    expect(sponsorObjectiveBonus(70, { kind: "top4", target: 4 }, 8)).toBe(0);
  });
  it("paga quando a meta é batida", () => {
    expect(sponsorObjectiveBonus(70, { kind: "top4", target: 4 }, 3)).toBeGreaterThan(0);
  });
  it("vencer o campeonato rende um bônus bem maior que só evitar o rebaixamento, pro mesmo clube", () => {
    const title = sponsorObjectiveBonus(70, { kind: "win_league", target: 1 }, 1);
    const survival = sponsorObjectiveBonus(70, { kind: "avoid_relegation", target: 16 }, 16);
    expect(title).toBeGreaterThan(survival * 2);
  });
  it("sobreviver lutando contra o rebaixamento (fight_relegation) também rende bônus — vira notícia", () => {
    expect(sponsorObjectiveBonus(70, { kind: "fight_relegation", target: 16 }, 16)).toBeGreaterThan(0);
  });
});

describe("fanTemperamentFromClubId — item 13 do backlog FootSim", () => {
  it("é determinístico — o mesmo ID sempre dá a mesma personalidade", () => {
    const a = fanTemperamentFromClubId("club-abc-123");
    const b = fanTemperamentFromClubId("club-abc-123");
    expect(a).toBe(b);
  });
  it("só produz valores válidos", () => {
    const valid = new Set(Object.keys(FAN_TEMPERAMENT_LABEL));
    for (const id of ["a", "b", "c", "manchester-city-id", "6cea41ad-e0c9-4459-972b-99640b4b0123"]) {
      expect(valid.has(fanTemperamentFromClubId(id))).toBe(true);
    }
  });
  it("IDs diferentes tendem a dar personalidades diferentes (não é sempre a mesma)", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `club-${i}`);
    const results = new Set(ids.map(fanTemperamentFromClubId));
    expect(results.size).toBeGreaterThan(1);
  });
});

describe("gateIncome — personalidade da torcida muda a curva de ocupação", () => {
  const rngHigh = () => 1; // topo da variação
  const rngLow = () => 0; // piso da variação

  it("torcida apaixonada nunca esvazia o estádio, mesmo no pior sorteio de variação", () => {
    const r = gateIncome(50_000, 40, false, rngLow, "apaixonada");
    expect(r.attendance / 50_000).toBeGreaterThan(0.4);
  });
  it("torcida exigente pode esvaziar bem mais o estádio no pior sorteio, pro mesmo clube", () => {
    const apaixonada = gateIncome(50_000, 40, false, rngLow, "apaixonada");
    const exigente = gateIncome(50_000, 40, false, rngLow, "exigente");
    expect(exigente.attendance).toBeLessThan(apaixonada.attendance);
  });
  it("sem personalidade informada, usa a curva tradicional (comportamento de antes do item 13)", () => {
    const semTemperamento = gateIncome(50_000, 60, false, () => 0.5);
    const tradicional = gateIncome(50_000, 60, false, () => 0.5, "tradicional");
    expect(semTemperamento).toEqual(tradicional);
  });
});
