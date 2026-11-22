// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// This file implements the whole of SPEC.md: the command line, the output and exit
// codes, safe paths, format detection, the three tiers of line matching (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
// Every edit applies to an in-memory tree first; only when no edit failed is the
// tree written out, so a failed edit leaves every file untouched.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// A file as lines (SPEC.md section 3): its line break is CRLF when its first line
// feed follows a carriage return, LF otherwise; it ends with a line break when its
// text ends with that break, and an empty file has no lines.
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// Line matching (SPEC.md section 5). Tier 0 is exact; tier 1 ignores trailing
// spaces and tabs; tier 2 ignores leading and trailing spaces and tabs.
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier at which O occurs at least once at or after `from` (tier 0 only
// with --strict), with every occurrence position at that tier.
function findOcc(O: string[], lines: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface OLine {
  text: string;
  ctx: boolean;
}

// The lines N writes when O matched at `pos` under `tier`: a context line is
// written as the file's own matched line, never the patch's; at tier 2 every other
// line is re-indented from O's first line's leading whitespace to the file's.
function buildN(O: OLine[], N: OLine[], fileLines: string[], pos: number, tier: number): string[] {
  const oCtxOff: number[] = [];
  O.forEach((e, i) => {
    if (e.ctx) oCtxOff.push(i);
  });
  const F = pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!.text) : '';
  let nCtx = 0;
  return N.map((e) => {
    if (e.ctx) {
      const off = oCtxOff[nCtx++]!;
      return fileLines[pos + off]!;
    }
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && !onlyWs(t) && t.startsWith(P)) return F + t.slice(P.length);
    }
    return e.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Unified diffs (SPEC.md section 6).
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface Hunk {
  A: number;
  body: BodyLine[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

// The path of a `--- ` / `+++ ` line: the text after the four characters, up to
// the first tab, with surrounding spaces removed; /dev/null means no file, and a
// leading a/ or b/ is removed.
function diffPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m ? parseInt(m[1]!, 10) : null;
}

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let section: Section | null = null;
  let hunk: Hunk | null = null;
  let inHeader = false;
  let pairSeen = false;
  const flushHunk = (): void => {
    if (hunk !== null && section !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      section.hunks.push(hunk);
    }
    hunk = null;
  };
  const flushSection = (): void => {
    flushHunk();
    if (section !== null) sections.push(section);
    section = null;
    inHeader = false;
    pairSeen = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        flushHunk();
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        const kind = line === '' || line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : line.startsWith('+') ? 'new' : 'bs';
        hunk.body.push({ kind, text: line === '' ? '' : line.slice(1) });
        i++;
        continue;
      } else {
        flushHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flushSection();
      section = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      pairSeen = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section !== null && inHeader && !pairSeen) {
        section.oldPath = diffPath(line);
        section.newPath = diffPath(lines[i + 1]!);
        pairSeen = true;
        i += 2;
        continue;
      }
      flushSection();
      section = { oldPath: diffPath(line), newPath: diffPath(lines[i + 1]!), isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      pairSeen = true;
      i += 2;
      continue;
    }
    if (section !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('@@')) {
        const A = parseHunkHeader(line);
        if (A === null) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        hunk = { A, body: [] };
        i++;
        continue;
      }
      if (line.startsWith('rename from ') && !pairSeen) section.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !pairSeen) section.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) section.isCreate = true;
      else if (line.startsWith('deleted file mode')) section.isDelete = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  flushSection();
  return sections;
}

// Split one hunk body into its old lines O and new lines N, and whether a `\`
// line follows the hunk's last context or `+` line.
function splitHunk(h: Hunk): { O: OLine[]; N: OLine[]; noEol: boolean } {
  const O: OLine[] = [];
  const N: OLine[] = [];
  let lastCtxPlus = -1;
  h.body.forEach((b, idx) => {
    if (b.kind === 'ctx' || b.kind === 'new') lastCtxPlus = idx;
  });
  let noEol = false;
  h.body.forEach((b, idx) => {
    if (b.kind === 'ctx') {
      O.push({ text: b.text, ctx: true });
      N.push({ text: b.text, ctx: true });
    } else if (b.kind === 'old') O.push({ text: b.text, ctx: false });
    else if (b.kind === 'new') N.push({ text: b.text, ctx: false });
    else if (idx === lastCtxPlus + 1) noEol = true;
  });
  return { O, N, noEol };
}

// Apply a section's hunks in order to a file's text, returning the new text.
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N, noEol } = splitHunk(h);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.A + d, f.lines.length));
      const atEnd = at === f.lines.length;
      const rep = buildN(O, N, f.lines, at, 0);
      f.lines.splice(at, 0, ...rep);
      if (atEnd) f.final = !noEol;
      d += N.length;
      continue;
    }
    const found = findOcc(
      O.map((e) => e.text),
      f.lines,
      strict,
      0,
    );
    if (found === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let pos = found.pos[0]!;
    let bestDist = Math.abs(pos - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        pos = p;
        bestDist = dist;
      }
    }
    const runsToEnd = pos + O.length === f.lines.length;
    const rep = buildN(O, N, f.lines, pos, found.tier);
    f.lines.splice(pos, O.length, ...rep);
    if (runsToEnd) f.final = !noEol;
    d += N.length - O.length;
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((sec) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = newP === null || sec.isDelete;
    return (tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate && newP !== null) {
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let noEol = false;
        let lastHunk = -1;
        sec.hunks.forEach((h, hi) => {
          if (h.body.some((b) => b.kind === 'new')) lastHunk = hi;
        });
        sec.hunks.forEach((h, hi) => {
          let lastPlus = -1;
          h.body.forEach((b, idx) => {
            if (b.kind === 'new') lastPlus = idx;
          });
          h.body.forEach((b, idx) => {
            if (b.kind === 'new') plus.push(b.text);
            else if (b.kind === 'bs' && hi === lastHunk && idx === lastPlus + 1) noEol = true;
          });
        });
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDelete && oldP !== null) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        const cur = tree.get(oldP);
        if (cur === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(cur, sec.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, out);
        tree.moves.push({ old: oldP, new: newP });
        return;
      }
      const p = (oldP ?? newP)!;
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(cur, sec.hunks, strict, p));
    };
  });
}

