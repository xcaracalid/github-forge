// The REST v3 surface: root, meta, user, repositories, branches, commits, git refs,
// contents, labels, issues, comments and pull requests — all over the forge store.

import { identEpoch } from './git.ts';
import {
  VIEWER,
  mergePull,
  pullChanges,
  pullMergeable,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown, status = 200): RestResult => ({ status, body });
const fail = (status: number, message: string): RestResult => ({ status, body: { message } });
export const notFound = (): RestResult => fail(404, 'Not Found');

export function encodeRepoId(databaseId: number): string {
  return Buffer.from(`Repository:${databaseId}`, 'utf8').toString('base64');
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: encodeRepoId(repo.databaseId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date(repo.createdAt * 1000).toISOString(),
    updated_at: new Date(repo.updatedAt * 1000).toISOString(),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalId,
    node_id: Buffer.from(`Issue:${repo.databaseId}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: new Date(issue.createdAt * 1000).toISOString(),
    updated_at: new Date(issue.updatedAt * 1000).toISOString(),
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.head) ?? null;
  const baseSha = forge.branchTip(repo, pull.base) ?? null;
  return {
    id: pull.globalId,
    node_id: Buffer.from(`PullRequest:${repo.databaseId}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headSha },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : new Date(pull.mergedAt * 1000).toISOString(),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(forge, repo, pull) === 'MERGEABLE' : null,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: new Date(pull.createdAt * 1000).toISOString(),
    updated_at: new Date(pull.updatedAt * 1000).toISOString(),
  };
}

export function commentJson(repo: Repo, item: Issue | Pull, comment: { id: number; body: string; author: string; createdAt: number }): Record<string, unknown> {
  void item;
  void repo;
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.author, id: VIEWER.id, type: 'User' },
    created_at: new Date(comment.createdAt * 1000).toISOString(),
    updated_at: new Date(comment.createdAt * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1,
  };
}

function paginate<T>(items: T[], page: Page, makeUrl: (page: number) => string): RestResult {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const headers: Record<string, string> = {};
  if (page.page < totalPages) {
    const links = [`<${makeUrl(page.page + 1)}>; rel="next"`, `<${makeUrl(totalPages)}>; rel="last"`];
    if (page.page > 1) links.push(`<${makeUrl(page.page - 1)}>; rel="prev"`, `<${makeUrl(1)}>; rel="first"`);
    headers.link = links.join(', ');
  }
  return { status: 200, body: slice, headers };
}

// ---------------------------------------------------------------------------
// The router

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  /** Absolute URL builder for pagination links. */
  urlFor: (pathAndQuery: string) => string;
}

export function handleRest(forge: Forge, request: RestRequest): RestResult {
  const { method, segments, query, body } = request;
  const [head, second, third] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (head === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: 'makefun-forge-1.0', github_deployment_id: 'forge' });
  }
  if (head === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({ login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }
  if (head === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const page = pageOf(query);
      const repos = forge.reposOf(VIEWER.login).map(repoJson);
      return paginate(repos, page, (p) => request.urlFor(`/api/v3/user/repos?per_page=${page.perPage}&page=${p}`));
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') return fail(422, 'Validation Failed: name is required');
      if (forge.getRepo(VIEWER.login, name)) return fail(422, 'Validation Failed: name already exists on this account');
      const repo = forge.createRepo(VIEWER.login, name, body?.private === true, typeof body?.description === 'string' ? body.description : '');
      return ok(repoJson(repo), 201);
    }
    return notFound();
  }
  if (head === 'repos' && second !== undefined && third !== undefined) {
    const repo = forge.getRepo(second, third);
    if (!repo) return notFound();
    return handleRepo(forge, repo, request, segments.slice(3));
  }
  return notFound();
}

