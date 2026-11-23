import { useEffect, useState } from "react";
import type { GoalSnapshot } from "../../goal/index.ts";

/**
 * Wall-clock ticker for the goal status segment, 1 Hz, only while a goal is
 * active AND a turn is running. Returning a stable timestamp otherwise keeps
 * the memoized segment string stable so StatusBar's memo boundary holds.
 */
export function useGoalStatusTicker(goalState: GoalSnapshot | null, busy: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ticking = goalState?.status === "active" && busy;
  useEffect(() => {
    if (!ticking) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return nowMs;
}
