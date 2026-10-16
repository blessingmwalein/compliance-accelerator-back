import dns from 'node:dns';
import net from 'node:net';

export type DnsResultOrder = 'verbatim' | 'ipv4first' | 'ipv6first';

/**
 * Process-wide outgoing-connection settings (applied before the first database connection).
 *
 * Why: a hostname such as a Neon endpoint resolves to several IPv4 AND IPv6 addresses. On a network
 * where some of them are unreachable (no IPv6 route, filtered ranges), Node tries them in resolver
 * order and a connection can stall for ~22 s before it fails: measured on a dev machine, 3 of 20 new
 * connections. IPv4 first removed every failure (0 of 45), and giving each address 2 s instead of
 * Node's 250 ms (shorter than one round trip to a distant region, which made it race extra sockets)
 * cut the median connect from 3.5 s to 2.1 s while keeping failover between addresses.
 */
export function configureNetwork(order: DnsResultOrder, attemptTimeoutMs: number): void {
  dns.setDefaultResultOrder(order);
  net.setDefaultAutoSelectFamilyAttemptTimeout(attemptTimeoutMs);
}
