export type ReviewVerdict = 'APPROVED' | 'BLOCKING' | 'INVALID' | 'UNKNOWN';

export function reviewVerdict(value: string): ReviewVerdict {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'UNKNOWN';

  // Preferred contract: the first non-empty line is the machine verdict.
  if (lines[0] === 'PASS') return 'APPROVED';
  if (lines[0] === 'FAIL') return 'BLOCKING';
  if (lines[0] === 'INVALID') return 'INVALID';

  // Real coding agents occasionally prepend a short narrative even when the
  // phase prompt requires the verdict first. Stay deterministic and fail closed:
  // accept only one unique standalone verdict token in the entire result. If
  // both tokens appear, neither appears, or only narrative aliases appear, the
  // verdict remains UNKNOWN.
  const standalone = new Set(
    lines.filter((line) => line === 'PASS' || line === 'FAIL' || line === 'INVALID'),
  );
  if (standalone.size !== 1) return 'UNKNOWN';
  if (standalone.has('PASS')) return 'APPROVED';
  if (standalone.has('FAIL')) return 'BLOCKING';
  return 'INVALID';
}
