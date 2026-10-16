/** Job type of the invitation email. The payload carries ids only: `{ organisationId, invitationId }`. */
export const INVITATION_JOB_TYPES = {
  send: 'invitations.send',
} as const;

/** How long an invitation link works (ADR-0003/0005); renewed every time the email is sent. */
export const INVITATION_TTL_DAYS = 7;
export const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * A repeated request inside this window enqueues nothing new, so "resend" cannot be used to spam an
 * address. Creating an invitation and resending it a moment later is therefore one email.
 */
export const INVITATION_SEND_WINDOW_MS = 5 * 60 * 1000;

export interface InvitationJobPayload {
  organisationId: string;
  invitationId: string;
}

/** The SPA page the invitation email links to. The token travels in the URL FRAGMENT. */
export const INVITATION_SPA_PATH = '/accept-invitation';
