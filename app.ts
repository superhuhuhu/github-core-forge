// The HTTP server: one router over the shared store.
//
//   GET  /healthz                          the env's boot probe: 200 {"ok":true}
//   /api/v3*                               REST v3 (src/rest.ts)
//   POST /api/graphql                      GraphQL v4, single or batched (src/graphql.ts)
//   POST /mcp                              MCP, JSON-RPC 2.0 Streamable HTTP (src/mcp.ts)
//   /{owner}/{repo}.git/info/refs         git smart-HTTP advertisement (v2 when the
//                                          Git-Protocol: version=2 header asks for it;
//                                          receive-pack is v0-only)
//   POST /{owner}/{repo}.git/git-upload-pack    v2 ls-refs / fetch, v0 fetch fallback
//   POST /{owner}/{repo}.git/git-receive-pack   v0 receive-pack (push)
//   everything else                        JSON 404 {message}
//
// Auth: every route except /healthz requires `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN` when that variable is set; when it is not set (local
// development) any non-empty Bearer token is accepted. No token at all is
// always 401. Every JSON reply carries a non-empty X-GitHub-Request-Id from a
// process counter (never a wall clock or Math.random()).
//
// A handler that throws answers 500 JSON and the server stays up: a malformed
// git POST must never kill the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type Repo } from './src/store.ts';
import { VIEWER } from './src/scenario.ts';
import { handleRest, type RestContext } from './src/rest.ts';
import { GraphQLExecutor } from './src/graphql.ts';
import { handleMcp, mcpParseErrorBody, parseMcpBody } from './src/mcp.ts';
import {
  PKT_MAX,
  advertiseV0,
  advertiseV2,
  applyPush,
  decodePackets,
  cachedFetchResponse,
  listRefs,
  lsRefsResponse,
  parsePushBody,
  parseV2Fetch,
  pkt,
  pktFlush,
  planFetch,
  pushReportResponse,
  writePack,
  type FetchRequest,
} from './src/gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}-${process.pid.toString(16)}`;
}

/** Answer with a JSON body. `status` 204 sends no body at all. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const requestId = nextRequestId();
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId, ...headers });
  res.end(text);
}

/** Answer with raw bytes (git smart HTTP). */
function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  const requestId = nextRequestId();
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId });
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/** A v0 upload-pack fetch answer: NAK (or ACKs for common haves), shallow lines, then the pack as sideband band-1. The suite only ever fetches v2, so this is a fallback, not the hot path. */
function v0FetchResponse(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(store, repo, req);
  const parts: Buffer[] = [];
  if (req.haves.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    let acked = false;
    for (const have of req.haves) {
      if (store.isAncestor(repo, have, req.wants[0] ?? have)) {
        parts.push(pkt(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pkt('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects);
  const chunkSize = PKT_MAX - 5;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v0 fetch POST body (want/have/shallow/deepen lines in two sections). */
function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = decodePackets(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]?.trim() ?? '');
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
  }
  return req;
}

/** Handle one git smart-HTTP request. Returns true when it answered. */
function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, rest: string, body: Buffer): boolean {
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const method = req.method ?? 'GET';
  const service = req.url?.includes('service=git-receive-pack') ? 'git-receive-pack' : 'git-upload-pack';

  if (method === 'GET' && rest === 'info/refs') {
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-receive-pack' || !wantsV2) {
      sendBytes(res, 200, advertiseV0(store, repo, service), `application/x-${service}-advertisement`);
    } else {
      sendBytes(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
    }
    return true;
  }

  if (method === 'POST' && rest === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const packets = decodePackets(body);
      if (wantsV2) {
        const first = packets.find((p) => p.kind === 'data' && p.payload !== undefined);
        const command = first?.payload?.toString('utf8').trim() ?? '';
        if (command === 'command=ls-refs') {
          const prefixes: string[] = [];
          let peel = false;
          let symrefs = false;
          for (const packet of packets) {
            if (packet.kind !== 'data' || packet.payload === undefined) continue;
            const line = packet.payload.toString('utf8').trim();
            if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
            else if (line === 'peel') peel = true;
            else if (line === 'symrefs') symrefs = true;
          }
          const refs = listRefs(store, repo, prefixes, peel, symrefs);
          sendBytes(res, 200, lsRefsResponse(refs), 'application/x-git-upload-pack-result');
          return true;
        }
        if (command === 'command=fetch') {
          const fetchReq = parseV2Fetch(packets);
          sendBytes(res, 200, cachedFetchResponse(store, repo, fetchReq), 'application/x-git-upload-pack-result');
          return true;
        }
        sendJson(res, 400, { message: `unknown git-upload-pack command: ${command}` });
        return true;
      }
      // v0 fetch fallback.
      const fetchReq = parseV0Fetch(body);
      sendBytes(res, 200, v0FetchResponse(store, repo, fetchReq), 'application/x-git-upload-pack-result');
      return true;
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'malformed git request' });
      return true;
    }
  }

  if (method === 'POST' && rest === 'git-receive-pack') {
    try {
      const parsed = parsePushBody(body);
      const outcome = applyPush(store, repo, parsed.commands, parsed.pack);
      sendBytes(res, 200, pushReportResponse(outcome), 'application/x-git-receive-pack-result');
      return true;
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'malformed git request' });
      return true;
    }
  }

  return false;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(store: Store = new Store()): Server {
  const graphql = new GraphQLExecutor(store);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://entry');
        } catch {
          url = new URL('/', 'http://entry');
        }
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth here.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        // REST v3. GETs carry no body; only read one for methods that send one.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          let parsed: { ok: true; value: unknown } | { ok: false } = { ok: true, value: null };
          if (method !== 'GET' && method !== 'HEAD') {
            const body = await readBody(req);
            parsed = parseJsonBody(body);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Invalid JSON body' });
              return;
            }
          }
          const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
          const ctx: RestContext = {
            store,
            url,
            body: parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : null,
            login: VIEWER.login,
            origin,
          };
          const outcome = handleRest(ctx, method, path);
          sendJson(res, outcome.status, outcome.body, outcome.headers ?? {});
          return;
        }

        // GraphQL v4 (single document or a batch array).
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
          const docs = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
          const results = docs.map((doc) => {
            if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { data: null, errors: [{ message: 'invalid operation document' }] };
            const record = doc as Record<string, unknown>;
            const query = typeof record.query === 'string' ? record.query : '';
            const variables = record.variables !== undefined && typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
            const operationName = typeof record.operationName === 'string' ? record.operationName : null;
            return graphql.execute(query, variables, operationName);
          });
          sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          const { request, parseError } = parseMcpBody(body);
          if (parseError || request === null) {
            sendJson(res, 400, mcpParseErrorBody());
            return;
          }
          const outcome = handleMcp(store, request);
          if (outcome.status === 202 || outcome.body === null) {
            res.writeHead(202, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/... GET info/refs carries no body.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
          const handled = handleGit(store, req, res, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] as string, body);
          if (handled) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
