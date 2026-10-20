// Types for the `latest` promotion step (QCLI-385). The implementation is
// plain ESM so it runs with node, in the terminal an operator publishes from.

export const PROMOTE_TAG: "latest";
export const RECORD_KIND: "quest.promotion-record.v1";
export const RELEASE_PACKAGES: readonly string[];

/** QCLI-399: the one non-staging publish, the final X launcher onto latest. */
export function launcherPublishArgs(
  tarball: string,
  options?: { otp?: string },
): string[];

export type DistTags = Readonly<Record<string, string>>;
export type ReadTags = (name: string) => Promise<DistTags>;
export type SetTag = (name: string, version: string, tag: string) => Promise<unknown>;

export interface PromotionRecord {
  readonly schemaVersion: 1;
  readonly kind: "quest.promotion-record.v1";
  readonly version: string;
  readonly recordedAt: string;
  readonly packages: readonly { readonly name: string; readonly priorLatest: string }[];
}

export function readDistTags(
  name: string,
  options?: { fetchFn?: typeof fetch },
): Promise<DistTags>;

export function planPromotion(options: {
  version: string;
  launcherVersion?: string;
  packages?: readonly string[];
  readTags?: ReadTags;
  now?: () => Date;
  resuming?: boolean;
}): Promise<
  | { ok: true; record: PromotionRecord }
  | { ok: false; problems: string[] }
>;

export function validateRecord(
  record: unknown,
  options?: { version?: string; packages?: readonly string[] },
): { ok: boolean; problems: string[] };

/** Orders two plain X.Y.Z versions exactly: negative, zero or positive. */
export function compareReleaseVersions(a: string, b: string): number;

export function checkRollbackState(options: {
  record: PromotionRecord;
  readTags?: ReadTags;
}): Promise<{ ok: boolean; problems: string[] }>;

export function promote(options: {
  record: PromotionRecord;
  setTag: SetTag;
  publishLauncher?: () => Promise<string>;
  log?: (line: string) => void;
}): Promise<
  | { ok: true; moved: string[] }
  | {
      ok: false;
      moved: string[];
      failed: string;
      restored: { ok: boolean; failed: string[] };
    }
>;

export function rollback(options: {
  record: PromotionRecord;
  setTag: SetTag;
  log?: (line: string) => void;
}): Promise<{ ok: boolean; failed: string[] }>;

type Checked = { ok: boolean; problems: string[] };
type Held = { ok: boolean; expected: string; actual: string | null };

export function downloadServedTarball(
  spec: string,
  into: string,
  options?: {
    execFile?: (
      command: string,
      args: readonly string[],
      options?: Record<string, unknown>,
    ) => Promise<{ stdout: string; stderr?: string }>;
  },
): Promise<string>;

export function checkServedLauncher(options: {
  version: string;
  launcherVersion: string;
  qualifiedRc: string;
  finalTarball: string;
  download?: (spec: string, into: string) => Promise<string>;
  checkEquivalence?: (options: {
    rcTarball: string;
    finalTarball: string;
    rcVersion: string;
    version: string;
  }) => Promise<Checked>;
}): Promise<Checked>;

export function checkFinalLauncherSlot(options: {
  version: string;
  finalTarball: string;
  alreadyPublished?: (name: string, version: string) => Promise<boolean>;
  holds?: (name: string, version: string, tarball: string) => Promise<Held>;
}): Promise<"absent" | "qualified">;

export function publishFinalLauncher(options: {
  version: string;
  finalTarball: string;
  recheck: () => Promise<Checked>;
  publish: (tarball: string) => Promise<unknown>;
  setTag: SetTag;
  alreadyPublished?: (name: string, version: string) => Promise<boolean>;
  holds?: (name: string, version: string, tarball: string) => Promise<Held>;
}): Promise<string>;

export const README_RECHECK: string;

export function readBackReadme(options?: {
  execFile?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr?: string }>;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ bytes: number | null; attempts: number; error?: string }>;

export function verifyFinalLauncher(options: {
  version: string;
  finalTarball: string;
  holds?: (name: string, version: string, tarball: string) => Promise<Held>;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Checked>;

export function verifyTags(options: {
  expected: Readonly<Record<string, string>>;
  readTags?: ReadTags;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; attempts: number; wrong: string[] }>;

/** QCLI-515: what to tell the operator when the GitHub Release did not cut. */
export function repairHint(version: string, notesFrom?: string): string;
