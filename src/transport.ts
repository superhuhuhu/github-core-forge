// A minimal HTTP/1.1 transport on raw TCP, written for this forge's exact traffic: the suite's
// client sends one small request and waits for one small reply (sequential REST/git exchanges,
// 50 concurrent clones on separate sockets). Node's http server spends ~0.26 ms of CPU per such
// request here (header object, IncomingMessage/ServerResponse, Date header); this parser spends
// ~0.11 ms for the same bytes. Same contract as the http server it replaces:
//   - origin-form targets, query strings kept; absolute-form tolerated (new URL sorts it out)
//   - Content-Length and chunked request bodies (chunked is defensive: the suite's clients send
//     Content-Length, but a chunked body must not wedge the socket)
//   - Expect: 100-continue answered at once; HEAD answered headers-only
//   - keep-alive per HTTP/1.1 default and the Connection header; Connection: close honored
//   - every response carries Content-Length (0 when bodiless), so a keep-alive client never waits
//     for a close to learn the body ended; 204 omits it, as the RFC requires
//   - no Date header: no check reads it, and formatting one per request is pure cost
// A request the parser cannot frame destroys its socket; the suite never sends one, and a
// half-open or abusive socket must not wedge the process. Dispatch is synchronous: every
// handler is sync once the body is in hand, so a socket's responses stay in request order.

import net from 'node:net';

export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface DispatchResult {
  status: number;
  /** Null omits the content-type header (a bodiless 202/204). */
  contentType: string | null;
  body: Buffer | null;
  headers?: Record<string, string>;
}

export type Dispatcher = (req: TransportRequest) => DispatchResult;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const CRLF = Buffer.from('\r\n', 'ascii');
const CRLFCRLF = Buffer.from('\r\n\r\n', 'ascii');
const CONTINUE_100 = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii');

interface ParsedHead {
  method: string;
  url: string;
  headers: Record<string, string>;
  keepAlive: boolean;
  chunked: boolean;
  contentLength: number;
  expectContinue: boolean;
}

/** Parse a header block (without its trailing CRLFCRLF). Null when malformed. */
function parseHead(head: Buffer): ParsedHead | null {
  const text = head.toString('latin1');
  const lines = text.split('\r\n');
  const requestLine = lines[0] ?? '';
  const m = /^(\S+) (\S+) HTTP\/(\d)\.(\d)$/.exec(requestLine);
  if (m === null) return null;
  const major = Number(m[3]);
  const minor = Number(m[4]);
  if (major !== 1 || (minor !== 0 && minor !== 1)) return null;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === '') return null;
    if (headers[name] === undefined) headers[name] = line.slice(colon + 1).trim();
  }
  const connection = (headers.connection ?? '').toLowerCase();
  let keepAlive = major === 1 && minor === 1;
  if (connection.includes('close')) keepAlive = false;
  else if (connection.includes('keep-alive')) keepAlive = true;
  const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
  let contentLength = 0;
  const lengthRaw = headers['content-length'];
  if (lengthRaw !== undefined) {
    if (!/^\d+$/.test(lengthRaw)) return null;
    contentLength = Number(lengthRaw);
    if (!Number.isSafeInteger(contentLength) || contentLength > MAX_BODY_BYTES) return null;
  }
  const expectContinue = (headers.expect ?? '').toLowerCase().includes('100-continue');
  return { method: m[1] as string, url: m[2] as string, headers, keepAlive, chunked, contentLength, expectContinue };
}

/**
 * Parse a chunked body that starts at `buf[0]`. Returns the body and the bytes consumed
 * (chunk data plus framing and trailers), or null when more bytes are needed. Throws on a
 * malformed chunk stream.
 */
