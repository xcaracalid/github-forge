// The forge's state and domain operations: repositories, git refs over a shared object
// store, issues and pull requests (one number space, as on GitHub), labels and comments,
// plus the tree/commit surgery the contents API and pull-request merges need.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  ident,
  isTreeMode,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: number;
}

export interface Issue {
  kind: 'issue';
  globalId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
}

export interface Pull {
  kind: 'pull';
  globalId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
}

export type Item = Issue | Pull;

export interface Repo {
  owner: string;
  name: string;
  databaseId: number;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  items: Map<number, Item>;
  nextNumber: number;
  nextCommentId: number;
  createdAt: number;
  updatedAt: number;
}

export class Forge {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private repoDatabaseSeq = 0;
  private itemGlobalSeq = 0;
  private clockSec: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = trialNow ? Date.parse(trialNow) : Number.NaN;
    this.clockSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
  }

  /** A strictly increasing forge clock, in epoch seconds. */
  now(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  isoNow(): string {
    return new Date(this.now() * 1000).toISOString();
  }

  // ------------------------------------------------------------- objects

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  commitOf(oid: string) {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** The commit a ref value ultimately names, peeling annotated tags. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Peel an annotated tag one level: the object it points at, or null. */
  peelTag(oid: string): string | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tag') return null;
    return parseTag(object.data).object;
  }

  // ------------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const stamp = this.now();
    const repo: Repo = {
      owner,
      name,
      databaseId: (this.repoDatabaseSeq += 1),
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  repoByDatabaseId(databaseId: number): Repo | undefined {
    return [...this.repos.values()].find((repo) => repo.databaseId === databaseId);
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  // ------------------------------------------------------------- trees

  /** Flatten a tree (recursively) into path -> {oid, mode}. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isTreeMode(entry.mode)) this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Build (and store) nested trees from a flat path -> blob map; returns the root tree oid. */
  buildTreeFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    interface Dir {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.dirs.get(part);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          dir.dirs.set(part, next);
        }
        dir = next;
      }
      dir.files.set(parts[parts.length - 1] ?? path, file);
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  treeOfCommit(commitOid: string): string | null {
    const commit = this.commitOf(commitOid);
    return commit ? commit.tree : null;
  }

  /** The flat file map at a commit (empty map for an unborn/invalid commit). */
  filesAt(commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
    if (!commitOid) return new Map();
    const commit = this.peelToCommit(commitOid);
    if (!commit) return new Map();
    const tree = this.treeOfCommit(commit);
    if (!tree) return new Map();
    return this.flattenTree(tree);
  }

  blobText(oid: string): string {
    const object = this.objects.get(oid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : '';
  }

  // ------------------------------------------------------------- history

  /** Every commit reachable from `start` (inclusive), newest first. */
  reachableCommits(start: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue: string[] = [start];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      const commit = this.commitOf(oid);
      if (!commit) continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of commit.parents) queue.push(parent);
    }
    return order;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(oid);
      if (commit) queue.push(...commit.parents);
    }
    return false;
  }

  /** The best common ancestor of two commits, or null. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = new Set(this.reachableCommits(a));
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const commit = this.commitOf(oid);
      if (commit) queue.push(...commit.parents);
    }
    return null;
  }

  /** Make a commit on top of `parent` (or a root commit) with the given tree, as the viewer. */
  makeCommit(tree: string, parent: string | null, message: string): string {
    const stamp = this.now();
    const identity = ident(VIEWER.name, VIEWER.email, stamp);
    const data = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      author: identity,
      committer: identity,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return this.putObject('commit', data);
  }

  // ------------------------------------------------------------- items

  nextGlobalId(): number {
    this.itemGlobalSeq += 1;
    return this.itemGlobalSeq;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const stamp = this.now();
    const issue: Issue = {
      kind: 'issue',
      globalId: this.nextGlobalId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.nextNumber += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const stamp = this.now();
    const pull: Pull = {
      kind: 'pull',
      globalId: this.nextGlobalId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.nextNumber += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  addComment(repo: Repo, item: Item, body: string): Comment {
    const comment: Comment = { id: repo.nextCommentId, body, author: VIEWER.login, createdAt: this.now() };
    repo.nextCommentId += 1;
    item.comments.push(comment);
    return comment;
  }
}

// ---------------------------------------------------------------------------
// Pull request diffing and merging (shared by REST, GraphQL and MCP).

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-level diff counts between two texts (LCS over lines; inputs here are small). */
export function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Drop the shared trailing empty line artifact of a final newline.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const common = dp[0]![0] ?? 0;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The files a pull request changes: merge-base tree versus head tree. */
export function pullChanges(forge: Forge, repo: Repo, pull: Pull): FileChange[] {
  const headTip = forge.branchTip(repo, pull.head);
  const baseTip = forge.branchTip(repo, pull.base);
  if (!headTip || !baseTip) return [];
  const headCommit = forge.peelToCommit(headTip);
  const baseCommit = forge.peelToCommit(baseTip);
  if (!headCommit || !baseCommit) return [];
  const base = forge.mergeBase(headCommit, baseCommit) ?? baseCommit;
  const fromFiles = forge.filesAt(base);
  const toFiles = forge.filesAt(headCommit);
  const changes: FileChange[] = [];
  const paths = new Set([...fromFiles.keys(), ...toFiles.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFiles.get(path);
    const to = toFiles.get(path);
    if (from && to && from.oid === to.oid) continue;
    const counts = lineDiffCounts(from ? forge.blobText(from.oid) : '', to ? forge.blobText(to.oid) : '');
    changes.push({
      filename: path,
      status: !from ? 'added' : !to ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}

/**
 * Three-way tree merge for a pull request. Returns the merged flat file map, or null on a
 * conflict: a path both sides changed away from the merge base in different ways.
 */
export function mergedFiles(
  forge: Forge,
  repo: Repo,
  pull: Pull,
): Map<string, { oid: string; mode: string }> | null {
  const headTip = forge.branchTip(repo, pull.head);
  const baseTip = forge.branchTip(repo, pull.base);
  if (!headTip || !baseTip) return null;
  const headCommit = forge.peelToCommit(headTip);
  const baseCommit = forge.peelToCommit(baseTip);
  if (!headCommit || !baseCommit) return null;
  const base = forge.mergeBase(headCommit, baseCommit);
  if (!base) return null;
  const baseFiles = forge.filesAt(base);
  const ourFiles = forge.filesAt(baseCommit);
  const theirFiles = forge.filesAt(headCommit);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    const ours = ourFiles.get(path);
    const theirs = theirFiles.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (same(ours, theirs)) {
      if (ours) merged.set(path, ours);
    } else if (same(atBase, ours)) {
      if (theirs) merged.set(path, theirs);
    } else if (same(atBase, theirs)) {
      if (ours) merged.set(path, ours);
    } else {
      return null;
    }
  }
  return merged;
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'missing' };

/** Squash-merge a pull request onto its base branch (also used for merge/rebase requests). */
export function mergePull(forge: Forge, repo: Repo, pull: Pull): MergeOutcome {
  const files = mergedFiles(forge, repo, pull);
  if (!files) return { ok: false, reason: 'conflict' };
  const baseTip = forge.branchTip(repo, pull.base);
  if (!baseTip) return { ok: false, reason: 'missing' };
  const baseCommit = forge.peelToCommit(baseTip);
  if (!baseCommit) return { ok: false, reason: 'missing' };
  const tree = forge.buildTreeFromFiles(files);
  const sha = forge.makeCommit(tree, baseCommit, `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.now();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now. */
export function pullMergeable(forge: Forge, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  return mergedFiles(forge, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
}

export { ZERO_OID };
