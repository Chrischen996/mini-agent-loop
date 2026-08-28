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
 * Welcome header (~1 when the feed is empty) + input (~2) + status bar (~4) + optional image strip / pickers
 * / permission panel / plan approval bar.
 */
export function getMessageFeedHeight(options: {
  termRows: number | undefined;
  /** Whether the one-row welcome header is mounted. */
  hasHeader?: boolean;
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
    (options.hasHeader === false ? 0 : 1) + // Claude Code title row
    2 + // input row
    4 + // status bar border box (fixed two content rows)
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
  requestedItems: number;
  hasPendingImages?: boolean;
  todoRows?: number;
  extraRows?: number;
  permissionRows?: number;
  planApprovalRows?: number;
}): { itemRows: number; totalRows: number } {
  const viewport = getTuiViewportHeight(options.termRows);
  const fixedChrome =
    (options.hasHeader === false ? 0 : 1) + 2 + 4 + (options.hasPendingImages ? 1 : 0) + (options.todoRows ?? 0) +
    (options.permissionRows ?? 0) + (options.planApprovalRows ?? 0);
  const extraRows = options.extraRows ?? 2;
  const maxTotal = Math.max(0, viewport - fixedChrome - 3);
  const itemRows = Math.max(0, Math.min(options.requestedItems, maxTotal - extraRows));
  return { itemRows, totalRows: itemRows > 0 ? itemRows + extraRows : 0 };
}
