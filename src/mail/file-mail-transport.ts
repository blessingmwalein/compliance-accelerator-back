import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EmailMessage, EmailProvider, SendResult } from './email-provider.js';

/** RFC 2047 encoded-word, so a non-ASCII subject survives. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Lines(value: string): string {
  return (
    Buffer.from(value, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');
}

/** Builds an RFC 5322 message (multipart/alternative, base64 parts). */
export function buildEml(message: EmailMessage, messageId: string, date: Date): string {
  const boundary = `fca-${randomUUID()}`;
  return [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}@fca.local>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * Development and test transport (there is no Docker or Mailpit): writes each message to a `.eml`
 * file you can open in a mail client, and logs the first link of the text body so the flow can be
 * followed from the terminal. NOTHING IS DELIVERED. The link (which contains a one-time token) is
 * only logged outside production.
 */
export class FileMailTransport implements EmailProvider {
  private readonly logger = new Logger('FileMailTransport');
  private readonly directory: string;

  constructor(
    directory: string,
    private readonly logLinks: boolean,
  ) {
    this.directory = resolve(directory);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const id = randomUUID();
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}.eml`;
    await mkdir(this.directory, { recursive: true });
    await writeFile(resolve(this.directory, fileName), buildEml(message, id, new Date()), 'utf8');

    const link = this.logLinks ? /https?:\/\/\S+/.exec(message.text)?.[0] : undefined;
    this.logger.log(`dev mail written: ${fileName}${link ? ` link=${link}` : ''}`);
    return { providerMessageId: fileName };
  }
}