function handleRepo(forge: Forge, repo: Repo, request: RestRequest, rest: string[]): RestResult {
  const { method, query, body } = request;
  const [head, second] = rest;

  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body?.name === 'string' && body.name !== '' && body.name !== repo.name) {
        // Rename: re-key the repository.
        forge.repos.delete(forge.repoKey(repo.owner, repo.name));
        repo.name = body.name;
        forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
      }
      repo.updatedAt = forge.now();
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    return notFound();
  }

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return ok(branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = forge.branchTip(repo, name);
      if (!sha) return notFound();
      return ok({ name, commit: { sha }, protected: false });
    }
    return notFound();
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    let start: string | undefined;
    if (shaParam) start = forge.branchTip(repo, shaParam) ?? (forge.getObject(shaParam)?.type === 'commit' ? shaParam : undefined);
    else start = forge.branchTip(repo, repo.defaultBranch);
    if (!start) return ok([]);
    const page = pageOf(query);
    const commits = forge.reachableCommits(start).map((oid) => {
      const commit = forge.commitOf(oid) as NonNullable<ReturnType<Forge['commitOf']>>;
      return {
        sha: oid,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          tree: { sha: commit.tree },
          author: { name: commit.author.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(commit.author)?.[1] ?? '', date: new Date(identEpoch(commit.author) * 1000).toISOString() },
          committer: { name: commit.committer.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(commit.committer)?.[1] ?? '', date: new Date(identEpoch(commit.committer) * 1000).toISOString() },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return paginate(commits, page, (p) => request.urlFor(`/api/v3/repos/${repo.owner}/${repo.name}/commits?per_page=${page.perPage}&page=${p}`));
  }

  if (head === 'git' && second === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        return ok([...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { type: forge.getObject(sha)?.type ?? 'commit', sha } })));
      }
      if (method === 'POST') {
        const ref = typeof body?.ref === 'string' ? body.ref : '';
        const sha = typeof body?.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || sha === '') return fail(422, 'Validation Failed: ref and sha are required');
        if (!forge.getObject(sha)) return fail(422, 'Validation Failed: sha does not name an object');
        if (repo.refs.has(ref)) return fail(422, 'Validation Failed: Reference already exists');
        repo.refs.set(ref, sha);
        return ok({ ref, object: { type: forge.getObject(sha)?.type ?? 'commit', sha } }, 201);
      }
      return notFound();
    }
    if (method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return ok({ ref, object: { type: forge.getObject(sha)?.type ?? 'commit', sha } });
    }
    return notFound();
  }

  if (head === 'contents') return handleContents(forge, repo, request, rest.slice(1).join('/'));
  if (head === 'labels') return handleLabels(forge, repo, request, rest);
  if (head === 'issues') return handleIssues(forge, repo, request, rest);
  if (head === 'pulls') return handlePulls(forge, repo, request, rest);
  void second;
  return notFound();
}

// ---------------------------------------------------------------------------
// Contents

function resolveCommit(forge: Forge, repo: Repo, ref: string | null): string | undefined {
  if (ref) {
    return forge.branchTip(repo, ref) ?? (forge.peelToCommit(ref) ?? undefined);
  }
  return forge.branchTip(repo, repo.defaultBranch);
}

