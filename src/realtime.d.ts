/**
 * Minimal type surface for the legacy realtime.js engine, covering only what the
 * streaming stack consumes (via SimulatedSource). The implementation stays in
 * JS; this just lets strict TypeScript type-check against it.
 */

export type RealtimeEvent = {
  kind: string;
  text?: string;
  payer?: string;
  phone?: string;
  [k: string]: unknown;
};

export class RealtimeCall {
  constructor(tree: unknown, opts?: Record<string, unknown>);
  onEvent(fn: (ev: RealtimeEvent) => void): () => void;
  start(): void;
  sendInput(inp: { type: "dtmf" | "speech"; value: string }): void;
  hangup(): void;
  isEnded(): boolean;
  events: RealtimeEvent[];
  stats(): { wordsHeard: number; bargeIns: number; timeouts: number; durationMs: number };
}
