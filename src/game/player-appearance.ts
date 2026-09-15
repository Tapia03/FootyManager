// Tom de pele/cabelo procedural por jogador — MESMA paleta e hash usados no
// boneco 3D da partida (src/components/match-3d-pitch.tsx), pra um jogador
// ter a mesma aparência no retrato 2D (src/components/player-face.tsx) e no
// campo 3D. Hash determinístico: o mesmo id sempre gera a mesma cara.
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

export const SKIN_TONES = [0xf1c9a5, 0xe0ac82, 0xc68642, 0x8d5524, 0x5c3a21];
export const HAIR_COLORS = [0x1c1917, 0x2b2b2b, 0x4b3621, 0x6b4a2f, 0x8d6e4c, 0xb08d57, 0x2a2a2a];

const toHex = (n: number) => "#" + n.toString(16).padStart(6, "0");

export function playerAppearance(id: string): { skin: string; hair: string; hairAmount: number } {
  return {
    skin: toHex(SKIN_TONES[(hashStr(id) * SKIN_TONES.length) | 0]),
    hair: toHex(HAIR_COLORS[(hashStr(id + "h") * HAIR_COLORS.length) | 0]),
    hairAmount: hashStr(id + "hs"),
  };
}
