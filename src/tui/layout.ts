import { TUI_BRAND_HEADER_HEIGHT } from "./brand.ts";

/**
 * Keep Ink's dynamic output below the terminal height. Ink clears the whole
 * terminal when the rendered output reaches the last row, which is visible as
 * a flash during streamed reasoning updates.
 */
export function getTuiViewportHeight(termRows: number | undefined): number {
  return Math.max(1, (termRows ?? 24) - 1);
}

/**
 * Estimate rows available for the scrollable message feed after chrome.
 * Welcome header (compact or expanded) + input (~2) + status row (~1) + optional image strip / pickers
 * / permission panel / plan approval bar.
 */
export function getMessageFeedHeight(options: {
  termRows: number | undefined;
  /** Whether the welcome identity is mounted. */
  hasHeader?: boolean;
  headerRows?: number;
  hasPendingImages?: boolean;
  todoRows?: number;
  pickerRows?: number;
  /** Rows reserved for the pending tool-permission confirmation card. */
  permissionRows?: number;
  /** Rows reserved for the plan approval bar during plan review. */
  planApprovalRows?: number;
}): number {
  const viewport = getTuiViewportHeight(options.termRows);
  const chrome =
    (options.hasHeader === false ? 0 : options.headerRows ?? TUI_BRAND_HEADER_HEIGHT) + // welcome identity
    2 + // input row
    1 + // stable model/context metadata row; activity stays in the feed
    (options.hasPendingImages ? 1 : 0) +
    (options.todoRows ?? 0) +
    (options.pickerRows ?? 0) +
    (options.permissionRows ?? 0) +
    (options.planApprovalRows ?? 0);
  return Math.max(3, viewport - chrome);
}

export function getPickerLayout(options: {
  termRows: number | undefined;
  hasHeader?: boolean;
  headerRows?: number;
  requestedItems: number;
  hasPendingImages?: boolean;
  todoRows?: number;
  extraRows?: number;
  permissionRows?: number;
  planApprovalRows?: number;
}): { itemRows: number; totalRows: number } {
  const viewport = getTuiViewportHeight(options.termRows);
  const fixedChrome =
    (options.hasHeader === false ? 0 : options.headerRows ?? TUI_BRAND_HEADER_HEIGHT) + 2 + 1 + (options.hasPendingImages ? 1 : 0) + (options.todoRows ?? 0) +
    (options.permissionRows ?? 0) + (options.planApprovalRows ?? 0);
  const extraRows = options.extraRows ?? 2;
  const maxTotal = Math.max(0, viewport - fixedChrome - 3);
  const itemRows = Math.max(0, Math.min(options.requestedItems, maxTotal - extraRows));
  return { itemRows, totalRows: itemRows > 0 ? itemRows + extraRows : 0 };
}
