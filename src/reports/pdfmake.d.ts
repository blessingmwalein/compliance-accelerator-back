/**
 * `pdfmake` 0.3 ships no TypeScript types (its build is a browser bundle). Only the small surface this
 * project uses is declared here; document definitions are typed by `pdf-document.ts`, and the renderer hands
 * the finished definition over as `unknown`, so a wrong key is caught where the definition is built.
 */
declare module 'pdfmake' {
  interface PdfFontFamily {
    normal: string;
    bold: string;
    italics: string;
    bolditalics: string;
  }

  interface PdfVirtualFileSystem {
    writeFileSync(path: string, data: Buffer): void;
  }

  interface PdfMakePrinter {
    readonly virtualfs: PdfVirtualFileSystem;
    /** Blocks every external fetch a document definition could ask for. */
    setUrlAccessPolicy(allowed: () => boolean): void;
    /** Blocks reading the server's own disk from inside a document definition. */
    setLocalAccessPolicy(allowed: () => boolean): void;
    setFonts(fonts: Record<string, PdfFontFamily>): void;
    createPdf(definition: unknown): { getBuffer(): Promise<Buffer> };
  }

  const pdfMake: PdfMakePrinter;

  export = pdfMake;
}

/** The OFL Roboto family pdfmake ships, as base64 strings keyed by file name. */
declare module 'pdfmake/build/vfs_fonts.js' {
  const files: Record<string, string>;

  export = files;
}
