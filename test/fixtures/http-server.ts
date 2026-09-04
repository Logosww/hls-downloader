import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export type FixtureRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  attempt: number;
};

export type FixtureHandler = (
  request: FixtureRequest,
  response: ServerResponse,
) => void | Promise<void>;

export async function startFixtureServer(routes: Record<string, FixtureHandler>) {
  const attempts = new Map<string, number>();
  let activeRequests = 0;
  let peakConcurrency = 0;
  const requests: FixtureRequest[] = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test');
    const attempt = (attempts.get(url.pathname) ?? 0) + 1;
    attempts.set(url.pathname, attempt);
    const recorded: FixtureRequest = {
      method: request.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      attempt,
    };
    requests.push(recorded);
    activeRequests++;
    peakConcurrency = Math.max(peakConcurrency, activeRequests);
    try {
      const handler = routes[url.pathname];
      if (!handler) {
        response.writeHead(404).end('not found');
        return;
      }
      await handler(recorded, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    } finally {
      activeRequests--;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server failed to listen');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    attempts,
    get peakConcurrency() {
      return peakConcurrency;
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

export function sendText(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/vnd.apple.mpegurl' });
  response.end(body);
}

export async function sendBytes(
  response: ServerResponse,
  bytes: Uint8Array,
  delayMs = 0,
): Promise<void> {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  response.writeHead(200, { 'content-type': 'application/octet-stream' });
  response.end(bytes);
}
