export type ReviewVerdict = 'APPROVED' | 'BLOCKING' | 'UNKNOWN';

export function reviewVerdict(value: string): ReviewVerdict {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'UNKNOWN';

  // Preferred contract: the first non-empty line is the machine verdict.
  if (lines[0] === 'PASS') return 'APPROVED';
  if (lines[0] === 'FAIL') return 'BLOCKING';

  // Real coding agents occasionally prepend a short narrative even when the
  // phase prompt requires the verdict first. Stay deterministic and fail closed:
  // accept only one unique standalone verdict token in the entire result. If
  // both tokens appear, neither appears, or only narrative aliases appear, the
  // verdict remains UNKNOWN.
  const standalone = new Set(lines.filter((line) => line === 'PASS' || line === 'FAIL'));
  if (standalone.size !== 1) return 'UNKNOWN';
  return standalone.has('PASS') ? 'APPROVED' : 'BLOCKING';
}
