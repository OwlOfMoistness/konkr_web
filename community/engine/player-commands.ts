import { parseDecision } from '../shared/contracts.ts';
import type { PlayerDecision } from '../shared/contracts.ts';
import type { EngineSession } from './adapter.ts';
import type { Recovered } from './platform.ts';
import { MAX_HEX_ID } from './hex-grid.ts';

export class PlayerCommandError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'PlayerCommandError'; this.code = code; }
}
export class UnsupportedDecisionError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'UnsupportedDecisionError'; this.code = code; }
}
const deny = (code: string): never => { throw new PlayerCommandError(code); };

function destination(session: EngineSession, id: number): Recovered {
  // parseDecision already checks nonnegative integers. Bound the native cache,
  // then require actual server-owned land, including tiles beyond nominal size.
  if (id > MAX_HEX_ID) deny('invalid-destination');
  const hex = session.requireModule(35326).getHex(id);
  if (!hex || !session.model.regions.byHex(hex)) deny('invalid-destination');
  return hex;
}
function allowDrop(session: EngineSession, hex: Recovered, type: string, region: Recovered): void {
  const result = session.model.warfare.getDropPawnResult(hex, type, region);
  if (!result || result.type === session.requireModule(89111).DropPawnResultType.Invalid) deny('illegal-destination');
}

/** Validate player authority before calling any trusted reducer capability. */
export async function applyPlayerDecision(session: EngineSession, value: PlayerDecision): Promise<void> {
  const decision = parseDecision(value);
  if (decision.kind === 'choose-landing' || session.model.plugins.pickLandingSpot) {
    throw new UnsupportedDecisionError('landing-not-supported');
  }
  if (session.outcome) deny('decision-after-game-over');
  const { model } = session;
  if (!model.currentPhase.isLocalPlayerTurn() || model.currentPhase.faction?.id !== 1 || !model.factions.localPlayer?.isAlive()) deny('not-player-turn');
  switch (decision.kind) {
    case 'move': {
      const pawn = model.pawns.byId(decision.pawnId);
      if (!pawn?.exists || pawn.region?.faction?.id !== 1 || !pawn.region.isAlive() || !pawn.isMovable()) deny('pawn-not-movable');
      const hex = destination(session, decision.destinationHexId);
      if (pawn.hex.id === hex.id) deny('no-op-move');
      allowDrop(session, hex, pawn.type, pawn.region);
      session.executeInternal('MovePawn', { pawnId: pawn.id, destinationHexId: hex.id, tapUnit: false });
      break;
    }
    case 'buy': {
      const region = model.regions.byId(decision.buyerRegionId);
      if (!region?.exists || region.faction?.id !== 1 || !region.isAlive()) deny('region-not-controllable');
      const { PawnType } = session.requireModule(62928);
      // Original PlayUIScene.getBuyablePawnsConfig (45474), without importing
      // Phaser UI classes. Preserve ordered plugin application and real prices.
      const baseUnits = [PawnType.Villager, PawnType.Pikeman, PawnType.Knight, PawnType.Hero];
      const buildings = model.plugins.rules.adjustBuyableObjects.apply([PawnType.Castle], model.state);
      if (![...baseUnits, ...buildings].includes(decision.pawnType)) deny('pawn-not-buyable');
      const rules = model.rules.pawns(decision.pawnType);
      if (!rules || rules.cost <= 0 || model.economy.treasuryOf(region) < rules.cost) deny('insufficient-funds');
      const hex = destination(session, decision.destinationHexId);
      allowDrop(session, hex, decision.pawnType, region);
      session.executeInternal('BuyPawn', { pawnType: decision.pawnType, destinationHexId: hex.id, buyerRegionId: region.id, tapUnit: false });
      break;
    }
    case 'end-turn':
      session.surrenderOffered = false;
      session.executeInternal('EndTurn');
      break;
    case 'accept-surrender':
      if (!session.surrenderOffered) deny('surrender-not-offered');
      session.executeInternal('AcceptSurrender');
      break;
  }
  session.capture('player', 1);
  if (decision.kind === 'end-turn') await session.settleOpponents();
}
