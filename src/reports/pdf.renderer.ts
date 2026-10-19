import pdfMake from 'pdfmake';
import vfsFonts from 'pdfmake/build/vfs_fonts.js';
import type { PdfDocument } from './pdf-document.js';

/**
 * pdfmake resolves fonts by name inside one process-wide printer, so the family is installed once. Its shipped
 * virtual file system holds the font files as base64 strings: they must be decoded, because a PDF parser handed
 * base64 text answers "unknown font format".
 */
let fontsInstalled = false;

function installFonts(): void {
  if (fontsInstalled) return;
  // A report is built from data this server already has: nothing in a document definition may fetch a URL
  // or read a file.
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy(() => false);
  for (const [name, base64] of Object.entries(vfsFonts)) {
    pdfMake.virtualfs.writeFileSync(name, Buffer.from(base64, 'base64'));
  }
  // OFL Roboto, the family pdfmake ships: full Latin coverage, so accented names and the punctuation the
  // reports use survive (the built-in PDF fonts dropped both).
  pdfMake.setFonts({
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  });
  fontsInstalled = true;
}

/** The PDF bytes of a document definition. Throws when pdfmake rejects the definition, which the caller fails. */
export async function renderPdf(document: PdfDocument): Promise<Buffer> {
  installFonts();
  return pdfMake.createPdf(document).getBuffer();
}