// SEARCH/REPLACE blocks (SPEC.md section 7).
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p, oldL, newL) => (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldL.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const found = findOcc(oldL, f.lines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const repLines = buildN(
        oldL.map((t) => ({ text: t, ctx: false })),
        newL.map((t) => ({ text: t, ctx: false })),
        f.lines,
        pos,
        found.tier,
      );
      f.lines.splice(pos, oldL.length, ...repLines);
      tree.now.set(p, joinFile(f));
    })(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// V4A patches (SPEC.md section 8).
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  lines: { text: string; no: number }[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let j = first + 1; j < last; j++) {
    const line = lines[j]!;
    let kind: VSection['kind'] | null = null;
    let prefix = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      prefix = '*** Delete File: ';
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      prefix = '*** Update File: ';
    }
    if (kind !== null) {
      if (cur !== null) sections.push(cur);
      cur = { kind, path: line.slice(prefix.length).trim(), lineNo: j + 1, lines: [] };
    } else if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${j + 1}`);
    } else {
      cur.lines.push({ text: line, no: j + 1 });
    }
  }
  if (cur !== null) sections.push(cur);
  return sections.map((sec) => {
    // Blank lines at the end of a section are not part of it.
    const content = [...sec.lines];
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const l of content) {
        if (l.text === '') fileLines.push('');
        else if (l.text.startsWith('+')) fileLines.push(l.text.slice(1));
        else throw new Exit2(`error: parse ${l.no}`);
      }
      const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
      const p = sec.path;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      };
    }
    if (sec.kind === 'delete') {
      for (const l of content) throw new Exit2(`error: parse ${l.no}`);
      const p = sec.path;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    // Update File: an optional `*** Move to:` first line, then chunks.
    let moveTo: string | null = null;
    let idx = 0;
    let probe = 0;
    while (probe < content.length && blank(content[probe]!.text)) probe++;
    if (probe < content.length && content[probe]!.text.startsWith('*** Move to: ')) {
      moveTo = content[probe]!.text.slice('*** Move to: '.length).trim();
      idx = probe + 1;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    for (; idx < content.length; idx++) {
      const { text: line, no } = content[idx]!;
      if (line.startsWith('@@')) {
        if (chunk !== null) chunks.push(chunk);
        chunk = { anchor: line.slice(2).trim(), body: [], eof: false };
      } else if (line === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${no}`);
        chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
        if (chunk === null) chunk = { anchor: null, body: [], eof: false };
        const kind = line === '' || line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : 'new';
        chunk.body.push({ kind, text: line === '' ? '' : line.slice(1) });
      } else {
        throw new Exit2(`error: parse ${no}`);
      }
    }
    if (chunk !== null) chunks.push(chunk);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    const p = sec.path;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const f = splitFile(curText);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const found = findOcc([ch.anchor], f.lines, strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          cursor = found.pos[0]! + 1;
        }
        const O: OLine[] = [];
        const N: OLine[] = [];
        for (const b of ch.body) {
          if (b.kind === 'ctx') {
            O.push({ text: b.text, ctx: true });
            N.push({ text: b.text, ctx: true });
          } else if (b.kind === 'old') O.push({ text: b.text, ctx: false });
          else if (b.kind === 'new') N.push({ text: b.text, ctx: false });
        }
        if (O.length === 0) {
          const at = ch.eof ? f.lines.length : cursor;
          const rep = buildN(O, N, f.lines, at, 0);
          f.lines.splice(at, 0, ...rep);
          cursor = at + rep.length;
          continue;
        }
        const oText = O.map((e) => e.text);
        let found: { tier: number; pos: number[] } | null = null;
        if (ch.eof) {
          const want = f.lines.length - oText.length;
          if (want >= cursor) {
            const tiers = strict ? [0] : [0, 1, 2];
            for (const t of tiers) {
              if (occurrences(oText, f.lines, t, want).includes(want)) {
                found = { tier: t, pos: [want] };
                break;
              }
            }
          }
        } else {
          found = findOcc(oText, f.lines, strict, cursor);
        }
        if (found === null) throw new Fail('no-match', p);
        const pos = found.pos[0]!;
        const rep = buildN(O, N, f.lines, pos, found.tier);
        f.lines.splice(pos, O.length, ...rep);
        cursor = pos + rep.length;
      }
      const out = joinFile(f);
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, out);
        tree.moves.push({ old: p, new: moveTo });
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per path whose state changed, in byte order of the paths; a move
  // prints `R <old> -> <new>` instead of that pair's `D` and `A` lines, and
  // sorts by `<new>`.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rows: { key: string; text: string }[] = [];
  for (const m of tree.moves) {
    const o = changed.get(m.old);
    const n = changed.get(m.new);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null) {
      changed.delete(m.old);
      changed.delete(m.new);
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const [p, c] of changed) {
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
