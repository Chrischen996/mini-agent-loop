/**
 * Plan workflow kernel — public API.
 */

export type {
  PlanDocument,
  PlanDocumentStep,
  PlanExecutionBaseline,
  PlanExecutionState,
  PlanFile,
  PlanStatus,
  PlanStepStatus,
} from "./document.ts";
export {
  createPlanDocument,
  documentToLegacyPlanFile,
  legacyPlanFileToDocument,
  planDocumentToSummary,
  statusToLegacyApproval,
} from "./document.ts";

export {
  archivePlanDocument,
  clearPlanDocument,
  currentPlanPath,
  HISTORY_DIR,
  historyPlanPath,
  LEGACY_PLAN_FILENAME,
  legacyPlanPath,
  listPlanHistory,
  loadPlanDocument,
  PLAN_DIR,
  savePlanDocument,
  updatePlanDocument,
} from "./store.ts";

export {
  approveCurrentPlan,
  archiveCurrentPlan,
  createAndSavePlan,
  editCurrentPlan,
  getExecutionPromptSuffix,
  markPlanExecutionResult,
  PLAN_ONLY_SUFFIX,
  preparePlanForExecution,
  rejectCurrentPlan,
  updatePlanStepStatus,
} from "./workflow.ts";

export {
  formatPlanDiff,
  formatPlanDocumentPreview,
} from "./format.ts";

export type { FileAuditResult } from "./audit.ts";
export {
  auditPlanFiles,
  captureBaseline,
  collectChangedFiles,
  formatAuditReport,
  inferStepStatuses,
  normalizePath,
  pathsMatch,
  runExecutionAudit,
} from "./audit.ts";

export { formatPlanPreview, parsePlan } from "../plan-formatter.ts";
export type { PlanStep, PlanSummary } from "../plan-formatter.ts";
