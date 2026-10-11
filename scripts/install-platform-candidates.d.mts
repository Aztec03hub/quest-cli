// Types for the stage-two platform-candidate install (QCLI-305).

export const TARGETS: readonly string[];

export function packageNameFor(target: string): string;
export function binaryNameFor(target: string): string;

export interface VerifyArtifactSetOptions {
  readonly sourceRoot: string;
  readonly targets?: readonly string[];
}

export interface VerifyResult {
  readonly problems: readonly string[];
  readonly digests: Readonly<Record<string, string>>;
  readonly verified: number;
}

export function verifyArtifactSet(
  options: VerifyArtifactSetOptions,
): Promise<VerifyResult>;

export interface InstallArtifactSetOptions {
  readonly sourceRoot: string;
  readonly writableRoot: string;
  readonly digests: Readonly<Record<string, string>>;
  readonly targets?: readonly string[];
}

export interface InstallResult {
  readonly written: readonly string[];
}

export function installArtifactSet(
  options: InstallArtifactSetOptions,
): Promise<InstallResult>;

export class ArtifactVerificationError extends Error {
  readonly problems: readonly string[];
}

export interface RunInstallOptions {
  readonly runId?: string;
  readonly dryRun?: boolean;
  readonly artifactSource?: string;
  readonly writableRoot?: string;
  readonly targets?: readonly string[];
  readonly log?: (message: string) => void;
  readonly download?: (options: {
    readonly runId: string;
    readonly into: string;
    readonly gh?: (args: readonly string[]) => Promise<{ stdout: string }>;
  }) => Promise<void>;
}

export interface RunInstallResult {
  readonly dryRun: boolean;
  readonly verified: number;
  readonly digests: Readonly<Record<string, string>>;
  readonly written: readonly string[];
}

export function runInstallCandidates(
  options?: RunInstallOptions,
): Promise<RunInstallResult>;
