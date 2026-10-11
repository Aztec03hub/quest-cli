// Types for the lore/quest version-parity gate (QCLI-386, Article 3.6).

export const PEER: {
  readonly repository: string;
  readonly ref: string;
  readonly packageName: string;
};

export interface PeerRead {
  readonly version: string | null;
  readonly source: string;
  readonly error?: string;
}

export function peerReadArgs(peer?: typeof PEER): string[];

export function readPeerVersion(options?: {
  peer?: typeof PEER;
  execFile?: (
    command: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr?: string }>;
}): Promise<PeerRead>;

export type ParityVerdict =
  | { readonly ok: true; readonly problem: null; readonly message: string }
  | { readonly ok: false; readonly problem: string };

export function checkVersionParity(facts: {
  version: string;
  peerRead: PeerRead;
}): ParityVerdict;

export function requireVersionParity(options: {
  version: string;
  read?: () => Promise<PeerRead>;
}): Promise<ParityVerdict>;
