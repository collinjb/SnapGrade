/** Small, dependency-free id generator. Collision risk is irrelevant at the
 *  scale of one teacher's device, and it keeps the cold-start path light. */
export function uid(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

const HEX = '0123456789abcdef';

/** UUID v4 from Math.random — used only for client-generated row ids that
 *  Postgres stores in a uuid column. Not for anything security-sensitive. */
export function uuidv4(): string {
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += HEX[((Math.random() * 4) | 0) + 8];
    else out += HEX[(Math.random() * 16) | 0];
  }
  return out;
}
