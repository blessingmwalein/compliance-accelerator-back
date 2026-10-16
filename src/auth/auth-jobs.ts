/** Job types of the authentication emails. Payloads carry the user id only. */
export const AUTH_JOB_TYPES = {
  sendVerification: 'auth.send-verification',
  sendPasswordReset: 'auth.send-password-reset',
  sendAccountExists: 'auth.send-account-exists',
  sendPasswordChanged: 'auth.send-password-changed',
} as const;

/** Lifetimes of the one-time links (ADR-0003). */
export const VERIFICATION_TOKEN_TTL_HOURS = 24;
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;

/** A repeated request inside this window enqueues nothing new: it throttles email spam deterministically. */
export const VERIFICATION_DEDUPE_SECONDS = 5 * 60;
export const PASSWORD_RESET_DEDUPE_SECONDS = 10 * 60;
export const ACCOUNT_EXISTS_DEDUPE_SECONDS = 60 * 60;

export interface UserJobPayload {
  userId: string;
}

/** Path of each SPA page the emails link to. The token travels in the URL FRAGMENT, which browsers never send to servers. */
export const SPA_PATHS = {
  verifyEmail: '/verify-email',
  resetPassword: '/reset-password',
  login: '/login',
  forgotPassword: '/forgot-password',
} as const;
