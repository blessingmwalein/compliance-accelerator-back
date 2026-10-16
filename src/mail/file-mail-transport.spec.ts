import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildEml, FileMailTransport } from './file-mail-transport.js';

beforeAll(() => {
  Logger.overrideLogger(false);
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fca-mail-spec-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const message = {
  to: 'maria@example.com',
  from: 'Fernando Compliance Accelerator <no-reply@fca.localhost>',
  subject: 'Confirm your email address',
  text: 'Open https://app.example.com/verify-email#token=abc',
  html: '<p>Open <a href="https://app.example.com/verify-email#token=abc">link</a></p>',
};

describe('FileMailTransport', () => {
  it('writes one .eml file per message and returns its name as the provider id', async () => {
    const transport = new FileMailTransport(directory, true);
    const result = await transport.send(message);
    const files = await readdir(directory);
    expect(files).toEqual([result.providerMessageId]);
    expect(files[0]).toMatch(/\.eml$/);
  });

  it('creates the directory when it does not exist yet', async () => {
    const nested = join(directory, 'not', 'yet');
    await new FileMailTransport(nested, false).send(message);
    expect(await readdir(nested)).toHaveLength(1);
  });

  it('writes a multipart message a mail client can open', async () => {
    const result = await new FileMailTransport(directory, false).send(message);
    const eml = await readFile(join(directory, result.providerMessageId), 'utf8');
    expect(eml).toContain('To: maria@example.com');
    expect(eml).toContain('Content-Type: multipart/alternative');
    expect(eml).toContain('Content-Type: text/plain; charset=utf-8');
    expect(eml).toContain('Content-Type: text/html; charset=utf-8');
    const base64Text = eml
      .split('Content-Transfer-Encoding: base64')[1]!
      .split('--fca-')[0]!
      .replace(/\s+/g, '');
    expect(Buffer.from(base64Text, 'base64').toString('utf8')).toBe(message.text);
  });

  it('encodes a non-ASCII subject (RFC 2047)', () => {
    const eml = buildEml(
      { ...message, subject: 'Confirmação' },
      'id-1',
      new Date('2026-10-15T00:00:00Z'),
    );
    expect(eml).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });
});
