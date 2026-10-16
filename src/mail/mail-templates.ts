export type MailRequest =
  | { template: 'verify-email'; to: string; link: string; expiresInHours: number }
  | { template: 'password-reset'; to: string; link: string; expiresInMinutes: number }
  | { template: 'account-exists'; to: string; loginUrl: string; forgotPasswordUrl: string }
  | { template: 'password-changed'; to: string; loginUrl: string; forgotPasswordUrl: string }
  | {
      template: 'invitation';
      to: string;
      link: string;
      organisationName: string;
      roleLabel: string;
      expiresInDays: number;
    };

export type MailTemplateName = MailRequest['template'];

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

interface Link {
  label: string;
  url: string;
}

const PRODUCT = 'Fernando Compliance Accelerator';
const DISCLAIMER = `${PRODUCT} supports a compliance programme; it does not provide legal advice or guarantee compliance with any law.`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The only links allowed in a message are http(s): never `javascript:` or anything a template variable could smuggle in. */
function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unsupported link protocol');
  }
  return parsed.toString();
}

function html(heading: string, paragraphs: string[], primary: Link, secondary?: Link): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
  const button = `<p style="margin:24px 0"><a href="${escapeHtml(primary.url)}" style="background:#4f46e5;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(primary.label)}</a></p><p style="margin:0 0 16px;font-size:13px;color:#475569">If the button does not work, copy this address into your browser:<br>${escapeHtml(primary.url)}</p>`;
  const other = secondary
    ? `<p style="margin:0 0 16px">${escapeHtml(secondary.label)}: <a href="${escapeHtml(secondary.url)}">${escapeHtml(secondary.url)}</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5"><div style="max-width:560px;margin:0 auto;padding:24px"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}${button}${other}<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"><p style="font-size:12px;color:#475569;margin:0">${escapeHtml(DISCLAIMER)}</p></div></body></html>`;
}

function text(paragraphs: string[], primary: Link, secondary?: Link): string {
  return [
    ...paragraphs,
    `${primary.label}: ${primary.url}`,
    ...(secondary ? [`${secondary.label}: ${secondary.url}`] : []),
    '--',
    DISCLAIMER,
  ].join('\n\n');
}

function build(
  subject: string,
  heading: string,
  paragraphs: string[],
  primary: Link,
  secondary?: Link,
): RenderedMail {
  return {
    subject,
    text: text(paragraphs, primary, secondary),
    html: html(heading, paragraphs, primary, secondary),
  };
}

/** Free text in a subject line: control characters (header injection) are removed and the length is capped. */
function subjectText(value: string): string {
  const printable = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
  return printable.replace(/ {2,}/g, ' ').trim().slice(0, 120);
}

/**
 * Renders a message. Bodies are LINK-ONLY: they say something needs attention and link into the app.
 * They never contain personal data beyond the recipient's own address, and no organisation data,
 * with one deliberate exception: an invitation names the organisation and the role, because the
 * recipient must be able to tell who is inviting them before following a link.
 */
export function renderMail(request: MailRequest): RenderedMail {
  switch (request.template) {
    case 'verify-email':
      return build(
        `Confirm your email address for ${PRODUCT}`,
        'Confirm your email address',
        [
          `Someone (hopefully you) registered this email address for ${PRODUCT}.`,
          `Confirm the address to finish setting up the account. The link works once and expires in ${request.expiresInHours} hours. If you did not register, you can ignore this message: nothing happens until the address is confirmed.`,
        ],
        { label: 'Confirm email address', url: safeUrl(request.link) },
      );
    case 'password-reset':
      return build(
        `Reset your ${PRODUCT} password`,
        'Reset your password',
        [
          `A password reset was requested for this ${PRODUCT} account.`,
          `Choose a new password with the link below. It works once and expires in ${request.expiresInMinutes} minutes. If you did not ask for this, ignore the message: your password has not changed.`,
        ],
        { label: 'Choose a new password', url: safeUrl(request.link) },
      );
    case 'account-exists':
      return build(
        `${PRODUCT}: this email address already has an account`,
        'You already have an account',
        [
          `Someone tried to register this email address for ${PRODUCT}, but an account already exists.`,
          'If it was you, sign in instead, or reset the password if you have forgotten it. If it was not you, no action is needed.',
        ],
        { label: 'Sign in', url: safeUrl(request.loginUrl) },
        { label: 'Forgot your password?', url: safeUrl(request.forgotPasswordUrl) },
      );
    case 'password-changed':
      return build(
        `Your ${PRODUCT} password was changed`,
        'Your password was changed',
        [
          `The password of your ${PRODUCT} account was just changed and every signed-in session was ended.`,
          'If you did this, no action is needed. If you did not, reset your password now.',
        ],
        { label: 'Reset your password', url: safeUrl(request.forgotPasswordUrl) },
        { label: 'Sign in', url: safeUrl(request.loginUrl) },
      );
    case 'invitation': {
      const organisation = subjectText(request.organisationName);
      return build(
        `You have been invited to join ${organisation} on ${PRODUCT}`,
        'You have been invited',
        [
          `${organisation} has invited this email address to join its ${PRODUCT} workspace as ${request.roleLabel}.`,
          `Sign in (or create an account with this same email address) and accept the invitation. The link works once and expires in ${request.expiresInDays} days. If you were not expecting this, ignore the message: nothing changes until the invitation is accepted.`,
        ],
        { label: 'View the invitation', url: safeUrl(request.link) },
      );
    }
  }
}
