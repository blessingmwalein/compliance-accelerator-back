// Extracts the structure of the GDPR (chapters and the title of each article) from the English text of
// the Official Journal as published by the EU Publications Office (XHTML). Only identifiers and headings
// are taken, word for word; the operative text of the Regulation is NOT stored. Nothing is typed from memory.
import { plainText } from './lib.mjs';

/** @param {Buffer} buffer the XHTML file */
export function extractGdpr(buffer) {
  const html = buffer.toString('utf8');
  // the file must really be the Regulation (a challenge page or another act would otherwise be parsed to nothing)
  for (const expected of [
    'REGULATION (EU) 2016/679',
    '27 April 2016',
    'General Data Protection Regulation',
  ]) {
    if (!html.includes(expected))
      throw new Error(`The source does not look like the GDPR: "${expected}" not found.`);
  }

  // in document order: chapter numbers, the heading that follows them, and articles with their titles
  const token =
    /<p[^>]*class="oj-ti-section-1"[^>]*>([\s\S]*?)<\/p>|<p[^>]*class="oj-ti-section-2"[^>]*>([\s\S]*?)<\/p>|<p[^>]*class="oj-ti-art"[^>]*>([\s\S]*?)<\/p>|<p[^>]*class="oj-sti-art"[^>]*>([\s\S]*?)<\/p>/g;
  const requirements = [];
  let chapter = null;
  let pendingHeading = null; // 'chapter' | 'section' | null: what the next section-2 heading belongs to
  let article = null;
  for (const match of html.matchAll(token)) {
    if (match[1] !== undefined) {
      const text = plainText(match[1]);
      const chapterNumber = /^CHAPTER ([IVXL]+)$/.exec(text);
      if (chapterNumber) {
        chapter = {
          ref: `Chapter ${chapterNumber[1]}`,
          kind: 'chapter',
          title: '',
          description: null,
          parent: null,
          textSource: 'VERBATIM',
        };
        pendingHeading = 'chapter';
      } else if (/^Section \d+$/.test(text)) {
        pendingHeading = 'section'; // sections are not modelled: articles sit directly under their chapter
      }
    } else if (match[2] !== undefined) {
      if (pendingHeading === 'chapter' && chapter) {
        chapter.title = plainText(match[2]);
        requirements.push({ ...chapter, sortOrder: requirements.length });
      }
      pendingHeading = null;
    } else if (match[3] !== undefined) {
      const number = /^Article (\d+)$/.exec(plainText(match[3]));
      article = number ? { number: Number(number[1]) } : null;
    } else if (match[4] !== undefined && article && chapter) {
      requirements.push({
        ref: `Art. ${article.number}`,
        kind: 'article',
        title: plainText(match[4]),
        description: null,
        parent: chapter.ref,
        textSource: 'VERBATIM',
        sortOrder: requirements.length,
      });
      article = null;
    }
  }

  const articles = requirements.filter((requirement) => requirement.kind === 'article');
  const chapters = requirements.filter((requirement) => requirement.kind === 'chapter');
  // the date the source itself gives for when the Regulation applies (its final article)
  const applies = /shall apply from (\d{1,2}) (May) (\d{4})/.exec(plainText(html));
  const effectiveFrom = applies ? `${applies[3]}-05-${applies[1].padStart(2, '0')}` : null;
  return {
    requirements,
    effectiveFrom,
    counts: { chapter: chapters.length, article: articles.length },
  };
}