function handleContents(forge: Forge, repo: Repo, request: RestRequest, path: string): RestResult {
  const { method, query, body } = request;
  const refParam = query.get('ref');

  if (method === 'GET') {
    const commitOid = resolveCommit(forge, repo, refParam);
    if (!commitOid) return notFound();
    const commit = forge.peelToCommit(commitOid);
    if (!commit) return notFound();
    const files = forge.filesAt(commit);
    if (path === '') {
      return ok(dirListing(forge, repo, files, ''));
    }
    const file = files.get(path);
    if (file) {
      const object = forge.getObject(file.oid);
      const data = object?.data ?? Buffer.alloc(0);
      return ok({
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: file.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
    }
    const prefix = `${path}/`;
    if ([...files.keys()].some((candidate) => candidate.startsWith(prefix))) {
      return ok(dirListing(forge, repo, files, path));
    }
    return notFound();
  }

  if (method === 'PUT' || method === 'DELETE') {
    if (path === '') return fail(422, 'Validation Failed: path is required');
    const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body?.message === 'string' && body.message !== '' ? body.message : `${method === 'PUT' ? 'Update' : 'Delete'} ${path}`;
    let tip = forge.branchTip(repo, branch);
    if (!tip && branch !== repo.defaultBranch) {
      // A contents write names the branch it creates: fork it from the default branch.
      tip = forge.branchTip(repo, repo.defaultBranch);
    }
    const tipCommit = tip ? forge.peelToCommit(tip) : null;
    const files = forge.filesAt(tipCommit ?? undefined);
    const existing = files.get(path);
    const givenSha = typeof body?.sha === 'string' ? body.sha : undefined;

    if (method === 'PUT') {
      const content = typeof body?.content === 'string' ? body.content : '';
      if (existing) {
        if (givenSha === undefined) return fail(422, 'Validation Failed: sha is required when updating a file');
        if (givenSha !== existing.oid) return fail(409, 'Conflict: the file has changed since the given sha');
      } else if (givenSha !== undefined) {
        return fail(422, 'Validation Failed: sha must be omitted when creating a file');
      }
      const blobData = Buffer.from(content, 'base64');
      const blobOid = forge.putObject('blob', blobData);
      files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
      const tree = forge.buildTreeFromFiles(files);
      const commit = forge.makeCommit(tree, tipCommit, message);
      repo.refs.set(`refs/heads/${branch}`, commit);
      return ok(
        {
          content: {
            name: path.split('/').pop(),
            path,
            sha: blobOid,
            size: blobData.length,
            type: 'file',
            encoding: 'base64',
            content: blobData.toString('base64'),
          },
          commit: { sha: commit },
        },
        existing ? 200 : 201,
      );
    }
    // DELETE
    if (!existing) return notFound();
    if (givenSha !== undefined && givenSha !== existing.oid) return fail(409, 'Conflict: the file has changed since the given sha');
    files.delete(path);
    const tree = forge.buildTreeFromFiles(files);
    const commit = forge.makeCommit(tree, tipCommit, message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return ok({ content: null, commit: { sha: commit } });
  }
  return notFound();
}

function dirListing(forge: Forge, repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string): unknown[] {
  void repo;
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      entries.set(rest, { type: 'file', name: rest, path, sha: file.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) {
        entries.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: subtreeOid(forge, files, `${prefix}${name}`) });
      }
    }
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

function subtreeOid(forge: Forge, files: Map<string, { oid: string; mode: string }>, dir: string): string {
  const prefix = `${dir}/`;
  const sub = new Map<string, { oid: string; mode: string }>();
  for (const [path, file] of files) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), file);
  }
  return forge.buildTreeFromFiles(sub);
}

// ---------------------------------------------------------------------------
// Labels

