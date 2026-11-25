import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as publicFetch } from 'undici';
import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type NodeRequestPolicy,
  type HlsDownloaderBrowserRequestOptions,
} from '@hls-downloader/shared';
import { credentialHeaders, originSet } from '../credential-origins';

const denied = () =>
  new HlsDownloaderError(
    Code.REQUEST_POLICY_DENIED,
    'Network destination is outside the request policy',
  );

// Conservatively exclude special-purpose assignments, including transition ranges.
const reserved = new BlockList();
for (const cidr of [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  '3fff::/20',
]) {
  const [address, bits] = cidr.split('/') as [string, string];
  reserved.addSubnet(address, Number(bits), isIP(address) === 4 ? 'ipv4' : 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !reserved.check(address, 'ipv4');
  return isIP(address) === 6 && globalV6.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
}

// Validate the addresses returned directly to net.connect, keeping the URL hostname for TLS.
export const lookupPublicAddress: LookupFunction = (host, options, callback) => {
  lookup(host, { all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
      return callback(denied(), '', 0);
    const candidates = addresses.filter((a) => !options.family || a.family === options.family);
    if (!candidates.length) return callback(denied(), '', 0);
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0]!.address, candidates[0]!.family);
  });
};
const publicAgent = new Agent({ connect: { lookup: lookupPublicAddress } });

export function nodeTransport(
  entry: string,
  origins: readonly string[] = [],
  policy?: NodeRequestPolicy,
): HlsDownloaderBrowserRequestOptions {
  const entryOrigin = new URL(entry).origin;
  const trusted = originSet(origins);
  const allowed = policy?.allowedOrigins && originSet(policy.allowedOrigins);
  return {
    fetch: async (resource: string, init: RequestInit): Promise<Response> => {
      let url = new URL(resource);
      for (let hop = 0; hop <= 20; hop++) {
        if (!['http:', 'https:'].includes(url.protocol) || (allowed && !allowed.has(url.origin)))
          throw denied();
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (policy?.publicOnly && isIP(host) && !isPublicAddress(host)) throw denied();
        const headers = credentialHeaders(init.headers, url.origin, entryOrigin, trusted);
        let response: Response;
        try {
          if (policy?.publicOnly) {
            const checked = await publicFetch(url.href, {
              headers: Array.from(headers.entries()),
              signal: init.signal ?? undefined,
              redirect: 'manual',
              dispatcher: publicAgent,
            });
            // Undici's streaming Response implements the Fetch methods consumed by the reader.
            response = checked as unknown as Response;
          } else {
            response = await fetch(url.href, { ...init, headers, redirect: 'manual' });
          }
        } catch (error) {
          if (error instanceof Error && error.cause instanceof HlsDownloaderError)
            throw error.cause;
          throw error;
        }
        const location = response.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(response.status) || location === null)
          return response;
        await response.body?.cancel();
        url = new URL(location, url);
      }
      throw denied();
    },
  };
}
