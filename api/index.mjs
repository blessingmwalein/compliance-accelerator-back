/**
 * The Vercel entry point: one serverless function for the whole API.
 *
 * It re-exports the built Nest handler and nothing else, so `vercel build` traces `dist/` and the
 * dependencies it needs, and every request is answered by the same application `npm run start` serves.
 * `npm run build` has to have run first (Vercel does that in the build command); `dist/` is not committed.
 */
export { default } from '../dist/main-serverless.js';
