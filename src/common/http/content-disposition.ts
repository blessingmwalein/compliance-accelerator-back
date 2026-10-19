/**
 * `attachment` so the browser saves the file instead of rendering it: a download is a document, not a page.
 * The name is made safe for a header first — an ASCII fallback with quotes, backslashes and anything outside
 * printable ASCII replaced (so no CR or LF can reach the header), plus the RFC 6266 `filename*` for names the
 * fallback cannot carry. `Content-Disposition` is an exposed CORS header, so the web app can read it back and
 * name the downloaded file.
 */
export function contentDisposition(filename: string, fallback: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 180);
  const basic = `attachment; filename="${ascii.length > 0 ? ascii : fallback}"`;
  if (ascii === filename) return basic;
  return `${basic}; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`;
}