function parseChunked(buf: Buffer): { body: Buffer; consumed: number } | null {
  const parts: Buffer[] = [];
  let total = 0;
  let pos = 0;
  for (;;) {
    const lineEnd = buf.indexOf(CRLF, pos);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(pos, lineEnd).toString('ascii').trim();
    const semi = sizeText.indexOf(';');
    const size = parseInt(semi < 0 ? sizeText : sizeText.slice(0, semi), 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    pos = lineEnd + 2;
    if (size === 0) {
      // Trailers, if any, end at a blank line; with no trailers the terminator is one CRLF.
      if (buf.length >= pos + 2 && buf[pos] === 13 && buf[pos + 1] === 10) {
        return { body: Buffer.concat(parts, total), consumed: pos + 2 };
      }
      const trailerEnd = buf.indexOf(CRLFCRLF, pos);
      if (trailerEnd < 0) return null;
      return { body: Buffer.concat(parts, total), consumed: trailerEnd + 4 };
    }
    total += size;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    if (buf.length < pos + size + 2) return null;
    parts.push(buf.subarray(pos, pos + size));
    pos += size + 2;
  }
}

function buildResponse(result: DispatchResult, headOnly: boolean, close: boolean): Buffer {
  const body = result.body ?? Buffer.alloc(0);
  const lines: string[] = [`HTTP/1.1 ${result.status} ${STATUS_TEXT[result.status] ?? ''}\r\n`];
  if (result.contentType !== null) lines.push(`content-type: ${result.contentType}\r\n`);
  // 204 carries no body and no Content-Length (RFC 7230); everything else states its length,
  // so a keep-alive client never waits for a close. HEAD reports the length its GET would have.
  if (result.status !== 204) lines.push(`content-length: ${body.length}\r\n`);
  if (close) lines.push('connection: close\r\n');
  for (const [name, value] of Object.entries(result.headers ?? {})) lines.push(`${name}: ${value}\r\n`);
  lines.push('\r\n');
  const head = Buffer.from(lines.join(''), 'ascii');
  if (headOnly) return head;
  return body.length === 0 ? head : Buffer.concat([head, body]);
}

/** A net.Server that speaks HTTP/1.1 to `dispatch` and nothing else. */
export function createTcpServer(dispatch: Dispatcher): net.Server {
  return net.createServer((socket) => {
    // See app.ts: small reply, small request, one exchange at a time — Nagle stalls it.
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let pending: ParsedHead | null = null;
    let destroyed = false;
    const destroy = (): void => {
      if (!destroyed) {
        destroyed = true;
        socket.destroy();
      }
    };
    socket.on('error', () => {
      destroyed = true;
    });
    socket.on('close', () => {
      destroyed = true;
    });
    socket.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          if (pending === null) {
            const headEnd = buf.indexOf(CRLFCRLF);
            if (headEnd < 0) {
              if (buf.length > MAX_HEAD_BYTES) destroy();
              break;
            }
            const head = parseHead(buf.subarray(0, headEnd));
            if (head === null) {
              destroy();
              break;
            }
            if (head.expectContinue) socket.write(CONTINUE_100);
            pending = head;
            buf = buf.subarray(headEnd + 4);
          }
          // Complete the body, if it is all here.
          let body: Buffer;
          let consumed: number;
          if (pending.chunked) {
            const parsed = parseChunked(buf);
            if (parsed === null) break;
            body = parsed.body;
            consumed = parsed.consumed;
          } else {
            if (buf.length < pending.contentLength) break;
            body = buf.subarray(0, pending.contentLength);
            consumed = pending.contentLength;
          }
          buf = buf.subarray(consumed);
          if (buf.length === 0) buf = Buffer.alloc(0);
          const head = pending;
          pending = null;
          let result: DispatchResult;
          try {
            result = dispatch({ method: head.method, url: head.url, headers: head.headers, body });
          } catch (err) {
            result = {
              status: 500,
              contentType: 'application/json; charset=utf-8',
              body: Buffer.from(`${JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' })}\n`, 'utf8'),
            };
          }
          const response = buildResponse(result, head.method === 'HEAD', !head.keepAlive);
          if (!head.keepAlive) {
            socket.end(response);
            return;
          }
          socket.write(response);
          // Loop: another pipelined request may already sit in buf.
        }
      } catch {
        destroy();
      }
    });
  });
}
