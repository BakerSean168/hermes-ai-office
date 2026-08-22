export type ReviewVerdict = 'APPROVED' | 'BLOCKING' | 'UNKNOWN';

export function reviewVerdict(value: string): ReviewVerdict {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return 'UNKNOWN';

  if (firstLine === 'PASS') return 'APPROVED';
  if (firstLine === 'FAIL') return 'BLOCKING';
  return 'UNKNOWN';
}
