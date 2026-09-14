// -----------------------------------------------------------------------------
// Número da camisa. Não vem da base do FM (a CSV não traz), então é atribuído
// por nós: pilha de preferência por setor (goleiro puxa o 1, atacante o 9/10/7
// etc.) com fallback pro menor número livre. Determinístico dado o elenco.
// -----------------------------------------------------------------------------
type Pos = "GK" | "DEF" | "MID" | "FWD" | string;

const PREF: Record<"GK" | "DEF" | "MID" | "FWD", number[]> = {
  GK: [1, 12, 13, 25, 31, 40],
  DEF: [3, 4, 2, 5, 6, 15, 14, 16, 22, 24, 26, 33],
  MID: [8, 10, 6, 7, 16, 17, 18, 20, 21, 23, 28, 30],
  FWD: [9, 10, 7, 11, 17, 19, 20, 27, 29, 32, 39, 45],
};
const POS_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

function basePos(p: Pos): "GK" | "DEF" | "MID" | "FWD" {
  return p === "GK" || p === "DEF" || p === "MID" || p === "FWD" ? p : "MID";
}

/** Menor número livre em 1..99 que não esteja em `used`. */
function lowestFree(used: Set<number>): number {
  for (let n = 1; n < 100; n++) if (!used.has(n)) return n;
  return 99;
}

/**
 * Um número livre pra uma contratação nova, respeitando a preferência do setor.
 */
export function nextSquadNumber(existing: (number | null | undefined)[], position: Pos): number {
  const used = new Set<number>(existing.filter((n): n is number => n != null));
  for (const n of PREF[basePos(position)]) if (!used.has(n)) return n;
  return lowestFree(used);
}

/**
 * Numera um elenco inteiro do zero. Ordena por setor (GK→DEF→MID→FWD) e overall,
 * e vai puxando da pilha de preferência de cada setor.
 */
export function assignSquadNumbers(
  players: { id: string; position: Pos; overall?: number | null }[],
): Record<string, number> {
  const ordered = [...players].sort((a, b) => {
    const po = (POS_ORDER[basePos(a.position)] ?? 2) - (POS_ORDER[basePos(b.position)] ?? 2);
    return po !== 0 ? po : (b.overall ?? 0) - (a.overall ?? 0);
  });
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const p of ordered) {
    let picked = 0;
    for (const n of PREF[basePos(p.position)]) {
      if (!used.has(n)) { picked = n; break; }
    }
    if (!picked) picked = lowestFree(used);
    used.add(picked);
    out[p.id] = picked;
  }
  return out;
}
