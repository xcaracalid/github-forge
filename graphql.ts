// GraphQL: a small parser and executor covering the schema the suite probes — viewer,
// repository reads, issue/pull-request connections with cursor pagination, the five
// mutations gh uses, Relay node(id:) and __type introspection. Errors follow GitHub's
// shape: HTTP 200 with an `errors` array naming the offending field.

import { pullChanges, pullMergeable, mergePull, VIEWER, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { encodeRepoId } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer and parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selection: FieldNode[] | null;
  fragmentType: string | null; // set for inline fragments: the type condition
  fragmentName: string | null; // set for fragment spreads
}

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: FieldNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: FieldNode[] }>;
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc ?? '';
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Array<{ kind: string; value: string }>;
  constructor(tokens: Array<{ kind: string; value: string }>) {
    this.tokens = tokens;
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.pos] as { kind: string; value: string };
  }
  private next(): { kind: string; value: string } {
    const token = this.tokens[this.pos] as { kind: string; value: string };
    this.pos += 1;
    return token;
  }
  private expect(kind: string, value?: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new GqlSyntaxError(`expected ${value ?? kind}, found ${token.value}`);
    }
    return token;
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: FieldNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('punct', '(');
    while (!this.atPunct(')')) {
      this.expect('punct', '$');
      this.expect('name');
      this.expect('punct', ':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect('punct', ')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    if (this.atPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expect('name');
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expect('name');
          this.expect('punct', ':');
          this.parseValue();
        }
        this.expect('punct', ')');
      }
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('punct', '{');
    const fields: FieldNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new GqlSyntaxError('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expect('punct', '}');
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        return { alias: null, name: '', args: new Map(), selection: this.parseSelectionSet(), fragmentType: typeCondition, fragmentName: null };
      }
      const name = this.expect('name').value;
      this.skipDirectives();
      return { alias: null, name: '', args: new Map(), selection: null, fragmentType: null, fragmentName: name };
    }
    let name = this.expect('name').value;
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    const args = new Map<string, ValueNode>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expect('name').value;
        this.expect('punct', ':');
        args.set(argName, this.parseValue());
      }
      this.expect('punct', ')');
    }
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { alias, name, args, selection, fragmentType: null, fragmentName: null };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      // unreachable: variables are lexed as punct '$' then a name
      return { kind: 'variable', name: this.expect('name').value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expect('punct', ']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.atPunct('}')) {
        const key = this.expect('name').value;
        this.expect('punct', ':');
        fields.set(key, this.parseValue());
      }
      this.expect('punct', '}');
      return { kind: 'object', fields };
    }
    throw new GqlSyntaxError(`unexpected value token ${token.value}`);
  }
}

function parseGraphql(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Schema (field lists drive both validation and __type introspection)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Node: ['id'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Organization: ['id', 'login', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'prefix'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'url', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'repository', 'url', 'createdAt', 'updatedAt', 'mergedAt',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'type', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

/** The object type a field resolves to (for validation and fragment checks). */
const FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Node: {},
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
    pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection',
  },
  Issue: { author: 'User', repository: 'Repository' },
  PullRequest: { author: 'User', repository: 'Repository', files: 'PullRequestChangedFileConnection' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { author: 'User' },
  IssueEdge: { node: 'Issue' },
  PullRequestEdge: { node: 'PullRequest' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const KNOWN_TYPES = new Set([...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES), 'Node']);

// ---------------------------------------------------------------------------
// Global ids

export function repoGlobalId(repo: Repo): string {
  return encodeRepoId(repo.databaseId);
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.databaseId}:${issue.number}`, 'utf8').toString('base64');
}
export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.databaseId}:${pull.number}`, 'utf8').toString('base64');
}
export function commentGlobalId(repo: Repo, itemNumber: number, commentId: number): string {
  return Buffer.from(`IssueComment:${repo.databaseId}:${itemNumber}:${commentId}`, 'utf8').toString('base64');
}

interface DecodedId {
  kind: string;
  parts: string[];
}

function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || !/^[A-Za-z]+$/.test(parts[0] as string)) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Execution

