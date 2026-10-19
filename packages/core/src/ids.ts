const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function random(n: number): string {
  let out = '';
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const newArtefactId = (): string => `a-${random(5)}`;
export const newActionId = (): string => `t-${random(5)}`;
export const newEventId = (): string => `e-${random(10)}`;
