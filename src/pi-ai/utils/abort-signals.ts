export interface CombinedAbortSignal {
	signal?: AbortSignal;
	cleanup: () => void;
}

export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	const activeSignals = [...new Set(
		signals.filter((signal): signal is AbortSignal => signal !== undefined),
	)];
	if (activeSignals.length === 0) {
		return { cleanup: () => {} };
	}
	if (activeSignals.length === 1) {
		return { signal: activeSignals[0], cleanup: () => {} };
	}

	return {
		signal: AbortSignal.any(activeSignals),
		cleanup: () => {},
	};
}
