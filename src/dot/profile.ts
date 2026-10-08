import type { DotProfile } from '../types';

export function sameDotConnection(a: DotProfile, b: DotProfile): boolean {
  return a.userId === b.userId && a.roomId === b.roomId &&
    (!a.accountId || !b.accountId || a.accountId === b.accountId);
}