function handleLabels(forge: Forge, repo: Repo, request: RestRequest, rest: string[]): RestResult {
  void forge;
  const { method, body } = request;
  if (rest.length === 1) {
    if (method === 'GET') return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') return fail(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: Label already exists');
      const color = typeof body?.color === 'string' ? body.color.replace(/^#/, '') : '000000';
      repo.labels.set(name, { name, color });
      return ok({ name, color }, 201);
    }
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Issues and comments

function handleIssues(forge: Forge, repo: Repo, request: RestRequest, rest: string[]): RestResult {
  const { method, query, body } = request;
  if (rest.length === 1) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.items.values()].filter((item): item is Issue => item.kind === 'issue');
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const key = sort === 'updated' ? 'updatedAt' : 'createdAt';
      issues.sort((a, b) => (a[key] - b[key]) * (direction === 'asc' ? 1 : -1) || (a.number - b.number) * (direction === 'asc' ? 1 : -1));
      const page = pageOf(query);
      return paginate(issues.map((issue) => issueJson(repo, issue)), page, (p) =>
        request.urlFor(`/api/v3/repos/${repo.owner}/${repo.name}/issues?per_page=${page.perPage}&page=${p}`),
      );
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      if (title === '') return fail(422, 'Validation Failed: title is required');
      const labelNames = Array.isArray(body?.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
      }
      const issue = forge.createIssue(repo, title, typeof body?.body === 'string' ? body.body : '', labelNames);
      return ok(issueJson(repo, issue), 201);
    }
    return notFound();
  }
  const number = Number(rest[1]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (!item || item.kind !== 'issue') return notFound();
  if (rest.length === 2) {
    if (method === 'GET') return ok(issueJson(repo, item));
    if (method === 'PATCH') {
      if (typeof body?.title === 'string') item.title = body.title;
      if (typeof body?.body === 'string') item.body = body.body;
      if (body?.state === 'open' || body?.state === 'closed') item.state = body.state;
      if (Array.isArray(body?.labels)) {
        const names = body.labels.filter((x): x is string => typeof x === 'string');
        for (const name of names) if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
        item.labels = names;
      }
      item.updatedAt = forge.now();
      return ok(issueJson(repo, item));
    }
    return notFound();
  }
  if (rest.length === 3 && rest[2] === 'comments') {
    if (method === 'GET') {
      const page = pageOf(query);
      return paginate(item.comments.map((comment) => commentJson(repo, item, comment)), page, (p) =>
        request.urlFor(`/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}/comments?per_page=${page.perPage}&page=${p}`),
      );
    }
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? body.body : '';
      if (text === '') return fail(422, 'Validation Failed: body is required');
      const comment = forge.addComment(repo, item, text);
      return ok(commentJson(repo, item, comment), 201);
    }
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Pull requests

function handlePulls(forge: Forge, repo: Repo, request: RestRequest, rest: string[]): RestResult {
  const { method, query, body } = request;
  if (rest.length === 1) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.items.values()].filter((item): item is Pull => item.kind === 'pull');
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => (pull.merged ? 'closed' : pull.state) === state);
      pulls.sort((a, b) => b.createdAt - a.createdAt || b.number - a.number);
      const page = pageOf(query);
      return paginate(pulls.map((pull) => pullJson(forge, repo, pull)), page, (p) =>
        request.urlFor(`/api/v3/repos/${repo.owner}/${repo.name}/pulls?per_page=${page.perPage}&page=${p}`),
      );
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      const head = typeof body?.head === 'string' ? body.head.replace(/^[^:]+:/, '') : '';
      const base = typeof body?.base === 'string' ? body.base : '';
      if (title === '' || head === '' || base === '') return fail(422, 'Validation Failed: title, head and base are required');
      if (!forge.branchTip(repo, head)) return fail(422, `Validation Failed: head branch "${head}" does not exist`);
      if (!forge.branchTip(repo, base)) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
      const duplicate = [...repo.items.values()].some(
        (item) => item.kind === 'pull' && item.state === 'open' && !item.merged && item.head === head && item.base === base,
      );
      if (duplicate) return fail(422, `Validation Failed: A pull request already exists for ${head} into ${base}`);
      const pull = forge.createPull(repo, title, typeof body?.body === 'string' ? body.body : '', head, base);
      return ok(pullJson(forge, repo, pull), 201);
    }
    return notFound();
  }
  const number = Number(rest[1]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (!item || item.kind !== 'pull') return notFound();
  if (rest.length === 2) {
    if (method === 'GET') return ok(pullJson(forge, repo, item));
    if (method === 'PATCH') {
      if (typeof body?.title === 'string') item.title = body.title;
      if (typeof body?.body === 'string') item.body = body.body;
      if (body?.state === 'open' || body?.state === 'closed') item.state = body.state;
      item.updatedAt = forge.now();
      return ok(pullJson(forge, repo, item));
    }
    return notFound();
  }
  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    const page = pageOf(query);
    return paginate(pullChanges(forge, repo, item), page, (p) =>
      request.urlFor(`/api/v3/repos/${repo.owner}/${repo.name}/pulls/${item.number}/files?per_page=${page.perPage}&page=${p}`),
    );
  }
  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    if (item.state !== 'open' || item.merged) return fail(405, 'Pull Request is not mergeable: it is not open');
    const outcome = mergePull(forge, repo, item);
    if (!outcome.ok) return fail(405, 'Pull Request is not mergeable: merge conflict');
    return ok({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return notFound();
}
