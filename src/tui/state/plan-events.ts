// `PLAN_ACT_EVENT` projection for the Ink session state.
//
// Split out of `state.ts`: the planning/acting event stream was an 88-line
// nested switch inside `tuiReducer` with its own private helper
// `updateExecutionTodo`. Both move here; the main reducer delegates via
// `reducePlanActEvent`.

import type { PlanActEvent } from "../../plan-act/types.ts";
import { executionPlanToTodoItems } from "../todo-format.ts";
import { nextTodoRevision, type TodoItem } from "../../todo.ts";
import { todoSpinnerMessage, type TuiState } from "../state.ts";

function updateExecutionTodo(
  state: TuiState,
  stepId: string,
  status: TodoItem["status"],
  error?: string,
): TuiState {
  const items = state.todoItems ?? (state.currentPlan ? executionPlanToTodoItems(state.currentPlan) : []);
  if (items.length === 0) return state;
  const next = items.map((item) => item.id === stepId ? { ...item, status, ...(error ? { error } : {}) } : item);
  return {
    ...state,
    todos: next,
    todoItems: next,
    todoRevision: nextTodoRevision(),
    spinnerMessage: todoSpinnerMessage(next),
  };
}

export function reducePlanActEvent(state: TuiState, event: PlanActEvent): TuiState {
  switch (event.type) {
    case "planning_started":
      return { ...state, phase: "planning", status: "Planning…" };
    case "plan_generated":
      return {
        ...state,
        phase: "review",
        currentPlan: event.plan,
        todos: executionPlanToTodoItems(event.plan),
        todoItems: executionPlanToTodoItems(event.plan),
        todoRevision: nextTodoRevision(),
        spinnerMessage: todoSpinnerMessage(executionPlanToTodoItems(event.plan)),
        status: "Plan ready for review (A approve / R reject)",
      };
    case "plan_approved":
      return {
        ...state,
        phase: "acting",
        currentPlan: state.currentPlan?.status === "approved"
          ? state.currentPlan
          : state.currentPlan
            ? { ...state.currentPlan, status: "approved" as const }
            : undefined,
        status: "Executing…",
      };
    case "plan_rejected":
      return {
        ...state,
        phase: "cancelled",
        currentPlan: undefined,
        status: "Plan rejected",
      };
    case "plan_modified":
      return {
        ...state,
        phase: "review",
        currentPlan: event.plan,
        status: "Plan revised, waiting for review (A approve / R reject)",
      };
    case "acting_started":
      return { ...state, phase: "acting", status: "Executing plan…" };
    case "step_started":
      return {
        ...updateExecutionTodo(state, event.stepId, "in_progress"),
        status: `Running: ${event.step.description.slice(0, 30)}…`,
      };
    case "step_completed":
      return {
        ...updateExecutionTodo(state, event.stepId, "completed"),
        status: "Step completed",
      };
    case "step_failed":
      return {
        ...updateExecutionTodo(state, event.stepId, "failed", event.error),
        status: `Step failed: ${event.error.slice(0, 50)}`,
      };
    case "all_steps_completed":
      return {
        ...state,
        phase: "completed",
        currentPlan: state.currentPlan
          ? { ...state.currentPlan, status: "completed" as const }
          : undefined,
        todos: (state.todoItems ?? state.todos).map((item) => ({ ...item, status: "completed" as const })),
        todoItems: (state.todoItems ?? state.todos).map((item) => ({ ...item, status: "completed" as const })),
        todoRevision: nextTodoRevision(),
        spinnerMessage: undefined,
        status: "Plan execution completed",
      };
    case "execution_failed":
      return {
        ...state,
        phase: "failed",
        currentPlan: state.currentPlan
          ? { ...state.currentPlan, status: "failed" as const }
          : undefined,
        todos: (state.todoItems ?? state.todos).map((item) => item.status === "completed" ? item : { ...item, status: "failed" as const }),
        todoItems: (state.todoItems ?? state.todos).map((item) => item.status === "completed" ? item : { ...item, status: "failed" as const }),
        todoRevision: nextTodoRevision(),
        spinnerMessage: undefined,
        status: "Execution failed",
      };
    default:
      return state;
  }
}
