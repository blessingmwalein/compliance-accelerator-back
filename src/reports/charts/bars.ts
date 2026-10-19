export interface BarDatum {
  /** Carried for the caller: the label is set beside the bar in the document, never drawn inside the SVG. */
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

export interface BarChartOptions {
  /** Width of the drawing area in points. */
  readonly width?: number;
  readonly rowHeight?: number;
  readonly barHeight?: number;
}

const DEFAULTS = { width: 300, rowHeight: 16, barHeight: 9 } as const;

/**
 * A horizontal bar chart as plain SVG (ADR-0008): drawn from the same roll-up the screen shows, so the PDF and
 * the dashboard cannot disagree. Only shapes are emitted — pdfmake resolves `<text>` against its own font list
 * rather than the document's, so every word of a chart is set by the document beside it.
 */
export function horizontalBars(data: readonly BarDatum[], options: BarChartOptions = {}): string {
  const width = options.width ?? DEFAULTS.width;
  const rowHeight = options.rowHeight ?? DEFAULTS.rowHeight;
  const barHeight = options.barHeight ?? DEFAULTS.barHeight;
  if (data.length === 0) return '';
  const height = data.length * rowHeight;
  const largest = Math.max(1, ...data.map((datum) => datum.value));
  const offset = (rowHeight - barHeight) / 2;
  const rows = data.map((datum, index) => {
    const y = index * rowHeight + offset;
    const length = Math.round((Math.max(0, datum.value) / largest) * width);
    const track = `<rect x="0" y="${y}" width="${width}" height="${barHeight}" fill="#eceef1"/>`;
    const bar = `<rect x="0" y="${y}" width="${length}" height="${barHeight}" fill="${datum.color}"/>`;
    return `${track}${bar}`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img">${rows.join('')}</svg>`
  );
}
