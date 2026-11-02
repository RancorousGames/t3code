/**
 * Multi-window experiment sampler lease. One Electron renderer owns passive
 * metric updates; a closed/sleeping renderer releases or expires its lease.
 * No guest action or recovery scheduler is controlled by this lock.
 */
// Recovery preferences and experiment results are device-global, so the
// sampler lease must also be global. Environment-scoped leases would allow
// multiple renderers to corrupt the same statistics and arm selection.
const KEY = "t3code:chatgpt:recovery-experiment-observer:global:v1";
const TTL_MS = 90_000;

interface Lease {
  version: 1;
  owner: string;
  environmentId: string;
  expiresAt: number;
}
function parse(raw: string | null): Lease | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const candidate = v as Record<string, unknown>;
    return candidate.version === 1 &&
      typeof candidate.owner === "string" && candidate.owner.length > 0 &&
      typeof candidate.environmentId === "string" && candidate.environmentId.length > 0 &&
      typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt)
      ? { version: 1, owner: candidate.owner, environmentId: candidate.environmentId,
          expiresAt: candidate.expiresAt }
      : null;
  } catch { return null; }
}
export function claimRecoveryExperimentSampler(
  storage: Storage, environmentId: string, owner: string, now: number,
): boolean {
  try {
    const current = parse(storage.getItem(KEY));
    const plausible = current && current.expiresAt - now <= TTL_MS * 5;
    if (plausible && current.owner !== owner && current.expiresAt > now) return false;
    const lease: Lease = { version: 1, owner, environmentId, expiresAt: now + TTL_MS };
    storage.setItem(KEY, JSON.stringify(lease));
    // Readback prevents most races with another renderer claiming simultaneously.
    const saved = parse(storage.getItem(KEY));
    return saved?.owner === owner && saved.environmentId === environmentId &&
      saved.expiresAt === lease.expiresAt;
  } catch {
    // Cannot prove exclusivity: skip this observation rather than double-count.
    return false;
  }
}
export function releaseRecoveryExperimentSampler(storage: Storage, environmentId: string, owner: string) {
  try {
    const current = parse(storage.getItem(KEY));
    if (current?.owner === owner && current.environmentId === environmentId)
      storage.removeItem(KEY);
  } catch {
    // The lease expires; never delete another renderer's lock.
  }
}
