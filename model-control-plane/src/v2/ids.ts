import crypto from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(value: bigint, length: number): string {
  let current = value;
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out = CROCKFORD[Number(current & 31n)] + out;
    current >>= 5n;
  }
  return out;
}

export function ulid(timestamp = Date.now()): string {
  const time = encodeBase32(BigInt(timestamp), 10);
  const random = crypto.randomBytes(10);
  let randomValue = 0n;
  for (const byte of random) randomValue = (randomValue << 8n) | BigInt(byte);
  return `${time}${encodeBase32(randomValue, 16)}`;
}

export function newId(prefix: string, timestamp = Date.now()): string {
  return `${prefix}_${ulid(timestamp)}`;
}
