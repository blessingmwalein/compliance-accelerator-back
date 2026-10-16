import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface ReadMail {
  file: string;
  to: string;
  subject: string;
  text: string;
  /** The one-time token in the first link's fragment (`#token=...`), if any. */
  token: string | undefined;
  links: string[];
}

/** Empties the dev-mail directory the file transport writes to, so a test only sees its own mail. */
export async function resetMailDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

/** Reads the `.eml` files the file transport wrote, oldest first. */
export async function readMails(directory: string): Promise<ReadMail[]> {
  const files = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith('.eml'))
    .sort();
  const mails: ReadMail[] = [];
  for (const file of files) {
    const raw = await readFile(join(directory, file), 'utf8');
    const header = (name: string) =>
      new RegExp(`^${name}: (.+)$`, 'm').exec(raw)?.[1]?.trim() ?? '';
    const textPart = raw.split('Content-Type: text/plain; charset=utf-8')[1] ?? '';
    const base64 =
      (textPart.split('Content-Transfer-Encoding: base64')[1] ?? '').split('--fca-')[0] ?? '';
    const text = Buffer.from(base64.replace(/\s+/g, ''), 'base64').toString('utf8');
    const links = text.match(/https?:\/\/\S+/g) ?? [];
    mails.push({
      file,
      to: header('To'),
      subject: header('Subject'),
      text,
      links,
      token: /#token=([A-Za-z0-9_-]+)/.exec(links[0] ?? '')?.[1],
    });
  }
  return mails;
}
