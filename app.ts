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

import type net from 'node:net';
import { Store, type Repo } from './src/store.ts';
import { VIEWER } from './src/scenario.ts';
import { handleRest, type RestContext } from './src/rest.ts';
import { GraphQLExecutor } from './src/graphql.ts';
import { handleMcp, mcpParseErrorBody, parseMcpBody } from './src/mcp.ts';
import { createTcpServer, type DispatchResult, type TransportRequest } from './src/transport.ts';
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

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}-${process.pid.toString(16)}`;
}

/** A JSON reply as a result the transport writes. `status` 204 sends no body at all. */
function jsonResult(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): DispatchResult {
  const requestId = nextRequestId();
  if (status === 204) {
    return { status, contentType: null, body: null, headers: { 'x-github-request-id': requestId, ...headers } };
  }
  const text = `${JSON.stringify(body)}\n`;
  return { status, contentType: JSON_TYPE, body: Buffer.from(text, 'utf8'), headers: { 'x-github-request-id': requestId, ...headers } };
}

/** A raw-bytes reply (git smart HTTP) as a result the transport writes. */
function bytesResult(status: number, body: Buffer, contentType: string): DispatchResult {
  return { status, contentType, body, headers: { 'x-github-request-id': nextRequestId() } };
}

function authorized(headers: Readonly<Record<string, string>>): boolean {
  const header = headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
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

/** Handle one git smart-HTTP request. Returns its result, or null when the route is not a git one. */
function handleGit(store: Store, method: string, rawUrl: string, gitProtocol: string, owner: string, repoName: string, rest: string, body: Buffer): DispatchResult | null {
  if (owner !== VIEWER.login) {
    return jsonResult(404, { message: 'Not Found' });
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return jsonResult(404, { message: 'Not Found' });
  }
  const service = rawUrl.includes('service=git-receive-pack') ? 'git-receive-pack' : 'git-upload-pack';

  if (method === 'GET' && rest === 'info/refs') {
    const wantsV2 = gitProtocol === 'version=2';
    if (service === 'git-receive-pack' || !wantsV2) {
      return bytesResult(200, advertiseV0(store, repo, service), `application/x-${service}-advertisement`);
    }
    return bytesResult(200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
  }

  if (method === 'POST' && rest === 'git-upload-pack') {
    const wantsV2 = gitProtocol === 'version=2';
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
          return bytesResult(200, lsRefsResponse(refs), 'application/x-git-upload-pack-result');
        }
        if (command === 'command=fetch') {
          const fetchReq = parseV2Fetch(packets);
          return bytesResult(200, cachedFetchResponse(store, repo, fetchReq), 'application/x-git-upload-pack-result');
        }
        return jsonResult(400, { message: `unknown git-upload-pack command: ${command}` });
      }
      // v0 fetch fallback.
      const fetchReq = parseV0Fetch(body);
      return bytesResult(200, v0FetchResponse(store, repo, fetchReq), 'application/x-git-upload-pack-result');
    } catch (err) {
      return jsonResult(400, { message: err instanceof Error ? err.message : 'malformed git request' });
    }
  }

  if (method === 'POST' && rest === 'git-receive-pack') {
    try {
      const parsed = parsePushBody(body);
      const outcome = applyPush(store, repo, parsed.commands, parsed.pack);
      return bytesResult(200, pushReportResponse(outcome), 'application/x-git-receive-pack-result');
    } catch (err) {
      return jsonResult(400, { message: err instanceof Error ? err.message : 'malformed git request' });
    }
  }

  return null;
}

/**
 * One request, answered synchronously: the transport hands over the whole body, so no handler
 * here awaits anything. A handler that throws answers 500 JSON and the server stays up: a
 * malformed git POST must never kill the process.
 */
function dispatchRequest(store: Store, graphql: GraphQLExecutor, req: TransportRequest): DispatchResult {
  try {
    let url: URL;
    try {
      url = new URL(req.url, 'http://entry');
    } catch {
      url = new URL('/', 'http://entry');
    }
    const path = url.pathname;
    const method = req.method;
    const headers = req.headers;

    // The env's boot check calls this twice: 200 {"ok":true}. No auth here.
    if (method === 'GET' && path === '/healthz') {
      return jsonResult(200, { ok: true });
    }

    if (!authorized(headers)) {
      return jsonResult(401, { message: 'Requires authentication' });
    }

    // REST v3. GETs carry no body; only read one for methods that send one.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      let parsed: { ok: true; value: unknown } | { ok: false } = { ok: true, value: null };
      if (method !== 'GET' && method !== 'HEAD') {
        parsed = parseJsonBody(req.body);
        if (!parsed.ok) {
          return jsonResult(400, { message: 'Invalid JSON body' });
        }
      }
      const origin = `http://${headers.host ?? '127.0.0.1'}`;
      const ctx: RestContext = {
        store,
        url,
        body: parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : null,
        login: VIEWER.login,
        origin,
      };
      const outcome = handleRest(ctx, method, path);
      return jsonResult(outcome.status, outcome.body, outcome.headers ?? {});
    }

    // GraphQL v4 (single document or a batch array).
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        return jsonResult(404, { message: 'Not Found' });
      }
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) {
        return jsonResult(400, { message: 'Invalid JSON body' });
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
      return jsonResult(200, Array.isArray(parsed.value) ? results : results[0]);
    }

    // MCP.
    if (path === '/mcp') {
      if (method !== 'POST') {
        return jsonResult(404, { message: 'Not Found' });
      }
      const { request, parseError } = parseMcpBody(req.body);
      if (parseError || request === null) {
        return jsonResult(400, mcpParseErrorBody());
      }
      const outcome = handleMcp(store, request);
      if (outcome.status === 202 || outcome.body === null) {
        return { status: 202, contentType: null, body: null, headers: { 'x-github-request-id': nextRequestId() } };
      }
      return jsonResult(outcome.status, outcome.body);
    }

    // Git smart HTTP.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
    if (gitMatch !== null) {
      const handled = handleGit(store, method, req.url, headers['git-protocol'] ?? '', gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] as string, req.body);
      if (handled !== null) return handled;
    }

    // Everything else, every method: GitHub's 404 body.
    return jsonResult(404, { message: 'Not Found' });
  } catch (err) {
    return jsonResult(500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
  }
}

/**
 * Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral
 * port. The transport is a minimal HTTP/1.1 server on raw TCP (src/transport.ts), not Node's
 * http server: for this traffic — one small request, one small reply, sequential — the http
 * stack's per-request cost (~0.26 ms CPU here) is most of what a request costs, and the raw
 * parser spends about half that. The router above is unchanged; only the bytes around it moved.
 */
export function createApp(store: Store = new Store()): net.Server {
  const graphql = new GraphQLExecutor(store);
  return createTcpServer((req) => dispatchRequest(store, graphql, req));
}
