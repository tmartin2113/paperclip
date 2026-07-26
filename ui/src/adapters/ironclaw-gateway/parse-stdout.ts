import type { TranscriptEntry } from "../types";

export function parseIronclawStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
