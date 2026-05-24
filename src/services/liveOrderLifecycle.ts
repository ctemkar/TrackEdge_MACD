export const LIVE_ORDER_FOLLOW_UP_SYNC_DELAYS_MS = [1500, 4500] as const;

export interface LiveOrderVerificationResult {
  verified: boolean;
  authDegradedDuringVerify: boolean;
  attempts: number;
}

export const buildAcceptedOrderVisibilityMessage = (orderId?: string | number | null) => {
  const normalizedOrderId = orderId === undefined || orderId === null || orderId === '' ? null : String(orderId);
  return `Order accepted by exchange but live position not yet visible${normalizedOrderId ? ` (order ${normalizedOrderId})` : ''}.`;
};

export const scheduleFollowUpSyncs = (syncFn: () => void, delays = LIVE_ORDER_FOLLOW_UP_SYNC_DELAYS_MS) => {
  delays.forEach((delay) => {
    setTimeout(syncFn, delay);
  });
};

export const verifyLiveOrderOnExchange = async ({
  fetchFreshBalance,
  hasPositionForSymbol,
  tradeSymbol,
  closingExisting,
  openingExposure,
  maxAttempts = 4,
  initialDelayMs = 600,
  stepDelayMs = 400,
}: {
  fetchFreshBalance: () => Promise<any>;
  hasPositionForSymbol: (positions: any, tradeSymbol: string) => boolean;
  tradeSymbol: string;
  closingExisting: boolean;
  openingExposure: boolean;
  maxAttempts?: number;
  initialDelayMs?: number;
  stepDelayMs?: number;
}): Promise<LiveOrderVerificationResult> => {
  let verified = false;
  let authDegradedDuringVerify = false;
  let attempts = 0;

  while (attempts < maxAttempts && !verified) {
    await new Promise((resolve) => setTimeout(resolve, initialDelayMs + (attempts * stepDelayMs)));
    const verify = await fetchFreshBalance();
    if (verify?.authDegraded === true) {
      authDegradedDuringVerify = true;
      verified = true;
      break;
    }

    const positions = verify?.positions || {};
    const hasPosition = hasPositionForSymbol(positions, tradeSymbol);
    if (closingExisting) {
      verified = !hasPosition;
    } else if (openingExposure) {
      verified = hasPosition;
    }

    attempts += 1;
  }

  return {
    verified,
    authDegradedDuringVerify,
    attempts,
  };
};