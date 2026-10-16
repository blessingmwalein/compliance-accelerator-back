import { describe, expect, it } from 'vitest';
import { isUuid, uuidv7 } from './uuid.js';

describe('uuidv7', () => {
  it('has the version and variant bits of RFC 9562', () => {
    for (let i = 0; i < 50; i++) {
      const id = uuidv7();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(isUuid(id)).toBe(true);
    }
  });

  it('sorts by creation time', () => {
    const earlier = uuidv7(1_800_000_000_000);
    const later = uuidv7(1_800_000_000_001);
    expect(earlier < later).toBe(true);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const id = uuidv7(1_800_000_000_000);
    const hex = id.replaceAll('-', '').slice(0, 12);
    expect(Number.parseInt(hex, 16)).toBe(1_800_000_000_000);
  });

  it('does not repeat', () => {
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
  });

  it('isUuid rejects other strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid('00000000-0000-7000-8000-000000000001')).toBe(true);
  });
});
