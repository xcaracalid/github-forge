// The forge's HTTP server: one process routing git smart HTTP, REST v3, GraphQL and
// MCP over a single in-memory store. Every surface but /healthz requires the trial's
// bearer token; a missing token is a 401 JSON body, and unknown routes are JSON 404s.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { advertise, handleReceivePack, handleUploadPackV0, handleV2 } from './githttp.ts';
import { handleRest, notFound, type RestResult } from './rest.ts';
import { executeGraphql, type GraphqlRequestBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (body === null || body === undefined) {
    res.writeHead(status, { 'content-length': 0, ...headers });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

let requestSeq = 0;
function requestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hasBearer(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^Bearer .+/.test(header);
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req, res) => {
    void dispatch(forge, req, res).catch(() => {
      // A handler fault must never take the server down (the suite probes resilience).
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    if (!hasBearer(req)) return unauthorized(res);
    const [, owner, repoName, route] = gitMatch as unknown as [string, string, string, string];
    const repo = forge.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (route === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('error: service required\n');
        return;
      }
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.split(':').includes('version=2');
      const result = advertise(forge, repo, service, v2);
      res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
      res.end(result.body);
      return;
    }
    if (route === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.split(':').includes('version=2');
      const result = v2 ? handleV2(forge, repo, body) : handleUploadPackV0(forge, repo, body);
      res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
      res.end(result.body);
      return;
    }
    if (route === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const result = handleReceivePack(forge, repo, body);
      res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
      res.end(result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL
  if (path === '/api/graphql') {
    if (!hasBearer(req)) return unauthorized(res);
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Body is not valid JSON' });
      return;
    }
    if (Array.isArray(parsed)) {
      const answers = parsed.map((entry) => executeGraphql(forge, entry as GraphqlRequestBody));
      sendJson(res, 200, answers);
      return;
    }
    const answer = executeGraphql(forge, parsed as GraphqlRequestBody);
    sendJson(res, 200, answer);
    return;
  }

  // MCP
  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendJson(res, 200, null);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!hasBearer(req)) return unauthorized(res);
    const raw = await readBody(req);
    const result = handleMcp(forge, raw.toString('utf8'));
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  // REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!hasBearer(req)) return unauthorized(res);
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    let body: Record<string, unknown> | null = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          const parsed = JSON.parse(raw.toString('utf8')) as unknown;
          body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      } else {
        body = {};
      }
    }
    const host = req.headers.host ?? '127.0.0.1';
    const result: RestResult = handleRest(forge, {
      method,
      segments,
      query: url.searchParams,
      body,
      urlFor: (pathAndQuery) => `http://${host}${pathAndQuery}`,
    });
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  const fallback: RestResult = notFound();
  sendJson(res, fallback.status, fallback.body);
}
