// Events outlive the code that wrote them. Every event carries its schema
// version (`v`); a reader brings older shapes up to the current one here
// before projecting, so the projection only ever sees SCHEMA_VERSION.
// Add a case per version bump; never edit stored events.

import { SCHEMA_VERSION, type Event } from './types.js';

export class UpcastError extends Error {}

export function upcast(raw: unknown): Event {
  if (!raw || typeof raw !== 'object') throw new UpcastError('event is not an object');
  const e = raw as Record<string, unknown>;
  let v = typeof e.v === 'number' ? e.v : 1;
  if (v > SCHEMA_VERSION) throw new UpcastError(`event ${String(e.id)} has schema v${v}; this build reads up to v${SCHEMA_VERSION}`);
  let out = e;
  // v1 is the first versioned shape; the unversioned MVP log is v1 without the field.
  for (; v < SCHEMA_VERSION; v++) {
    // Example of a future step:
    // if (v === 1) out = { ...out, type: out.type === 'old.name' ? 'new.name' : out.type };
  }
  return { ...out, v: SCHEMA_VERSION } as Event;
}