type Source =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueComment'; repo: Repo; itemNumber: number; comment: { id: number; body: string; author: string; createdAt: number } }
  | { __type: 'Connection'; connectionOf: 'Issue' | 'PullRequest' | 'PullRequestChangedFile'; nodes: Source[]; totalCount: number; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __type: 'ChangedFile'; path: string; additions: number; deletions: number }
  | { __type: 'Payload'; payloadOf: string; repo: Repo; issue?: Issue; pull?: Pull; commentNode?: Source }
  | { __type: 'CommentEdge'; node: Source }
  | { __type: 'Edge'; node: Source; cursor: string }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | null;

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: FieldNode[] }>;
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = valueOf(value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = valueOf(value, ctx.variables);
  return out;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionSpec {
  connectionOf: 'Issue' | 'PullRequest' | 'PullRequestChangedFile';
  all: Source[];
  first: unknown;
  after: unknown;
}

function makeConnection(spec: ConnectionSpec): Source {
  const first = typeof spec.first === 'number' && Number.isFinite(spec.first) ? Math.max(0, Math.trunc(spec.first)) : spec.all.length;
  let start = 0;
  if (typeof spec.after === 'string' && spec.after !== '') {
    const index = indexOfCursor(spec.after);
    if (index >= 0) start = index + 1;
  }
  const nodes = spec.all.slice(start, start + first);
  const hasNextPage = start + nodes.length < spec.all.length;
  return {
    __type: 'Connection',
    connectionOf: spec.connectionOf,
    nodes,
    totalCount: spec.all.length,
    hasNextPage,
    endCursor: nodes.length > 0 ? cursorOf(start + nodes.length - 1) : null,
    startCursor: nodes.length > 0 ? cursorOf(start) : null,
  };
}

/** Concrete schema type names collapse onto the resolver's marker types. */
function resolverType(typeName: string): string {
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') return 'Connection';
  if (typeName.endsWith('Payload')) return 'Payload';
  if (typeName === 'IssueCommentEdge') return 'CommentEdge';
  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge') return 'Edge';
  if (typeName === 'PullRequestChangedFile') return 'ChangedFile';
  return typeName;
}

function resolveField(givenTypeName: string, source: Source, field: FieldNode, ctx: ExecContext): unknown {
  const typeName = resolverType(givenTypeName);
  const { forge } = ctx;
  const args = argsOf(field, ctx);
  const name = field.name;

  if (name === '__typename') return source?.__type === 'Connection' ? `${source.connectionOf}Connection` : (source?.__type ?? typeName);
  if (typeName === 'Node') {
    // The Relay interface: only `id` resolves directly; concrete fields ride fragments.
    if (name !== 'id' || !source) return null;
    if (source.__type === 'Repository') return repoGlobalId(source.repo);
    if (source.__type === 'Issue') return issueGlobalId(source.repo, source.issue);
    if (source.__type === 'PullRequest') return pullGlobalId(source.repo, source.pull);
    if (source.__type === 'User') return Buffer.from(`User:${source.login}`, 'utf8').toString('base64');
    return null;
  }
  if (typeName === 'Query' && name === '__type') {
    const wanted = typeof args.name === 'string' ? args.name : '';
    return KNOWN_TYPES.has(wanted) ? ({ __type: '__Type', name: wanted } satisfies Source) : null;
  }
  if (typeName === 'Query' && name === '__schema') return null;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return { __type: 'User', login: VIEWER.login } satisfies Source;
      if (name === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? ({ __type: 'Repository', repo } satisfies Source) : null;
      }
      if (name === 'node') return resolveNode(forge, String(args.id ?? ''));
      return null;
    }
    case 'Mutation':
      return resolveMutation(forge, name, args, ctx);
    case 'User': {
      const user = source as Extract<Source, { __type: 'User' }>;
      if (name === 'id') return Buffer.from(`User:${user.login}`, 'utf8').toString('base64');
      if (name === 'login') return user.login;
      if (name === 'name') return user.login === VIEWER.login ? VIEWER.name : user.login;
      if (name === 'email') return user.login === VIEWER.login ? VIEWER.email : null;
      if (name === 'url') return `https://github.com/${user.login}`;
      return null;
    }
    case 'Repository': {
      const repo = (source as Extract<Source, { __type: 'Repository' }>).repo;
      switch (name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.databaseId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', login: repo.owner } satisfies Source;
        case 'defaultBranchRef': {
          const tip = forge.branchTip(repo, repo.defaultBranch);
          return tip ? ({ __type: 'Ref', name: repo.defaultBranch } satisfies Source) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'createdAt': return new Date(repo.createdAt * 1000).toISOString();
        case 'updatedAt': return new Date(repo.updatedAt * 1000).toISOString();
        case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
        case 'issue': {
          const item = repo.items.get(Number(args.number));
          return item && item.kind === 'issue' ? ({ __type: 'Issue', repo, issue: item } satisfies Source) : null;
        }
        case 'issues': {
          let issues = [...repo.items.values()].filter((item): item is Issue => item.kind === 'issue');
          const states = Array.isArray(args.states) ? args.states.map(String) : null;
          if (states) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
          const direction = orderBy.direction === 'ASC' ? 1 : -1;
          issues.sort((a, b) => (a.createdAt - b.createdAt) * direction || (a.number - b.number) * direction);
          return makeConnection({
            connectionOf: 'Issue',
            all: issues.map((issue) => ({ __type: 'Issue', repo, issue }) as Source),
            first: args.first,
            after: args.after,
          });
        }
        case 'pullRequest': {
          const item = repo.items.get(Number(args.number));
          return item && item.kind === 'pull' ? ({ __type: 'PullRequest', repo, pull: item } satisfies Source) : null;
        }
        case 'pullRequests': {
          const pulls = [...repo.items.values()]
            .filter((item): item is Pull => item.kind === 'pull')
            .sort((a, b) => b.number - a.number);
          const states = Array.isArray(args.states) ? args.states.map(String) : null;
          const filtered = states
            ? pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()))
            : pulls;
          return makeConnection({
            connectionOf: 'PullRequest',
            all: filtered.map((pull) => ({ __type: 'PullRequest', repo, pull }) as Source),
            first: args.first,
            after: args.after,
          });
        }
        default: return null;
      }
    }
    case 'Ref':
      if (name === 'name') return (source as Extract<Source, { __type: 'Ref' }>).name;
      if (name === 'prefix') return 'refs/heads/';
      return null;
    case 'Issue': {
      const { repo, issue } = source as Extract<Source, { __type: 'Issue' }>;
      switch (name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'author': return { __type: 'User', login: VIEWER.login } satisfies Source;
        case 'repository': return { __type: 'Repository', repo } satisfies Source;
        case 'createdAt': return new Date(issue.createdAt * 1000).toISOString();
        case 'updatedAt': return new Date(issue.updatedAt * 1000).toISOString();
        case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = source as Extract<Source, { __type: 'PullRequest' }>;
      switch (name) {
        case 'id': return pullGlobalId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pullMergeable(forge, repo, pull);
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'author': return { __type: 'User', login: VIEWER.login } satisfies Source;
        case 'repository': return { __type: 'Repository', repo } satisfies Source;
        case 'createdAt': return new Date(pull.createdAt * 1000).toISOString();
        case 'updatedAt': return new Date(pull.updatedAt * 1000).toISOString();
        case 'mergedAt': return pull.mergedAt === null ? null : new Date(pull.mergedAt * 1000).toISOString();
        case 'url': return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'files': {
          const changes = pullChanges(forge, repo, pull);
          return makeConnection({
            connectionOf: 'PullRequestChangedFile',
            all: changes.map((change) => ({ __type: 'ChangedFile', path: change.filename, additions: change.additions, deletions: change.deletions }) as Source),
            first: args.first,
            after: args.after,
          });
        }
        default: return null;
      }
    }
    case 'Connection': {
      const connection = source as Extract<Source, { __type: 'Connection' }>;
      if (name === 'nodes') return connection.nodes;
      if (name === 'totalCount') return connection.totalCount;
      if (name === 'pageInfo') return { __pageInfo: true, connection };
      if (name === 'edges') return connection.nodes.map((node, index) => ({ __type: 'Edge', node, cursor: cursorOf(index) }) satisfies Source);
      return null;
    }
    case 'PageInfo': {
      const connection = (source as unknown as { __pageInfo: true; connection: Extract<Source, { __type: 'Connection' }> }).connection;
      if (name === 'hasNextPage') return connection.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return connection.endCursor;
      if (name === 'startCursor') return connection.startCursor;
      return null;
    }
    case 'ChangedFile': {
      const file = source as Extract<Source, { __type: 'ChangedFile' }>;
      if (name === 'path') return file.path;
      if (name === 'additions') return file.additions;
      if (name === 'deletions') return file.deletions;
      if (name === 'changeType') return 'MODIFIED';
      return null;
    }
    case 'IssueComment': {
      const comment = source as Extract<Source, { __type: 'IssueComment' }>;
      if (name === 'id') return commentGlobalId(comment.repo, comment.itemNumber, comment.comment.id);
      if (name === 'body') return comment.comment.body;
      if (name === 'author') return { __type: 'User', login: comment.comment.author } satisfies Source;
      if (name === 'createdAt' || name === 'updatedAt') return new Date(comment.comment.createdAt * 1000).toISOString();
      return null;
    }
    case 'Payload': {
      const payload = source as Extract<Source, { __type: 'Payload' }>;
      if (name === 'issue' && payload.issue) return { __type: 'Issue', repo: payload.repo, issue: payload.issue } satisfies Source;
      if (name === 'pullRequest' && payload.pull) return { __type: 'PullRequest', repo: payload.repo, pull: payload.pull } satisfies Source;
      if (name === 'commentEdge' && payload.commentNode) return { __type: 'CommentEdge', node: payload.commentNode } satisfies Source;
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'CommentEdge':
      if (name === 'node') return (source as Extract<Source, { __type: 'CommentEdge' }>).node;
      if (name === 'cursor') return cursorOf(0);
      return null;
    case 'Edge': {
      const edge = source as Extract<Source, { __type: 'Edge' }>;
      if (name === 'node') return edge.node;
      if (name === 'cursor') return edge.cursor;
      return null;
    }
    case '__Type': {
      const typeName = (source as Extract<Source, { __type: '__Type' }>).name;
      if (name === 'name') return typeName;
      if (name === 'kind') return ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT';
      if (name === 'description') return null;
      if (name === 'fields') {
        return (TYPE_FIELDS[typeName] ?? []).map((fieldName) => ({ __type: '__Field', name: fieldName }) satisfies Source);
      }
      if (name === 'enumValues') {
        return (ENUM_VALUES[typeName] ?? []).map((value) => ({ __type: '__EnumValue', name: value }) satisfies Source);
      }
      return null;
    }
    case '__Field':
      if (name === 'name') return (source as Extract<Source, { __type: '__Field' }>).name;
      if (name === 'isDeprecated') return false;
      if (name === 'description') return null;
      return null;
    case '__EnumValue':
      if (name === 'name') return (source as Extract<Source, { __type: '__EnumValue' }>).name;
      if (name === 'isDeprecated') return false;
      if (name === 'description') return null;
      return null;
    default:
      return null;
  }
}

