// Git smart HTTP: info/refs advertisements, protocol v2 ls-refs and fetch, protocol v0
// fetch, and receive-pack with per-ref report-status. Works entirely over the forge's
// in-memory object store; pushed packs are parsed and stored before refs move.

import {
  PKT_FLUSH,
  ZERO_OID,
  hashObject,
  isTreeMode,
  parseTree,
  pktLine,
  readPack,
  readPktStream,
  writePack,
  type GitObject,
  type PackObjectInput,
} from './git.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'makefun-forge/1.0';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Advertisements

export function advertise(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): GitHttpResult {
  const refs = sortedRefs(repo);
  const headTarget = forge.headRef(repo);
  const headOid = repo.refs.get(headTarget);
  if (service === 'git-upload-pack' && protocolV2) {
    const lines = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow wait-for-done',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const capabilities =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not symref=HEAD:${headTarget} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refLines: string[] = [];
  if (headOid) refLines.push(`${headOid} HEAD`);
  for (const ref of refs) {
    refLines.push(`${ref.oid} ${ref.name}`);
    const peeled = forge.peelTag(ref.oid);
    if (peeled) refLines.push(`${peeled} ${ref.name}^{}`);
  }
  if (refLines.length === 0) refLines.push(`${ZERO_OID} capabilities^{}`);
  refLines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${capabilities}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(forge: Forge, repo: Repo, args: LsRefsArgs): Buffer {
  const headTarget = forge.headRef(repo);
  const headOid = repo.refs.get(headTarget);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = forge.peelTag(ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// Fetch planning

interface FetchPlan {
  /** Objects to pack, keyed by oid. */
  objects: Map<string, GitObject>;
  /** Commits the client named as haves that the forge holds. */
  commonHaves: string[];
  /** Shallow boundary lines to report (only when shallow state is in play). */
  shallowInfo: string[];
  shallowInPlay: boolean;
}

/**
 * Compute what a fetch must deliver: the closure of the wants minus what the haves prove
 * the client already holds, honoring a depth cut and the client's shallow boundary.
 */
function planFetch(forge: Forge, wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const shallowInPlay = depth !== null || clientShallow.length > 0;

  // Commits the client provably holds: the closure of its haves, treating its shallow
  // boundary commits as parentless.
  const hadCommits = new Set<string>();
  const hadQueue: string[] = [];
  for (const have of haves) {
    const commit = forge.peelToCommit(have);
    if (commit) hadQueue.push(commit);
  }
  while (hadQueue.length > 0) {
    const oid = hadQueue.shift() as string;
    if (hadCommits.has(oid)) continue;
    hadCommits.add(oid);
    if (shallowSet.has(oid)) continue;
    const commit = forge.commitOf(oid);
    if (commit) hadQueue.push(...commit.parents);
  }
  const commonHaves = haves.filter((have) => forge.getObject(have) !== undefined);

  // Objects reachable from the held commits (their trees and blobs) are held too.
  const hadObjects = new Set<string>();
  const collectTree = (treeOid: string): void => {
    if (hadObjects.has(treeOid)) return;
    const object = forge.getObject(treeOid);
    if (!object || object.type !== 'tree') return;
    hadObjects.add(treeOid);
    for (const entry of treeEntries(forge, treeOid)) {
      if (entry.isTree) collectTree(entry.oid);
      else hadObjects.add(entry.oid);
    }
  };
  for (const oid of hadCommits) {
    hadObjects.add(oid);
    const commit = forge.commitOf(oid);
    if (commit) collectTree(commit.tree);
  }

  // Walk the wants, cutting at the depth limit and at held history.
  const sendCommits = new Set<string>();
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [];
  const extraObjects = new Map<string, GitObject>();
  const enqueue = (oid: string, generation: number): void => {
    const object = forge.getObject(oid);
    if (!object) return;
    if (object.type === 'tag') {
      if (!hadObjects.has(oid) && !extraObjects.has(oid)) extraObjects.set(oid, object);
      const target = forge.peelTag(oid);
      if (target) enqueue(target, generation);
      return;
    }
    if (object.type !== 'commit') {
      if (!hadObjects.has(oid)) extraObjects.set(oid, object);
      return;
    }
    if (generations.has(oid) && (generations.get(oid) as number) <= generation) return;
    generations.set(oid, generation);
    queue.push({ oid, generation });
  };
  for (const want of wants) enqueue(want, 1);
  while (queue.length > 0) {
    const { oid, generation } = queue.shift() as { oid: string; generation: number };
    if ((generations.get(oid) as number) < generation) continue;
    const held = hadCommits.has(oid);
    if (held && !shallowSet.has(oid)) continue; // the client holds this and everything below it
    if (depth !== null && generation > depth) continue;
    if (!held) sendCommits.add(oid);
    if (depth !== null && generation >= depth) continue; // boundary: parents stay behind
    const commit = forge.commitOf(oid);
    if (commit) for (const parent of commit.parents) enqueue(parent, generation + 1);
  }

  const objects = new Map<string, GitObject>();
  for (const [oid, object] of extraObjects) objects.set(oid, object);
  for (const oid of sendCommits) {
    const object = forge.getObject(oid);
    if (object) objects.set(oid, object);
  }
  const addTree = (treeOid: string): void => {
    if (objects.has(treeOid) || hadObjects.has(treeOid)) return;
    const object = forge.getObject(treeOid);
    if (!object || object.type !== 'tree') return;
    objects.set(treeOid, object);
    for (const entry of treeEntries(forge, treeOid)) {
      if (entry.isTree) addTree(entry.oid);
      else if (!objects.has(entry.oid) && !hadObjects.has(entry.oid)) {
        const blob = forge.getObject(entry.oid);
        if (blob) objects.set(entry.oid, blob);
      }
    }
  };
  for (const oid of sendCommits) {
    const commit = forge.commitOf(oid);
    if (commit) addTree(commit.tree);
  }

  // The shallow bookkeeping the client expects back.
  const shallowInfo: string[] = [];
  if (shallowInPlay) {
    const heldOrSent = new Set<string>([...hadCommits, ...sendCommits]);
    const boundary = new Set<string>();
    for (const oid of sendCommits) {
      const commit = forge.commitOf(oid);
      if (!commit) continue;
      if (commit.parents.some((parent) => !heldOrSent.has(parent) && forge.getObject(parent))) boundary.add(oid);
    }
    for (const oid of boundary) shallowInfo.push(`shallow ${oid}`);
    for (const oid of shallowSet) {
      const commit = forge.commitOf(oid);
      if (!commit) continue;
      if (commit.parents.every((parent) => heldOrSent.has(parent))) shallowInfo.push(`unshallow ${oid}`);
    }
  }
  return { objects, commonHaves, shallowInfo, shallowInPlay };
}

function treeEntries(forge: Forge, treeOid: string): Array<{ oid: string; isTree: boolean }> {
  const object = forge.getObject(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => ({ oid: entry.oid, isTree: isTreeMode(entry.mode) }));
}

function packBytesOf(plan: FetchPlan): Buffer {
  const inputs: PackObjectInput[] = [...plan.objects.values()].map((object) => ({ type: object.type, data: object.data }));
  return writePack(inputs);
}

/** Sideband-1 packets carrying a pack inside a fetch section. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxPayload = 65516 - 1;
  for (let offset = 0; offset < pack.length; offset += maxPayload) {
    const chunk = pack.subarray(offset, offset + maxPayload);
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.concat([Buffer.from([1])])));
  return chunks;
}

// ---------------------------------------------------------------------------
// Protocol v2 commands

export function handleV2(forge: Forge, repo: Repo, body: Buffer): GitHttpResult {
  const first = readPktStream(body, 0);
  const lines = first.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
  const command = lines.find((line) => line.startsWith('command='));
  if (!command) return { status: 400, contentType: 'text/plain', body: Buffer.from('error: no command\n') };

  if (command === 'command=ls-refs') {
    // Arguments follow the delimiter packet; readPktStream stops at flush only, so parse the
    // argument block manually: it begins right after the first stream's delimiter.
    const args = readArguments(body, first);
    const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of args) {
      if (arg === 'peel') parsed.peel = true;
      else if (arg === 'symrefs') parsed.symrefs = true;
      else if (arg === 'unborn') parsed.unborn = true;
      else if (arg.startsWith('ref-prefix ')) parsed.prefixes.push(arg.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(forge, repo, parsed) };
  }

  if (command === 'command=fetch') {
    const args = readArguments(body, first);
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | null = null;
    let done = false;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim()) || depth;
      else if (arg === 'done') done = true;
    }
    const plan = planFetch(forge, wants, haves, clientShallow, depth);
    const parts: Buffer[] = [];
    const ackLines: string[] = [];
    if (plan.commonHaves.length === 0) ackLines.push('NAK');
    else for (const have of plan.commonHaves) ackLines.push(`ACK ${have}`);
    if (done && plan.objects.size > 0) ackLines.push('ready');
    parts.push(pktLine('acknowledgments\n'));
    for (const line of ackLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_FLUSH);
    if (plan.shallowInPlay && plan.shallowInfo.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const line of plan.shallowInfo) parts.push(pktLine(`${line}\n`));
      parts.push(PKT_FLUSH);
    }
    if (plan.objects.size > 0) {
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPackets(packBytesOf(plan)));
      parts.push(PKT_FLUSH);
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }

  return { status: 400, contentType: 'text/plain', body: Buffer.from('error: unknown command\n') };
}

/** The argument block of a v2 request: the pkt-lines between the delimiter and the flush. */
function readArguments(body: Buffer, first: ReturnType<typeof readPktStream>): string[] {
  // readPktStream treats delim (0001) as a skip, so the first stream already contains the
  // capability lines AND the argument lines when no flush separates them. The capability
  // section ends at the delimiter; since readPktStream skipped it silently, re-walk manually.
  const args: string[] = [];
  let offset = 0;
  let pastDelim = false;
  while (offset + 4 <= body.length) {
    const hex = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) break;
    if (length === 1) {
      pastDelim = true;
      offset += 4;
      continue;
    }
    if (length === 2) break;
    if (length < 4 || offset + length > body.length) break;
    const payload = body.toString('utf8', offset + 4, offset + length).replace(/\n$/, '');
    if (pastDelim) args.push(payload);
    offset += length;
  }
  void first;
  return args;
}

// ---------------------------------------------------------------------------
// Protocol v0 fetch

export function handleUploadPackV0(forge: Forge, repo: Repo, body: Buffer): GitHttpResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let offset = 0;
  let inHaves = false;
  while (offset + 4 <= body.length) {
    const hex = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      if (!inHaves) {
        inHaves = true;
        offset += 4;
        continue;
      }
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    let line = body.toString('utf8', offset + 4, offset + length).replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || depth;
    offset += length;
  }
  const plan = planFetch(forge, wants, haves, clientShallow, depth);
  const parts: Buffer[] = [];
  for (const line of plan.shallowInfo) parts.push(pktLine(`${line}\n`));
  if (plan.commonHaves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of plan.commonHaves) parts.push(pktLine(`ACK ${have} common\n`));
    parts.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  }
  if (plan.objects.size > 0) parts.push(...sidebandPackets(packBytesOf(plan)));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// Receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): GitHttpResult {
  const stream = readPktStream(body, 0);
  if (!stream.flushed && stream.lines.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('error: malformed push\n') };
  }
  const commands: PushCommand[] = [];
  for (const raw of stream.lines) {
    let line = raw.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = body.subarray(stream.rest);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, (oid) => forge.getObject(oid));
      for (const object of parsed.objects) {
        forge.objects.set(hashObject(object.type, object.data), object);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const report: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackError}`];
  for (const command of commands) {
    const failure = unpackOk ? validateAndApply(forge, repo, command) : 'unpack failed';
    report.push(failure === null ? `ok ${command.ref}` : `ng ${command.ref} ${failure}`);
  }
  const inner = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  // The report travels as band-1 sideband packets, then the stream's own flush.
  const outer: Buffer[] = [];
  const maxPayload = 65516 - 1;
  for (let offset = 0; offset < inner.length; offset += maxPayload) {
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + maxPayload)])));
  }
  outer.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(outer) };
}

/** Validate one ref update against the store and apply it; returns the refusal reason or null. */
function validateAndApply(forge: Forge, repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) return 'stale info';
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return null;
  }
  const target = forge.getObject(command.newOid);
  if (!target) return 'missing object';
  if (command.oldOid !== ZERO_OID) {
    const newCommit = forge.peelToCommit(command.newOid);
    const oldCommit = forge.peelToCommit(command.oldOid);
    if (newCommit && oldCommit && !forge.isAncestor(oldCommit, newCommit)) return 'non-fast-forward';
    if (newCommit && !oldCommit) return 'non-fast-forward';
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}
