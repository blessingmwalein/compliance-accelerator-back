import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMail, type MailRequest } from './mail-templates.js';

const LINK = 'https://app.example.com/verify-email#token=abc123_-XYZ';

const requests: MailRequest[] = [
  { template: 'verify-email', to: 'maria@example.com', link: LINK, expiresInHours: 24 },
  { template: 'password-reset', to: 'maria@example.com', link: LINK, expiresInMinutes: 30 },
  {
    template: 'account-exists',
    to: 'maria@example.com',
    loginUrl: 'https://app.example.com/login',
    forgotPasswordUrl: 'https://app.example.com/forgot-password',
  },
  {
    template: 'password-changed',
    to: 'maria@example.com',
    loginUrl: 'https://app.example.com/login',
    forgotPasswordUrl: 'https://app.example.com/forgot-password',
  },
];

describe('renderMail', () => {
  it.each(requests.map((request) => [request.template, request] as const))(
    '%s renders a subject, plain text and HTML with the disclaimer',
    (_name, request) => {
      const mail = renderMail(request);
      expect(mail.subject.length).toBeGreaterThan(10);
      expect(mail.text).toContain('does not provide legal advice');
      expect(mail.html).toContain('does not provide legal advice');
      expect(mail.html).toMatch(/^<!doctype html>/);
    },
  );

  it('puts the action link in both the text and the HTML body', () => {
    const mail = renderMail(requests[0]!);
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain(`href="${LINK}"`);
  });

  it('every template links to the app and never to anything else', () => {
    for (const request of requests) {
      const { text } = renderMail(request);
      const urls = text.match(/https?:\/\/\S+/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url.startsWith('https://app.example.com/')).toBe(true);
    }
  });

  it('is link-only: states the situation without account, organisation or compliance data', () => {
    for (const request of requests) {
      const { text } = renderMail(request);
      expect(text).not.toMatch(/organisation|DSAR|breach|risk|assessment/i);
    }
  });

  it('refuses links that are not http(s)', () => {
    expect(() =>
      renderMail({
        template: 'verify-email',
        to: 'a@b.co',
        link: 'javascript:alert(1)',
        expiresInHours: 1,
      }),
    ).toThrow();
    expect(() =>
      renderMail({ template: 'verify-email', to: 'a@b.co', link: 'not a url', expiresInHours: 1 }),
    ).toThrow();
  });

  it('escapes HTML in everything it interpolates', () => {
    const mail = renderMail({
      template: 'verify-email',
      to: 'a@b.co',
      link: 'https://app.example.com/x?a=1&b="><script>alert(1)</script>',
      expiresInHours: 1,
    });
    expect(mail.html).not.toContain('<script>');
  });

  it('tells the reader what to do if they did not ask for it', () => {
    expect(renderMail(requests[0]!).text).toMatch(/ignore this message/i);
    expect(renderMail(requests[1]!).text).toMatch(/ignore the message/i);
  });
});

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    );
  });
});