function resolveNode(forge: Forge, id: string): Source {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const repo = forge.repoByDatabaseId(Number(decoded.parts[0]));
    return repo ? { __type: 'Repository', repo } : null;
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repo = forge.repoByDatabaseId(Number(decoded.parts[0]));
    const item = repo?.items.get(Number(decoded.parts[1]));
    if (!repo || !item) return null;
    if (decoded.kind === 'Issue' && item.kind === 'issue') return { __type: 'Issue', repo, issue: item };
    if (decoded.kind === 'PullRequest' && item.kind === 'pull') return { __type: 'PullRequest', repo, pull: item };
    return null;
  }
  if (decoded.kind === 'User') return { __type: 'User', login: decoded.parts.join(':') };
  return null;
}

function resolveMutation(forge: Forge, name: string, args: Record<string, unknown>, ctx: ExecContext): Source {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'Repository' ? forge.repoByDatabaseId(Number(decoded.parts[0])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const issue = forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    return { __type: 'Payload', payloadOf: 'CreateIssuePayload', repo, issue };
  }
  if (name === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    const repo = decoded?.kind === 'Issue' ? forge.repoByDatabaseId(Number(decoded.parts[0])) : undefined;
    const item = repo?.items.get(Number(decoded?.parts[1]));
    if (!repo || !item || item.kind !== 'issue') {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    item.state = 'closed';
    item.updatedAt = forge.now();
    return { __type: 'Payload', payloadOf: 'CloseIssuePayload', repo, issue: item };
  }
  if (name === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'Repository' ? forge.repoByDatabaseId(Number(decoded.parts[0])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return null;
    }
    const head = String(input.headRefName ?? '').replace(/^[^:]+:/, '');
    const base = String(input.baseRefName ?? repo.defaultBranch);
    if (!forge.branchTip(repo, head) || !forge.branchTip(repo, base)) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch not found' });
      return null;
    }
    const pull = forge.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
    return { __type: 'Payload', payloadOf: 'CreatePullRequestPayload', repo, pull };
  }
  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    const repo = decoded?.kind === 'PullRequest' ? forge.repoByDatabaseId(Number(decoded.parts[0])) : undefined;
    const item = repo?.items.get(Number(decoded?.parts[1]));
    if (!repo || !item || item.kind !== 'pull') {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    const outcome = mergePull(forge, repo, item);
    if (!outcome.ok) {
      ctx.errors.push({ message: 'mergePullRequest: pull request is not mergeable' });
      return null;
    }
    return { __type: 'Payload', payloadOf: 'MergePullRequestPayload', repo, pull: item };
  }
  if (name === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    const repo = decoded ? forge.repoByDatabaseId(Number(decoded.parts[0])) : undefined;
    const item = repo?.items.get(Number(decoded?.parts[1]));
    if (!repo || !item) {
      ctx.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
    const comment = forge.addComment(repo, item, String(input.body ?? ''));
    const node: Source = { __type: 'IssueComment', repo, itemNumber: item.number, comment };
    return { __type: 'Payload', payloadOf: 'AddCommentPayload', repo, commentNode: node };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation and the execution walk

function validateSelection(typeName: string, selection: FieldNode[], ctx: ExecContext): void {
  const fields = TYPE_FIELDS[typeName];
  for (const field of selection) {
    if (field.fragmentName) {
      const fragment = ctx.fragments.get(field.fragmentName);
      if (fragment) validateSelection(fragment.typeCondition, fragment.selection, ctx);
      continue;
    }
    if (field.fragmentType) {
      validateSelection(field.fragmentType, field.selection ?? [], ctx);
      continue;
    }
    if (field.name === '__typename' || field.name === '__type' || field.name === '__schema') {
      if (field.selection) validateSelection('__Type', field.selection, ctx);
      continue;
    }
    if (!fields || !fields.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    const childType = FIELD_TYPES[typeName]?.[field.name];
    if (childType && field.selection) validateSelection(childType, field.selection, ctx);
    else if (field.selection && (typeName === 'Connection' || typeName === 'Payload')) {
      // Connections and payloads resolve through marker types; validate loosely.
      continue;
    }
  }
}

function executeSelection(typeName: string, source: Source, selection: FieldNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.fragmentName) {
      const fragment = ctx.fragments.get(field.fragmentName);
      if (fragment && source && fragmentApplies(source, fragment.typeCondition)) {
        Object.assign(out, executeSelection(fragment.typeCondition, source, fragment.selection, ctx));
      }
      continue;
    }
    if (field.fragmentType) {
      if (source && fragmentApplies(source, field.fragmentType)) {
        Object.assign(out, executeSelection(field.fragmentType, source, field.selection ?? [], ctx));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const value = source === null && typeName !== 'Query' && typeName !== 'Mutation' ? null : resolveField(typeName, source, field, ctx);
    out[key] = completeValue(typeName, field, value, ctx);
  }
  return out;
}

function fragmentApplies(source: Source, typeCondition: string): boolean {
  if (!source) return false;
  if (source.__type === 'Connection') return typeCondition.endsWith('Connection');
  if (source.__type === 'Payload') return typeCondition === source.payloadOf;
  if (source.__type === 'ChangedFile') return typeCondition === 'PullRequestChangedFile';
  if (source.__type === 'CommentEdge') return typeCondition === 'IssueCommentEdge';
  if (source.__type === 'Edge') return true;
  return source.__type === typeCondition || typeCondition === 'Node';
}

function completeValue(parentType: string, field: FieldNode, value: unknown, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (!field.selection) return value;
  const childType = childTypeOf(parentType, field, value);
  if (Array.isArray(value)) {
    return value.map((entry) => (entry !== null && typeof entry === 'object' ? executeSelection(childType, entry as Source, field.selection as FieldNode[], ctx) : entry));
  }
  if (typeof value === 'object') {
    // PageInfo rides inside a marker object; unwrap it to its pseudo-source.
    const record = value as Record<string, unknown>;
    if (record.__pageInfo === true) {
      return executeSelection('PageInfo', value as Source, field.selection, ctx);
    }
    return executeSelection(childType, value as Source, field.selection, ctx);
  }
  return value;
}

function childTypeOf(parentType: string, field: FieldNode, value: unknown): string {
  const mapped = FIELD_TYPES[parentType]?.[field.name];
  if (mapped) return mapped;
  if (value !== null && typeof value === 'object') {
    const source = value as Source;
    if (source?.__type === 'Connection') return 'Connection';
    if (source?.__type === 'Payload') return 'Payload';
    if (source?.__type === 'ChangedFile') return 'ChangedFile';
    if (source?.__type === 'CommentEdge') return 'CommentEdge';
    if (source?.__type === 'Edge') return 'Edge';
    if (source?.__type) return source.__type;
  }
  return parentType;
}

// ---------------------------------------------------------------------------
// Entry point

export interface GraphqlRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export function executeGraphql(forge: Forge, body: GraphqlRequestBody): { data: unknown; errors?: Array<{ message: string }> } {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables !== null && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  let document: DocumentNode;
  try {
    document = parseGraphql(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation in document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  validateSelection(rootType, operation.selection, ctx);
  const data = executeSelection(rootType, null, operation.selection, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
