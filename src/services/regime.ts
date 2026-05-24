export type RegimeState = 'BULL' | 'BEAR' | 'NEUTRAL';

type ScanCounts = {
  buy: number;
  sell: number;
  hold?: number;
  updatedAt?: number;
};

type ScanArchiveLike = {
  buy: number;
  sell: number;
  hold: number;
  completedAt: number;
};

export type MarkovRegimeSummary = {
  state: RegimeState;
  currentObservation: RegimeState;
  previousState: RegimeState;
  bullProbability: number;
  bearProbability: number;
  neutralProbability: number;
  confidence: number;
};

const REGIME_STATES: RegimeState[] = ['BULL', 'BEAR', 'NEUTRAL'];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeProbabilities = (values: Record<RegimeState, number>) => {
  const total = REGIME_STATES.reduce((sum, state) => sum + Math.max(0.0001, values[state]), 0);
  return {
    BULL: values.BULL / total,
    BEAR: values.BEAR / total,
    NEUTRAL: values.NEUTRAL / total,
  };
};

export const classifyRegimeObservation = ({ buy, sell }: ScanCounts): RegimeState => {
  const activeSignals = Math.max(0, buy) + Math.max(0, sell);
  if (activeSignals < 5) return 'NEUTRAL';

  const bullShare = buy / activeSignals;
  const bearShare = sell / activeSignals;
  if (buy >= Math.max(4, Math.ceil(sell * 1.15)) && bullShare >= 0.62) return 'BULL';
  if (sell >= Math.max(4, Math.ceil(buy * 1.15)) && bearShare >= 0.62) return 'BEAR';
  return 'NEUTRAL';
};

export const computeMarkovRegime = (archive: ScanArchiveLike[], currentSummary: ScanCounts): MarkovRegimeSummary => {
  const orderedObservations = [...archive]
    .slice(0, 18)
    .reverse()
    .map((entry) => classifyRegimeObservation(entry));

  const previousState = orderedObservations[orderedObservations.length - 1] || 'NEUTRAL';
  const currentObservation = currentSummary.updatedAt ? classifyRegimeObservation(currentSummary) : previousState;

  const transitions: Record<RegimeState, Record<RegimeState, number>> = {
    BULL: { BULL: 1, BEAR: 1, NEUTRAL: 1 },
    BEAR: { BULL: 1, BEAR: 1, NEUTRAL: 1 },
    NEUTRAL: { BULL: 1, BEAR: 1, NEUTRAL: 1 },
  };

  for (let index = 1; index < orderedObservations.length; index += 1) {
    const from = orderedObservations[index - 1];
    const to = orderedObservations[index];
    transitions[from][to] += 1;
  }

  const prior = normalizeProbabilities(transitions[previousState]);
  const emissionWeights: Record<RegimeState, number> = currentObservation === 'NEUTRAL'
    ? { BULL: 0.94, BEAR: 0.94, NEUTRAL: 1.22 }
    : {
        BULL: currentObservation === 'BULL' ? 1.35 : 0.72,
        BEAR: currentObservation === 'BEAR' ? 1.35 : 0.72,
        NEUTRAL: 1.02,
      };

  const posterior = normalizeProbabilities({
    BULL: prior.BULL * emissionWeights.BULL,
    BEAR: prior.BEAR * emissionWeights.BEAR,
    NEUTRAL: prior.NEUTRAL * emissionWeights.NEUTRAL,
  });

  const state = REGIME_STATES.reduce((best, candidate) => posterior[candidate] > posterior[best] ? candidate : best, 'NEUTRAL' as RegimeState);
  const confidence = clamp((posterior[state] - 0.34) / 0.36, 0, 1);

  return {
    state,
    currentObservation,
    previousState,
    bullProbability: Number(posterior.BULL.toFixed(3)),
    bearProbability: Number(posterior.BEAR.toFixed(3)),
    neutralProbability: Number(posterior.NEUTRAL.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
  };
};

export const getRegimeWeightAdjustments = (summary: MarkovRegimeSummary) => {
  const confidence = summary.confidence;
  if (summary.state === 'BULL' || summary.state === 'BEAR') {
    return {
      macdDelta: 0.04 + (0.04 * confidence),
      trendDelta: 0.06 + (0.06 * confidence),
      volumeDelta: 0.02 + (0.03 * confidence),
      emaDelta: 0.03 + (0.05 * confidence),
      rsiDelta: -(0.03 + (0.04 * confidence)),
    };
  }

  return {
    macdDelta: -(0.02 + (0.03 * confidence)),
    trendDelta: -(0.04 + (0.04 * confidence)),
    volumeDelta: 0.03 + (0.03 * confidence),
    emaDelta: -(0.02 + (0.03 * confidence)),
    rsiDelta: 0.05 + (0.05 * confidence),
  };
};

export const getRegimeTradeAdjustments = (summary: MarkovRegimeSummary, side: 'BUY' | 'SELL') => {
  if (summary.state === 'NEUTRAL') {
    return {
      minScoreDelta: Number((0.1 + (0.1 * summary.confidence)).toFixed(2)),
      minEdgeDelta: Number((0.02 + (0.03 * summary.confidence)).toFixed(2)),
      label: 'Markov neutral regime: selective both ways',
    };
  }

  const aligned = (summary.state === 'BULL' && side === 'BUY') || (summary.state === 'BEAR' && side === 'SELL');
  const alignedBearShort = summary.state === 'BEAR' && side === 'SELL';
  return aligned
    ? {
        minScoreDelta: Number((-(alignedBearShort ? (0.3 + (0.2 * summary.confidence)) : (0.15 + (0.15 * summary.confidence)))).toFixed(2)),
        minEdgeDelta: Number((-(alignedBearShort ? (0.05 + (0.03 * summary.confidence)) : (0.03 + (0.02 * summary.confidence)))).toFixed(2)),
        label: `Markov ${summary.state.toLowerCase()} regime: aligned ${side === 'BUY' ? 'long' : 'short'}`,
      }
    : {
        minScoreDelta: Number((0.25 + (0.25 * summary.confidence)).toFixed(2)),
        minEdgeDelta: Number((0.05 + (0.04 * summary.confidence)).toFixed(2)),
        label: `Markov ${summary.state.toLowerCase()} regime: countertrend ${side === 'BUY' ? 'long' : 'short'}`,
      };
};
