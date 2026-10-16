export interface EmailMessage {
  /** Recipient ADDRESS: invitees and the DPO contact need not be registered users. */
  to: string;
  /** Display name and address, e.g. `Fernando Compliance Accelerator <no-reply@example.com>`. */
  from: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  /** The provider's id for the message (for webhooks and support); the file transport returns the file name. */
  providerMessageId: string;
}

/** Sends one message. Throw to signal failure: the job is retried with backoff. */
export interface EmailProvider {
  send(message: EmailMessage): Promise<SendResult>;
}

/** Injection token for the active provider (selected by MAIL_TRANSPORT). */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
