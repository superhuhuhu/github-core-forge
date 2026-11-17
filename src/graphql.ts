// The GraphQL v4 surface at POST /api/graphql: the documents gh and
// github-mcp-server send, executed against the same store as REST and MCP.
//
// Supported: query/mutation operations with variables, aliases, inline fragments,
// input objects, inline enum lists, null variables, operation batching (a JSON array
// of documents answers an array in order), __type introspection for Issue,
// PullRequest, Repository and SearchType, and the Relay node(id:) round-trip.
// An unknown field is HTTP 200 with an `errors` array naming it; an unknown
// repository is data.repository = null with no errors; an unauthenticated request
// is 401 (enforced by the router, not here).

import {
  Store,
  commentGlobalId,
  isoOf,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc ?? '';
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: input.slice(i, j) } : { kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'eof') break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variableDefinitions: [], selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kindToken = this.next();
        if (kindToken.kind !== 'name') throw new Error('expected an operation keyword');
        const kind = kindToken.value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        const next = this.peek();
        if (next.kind === 'name') {
          const nameToken = this.next();
          if (nameToken.kind === 'name') name = nameToken.value;
        }
        const variableDefinitions = this.parseVariableDefinitions();
        const selections = this.parseSelections();
        operations.push({ kind, name, variableDefinitions, selections });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        throw new Error('named fragments are not supported by this executor');
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} at the top of a GraphQL document`);
    }
    return operations;
  }

  private parseVariableDefinitions(): Operation['variableDefinitions'] {
    const defs: Operation['variableDefinitions'] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        defs.push({ name, type, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): string {
    let type = '';
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        let typeCondition: string | null = null;
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        selections.push({ kind: 'inlineFragment', typeCondition, selections: this.parseSelections() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args = this.parseArguments();
      let children: SelectionNode[] = [];
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
        children = this.parseSelections();
      }
      selections.push({ kind: 'field', alias, name, arguments: args, selections: children });
    }
    return selections;
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------- values

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- schema (introspection)

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'repository',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  'createdAt', 'updatedAt', 'url',
];
const USER_FIELDS = ['id', 'login', 'name', 'email', 'url'];

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_REQUEST_FIELDS,
  Repository: REPOSITORY_FIELDS,
  User: USER_FIELDS,
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'COMMIT', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'TOPIC', 'PACKAGE', 'MARKETPLACE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

interface GqlError {
  message: string;
}

class GqlFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlFailure';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface GqlResult {
  data: unknown;
  errors?: GqlError[];
}

export class GraphQLExecutor {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  execute(query: string, variables: Record<string, unknown> = {}, operationName?: string | null): GqlResult {
    let operations: Operation[];
    try {
      operations = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    let operation: Operation | undefined;
    if (operationName !== undefined && operationName !== null && operationName !== '') {
      operation = operations.find((op) => op.name === operationName);
      if (operation === undefined) return { data: null, errors: [{ message: `unknown operation ${operationName}` }] };
    } else {
      operation = operations[0];
      if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
    }
    const mergedVariables: Record<string, unknown> = { ...variables };
    for (const def of operation.variableDefinitions) {
      if (!(def.name in mergedVariables) && def.defaultValue !== undefined) {
        mergedVariables[def.name] = valueOf(def.defaultValue, mergedVariables);
      }
    }
    try {
      const data = this.executeSelections(operation.selections, { __type: operation.kind === 'mutation' ? 'Mutation' : 'Query', __value: null }, mergedVariables);
      return { data };
    } catch (err) {
      if (err instanceof GqlFailure) return { data: null, errors: [{ message: err.message }] };
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  }

  private executeSelections(
    selections: SelectionNode[],
    parent: { __type: string; __value: unknown },
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== parent.__type) continue;
        Object.assign(out, this.executeSelections(selection.selections, parent, variables));
        continue;
      }
      const key = selection.alias ?? selection.name;
      out[key] = this.resolveField(selection, parent, variables);
    }
    return out;
  }

  private resolveField(field: FieldNode, parent: { __type: string; __value: unknown }, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    const type = parent.__type;
    const value = parent.__value;
    switch (type) {
      case 'Query':
        return this.resolveQuery(field, args, variables);
      case 'Mutation':
        return this.resolveMutation(field, args, variables);
      case 'Repository':
        return this.resolveRepository(field, value as Repo, args, variables);
      case 'Issue':
        return this.resolveIssue(field, value as { repo: Repo; issue: Issue }, args, variables);
      case 'PullRequest':
        return this.resolvePullRequest(field, value as { repo: Repo; pull: PullRequest }, args, variables);
      case 'User':
        return this.resolveUser(field, value as { login: string }, args, variables);
      case 'IssueConnection':
      case 'PullRequestConnection':
        return this.resolveConnection(field, value as { nodes: unknown[]; pageInfo: Record<string, unknown> }, args, variables);
      case 'PullRequestChangedFile':
        return this.resolveChangedFile(field, value as { path: string }, args, variables);
      case '__Type':
        return this.resolveType(field, value as { name: string }, args, variables);
      case 'Ref':
        return this.resolveRef(field, value as { name: string }, args, variables);
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        const payload = value as { repo: Repo; issue: Issue };
        if (field.name === 'issue') {
          return this.executeSelections(field.selections, { __type: 'Issue', __value: payload }, variables);
        }
        throw new GqlFailure(`Cannot query field "${field.name}" on type "${type}".`);
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        const payload = value as { repo: Repo; pull: PullRequest };
        if (field.name === 'pullRequest') {
          return this.executeSelections(field.selections, { __type: 'PullRequest', __value: payload }, variables);
        }
        throw new GqlFailure(`Cannot query field "${field.name}" on type "${type}".`);
      }
      case 'AddCommentPayload': {
        const payload = value as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
        if (field.name === 'commentEdge') {
          const out: Record<string, unknown> = {};
          for (const selection of field.selections) {
            if (selection.kind === 'field' && selection.name === 'node') {
              const node: Record<string, unknown> = {};
              for (const child of selection.selections) {
                if (child.kind === 'field' && child.name === 'id') node[child.alias ?? 'id'] = commentGlobalId(payload.repo.owner, payload.repo.name, payload.issue.number, payload.comment.id);
                else if (child.kind === 'field' && child.name === 'body') node[child.alias ?? 'body'] = payload.comment.body;
                else if (child.kind === 'field') throw new GqlFailure(`Cannot query field "${child.name}" on type "IssueComment".`);
              }
              out[selection.alias ?? 'node'] = node;
            } else if (selection.kind === 'field' && selection.name === 'cursor') {
              out[selection.alias ?? 'cursor'] = null;
            } else if (selection.kind === 'field') {
              throw new GqlFailure(`Cannot query field "${selection.name}" on type "IssueCommentEdge".`);
            }
          }
          return out;
        }
        throw new GqlFailure(`Cannot query field "${field.name}" on type "${type}".`);
      }
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "${type}".`);
    }
  }

  private fieldKnown(type: string, name: string): boolean {
    if (type === 'Query') return ['viewer', 'repository', 'node', '__type', '__schema'].includes(name);
    if (type === 'Mutation') return ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'].includes(name);
    const fields = TYPE_FIELDS[type];
    return fields !== undefined && fields.includes(name);
  }

  private resolveQuery(field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'viewer': {
        const out = this.executeSelections(field.selections, { __type: 'User', __value: { login: VIEWER.login } }, variables);
        return out;
      }
      case 'repository': {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof name !== 'string') throw new GqlFailure('repository requires owner and name');
        const repo = this.store.getRepo(owner, name);
        if (repo === undefined) return null;
        return this.executeSelections(field.selections, { __type: 'Repository', __value: repo }, variables);
      }
      case 'node': {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') throw new GqlFailure('node requires id');
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        const repo = this.store.getRepo(parsed.owner, parsed.repo);
        if (repo === undefined) return null;
        if (parsed.kind === 'repo') {
          return this.executeSelections(field.selections, { __type: 'Repository', __value: repo }, variables);
        }
        if (parsed.kind === 'issue') {
          const issue = repo.issues.find((i) => i.number === parsed.number);
          if (issue === undefined) return null;
          return this.executeSelections(field.selections, { __type: 'Issue', __value: { repo, issue } }, variables);
        }
        if (parsed.kind === 'pull') {
          const pull = repo.pulls.find((p) => p.number === parsed.number);
          if (pull === undefined) return null;
          return this.executeSelections(field.selections, { __type: 'PullRequest', __value: { repo, pull } }, variables);
        }
        return null;
      }
      case '__type': {
        const name = args.name as string | undefined;
        if (typeof name !== 'string') throw new GqlFailure('__type requires name');
        const known = TYPE_FIELDS[name] !== undefined || TYPE_ENUM_VALUES[name] !== undefined;
        if (!known) return null;
        return this.executeSelections(field.selections, { __type: '__Type', __value: { name } }, variables);
      }
      case '__schema':
        return this.executeSelections(field.selections, { __type: '__Type', __value: { name: 'Query' } }, variables);
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "Query".`);
    }
  }

  private resolveType(field: FieldNode, type: { name: string }, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'name':
        return type.name;
      case 'kind':
        return TYPE_ENUM_VALUES[type.name] !== undefined ? 'ENUM' : 'OBJECT';
      case 'fields': {
        const names = TYPE_FIELDS[type.name] ?? [];
        return names.map((name) => ({ name }));
      }
      case 'enumValues': {
        const names = TYPE_ENUM_VALUES[type.name] ?? [];
        return names.map((name) => ({ name }));
      }
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "__Type".`);
    }
  }

  private resolveUser(field: FieldNode, user: { login: string }, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'login':
        return user.login;
      case 'id':
        return `U_${Buffer.from(`user:${user.login}`, 'utf8').toString('base64url')}`;
      case 'name':
        return user.login === VIEWER.login ? VIEWER.name : user.login;
      case 'email':
        return user.login === VIEWER.login ? VIEWER.email : `${user.login}@example.invalid`;
      case 'url':
        return `https://github.com/${user.login}`;
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "User".`);
    }
  }

  private resolveRef(field: FieldNode, ref: { name: string }, _args: Record<string, unknown>, _variables: Record<string, unknown>): unknown {
    if (field.name === 'name') return ref.name;
    throw new GqlFailure(`Cannot query field "${field.name}" on type "Ref".`);
  }

  private resolveRepository(field: FieldNode, repo: Repo, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo.owner, repo.name);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return this.executeSelections(field.selections, { __type: 'User', __value: { login: repo.owner } }, variables);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return this.executeSelections(field.selections, { __type: 'Ref', __value: { name: repo.defaultBranch } }, variables);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.private;
      case 'createdAt':
        return isoOf(repo.createdAt);
      case 'updatedAt':
        return isoOf(repo.updatedAt);
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}`;
      case 'issue': {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.find((i) => i.number === number) : undefined;
        if (issue === undefined) return null;
        return this.executeSelections(field.selections, { __type: 'Issue', __value: { repo, issue } }, variables);
      }
      case 'issues': {
        const nodes = this.issueConnection(repo, args);
        return this.executeSelections(field.selections, { __type: 'IssueConnection', __value: nodes }, variables);
      }
      case 'pullRequest': {
        const number = args.number as number | undefined;
        const pull = typeof number === 'number' ? repo.pulls.find((p) => p.number === number) : undefined;
        if (pull === undefined) return null;
        return this.executeSelections(field.selections, { __type: 'PullRequest', __value: { repo, pull } }, variables);
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = repo.pulls.slice(0, first).map((pull) => ({ repo, pull }));
        return this.executeSelections(
          field.selections,
          { __type: 'PullRequestConnection', __value: { nodes, pageInfo: { hasNextPage: repo.pulls.length > first, endCursor: null } } },
          variables,
        );
      }
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "Repository".`);
    }
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): { nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: Record<string, unknown> } {
    let issues = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s).toUpperCase()));
      issues = issues.filter((i) => wanted.has(i.state.toUpperCase()));
    }
    const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : null;
    const direction = orderBy !== null && String(orderBy.direction ?? '').toUpperCase() === 'ASC' ? 1 : -1;
    issues.sort((a, b) => (a.number - b.number) * direction);
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const after = args.after as string | null | undefined;
    let start = 0;
    if (typeof after === 'string' && after !== '') {
      try {
        const decoded = Buffer.from(after, 'base64url').toString('utf8');
        const match = /^cursor:(\d+)$/.exec(decoded);
        if (match !== null) {
          const afterNumber = Number(match[1]);
          const index = issues.findIndex((i) => i.number === afterNumber);
          if (index >= 0) start = index + 1;
        }
      } catch {
        start = 0;
      }
    }
    const page = issues.slice(start, start + first);
    const hasNextPage = start + page.length < issues.length;
    const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1]?.number as number}`, 'utf8').toString('base64url') : null;
    return { nodes: page.map((issue) => ({ repo, issue })), pageInfo: { hasNextPage, endCursor } };
  }

  private resolveConnection(field: FieldNode, value: { nodes: unknown[]; pageInfo: Record<string, unknown> }, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'nodes': {
        const parentType = (value.nodes[0] as { issue?: unknown; pull?: unknown } | undefined)?.issue !== undefined ? 'Issue' : 'PullRequest';
        return value.nodes.map((node) => this.executeSelections(field.selections, { __type: parentType, __value: node }, variables));
      }
      case 'pageInfo': {
        const out: Record<string, unknown> = {};
        for (const selection of field.selections) {
          if (selection.kind !== 'field') continue;
          if (selection.name === 'hasNextPage') out[selection.alias ?? selection.name] = value.pageInfo.hasNextPage ?? false;
          else if (selection.name === 'endCursor') out[selection.alias ?? selection.name] = value.pageInfo.endCursor ?? null;
          else if (selection.name === 'hasPreviousPage') out[selection.alias ?? selection.name] = false;
          else if (selection.name === 'startCursor') out[selection.alias ?? selection.name] = null;
          else throw new GqlFailure(`Cannot query field "${selection.name}" on type "PageInfo".`);
        }
        return out;
      }
      case 'totalCount':
        return value.nodes.length;
      case 'edges':
        return value.nodes.map((node) => ({ node, cursor: null }));
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "IssueConnection".`);
    }
  }

  private resolveIssue(field: FieldNode, value: { repo: Repo; issue: Issue }, _args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const { repo, issue } = value;
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo.owner, repo.name, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'createdAt':
        return isoOf(issue.createdAt);
      case 'updatedAt':
        return isoOf(issue.updatedAt);
      case 'author':
        return this.executeSelections(field.selections, { __type: 'User', __value: { login: VIEWER.login } }, variables);
      case 'labels':
        return issue.labels.map((label) => ({ name: label.name }));
      case 'comments':
        return this.executeSelections(field.selections, { __type: 'IssueConnection', __value: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }, variables);
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'repository':
        return this.executeSelections(field.selections, { __type: 'Repository', __value: repo }, variables);
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "Issue".`);
    }
  }

  private resolveChangedFile(field: FieldNode, value: { path: string }, _args: Record<string, unknown>, _variables: Record<string, unknown>): unknown {
    if (field.name === 'path') return value.path;
    throw new GqlFailure(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
  }

  private resolvePullRequest(field: FieldNode, value: { repo: Repo; pull: PullRequest }, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const { repo, pull } = value;
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo.owner, repo.name, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state': {
        if (pull.merged) return 'MERGED';
        return pull.state.toUpperCase();
      }
      case 'merged':
        return pull.merged;
      case 'mergeable': {
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
        const analysis = this.store.mergeAnalysis(repo, baseTip, headTip);
        return analysis.conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRef':
        return this.executeSelections(field.selections, { __type: 'Ref', __value: { name: pull.headRef } }, variables);
      case 'baseRef':
        return this.executeSelections(field.selections, { __type: 'Ref', __value: { name: pull.baseRef } }, variables);
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        let paths: string[] = [];
        if (headTip !== undefined && baseTip !== undefined) {
          const base = this.store.mergeBase(repo, baseTip, headTip);
          if (base !== null) {
            paths = this.store.diffFiles(repo, base, headTip).map((f) => f.path);
          }
        }
        const nodes = paths.slice(0, first).map((path) => ({ path }));
        return this.executeSelections(
          field.selections,
          { __type: 'PullRequestConnection', __value: { nodes, pageInfo: { hasNextPage: paths.length > first, endCursor: null } } },
          variables,
        );
      }
      case 'createdAt':
        return isoOf(pull.createdAt);
      case 'updatedAt':
        return isoOf(pull.updatedAt);
      case 'author':
        return this.executeSelections(field.selections, { __type: 'User', __value: { login: VIEWER.login } }, variables);
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'repository':
        return this.executeSelections(field.selections, { __type: 'Repository', __value: repo }, variables);
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "PullRequest".`);
    }
  }

  private resolveMutation(field: FieldNode, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
    switch (field.name) {
      case 'createIssue': {
        const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
        if (parsed === null || parsed.kind !== 'repo') throw new GqlFailure('createIssue requires a repository id');
        const repo = this.store.getRepo(parsed.owner, parsed.repo);
        if (repo === undefined) throw new GqlFailure('createIssue: unknown repository');
        const created = this.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) throw new GqlFailure(created.error);
        const out = this.executeSelections(field.selections, { __type: 'CreateIssuePayload', __value: { repo, issue: created } }, variables);
        return out;
      }
      case 'closeIssue': {
        const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
        if (parsed === null || parsed.kind !== 'issue') throw new GqlFailure('closeIssue requires an issue id');
        const repo = this.store.getRepo(parsed.owner, parsed.repo);
        const issue = repo?.issues.find((i) => i.number === parsed.number);
        if (repo === undefined || issue === undefined) throw new GqlFailure('closeIssue: unknown issue');
        issue.state = 'closed';
        issue.updatedAt = this.store.clock.tick();
        const out = this.executeSelections(field.selections, { __type: 'CloseIssuePayload', __value: { repo, issue } }, variables);
        return out;
      }
      case 'createPullRequest': {
        const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
        if (parsed === null || parsed.kind !== 'repo') throw new GqlFailure('createPullRequest requires a repository id');
        const repo = this.store.getRepo(parsed.owner, parsed.repo);
        if (repo === undefined) throw new GqlFailure('createPullRequest: unknown repository');
        const created = this.store.createPull(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in created) throw new GqlFailure(created.error);
        const out = this.executeSelections(field.selections, { __type: 'CreatePullRequestPayload', __value: { repo, pull: created } }, variables);
        return out;
      }
      case 'mergePullRequest': {
        const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
        if (parsed === null || parsed.kind !== 'pull') throw new GqlFailure('mergePullRequest requires a pull request id');
        const repo = this.store.getRepo(parsed.owner, parsed.repo);
        const pull = repo?.pulls.find((p) => p.number === parsed.number);
        if (repo === undefined || pull === undefined) throw new GqlFailure('mergePullRequest: unknown pull request');
        const method = String(input.mergeMethod ?? 'MERGE').toUpperCase();
        if (method !== 'SQUASH' && method !== 'MERGE' && method !== 'REBASE') throw new GqlFailure(`unknown merge method ${method}`);
        if (pull.state !== 'open') throw new GqlFailure('pull request is not open');
        const merged = this.store.squashMerge(repo, pull);
        if (merged === null) throw new GqlFailure('merge conflict: the pull request cannot be merged');
        const out = this.executeSelections(field.selections, { __type: 'MergePullRequestPayload', __value: { repo, pull } }, variables);
        return out;
      }
      case 'addComment': {
        const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
        if (parsed === null || parsed.kind !== 'issue') throw new GqlFailure('addComment requires an issue id');
        const repo = this.store.getRepo(parsed.owner, parsed.repo);
        const issue = repo?.issues.find((i) => i.number === parsed.number);
        if (repo === undefined || issue === undefined) throw new GqlFailure('addComment: unknown issue');
        const comment = createIssueComment(this.store, issue, String(input.body ?? ''));
        const out = this.executeSelections(field.selections, { __type: 'AddCommentPayload', __value: { repo, issue, comment } }, variables);
        return out;
      }
      default:
        throw new GqlFailure(`Cannot query field "${field.name}" on type "Mutation".`);
    }
  }
}

/** Create a comment on an issue, allocating its id from the store's sequence. */
export function createIssueComment(store: Store, issue: Issue, body: string): { id: number; body: string } {
  return store.createIssueComment(issue, body);
}
