import type { StrategySignal } from './indicators';
import type { MarketScanResult } from './scanner';

type OrderSide = 'BUY' | 'SELL';
type PositionSide = 'LONG' | 'SHORT';

export type ReplacementHolding = {
  id: string;
  symbol: string;
  amount: number;
  side: PositionSide;
  entryPrice: number;
};

export type ReplacementEntry = {
  side: OrderSide;
  pick: MarketScanResult;
};

type ReplacementCandidate = {
  holding: ReplacementHolding;
  closePrice: number;
  holdingResult?: MarketScanResult;
  holdingEdgeAfterFrictionPct: number | null;
  edgeImprovementPct: number;
};

export type ReplacementOpportunity = {
  entry: ReplacementEntry;
  holding: ReplacementHolding;
  closePrice: number;
  reason: string;
};

type ReplacementInput = {
  isRealMode: boolean;
  baseAvailableSlots: number;
  estimatedRoundTripFrictionBps: number;
  entry: ReplacementEntry;
  currentHoldings: ReplacementHolding[];
  scanResultsByRiskKey: Map<string, MarketScanResult>;
  holdingPrices: Record<string, number | undefined>;
};

const getCompactUsdSymbolParts = (raw: string) => {
  const compact = String(raw || '').toUpperCase().split(':')[0].replace('/', '');
  const match = compact.match(/^(.+?)(USDT|USDC|FDUSD|BUSD|TUSD|USDP|BTC|ETH|BNB|USD)$/);
  if (!match) return null;
  return { compact, base: match[1], quote: match[2] };
};

const getSymbolRiskIdentity = (raw: string) => {
  const compact = String(raw || '').toUpperCase().split(':')[0].replace('/', '');
  if (!compact) {
    return { key: '', symbol: '' };
  }
  const parts = getCompactUsdSymbolParts(compact);
  return {
    key: parts?.base || compact,
    symbol: parts?.compact || compact,
  };
};

const getDirectionalEntryScore = (side: OrderSide, score: number) => {
  return side === 'SELL' ? 10 - score : score;
};

const getExpectedEdgeAfterFrictionPct = (
  side: OrderSide,
  price: number,
  tradePlan: StrategySignal['tradePlan'] | undefined,
  estimatedRoundTripFrictionBps: number,
) => {
  if (!tradePlan || !price || price <= 0) return null;
  const targetPrice = tradePlan.tp1Price || tradePlan.tp2Price;
  if (!targetPrice || targetPrice <= 0) return null;
  const grossEdgePct = side === 'BUY'
    ? ((targetPrice - price) / price) * 100
    : ((price - targetPrice) / price) * 100;
  return grossEdgePct - (estimatedRoundTripFrictionBps / 100);
};

export const pickReplacementOpportunity = ({
  isRealMode,
  baseAvailableSlots,
  estimatedRoundTripFrictionBps,
  entry,
  currentHoldings,
  scanResultsByRiskKey,
  holdingPrices,
}: ReplacementInput): ReplacementOpportunity | null => {
  if (!isRealMode || baseAvailableSlots > 0) return null;

  const candidateEdgeAfterFrictionPct = getExpectedEdgeAfterFrictionPct(
    entry.side,
    entry.pick.lastPrice,
    entry.pick.signal.tradePlan,
    estimatedRoundTripFrictionBps,
  );
  if (candidateEdgeAfterFrictionPct === null) return null;

  const candidateDirectionalScore = getDirectionalEntryScore(entry.side, entry.pick.signal.score);
  const desiredHoldingSide: PositionSide = entry.side === 'SELL' ? 'SHORT' : 'LONG';
  const replacementFrictionBufferPct = Math.max(0.05, estimatedRoundTripFrictionBps / 100);

  const weakestHolding = currentHoldings
    .filter((holding) => holding.side === desiredHoldingSide)
    .map((holding): (ReplacementCandidate & { replaceable: boolean; priorityImprovement: number; directionalImprovement: number }) => {
      const holdingRiskKey = getSymbolRiskIdentity(holding.symbol).key;
      const holdingResult = scanResultsByRiskKey.get(holdingRiskKey);
      const holdingOrderSide: OrderSide = holding.side === 'SHORT' ? 'SELL' : 'BUY';
      const holdingDirectionalScore = holdingResult
        ? getDirectionalEntryScore(holdingOrderSide, holdingResult.signal.score)
        : 0;
      const holdingEdgeAfterFrictionPct = holdingResult
        ? getExpectedEdgeAfterFrictionPct(
            holdingOrderSide,
            holdingResult.lastPrice,
            holdingResult.signal.tradePlan,
            estimatedRoundTripFrictionBps,
          )
        : null;
      const edgeImprovementPct = candidateEdgeAfterFrictionPct - (holdingEdgeAfterFrictionPct ?? 0);
      const directionalImprovement = candidateDirectionalScore - holdingDirectionalScore;
      const priorityImprovement = (entry.pick.priorityRank || 0) - (holdingResult?.priorityRank || 0);
      const closePrice = holdingPrices[holding.symbol] || holding.entryPrice;
      const replaceable = Boolean(closePrice)
        && edgeImprovementPct > replacementFrictionBufferPct
        && (
          !holdingResult
          || holdingResult.signal.overall === 'HOLD'
          || directionalImprovement >= 0.6
          || priorityImprovement >= 2
        );

      return {
        holding,
        closePrice,
        holdingResult,
        holdingEdgeAfterFrictionPct,
        edgeImprovementPct,
        directionalImprovement,
        priorityImprovement,
        replaceable,
      };
    })
    .filter((candidate) => candidate.replaceable)
    .sort((a, b) => {
      const aEdge = Number.isFinite(a.holdingEdgeAfterFrictionPct) ? Number(a.holdingEdgeAfterFrictionPct) : Infinity;
      const bEdge = Number.isFinite(b.holdingEdgeAfterFrictionPct) ? Number(b.holdingEdgeAfterFrictionPct) : Infinity;
      if (aEdge !== bEdge) return aEdge - bEdge;
      if ((a.holdingResult?.priorityRank || 0) !== (b.holdingResult?.priorityRank || 0)) {
        return (a.holdingResult?.priorityRank || 0) - (b.holdingResult?.priorityRank || 0);
      }
      return b.edgeImprovementPct - a.edgeImprovementPct;
    })[0];

  if (!weakestHolding) return null;

  return {
    entry,
    holding: weakestHolding.holding,
    closePrice: weakestHolding.closePrice,
    reason: `replacement edge +${weakestHolding.edgeImprovementPct.toFixed(2)}% after friction vs ${weakestHolding.holding.symbol}`,
  };
};