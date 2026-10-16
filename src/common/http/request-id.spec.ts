import { resolveRequestId } from './request-id.js';

describe('resolveRequestId', () => {
  it('keeps a well-formed inbound id', () => {
    expect(resolveRequestId('abc12345-def')).toBe('abc12345-def');
  });

  it('uses the first value when the header is repeated', () => {
    expect(resolveRequestId(['first-id-123', 'second-id-456'])).toBe('first-id-123');
  });

  it.each([undefined, '', 'short', 'has spaces in it', 'line\nbreak-injection', 'x'.repeat(65)])(
    'replaces a missing or unsafe id (%j) with a UUID',
    (incoming) => {
      expect(resolveRequestId(incoming)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    },
  );
});
