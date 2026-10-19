/**
 * The document shapes this project hands to pdfmake. pdfmake 0.3 is a browser bundle with no types, so the
 * pieces actually used are declared here: a document is a fixed A4 page with a header and footer function,
 * and a block is any node of its content tree.
 */
export type PdfBlock = Record<string, unknown> | string;

export interface PdfStyles {
  readonly [name: string]: Record<string, unknown>;
}

export interface PdfDocumentInfo {
  readonly title: string;
  readonly author: string;
  /** Set for screen readers and PDF viewers: every report this product writes is English. */
  readonly language: string;
}

export interface PdfDocument {
  readonly pageSize: 'A4';
  readonly pageOrientation?: 'portrait' | 'landscape';
  readonly pageMargins: readonly number[];
  readonly info: PdfDocumentInfo;
  readonly header?: (page: number) => PdfBlock;
  readonly footer: (page: number, pages: number) => PdfBlock;
  readonly content: readonly PdfBlock[];
  readonly styles?: PdfStyles;
  readonly defaultStyle?: Record<string, unknown>;
}

/** Usable text width of an A4 page with the margins every report uses (595.28 - 42 - 42). */
export const CONTENT_WIDTH = 511;

export const PAGE_MARGINS = [42, 56, 42, 52] as const;

/** A hairline above a block of running text: pdfmake has no border on a stack, so a line is drawn. */
export function rule(color = '#c9ccd1'): PdfBlock {
  return {
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, color }],
  };
}
