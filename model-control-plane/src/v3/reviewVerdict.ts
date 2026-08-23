export type ReviewVerdict = 'APPROVED' | 'BLOCKING' | 'UNKNOWN';

export function reviewVerdict(value: string): ReviewVerdict {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return 'UNKNOWN';

  const exactToken = firstLine.toUpperCase().replace(/[\s_-]+/g, '_');
  if (exactToken === 'PASS' || exactToken === 'APPROVED') return 'APPROVED';
  if (['FAIL', 'REJECTED', 'BLOCKED', 'CHANGES_REQUESTED'].includes(exactToken)) {
    return 'BLOCKING';
  }

  const historical = firstLine.match(
    /^(APPROVED|BLOCKED|REJECTED|CHANGES[\s_-]+REQUESTED)\s*(?::|-|–|—)\s*.*$/i,
  );
  if (!historical) return 'UNKNOWN';

  const historicalToken = historical[1]?.toUpperCase().replace(/[\s_-]+/g, '_');
  if (historicalToken === 'APPROVED') return 'APPROVED';
  if (['BLOCKED', 'REJECTED', 'CHANGES_REQUESTED'].includes(historicalToken ?? '')) {
    return 'BLOCKING';
  }
  return 'UNKNOWN';
}
