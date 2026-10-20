// Types for the release-gate behavioural probe (QCLI-509 / DEC-204).

export interface ProbeResponse {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProbeRunner = (
  args: readonly string[],
) => ProbeResponse | Promise<ProbeResponse>;

export interface ProbeResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly probesRun: number;
  readonly id: string | null;
}

export interface ProbeEnablement {
  readonly enabled: boolean;
  readonly reason: string;
}

export const PROBE_LIST_ARGS: readonly string[];
export const PROBE_LIST_SHAPE_ARGS: readonly string[];
export function PROBE_VIEW_ARGS(id: string): readonly string[];
export function PROBE_VIEW_SHAPE_ARGS(id: string): readonly string[];
export function hostPlatformTarget(
  platform?: string,
  arch?: string,
): string | null;
export function releaseProbeEnablement(options?: {
  env?: Record<string, string | undefined>;
  target?: string | null;
}): ProbeEnablement;
export function probeReleaseBinary(options: {
  run: ProbeRunner;
}): Promise<ProbeResult>;
export function spawnRunner(binary: string, cwd: string): ProbeRunner;
