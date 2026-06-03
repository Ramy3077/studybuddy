import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DiscoveredFile, LectureKind, SourceType } from '../types.js';

export interface DiscoveryResult {
  files: DiscoveredFile[];
  ignored: { relPath: string; reason: string }[];
  warnings: string[];
}

const IGNORE_TOP = new Set(['Past Papers', 'Exercises', 'ML.md', 'ML Revision Plan.md']);
const CAPTIONS_SUFFIX = /_Captions_English \(United States\)\.txt$/i;

function letterFromNumber(n: string): string {
  const i = parseInt(n, 10);
  return ['a', 'b', 'c', 'd'][i - 1] ?? 'a';
}

function prettify(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function kindFromText(s: string): LectureKind | null {
  if (/assessment[-\s]?support/i.test(s)) return 'assessment_support';
  if (/tutorial/i.test(s)) return 'tutorial';
  if (/revision/i.test(s)) return 'revision';
  return null;
}

/** Parse a slide-deck filename. Handles both `1a-title.pdf` and `W07-01-title.pdf`. */
export function parseSlideName(filename: string): {
  week: number;
  lecture: string;
  code: string;
  title: string;
} | null {
  const a = filename.match(/^(\d+)\s*([a-c])\s*-\s*(.+)\.pdf$/i);
  if (a) {
    const week = parseInt(a[1]!, 10);
    const lecture = a[2]!.toLowerCase();
    return { week, lecture, code: `${week}${lecture}`, title: prettify(a[3]!) };
  }
  const b = filename.match(/^W(\d+)\s*-\s*(\d+)\s*-\s*(.+)\.pdf$/i);
  if (b) {
    const week = parseInt(b[1]!, 10);
    const lecture = letterFromNumber(b[2]!);
    return { week, lecture, code: `${week}${lecture}`, title: prettify(b[3]!) };
  }
  return null;
}

/** Parse a transcript caption filename into week/lecture/kind/title. */
export function parseTranscriptName(filename: string): {
  week: number | null;
  lecture: string | null;
  code: string | null;
  coveredCodes: string[];
  kind: LectureKind;
  title: string;
} {
  let base = filename.replace(CAPTIONS_SUFFIX, '').replace(/\.txt$/i, '');
  // Strip a trailing "- 07 October 2025 at 15_54_17" style date stamp.
  base = base.replace(/\s*-\s*\d{1,2}\s+\w+\s+\d{4}\s+at\s+.*$/i, '').trim();

  const kind: LectureKind = kindFromText(base) ?? 'lecture';

  let week: number | null = null;
  let lecture: string | null = null;
  let coveredCodes: string[] = [];

  const combined = base.match(/^(\d+)\s*([a-c])\s*_\s*(\d+)?\s*([a-c])/i);
  const startCode = base.match(/^\s*(\d+)\s*([a-c])?/i);
  const weekWord = base.match(/week\s*(\d+)/i);
  const anyCode = base.match(/(\d+)\s*([a-c])\b/i);

  if (combined) {
    week = parseInt(combined[1]!, 10);
    lecture = combined[2]!.toLowerCase();
    const w2 = combined[3] ? parseInt(combined[3], 10) : week;
    coveredCodes = [`${week}${lecture}`, `${w2}${combined[4]!.toLowerCase()}`];
  } else if (startCode) {
    week = parseInt(startCode[1]!, 10);
    lecture = startCode[2] ? startCode[2].toLowerCase() : null;
    coveredCodes = lecture ? [`${week}${lecture}`] : [];
  } else if (weekWord) {
    week = parseInt(weekWord[1]!, 10);
  } else if (anyCode) {
    week = parseInt(anyCode[1]!, 10);
    lecture = anyCode[2]!.toLowerCase();
    coveredCodes = [`${week}${lecture}`];
  }

  const code = coveredCodes[0] ?? null;
  return { week, lecture, code, coveredCodes, kind, title: prettify(base) };
}

export async function discoverVault(vaultRoot: string, module = 'ml'): Promise<DiscoveryResult> {
  const files: DiscoveredFile[] = [];
  const ignored: { relPath: string; reason: string }[] = [];
  const warnings: string[] = [];

  const topEntries = await readdir(vaultRoot, { withFileTypes: true });
  for (const entry of topEntries) {
    const name = entry.name;
    if (name === '.DS_Store') continue;
    if (IGNORE_TOP.has(name)) {
      ignored.push({ relPath: name, reason: 'ignored per CONFIG' });
      continue;
    }
    if (/^list-of-formulas.*\.pdf$/i.test(name)) {
      ignored.push({ relPath: name, reason: 'formula sheet ignored per CONFIG' });
      continue;
    }

    if (entry.isDirectory() && /^Week\s+(\d+)$/i.test(name)) {
      const weekNum = parseInt(name.match(/(\d+)/)![1]!, 10);
      const dir = join(vaultRoot, name);
      for (const f of await readdir(dir)) {
        if (f === '.DS_Store') continue;
        const abs = join(dir, f);
        const rel = `${name}/${f}`;
        if (/\.pdf$/i.test(f)) {
          const parsed = parseSlideName(f);
          if (!parsed) {
            files.push(makeFile(abs, rel, 'slides', module, prettify(f.replace(/\.pdf$/i, '')), null, null, weekNum, 'lecture', true, [], 'slide deck (code not parsed from filename)'));
            warnings.push(`Slide name not parsed, using folder week: ${rel}`);
            continue;
          }
          if (parsed.week !== weekNum) {
            warnings.push(`Slide code week (${parsed.week}) != folder week (${weekNum}) for ${rel}; using ${parsed.week}`);
          }
          files.push(makeFile(abs, rel, 'slides', module, parsed.title, parsed.code, parsed.lecture, parsed.week, 'lecture', true, [parsed.code], 'lecture slide deck'));
        } else if (/^ML W\d+\.md$/i.test(f)) {
          files.push(makeFile(abs, rel, 'notes', module, `ML Week ${weekNum} Notes`, null, null, weekNum, 'notes', true, [], "student's own notes"));
        } else if (/\.md$/i.test(f)) {
          files.push(makeFile(abs, rel, 'notes', module, prettify(f.replace(/\.md$/i, '')), null, null, weekNum, 'notes', true, [], 'markdown notes'));
        } else {
          ignored.push({ relPath: rel, reason: 'unrecognised file in week folder' });
        }
      }
    } else if (entry.isDirectory() && name === 'ML-Recordings') {
      const dir = join(vaultRoot, name);
      for (const f of await readdir(dir)) {
        if (f === '.DS_Store' || !/\.txt$/i.test(f)) continue;
        const abs = join(dir, f);
        const rel = `${name}/${f}`;
        const t = parseTranscriptName(f);
        if (t.week === null) warnings.push(`Could not determine week for transcript: ${rel} (week=null)`);
        const isPrimary = t.kind === 'lecture' && (t.lecture === 'a' || t.lecture === 'b');
        files.push(
          makeFile(abs, rel, 'transcript', module, t.title, t.code, t.lecture, t.week, t.kind, isPrimary, t.coveredCodes, `${t.kind} recording`),
        );
      }
    } else if (entry.isDirectory()) {
      ignored.push({ relPath: name, reason: 'directory not in CONFIG scope' });
    } else {
      ignored.push({ relPath: name, reason: 'top-level file not in scope' });
    }
  }

  files.sort((x, y) => (x.week ?? 99) - (y.week ?? 99) || x.sourceType.localeCompare(y.sourceType) || x.relPath.localeCompare(y.relPath));
  return { files, ignored, warnings };
}

function makeFile(
  vaultPath: string,
  relPath: string,
  sourceType: SourceType,
  module: string,
  title: string,
  code: string | null,
  lecture: string | null,
  week: number | null,
  kind: LectureKind,
  isPrimary: boolean,
  coveredCodes: string[],
  note: string,
): DiscoveredFile {
  return { vaultPath, relPath, sourceType, module, title, code, lecture, week, kind, isPrimary, coveredCodes, note };
}
