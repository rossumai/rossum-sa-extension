// Pure column-width math for the records Table view (DOM-free, unit-tested).
// The last data column is a computed "filler": it always absorbs the remaining
// pane width so the table fills the pane exactly (no trailing gap) and never
// shrinks below it; when the non-last columns overflow, the filler pins to `min`
// and the table grows past the pane (the wrap scrolls).

export function computeColumnWidths({
  availW,
  selectionW = 0,
  nonLastWidths,
  min = 60,
}: {
  availW: number;
  selectionW?: number;
  nonLastWidths: number[];
  min?: number;
}) {
  const sumNonLast = nonLastWidths.reduce((a: number, b: number) => a + b, 0);
  const lastW = Math.max(min, Math.round(availW - selectionW - sumNonLast));
  return [...nonLastWidths, lastW];
}

export function clampAutoFit(measured: number, min = 60, max = 600): number {
  return Math.max(min, Math.min(max, Math.round(measured)));
}
