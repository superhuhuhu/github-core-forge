// The forge's in-memory store: repositories, git objects, issues, pull requests.
// Everything is synchronous and in memory — the benchmark's read/write workloads
// are ~1.4 ms an operation against the reference, so no I/O may sit on a request path.
//
// Determinism: no wall clock and no unseeded randomness anywhere in this file. All
// timestamps come from a logical clock seeded by MAKEFUN_TRIAL_NOW (scenario.ts),
// advancing one second per server-created commit or record.

import { createHash } from 'node:crypto';
import { VIEWER, trialEpochSec } from './scenario.ts';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdAt: number;
  updatedAt: number;
  /** Creation sequence (ties to the issue number, but kept explicit for ordering). */
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  /** Shared issue + pull-request numbering, GitHub-faithful. */
  nextNumber: number;
}

// ---------------------------------------------------------------- clock

/** A logical clock: one second per tick, so every timestamp is reproducible. */
export class Clock {
  private current: number;

  constructor() {
    this.current = trialEpochSec();
  }

  /** The next timestamp, epoch seconds. */
  tick(): number {
    this.current += 1;
    return this.current;
  }

  /** The current reading without advancing. */
  now(): number {
    return this.current;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format epoch seconds as an ISO-8601 UTC string, without touching the wall clock. */
export function isoOf(epochSec: number): string {
  const ms = epochSec * 1000;
  const d = new Date(ms);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** Format epoch seconds the way a git author line wants it: `<epoch> +0000`. */
export function gitDateOf(epochSec: number): string {
  return `${epochSec} +0000`;
}

// ---------------------------------------------------------------- git object model

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** The author epoch, parsed from the author line (0 when unparseable). */
  timestamp: number;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const epoch = / (\d+) [+-]\d{4}$/.exec(author);
      if (epoch !== null) timestamp = Number(epoch[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, timestamp };
}

export function buildCommit(input: { tree: string; parents: readonly string[]; message: string; author: string; committer: string }): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  lines.push('');
  lines.push(input.message.endsWith('\n') ? input.message : `${input.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** The identity line of a server-created commit. */
export function serverIdentity(epochSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${gitDateOf(epochSec)}`;
}

// ---------------------------------------------------------------- global (Relay) ids

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

export function repoGlobalId(owner: string, name: string): string {
  return `R_${b64url(`repo:${owner}/${name}`)}`;
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return `I_${b64url(`issue:${owner}/${name}#${number}`)}`;
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return `PR_${b64url(`pr:${owner}/${name}#${number}`)}`;
}

export function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return `IC_${b64url(`comment:${owner}/${name}#${issueNumber}:${commentId}`)}`;
}

export type GlobalIdKind = 'repo' | 'issue' | 'pull' | 'comment' | null;

export interface ParsedGlobalId {
  kind: Exclude<GlobalIdKind, null>;
  owner: string;
  repo: string;
  number: number;
  commentId: number;
}

/** Decode an opaque global id back into what it names, or null when it is not one. */
export function parseGlobalId(id: string): ParsedGlobalId | null {
  const match = /^(R|I|PR|IC)_(.+)$/.exec(id);
  if (match === null) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[2] as string, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const prefix = match[1] as string;
  if (prefix === 'R') {
    const m = /^repo:([^/]+)\/(.+)$/.exec(decoded);
    if (m === null) return null;
    return { kind: 'repo', owner: m[1] as string, repo: m[2] as string, number: 0, commentId: 0 };
  }
  if (prefix === 'I') {
    const m = /^issue:([^/]+)\/(.+)#(\d+)$/.exec(decoded);
    if (m === null) return null;
    return { kind: 'issue', owner: m[1] as string, repo: m[2] as string, number: Number(m[3]), commentId: 0 };
  }
  if (prefix === 'PR') {
    const m = /^pr:([^/]+)\/(.+)#(\d+)$/.exec(decoded);
    if (m === null) return null;
    return { kind: 'pull', owner: m[1] as string, repo: m[2] as string, number: Number(m[3]), commentId: 0 };
  }
  const m = /^comment:([^/]+)\/(.+)#(\d+):(\d+)$/.exec(decoded);
  if (m === null) return null;
  return { kind: 'comment', owner: m[1] as string, repo: m[2] as string, number: Number(m[3]), commentId: Number(m[4]) };
}

// ---------------------------------------------------------------- the store

export class Store {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private nextRepoSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER.login) out.push(repo);
    return out.sort((a, b) => a.seq - b.seq);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(VIEWER.login, name))) return null;
    const now = this.clock.tick();
    const repo: Repo = {
      id: this.nextId++,
      owner: VIEWER.login,
      name,
      description: description ?? '',
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      seq: this.nextRepoSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.repos.set(this.key(VIEWER.login, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  /** Rename a repo (re-key the store entry). False when the new name is taken. */
  renameRepo(repo: Repo, newName: string): boolean {
    if (this.repos.has(this.key(repo.owner, newName))) return false;
    this.repos.delete(this.key(repo.owner, repo.name));
    repo.name = newName;
    this.repos.set(this.key(repo.owner, newName), repo);
    return true;
  }

  /** Create a branch ref pointing at an existing object. False when the ref exists or the object is unknown. */
  createBranch(repo: Repo, branch: string, sha: string): boolean {
    const ref = `refs/heads/${branch}`;
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    return true;
  }

  /** Create a comment on an issue, allocating its id from the store's sequence. */
  createIssueComment(issue: Issue, body: string): IssueComment {
    const now = this.clock.tick();
    const comment: IssueComment = { id: this.allocateId(), body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ the store's id sequence
  allocateId(): number {
    return this.nextId++;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  objectOf(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The commit object at `oid`, parsed, or null. */
  commitOf(repo: Repo, oid: string): CommitView | null {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Resolve a ref-ish: a branch name, a full ref, or a 40-hex commit id. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    if (oid !== undefined) return oid;
    return null;
  }

  /** All commit oids reachable from `tips` (parents only), in visit order. */
  reachableCommits(repo: Repo, tips: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      seen.add(oid);
      for (const parent of commit.parents) stack.push(parent);
    }
    return seen;
  }

  /** Every object id reachable from `tips` (commits, trees, blobs, tags). */
  reachableObjects(repo: Repo, tips: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? Walks up from the descendant and stops as soon as the ancestor is found. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The best common ancestor of two commits (the merge base), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = this.reachableCommits(repo, [a]);
    if (fromA.has(b)) return b;
    const fromB = this.reachableCommits(repo, [b]);
    if (fromB.has(a)) return a;
    // Walk b's ancestry breadth-first from the tip; the first commit also in a's set
    // is the nearest common ancestor on b's side.
    const queue = [b];
    const seen = new Set<string>([b]);
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (fromA.has(oid)) return oid;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return null;
  }

  /** The flat file map of a commit's tree: path -> { oid, mode }. */
  treeFiles(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The flat file map at a commit, or an empty map when the commit is unknown. */
  filesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const commit = this.commitOf(repo, commitOid);
    if (commit === null) return new Map();
    return this.treeFiles(repo, commit.tree);
  }

  // ------------------------------------------------------------ tree writes

  /** Apply one file change to a tree, returning the new root tree oid. */
  updateTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null, mode = '100644'): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const object = repo.objects.get(treeOid);
        if (object !== undefined && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth] as string;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode, name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childOid = child !== undefined && child.mode === '40000' ? child.oid : null;
        const next = build(childOid, depth + 1);
        const nextObject = repo.objects.get(next);
        const empty = nextObject !== undefined && nextObject.type === 'tree' && parseTree(nextObject.data).length === 0;
        if (empty) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      const data = buildTree([...entries.values()]);
      return this.putObject(repo, 'tree', data);
    };
    return build(baseTreeOid, 0);
  }

  /** Commit a file change on a branch. Creates the branch from the default tip when missing. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string; branchCreated: boolean } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    let branchCreated = false;
    if (tip === undefined) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      branchCreated = true;
    }
    const blobOid = this.putObject(repo, 'blob', content);
    const baseTree = tip !== undefined ? this.commitOf(repo, tip)?.tree ?? null : null;
    const treeOid = this.updateTree(repo, baseTree, path, blobOid);
    const epoch = this.clock.tick();
    const identity = serverIdentity(epoch);
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip !== undefined ? [tip] : [],
      message,
      author: identity,
      committer: identity,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: blobOid, branchCreated };
  }

  /** Delete a file on a branch, committing the removal. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const commit = this.commitOf(repo, tip);
    if (commit === null) return null;
    const treeOid = this.updateTree(repo, commit.tree, path, null);
    const epoch = this.clock.tick();
    const identity = serverIdentity(epoch);
    const commitData = buildCommit({ tree: treeOid, parents: [tip], message, author: identity, committer: identity });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  /** The commit history of a ref, newest first (full ancestry, not first-parent only). */
  commitsOf(repo: Repo, tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 0 }];
    // A stable newest-first order: walk by generation (parents are older), ties by
    // discovery order. For the linear histories the suite builds this is exact.
    const byDepth = new Map<string, number>();
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      if (seen.has(oid)) continue;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      seen.add(oid);
      byDepth.set(oid, depth);
      order.push(oid);
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    // Newest first: the tip first, then by increasing generation. Within one
    // generation keep discovery order (parents pushed in commit order).
    order.sort((a, b) => (byDepth.get(a) as number) - (byDepth.get(b) as number));
    return order;
  }

  // ------------------------------------------------------------ diff / merge

  /** A line diff between two blobs: added and removed line counts. */
  static lineDiff(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
    const a = before === null ? [] : before.toString('utf8').split('\n');
    const b = after === null ? [] : after.toString('utf8').split('\n');
    if (a.length > 0 && a[a.length - 1] === '') a.pop();
    if (b.length > 0 && b[b.length - 1] === '') b.pop();
    // LCS on lines (files here are small).
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
      }
    }
    const common = dp[0]![0] as number;
    return { additions: m - common, deletions: n - common };
  }

  /** The changed files between two commits' trees. */
  diffFiles(repo: Repo, fromCommit: string, toCommit: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
    const from = this.filesAt(repo, fromCommit);
    const to = this.filesAt(repo, toCommit);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> = [];
    const paths = new Set([...from.keys(), ...to.keys()]);
    for (const path of [...paths].sort()) {
      const a = from.get(path);
      const b = to.get(path);
      if (a !== undefined && b !== undefined && a.oid === b.oid) continue;
      const aData = a === undefined ? null : repo.objects.get(a.oid)?.data ?? null;
      const bData = b === undefined ? null : repo.objects.get(b.oid)?.data ?? null;
      const { additions, deletions } = Store.lineDiff(aData, bData);
      out.push({
        path,
        status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
        additions: a === undefined ? Math.max(1, additions) : additions,
        deletions,
      });
    }
    return out;
  }

  /** Three-way merge analysis between a base tip and a head tip over their merge base. */
  mergeAnalysis(repo: Repo, baseTip: string, headTip: string): { conflict: boolean; base: string | null; files: Array<{ path: string; oid: string; mode: string }> } {
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base === null) return { conflict: true, base: null, files: [] };
    const baseFiles = this.filesAt(repo, base);
    const headFiles = this.filesAt(repo, headTip);
    const baseTipFiles = this.filesAt(repo, baseTip);
    let conflict = false;
    const merged = new Map<string, { oid: string; mode: string }>();
    for (const [path, entry] of baseTipFiles) merged.set(path, entry);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      const inTip = baseTipFiles.get(path);
      const headChanged = (inHead?.oid ?? null) !== (inBase?.oid ?? null);
      const tipChanged = (inTip?.oid ?? null) !== (inBase?.oid ?? null);
      if (headChanged && tipChanged && (inHead?.oid ?? null) !== (inTip?.oid ?? null)) {
        conflict = true;
        continue;
      }
      if (headChanged) {
        if (inHead === undefined) merged.delete(path);
        else merged.set(path, inHead);
      }
    }
    return { conflict, base, files: [...merged.entries()].map(([path, entry]) => ({ path, ...entry })) };
  }

  /** Squash-merge a pull request. Returns the merge commit sha, or null on conflict. */
  squashMerge(repo: Repo, pull: PullRequest): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (baseTip === undefined || headTip === undefined) return null;
    const analysis = this.mergeAnalysis(repo, baseTip, headTip);
    if (analysis.conflict || analysis.base === null) return null;
    // Rebuild the merged tree from the flat file map, bottom-up by path segments.
    const files = [...analysis.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    const buildFrom = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Set<string>();
      for (const file of files) {
        const slash = file.path.lastIndexOf('/');
        const dir = slash < 0 ? '' : file.path.slice(0, slash);
        if (dir === prefix) {
          const name = slash < 0 ? file.path : file.path.slice(slash + 1);
          entries.push({ mode: file.mode, name, oid: file.oid });
        } else if (dir.startsWith(prefix === '' ? '' : `${prefix}/`)) {
          const rest = prefix === '' ? dir : dir.slice(prefix.length + 1);
          const first = rest.split('/')[0];
          if (first !== undefined && first !== '') subdirs.add(first);
        }
      }
      for (const sub of subdirs) {
        const subPath = prefix === '' ? sub : `${prefix}/${sub}`;
        entries.push({ mode: '40000', name: sub, oid: buildFrom(subPath) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    const treeOid = buildFrom('');
    const epoch = this.clock.tick();
    const identity = serverIdentity(epoch);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commitData = buildCommit({ tree: treeOid, parents: [baseTip], message, author: identity, committer: identity });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = epoch;
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = epoch;
    return mergeSha;
  }

  // ------------------------------------------------------------ issues / pulls

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { id: this.nextId++, name, color: color ?? 'ededed', description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `Label '${name}' does not exist` };
      labels.push(label);
    }
    const now = this.clock.tick();
    const issue: Issue = {
      id: this.nextId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdAt: now,
      updatedAt: now,
      seq: now,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined) return { error: `Head branch '${head}' does not exist` };
    if (baseTip === undefined) return { error: `Base branch '${base}' does not exist` };
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (existing !== undefined) return { error: 'A pull request already exists for this head and base' };
    const now = this.clock.tick();
    const pull: PullRequest = {
      id: this.nextId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      seq: now,
    };
    repo.pulls.push(pull);
    return pull;
  }
}
