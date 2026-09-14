// -----------------------------------------------------------------------------
// Valor de mercado — antes ficava travado no valor da importação do seed (ou
// da geração de um juvenil) pro resto da carreira do jogador, mesmo com o
// overall mudando bastante (treino, evolução de jovem, declínio por idade).
// Em vez de recalcular do zero com uma fórmula (o que destoaria dos valores
// reais importados via seed.json), ajusta PROPORCIONALMENTE ao valor atual
// toda vez que o overall muda — cada ponto de overall move o valor em ~7%,
// composto. Ver src/lib/advance-day.ts (treino) e src/lib/season-rollover.ts
// (virada de temporada).
// -----------------------------------------------------------------------------
export function adjustMarketValue(currentValue: number, overallDelta: number): number {
  if (!currentValue || overallDelta === 0) return currentValue;
  return Math.max(1000, Math.round(currentValue * Math.pow(1.07, overallDelta)));
}
