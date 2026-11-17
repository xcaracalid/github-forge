// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at /mcp. Speaks the modern
// 2026-07-28 revision (server/discover, per-request _meta) and the legacy initialize
// handshake. Tools mirror the REST surface over the same forge store.

import { mergePull, VIEWER, type Forge, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: false, required };
}

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const INTEGER = { type: 'integer' };

/** The tool table: one literal, built once, so tools/list is byte-identical across calls. */
export const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: schema({ name: STRING, description: STRING, private: BOOLEAN }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: schema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: schema({}, []),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'get_issue',
    description: 'Get one issue by its number.',
    inputSchema: schema({ owner: STRING, repo: STRING, issue_number: INTEGER }, ['owner', 'repo', 'issue_number']),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: schema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number (squash).',
    inputSchema: schema({ owner: STRING, repo: STRING, pull_number: INTEGER }, ['owner', 'repo', 'pull_number']),
  },
];

export interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown, headers?: Record<string, string>): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result }, headers };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function repoArg(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = stringArg(args, 'owner');
  const name = stringArg(args, 'repo');
  if (owner === '' || name === '') return null;
  return forge.getRepo(owner, name) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === '') return toolError('create_repo requires a name');
      if (forge.getRepo(VIEWER.login, repoName)) return toolError(`repository ${VIEWER.login}/${repoName} already exists`);
      const repo = forge.createRepo(VIEWER.login, repoName, args.private === true, stringArg(args, 'description'));
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoArg(forge, args);
      if (!repo) return toolError('repository not found');
      return toolOk(repoJson(repo));
    }
    case 'list_repos': {
      return toolOk(forge.reposOf(VIEWER.login).map(repoJson));
    }
    case 'create_issue': {
      const repo = repoArg(forge, args);
      if (!repo) return toolError('repository not found');
      const title = stringArg(args, 'title');
      if (title === '') return toolError('create_issue requires a title');
      const issue = forge.createIssue(repo, title, stringArg(args, 'body'), []);
      return toolOk(issueJson(repo, issue));
    }
    case 'get_issue': {
      const repo = repoArg(forge, args);
      if (!repo) return toolError('repository not found');
      const item = repo.items.get(Number(args.issue_number));
      if (!item || item.kind !== 'issue') return toolError('issue not found');
      return toolOk(issueJson(repo, item));
    }
    case 'list_issues': {
      const repo = repoArg(forge, args);
      if (!repo) return toolError('repository not found');
      const state = stringArg(args, 'state') || 'open';
      const issues = [...repo.items.values()].filter(
        (item) => item.kind === 'issue' && (state === 'all' || item.state === state),
      );
      return toolOk(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoArg(forge, args);
      if (!repo) return toolError('repository not found');
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head').replace(/^[^:]+:/, '');
      const base = stringArg(args, 'base');
      if (title === '' || head === '' || base === '') return toolError('create_pull_request requires title, head and base');
      if (!forge.branchTip(repo, head)) return toolError(`head branch "${head}" does not exist`);
      if (!forge.branchTip(repo, base)) return toolError(`base branch "${base}" does not exist`);
      const pull = forge.createPull(repo, title, stringArg(args, 'body'), head, base);
      return toolOk(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg(forge, args);
      if (!repo) return toolError('repository not found');
      const item = repo.items.get(Number(args.pull_number));
      if (!item || item.kind !== 'pull') return toolError('pull request not found');
      if (item.state !== 'open' || item.merged) return toolError('pull request is not open');
      const outcome = mergePull(forge, repo, item);
      if (!outcome.ok) return toolError('pull request is not mergeable: merge conflict');
      return toolOk(pullJson(forge, repo, item));
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

/** Handle one POST /mcp. `rawBody` is the exact request text (for the parse-error path). */
export function handleMcp(forge: Forge, rawBody: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not valid JSON' } },
    };
  }
  if (Array.isArray(parsed)) {
    // JSON-RPC batching: answer each request in order.
    const answers = parsed.map((entry) => handleOne(forge, entry as JsonRpcRequest).body);
    return { status: 200, body: answers };
  }
  return handleOne(forge, parsed as JsonRpcRequest);
}

function handleOne(forge: Forge, request: JsonRpcRequest): McpResult {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[1];
      return rpcResult(
        id,
        { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        { 'mcp-session-id': 'makefun-forge-session' },
      );
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      if (!TOOLS.some((tool) => tool.name === name)) {
        return rpcError(id, -32602, `unknown tool: ${name}`);
      }
      return rpcResult(id, callTool(forge, name, args));
    }
    default:
      if (isNotification || method.startsWith('notifications/')) {
        return { status: 202, body: null };
      }
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
