/** Types for `servers.mjs`, the plain-ESM test servers (loaded by the stdio child without a build step). */

export declare const LIMITS: {
  readonly wholeInputLimits: { maxInputBytes: number; maxFindings: number };
  readonly incrementalLimits: {
    maxInputCodeUnits: number;
    maxBufferedCodeUnits: number;
    maxTokenCodeUnits: number;
    maxMultilineCodeUnits: number;
  };
  readonly traversalLimits: { maxDepth: number; maxNodes: number };
};
export declare const CONTROL_MARKER: string;
export declare function buildLowLevelServer(
  line: "v1" | "v2",
): Promise<{ server: unknown; stats: Record<string, unknown> }>;
export declare function buildMcpServer(line: "v1" | "v2"): Promise<{ server: unknown }>;
export declare function materializeValue(value: unknown): unknown;
