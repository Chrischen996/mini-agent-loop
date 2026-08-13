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
 * Header (~3) + input (~2) + status bar (~3) + optional image strip / pickers.
 */
export function getMessageFeedHeight(options: {
  termRows: number | undefined;
  hasPendingImages?: boolean;
  pickerRows?: number;
}): number {
  const viewport = getTuiViewportHeight(options.termRows);
  const chrome =
    3 + // header border box
    2 + // input row
    3 + // status bar border box
    (options.hasPendingImages ? 1 : 0) +
    (options.pickerRows ?? 0);
  return Math.max(3, viewport - chrome);
}

export function getPickerLayout(options: {
  termRows: number | undefined;
  requestedItems: number;
  hasPendingImages?: boolean;
  extraRows?: number;
}): { itemRows: number; totalRows: number } {
  const viewport = getTuiViewportHeight(options.termRows);
  const fixedChrome = 3 + 2 + 3 + (options.hasPendingImages ? 1 : 0);
  const extraRows = options.extraRows ?? 2;
  const maxTotal = Math.max(0, viewport - fixedChrome - 3);
  const itemRows = Math.max(0, Math.min(options.requestedItems, maxTotal - extraRows));
  return { itemRows, totalRows: itemRows > 0 ? itemRows + extraRows : 0 };
}
