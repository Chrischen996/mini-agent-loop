import type { PlanSummary } from "../types/api.ts";

const STATUS_COLORS: Record<string, string> = {
  draft: "var(--muted)",
  pending_review: "var(--warn)",
  approved: "var(--ok)",
  rejected: "var(--error)",
  modified: "var(--accent)",
  executing: "var(--warn)",
  completed: "var(--ok)",
  failed: "var(--error)",
};

function stepStatusColor(status: string): string {
  switch (status) {
    case "completed": return "var(--ok)";
    case "running": return "var(--warn)";
    case "failed": return "var(--error)";
    case "skipped": return "var(--muted)";
    default: return "var(--muted)";
  }
}

export function PlanPanel({ plan }: { plan: PlanSummary | null }) {
  if (!plan) {
    return (
      <aside className="panel panel--plan">
        <div className="panel__head">
          <h2>Plan</h2>
          <span className="muted">No plan yet</span>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Plans appear here when a /plan command generates one.
        </p>
      </aside>
    );
  }

  const color = STATUS_COLORS[plan.status] ?? "var(--muted)";

  return (
    <aside className="panel panel--plan">
      <div className="panel__head">
        <h2>Plan</h2>
        <span
          className="chip"
          style={{ color, borderColor: color }}
        >
          {plan.status}
        </span>
      </div>

      <div className="plan-summary">
        <p className="plan-summary__prompt">{plan.prompt}</p>
        {plan.approvedBy ? (
          <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
            Approved by <code>{plan.approvedBy}</code>
          </p>
        ) : null}
      </div>

      {plan.steps && plan.steps.length > 0 ? (
        <ol className="plan-steps">
          {plan.steps.map((step) => (
            <li
              key={step.index}
              className={`plan-step plan-step--${step.status}`}
            >
              <span className="plan-step__index">{step.index + 1}</span>
              <span className="plan-step__text">{step.text}</span>
              <span
                className="plan-step__status"
                style={{ color: stepStatusColor(step.status) }}
              >
                {step.status}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {plan.changedFiles && plan.changedFiles.length > 0 ? (
        <div className="plan-files">
          <span className="muted" style={{ fontSize: 11 }}>Changed: </span>
          {plan.changedFiles.map((f) => (
            <code key={f} className="plan-files__item">{f}</code>
          ))}
        </div>
      ) : null}

      {plan.missingPlannedFiles && plan.missingPlannedFiles.length > 0 ? (
        <div className="plan-files plan-files--missing">
          <span className="muted" style={{ fontSize: 11 }}>Missing: </span>
          {plan.missingPlannedFiles.map((f) => (
            <code key={f} className="plan-files__item">{f}</code>
          ))}
        </div>
      ) : null}

      {plan.unplannedFiles && plan.unplannedFiles.length > 0 ? (
        <div className="plan-files plan-files--unplanned">
          <span className="muted" style={{ fontSize: 11 }}>Unplanned: </span>
          {plan.unplannedFiles.map((f) => (
            <code key={f} className="plan-files__item">{f}</code>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
