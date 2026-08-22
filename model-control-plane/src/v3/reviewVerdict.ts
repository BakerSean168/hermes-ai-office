export type ReviewVerdict = 'APPROVED' | 'BLOCKING' | 'UNKNOWN';

export function reviewVerdict(value: string): ReviewVerdict {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return 'UNKNOWN';

  const [rawToken] = firstLine.split(':', 1);
  const token =
    rawToken
      ?.trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_') ?? '';
  if (token === 'PASS' || token === 'APPROVED') return 'APPROVED';
  if (['FAIL', 'REJECTED', 'BLOCKED', 'CHANGES_REQUESTED'].includes(token)) return 'BLOCKING';
  return 'UNKNOWN';
}
