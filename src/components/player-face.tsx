import { playerAppearance } from "@/game/player-appearance";

type FaceEntity = { id: string; name: string; face_url?: string | null };

// Foto real (face_url, importado via scripts/import-player-faces.mjs) ou,
// na ausência dela, um retrato procedural (cabeça + cabelo nas cores
// determinísticas do jogador — mesmas de src/game/player-appearance.ts,
// usado também pelo boneco 3D da partida) — nunca fica sem nada, mesmo
// princípio de fallback do ClubCrest/NationalityFlag.
export function PlayerFace({ player, className = "w-8 h-8" }: { player: FaceEntity; className?: string }) {
  if (player.face_url) {
    return (
      <img
        src={player.face_url}
        alt={player.name}
        className={`${className} inline-block rounded-full object-cover align-middle`}
      />
    );
  }

  const { skin, hair, hairAmount } = playerAppearance(player.id);
  const bald = hairAmount < 0.12;

  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} inline-block rounded-full align-middle`}
      role="img"
      aria-label={player.name}
    >
      <circle cx="12" cy="12" r="12" fill={skin} />
      <circle cx="12" cy="15.5" r="7" fill={skin} />
      {!bald && (
        <path
          d="M2 11 A10 10 0 0 1 22 11 L22 9 A10 9 0 0 0 2 9 Z"
          fill={hair}
        />
      )}
    </svg>
  );
}
