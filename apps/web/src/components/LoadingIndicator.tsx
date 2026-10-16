import { useEffect, useState } from "react";
import { activityIndicator, formatLoadingElapsed, loadingShimmer, LOADING_REFRESH_MS, type LoadingActivity } from "../lib/loading.ts";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** One live status row; animation updates never rerender the conversation. */
export function LoadingIndicator({ activity, onStop }: { activity: LoadingActivity; onStop?: () => void }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), reducedMotion ? 1000 : LOADING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [reducedMotion]);
  const elapsed = Math.max(0, now - activity.startedAt);
  const graphemes = loadingShimmer(activity.label, Math.max(0, now - activity.labelStartedAt), reducedMotion);
  return (
    <div className="loading-status">
      <span role="status" aria-live="polite" aria-label={activity.label} className="loading-status__activity">
        <span aria-hidden="true" className="loading-status__marker">{activityIndicator(elapsed, reducedMotion)}</span>
        <span aria-hidden="true" className="loading-status__label">
          {graphemes.map((grapheme, index) => <span key={index} style={{ opacity: grapheme.alpha }}>{grapheme.text}</span>)}
        </span>
      </span>
      <span className="loading-status__details">
        ({formatLoadingElapsed(elapsed)}{onStop ? <> • <button type="button" className="loading-status__stop" onClick={onStop} aria-label="Stop response">Stop</button></> : null})
      </span>
    </div>
  );
}
