/** Harness-style geometry: protect chat space and overlay the dock on narrow screens. */
export function workbenchColumns(viewport: number, sidebar: number, rightbar: number) {
  const left = sidebar === 0 ? 56 : Math.min(420, Math.max(264, sidebar));
  const available = viewport - left - 400;
  const right = rightbar === 0 || available < 300
    ? 0
    : Math.min(available, Math.max(300, Math.min(rightbar, viewport * 0.7)));
  return { left, right, overlay: rightbar > 0 && right === 0 };
}
