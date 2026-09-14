import { supabase } from "@/integrations/supabase/client";
import {
  evaluateAsBuyer, evaluateAsSeller, initialBidFee, MAX_NEGOTIATION_ROUNDS,
} from "@/game/transfer-negotiation";

const AI_TRANSFER_CHANCE = 0.18; // por chamada de advanceDays, não por dia (mesmo padrão de refreshTransferOffers)
const PROTECTED_STARTERS = 11; // não vende os titulares prováveis (melhores do elenco)
const MIN_SQUAD_SIZE = 16; // não deixa o elenco de IA esvaziar

// -----------------------------------------------------------------------------
// Clubes de IA compram e vendem jogadores ENTRE SI em segundo plano — sem
// isso, o mercado só teria vida quando envolvesse o clube do usuário. Como
// não há humano dos dois lados, a negociação inteira (proposta inicial →
// contraproposta → aceite) roda síncrona numa única chamada, reaproveitando
// a mesma matemática de src/game/transfer-negotiation.ts usada no mercado
// do usuário.
// -----------------------------------------------------------------------------
export async function simulateAITransferActivity(saveId: string, myClubId: string | null): Promise<void> {
  if (Math.random() > AI_TRANSFER_CHANCE) return;

  const { data: clubs } = await supabase
    .from("clubs").select("id, transfer_budget, reputation").eq("save_id", saveId);
  const aiClubs = (clubs ?? []).filter((c) => c.id !== myClubId);
  if (aiClubs.length < 2) return;

  const buyer = aiClubs[Math.floor(Math.random() * aiClubs.length)];
  const sellerCandidates = aiClubs.filter((c) => c.id !== buyer.id);
  const seller = sellerCandidates[Math.floor(Math.random() * sellerCandidates.length)];
  if (!seller) return;

  const { data: roster } = await supabase
    .from("players").select("id, market_value, overall")
    .eq("club_id", seller.id).order("overall", { ascending: false });
  if (!roster || roster.length <= MIN_SQUAD_SIZE) return;

  const { data: pendingOffers } = await supabase
    .from("transfer_offers").select("player_id").eq("save_id", saveId).eq("status", "pending");
  const lockedIds = new Set((pendingOffers ?? []).map((o) => o.player_id));

  const sellable = roster.slice(PROTECTED_STARTERS).filter((p) => !lockedIds.has(p.id));
  if (sellable.length === 0) return;
  const target = sellable[Math.floor(Math.random() * sellable.length)];

  let fee = initialBidFee(target.market_value, buyer.reputation, seller.reputation);
  if (fee > buyer.transfer_budget) return;

  let accepted = false;
  let round = 1;
  while (round <= MAX_NEGOTIATION_ROUNDS) {
    const sellerDecision = evaluateAsSeller({
      offerFee: fee, marketValue: target.market_value, round,
      buyerReputation: buyer.reputation, sellerReputation: seller.reputation, clubBudget: seller.transfer_budget,
    });
    if (sellerDecision.decision === "accept") { accepted = true; break; }
    if (sellerDecision.decision === "reject") break;

    if (sellerDecision.counterFee > buyer.transfer_budget) break;
    const buyerDecision = evaluateAsBuyer({
      offerFee: sellerDecision.counterFee, marketValue: target.market_value, round: round + 1,
      buyerReputation: buyer.reputation, sellerReputation: seller.reputation,
    });
    fee = sellerDecision.counterFee;
    if (buyerDecision.decision === "accept") { accepted = true; break; }
    if (buyerDecision.decision === "reject") break;
    fee = buyerDecision.counterFee;
    round += 2;
  }
  if (!accepted || fee > buyer.transfer_budget) return;

  const today = new Date().toISOString().split("T")[0];
  // Nenhuma dessas escritas checava erro — mesma classe de bug já corrigida
  // em executeTransfer (src/lib/transfer-offers.ts): uma falha silenciosa
  // aqui pode debitar/creditar caixa sem o jogador trocar de clube de
  // verdade (ou o contrário), e isso roda automaticamente em TODO
  // advanceDays(), não só quando o usuário mexe no mercado.
  const { error: playerError } = await supabase.from("players").update({ club_id: buyer.id }).eq("id", target.id);
  if (playerError) throw playerError;
  const { error: buyerBudgetError } = await supabase.from("clubs").update({ transfer_budget: buyer.transfer_budget - fee }).eq("id", buyer.id);
  if (buyerBudgetError) throw buyerBudgetError;
  const { error: sellerBudgetError } = await supabase.from("clubs").update({ transfer_budget: seller.transfer_budget + fee }).eq("id", seller.id);
  if (sellerBudgetError) throw sellerBudgetError;
  const { error: transferRowError } = await supabase.from("transfers").insert({
    save_id: saveId, player_id: target.id, from_club_id: seller.id, to_club_id: buyer.id,
    fee, status: "completed", proposal_date: today, resolved_date: today,
  });
  if (transferRowError) throw transferRowError;
}
