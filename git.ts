// Git object model for the forge: SHA-1 addressed objects, commit/tree/tag parsing and
// building, pkt-line framing, and packfile read/write. Pure Node standard library.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const OBJECT_TYPE_IDS: Readonly<Record<GitObjectType, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const TYPE_BY_ID: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id git assigns to a payload: sha1 of "<type> <length>\0" + payload. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------
// Commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** "Name <email> 1700000000 +0000" from parts. */
export function ident(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

/** The epoch seconds an ident line carries, or 0 when unparseable. */
export function identEpoch(line: string): number {
  const match = / (\d{9,}) [+-]\d{4}$/.exec(line.trim());
  return match ? Number(match[1]) : 0;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const out: TagInfo = { object: '', type: '', tag: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Git orders tree entries by name, with directories compared as if they ended in '/'.
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

// ---------------------------------------------------------------------------
// Pkt-lines

/** One pkt-line frame for a payload (payload must fit in 65520 bytes total frame). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktStream {
  /** Payloads of the data frames, in order (flush/delim/response-end are not included). */
  lines: Buffer[];
  /** Index just past the terminating flush (or the end of the buffer when none came). */
  rest: number;
  /** True when a flush packet terminated the stream. */
  flushed: boolean;
}

/** Parse pkt-lines from the front of a buffer until the flush packet. */
export function readPktStream(buffer: Buffer, start = 0): PktStream {
  const lines: Buffer[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) return { lines, rest: offset + 4, flushed: true };
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    lines.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, rest: offset, flushed: false };
}

// ---------------------------------------------------------------------------
// Packfiles

export interface PackObjectInput {
  type: GitObjectType;
  data: Buffer;
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeId = OBJECT_TYPE_IDS[type];
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 packfile holding the given objects undeltified, with its SHA-1 trailer. */
export function writePack(objects: readonly PackObjectInput[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[offset] ?? 0) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[offset] ?? 0) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ParsedPack {
  objects: GitObject[];
}

/**
 * Parse a packfile fully, resolving OFS and REF deltas. `external` resolves a REF_DELTA base
 * that lives outside the pack (already in the object store).
 */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): ParsedPack {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const checksum = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!checksum.equals(trailer)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeId: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeId === 6) {
      // OFS_DELTA: negative offset to the base entry.
      let back = pack[offset] ?? 0;
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] ?? 0;
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeId === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset));
    // inflateSync consumed a prefix of the remaining bytes; find how many by re-inflating is not
    // possible, so use the zlib stream length via a manual walk: deflate streams are self-terminating
    // and Node exposes no consumed count, so decompress with a growing window instead.
    raw.push({ offset: start, typeId, data: inflated, baseOffset, baseOid });
    offset = advancePastZlib(pack, offset, size);
  }
  if (offset !== pack.length - 20) throw new Error('pack has trailing bytes after its objects');
  const byOffset = new Map<number, GitObject>();
  const resolved: GitObject[] = [];
  const resolve = (entry: RawEntry): GitObject => {
    const cached = byOffset.get(entry.offset);
    if (cached) return cached;
    let object: GitObject;
    if (entry.typeId === 6 || entry.typeId === 7) {
      let base: GitObject | undefined;
      if (entry.typeId === 6) {
        const baseEntry = raw.find((candidate) => candidate.offset === entry.baseOffset);
        if (!baseEntry) throw new Error('OFS_DELTA base not in pack');
        base = resolve(baseEntry);
      } else {
        base = resolved.find((candidate) => hashObject(candidate.type, candidate.data) === entry.baseOid) ?? external?.(entry.baseOid ?? '');
        if (!base) throw new Error('REF_DELTA base not found');
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = TYPE_BY_ID[entry.typeId];
      if (!type) throw new Error(`unknown pack object type ${entry.typeId}`);
      object = { type, data: entry.data };
    }
    byOffset.set(entry.offset, object);
    resolved.push(object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return { objects: resolved };
}

/**
 * How far a zlib stream starting at `offset` extends, found by inflating the smallest prefix
 * that yields `expectedSize` bytes. Streams in a pack are small; a linear probe is fine.
 */
function advancePastZlib(pack: Buffer, offset: number, expectedSize: number): number {
  // Try progressively larger windows; inflateSync throws until the window covers the stream end,
  // and trailing bytes after the stream are ignored by the decoder, so binary-search the boundary.
  // A deflate stream is never much larger than its plaintext, which caps the search window.
  let low = 1;
  let high = Math.min(pack.length - offset, expectedSize + 4096 + Math.ceil(expectedSize / 64));
  const inflates = (length: number): boolean => {
    try {
      return inflateSync(pack.subarray(offset, offset + length)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!inflates(high)) throw new Error('corrupt zlib stream in pack');
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (inflates(mid)) high = mid;
    else low = mid + 1;
  }
  return offset + low;
}
