import dns from 'node:dns';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureNetwork } from './network.js';

describe('configureNetwork', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets the DNS result order and the per-address attempt timeout for the whole process', () => {
    const order = vi.spyOn(dns, 'setDefaultResultOrder').mockImplementation(() => undefined);
    const timeout = vi
      .spyOn(net, 'setDefaultAutoSelectFamilyAttemptTimeout')
      .mockImplementation(() => undefined);

    configureNetwork('ipv4first', 2000);

    expect(order).toHaveBeenCalledWith('ipv4first');
    expect(timeout).toHaveBeenCalledWith(2000);
  });

  it('passes the other orders through unchanged', () => {
    const order = vi.spyOn(dns, 'setDefaultResultOrder').mockImplementation(() => undefined);
    vi.spyOn(net, 'setDefaultAutoSelectFamilyAttemptTimeout').mockImplementation(() => undefined);

    configureNetwork('verbatim', 500);
    configureNetwork('ipv6first', 500);

    expect(order.mock.calls.map(([value]) => value)).toEqual(['verbatim', 'ipv6first']);
  });
});
