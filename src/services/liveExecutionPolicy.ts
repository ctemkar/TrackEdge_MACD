export const MAX_TRANSIENT_EMPTY_SYNC_PRESERVES = 8;

export interface SyncTrustDecision {
  isTrusted: boolean;
  preserveExistingHoldings: boolean;
  nextConsecutiveEmptySyncs: number;
  warningMessage?: string;
}

export interface SyncTrustInputs {
  isRealMode: boolean;
  isAuthDegraded: boolean;
  existingHoldingCount: number;
  freshHoldingCount: number;
  filteredSymbolCount: number;
  consecutiveEmptySyncs: number;
}

export const decideExchangeSyncTrust = ({
  isRealMode,
  isAuthDegraded,
  existingHoldingCount,
  freshHoldingCount,
  filteredSymbolCount,
  consecutiveEmptySyncs,
}: SyncTrustInputs): SyncTrustDecision => {
  const preserveExistingHoldings = isRealMode
    && existingHoldingCount > 0
    && freshHoldingCount === 0
    && filteredSymbolCount === 0
    && consecutiveEmptySyncs < MAX_TRANSIENT_EMPTY_SYNC_PRESERVES;

  if (preserveExistingHoldings) {
    const nextConsecutiveEmptySyncs = consecutiveEmptySyncs + 1;
    return {
      isTrusted: false,
      preserveExistingHoldings: true,
      nextConsecutiveEmptySyncs,
      warningMessage: `SYNC WARNING: Binance returned an empty position snapshot while ${existingHoldingCount} live holding${existingHoldingCount === 1 ? '' : 's'} were already tracked. Preserving current positions until the exchange confirms the flat state (${nextConsecutiveEmptySyncs}/${MAX_TRANSIENT_EMPTY_SYNC_PRESERVES}).`,
    };
  }

  return {
    isTrusted: !isAuthDegraded,
    preserveExistingHoldings: false,
    nextConsecutiveEmptySyncs: freshHoldingCount === 0 ? consecutiveEmptySyncs : 0,
  };
};

export interface LiquidationRetryDecision {
  shouldRetry: boolean;
  warningMessage?: string;
}

export const decideLiquidationRetry = ({
  remainingPositionCount,
  syncTrusted,
  forcedReason,
}: {
  remainingPositionCount: number;
  syncTrusted: boolean;
  forcedReason?: string;
}): LiquidationRetryDecision => {
  if (remainingPositionCount === 0) {
    return { shouldRetry: false };
  }

  if (!syncTrusted) {
    return {
      shouldRetry: false,
      warningMessage: forcedReason
        ? `FORCED LIQUIDATION RETRY CANCELLED: Exchange sync is degraded after ${forcedReason}. No retry orders were sent.`
        : 'LIQUIDATION RETRY CANCELLED: Exchange sync is not trustworthy after the first close pass, so no retry orders were sent. Refresh exchange sync before sending more closes.',
    };
  }

  return { shouldRetry: true };
};