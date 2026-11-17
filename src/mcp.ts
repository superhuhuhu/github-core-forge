// The MCP endpoint at POST /mcp: JSON-RPC 2.0 over Streamable HTTP, modern
// revision 2026-07-28 (server/discover, no handshake, no session) with the legacy
// initialize handshake answered for older clients.
//
// Contract, from the suite's own client (program/env/src/mcp-client.ts):
//   - every POST carries `MCP-Protocol-Version`, `Mcp-Method`, Accept
//     `application/json, text/event-stream`; answers are plain JSON bodies.
//   - server/discover returns supportedVersions (YYYY-MM-DD), capabilities and
//     serverInfo (also under _meta['io.modelcontextprotocol/serverInfo']).
//   - tools/list lists at least the six tools; the list is byte-identical across
//     calls (one frozen array, serialized the same way every time).
//   - tools/call maps the suite's documented arguments onto the tool's own schema
//     property names; the tool result carries both content text and
//     structuredContent. Missing required arguments answer JSON-RPC -32602; an
//     unknown tool answers -32601. A non-JSON body answers HTTP 400 with -32700.
//   - tools/call without Authorization answers HTTP 401 (enforced by the router).

import { Store, commentGlobalId, issueGlobalId, isoOf, pullGlobalId, repoGlobalId, type Issue, type PullRequest, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools list, frozen so two calls serialize byte-identically. */
export const MCP_TOOLS: readonly McpToolDef[] = Object.freeze(TOOLS.map((tool) => Object.freeze(tool)));

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';
export const MCP_REVISION = '2026-07-28';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpOutcome {
  status: number;
  body: unknown;
}

function rpcResult(id: string | number | null, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): McpOutcome {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoOf(repo.createdAt),
    updatedAt: isoOf(repo.updatedAt),
    updated_at: isoOf(repo.updatedAt),
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.updatedAt),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Run one tool by name with its arguments; the tool result or an error string. */
function callTool(store: Store, name: string, args: Record<string, unknown>): { result?: unknown; error?: string } {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (repoNameArg === '') return { error: 'create_repo requires a name' };
      const repo = store.createRepo(repoNameArg, args.private === true, typeof args.description === 'string' ? args.description : '');
      if (repo === null) return { error: `repository ${repoNameArg} already exists` };
      return { result: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
      return { result: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { error: 'create_issue requires a title' };
      const created = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return { error: created.error };
      return { result: issueJson(repo, created) };
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(repo, i));
      return { result: { issues } };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
      const created = store.createPull(
        repo,
        typeof args.title === 'string' ? args.title : '',
        typeof args.body === 'string' ? args.body : '',
        typeof args.head === 'string' ? args.head : '',
        typeof args.base === 'string' ? args.base : '',
      );
      if ('error' in created) return { error: created.error };
      return { result: pullJson(repo, created) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return { error: `pull request #${number} not found` };
      if (pull.state !== 'open') return { error: `pull request #${number} is not open` };
      const merged = store.squashMerge(repo, pull);
      if (merged === null) return { error: 'merge conflict: the pull request cannot be merged' };
      return { result: pullJson(repo, pull) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

/** Handle one parsed JSON-RPC request object. */
export function handleMcp(store: Store, request: JsonRpcRequest): McpOutcome {
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = request.params ?? {};
  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return rpcResult(id, {
        resultType: 'DiscoverResult',
        supportedVersions: [MCP_REVISION],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP on one store.',
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
      return rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return { status: 202, body: null };
    case 'tools/list': {
      return rpcResult(id, { tools: MCP_TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== undefined && typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (tool === undefined) return rpcError(id, -32601, `Method not found: tools/call ${name}`);
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcError(id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
      const outcome = callTool(store, name, args);
      if (outcome.error !== undefined) return rpcResult(id, toolError(outcome.error));
      return rpcResult(id, toolResult(outcome.result));
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Parse a raw MCP body; a non-JSON body is HTTP 400 with JSON-RPC -32700. */
export function parseMcpBody(raw: Buffer): { request: JsonRpcRequest | null; parseError: boolean } {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { request: parsed as JsonRpcRequest, parseError: false };
    return { request: null, parseError: true };
  } catch {
    return { request: null, parseError: true };
  }
}

export function mcpParseErrorBody(): Record<string, unknown> {
  return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
}
