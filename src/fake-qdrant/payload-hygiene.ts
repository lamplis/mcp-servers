export const PAYLOAD_TEXT_KEYS = ["codeChunk", "text", "content"] as const;

export function payloadTextField(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of PAYLOAD_TEXT_KEYS) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  return undefined;
}

export function isWhitespaceOnlyPayload(payload: unknown): boolean {
  const text = payloadTextField(payload);
  return typeof text === "string" && text.trim().length === 0;
}

export function matchesFlagPatterns(
  payload: unknown,
  patterns: readonly string[]
): boolean {
  const text = payloadTextField(payload);
  if (typeof text !== "string" || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => pattern.length > 0 && text.includes(pattern));
}

export function countPayloadHygiene(
  points: Iterable<{ payload: unknown }>,
  patterns: readonly string[]
): { emptyPayloadPoints: number; flaggedPayloadPoints: number } {
  let emptyPayloadPoints = 0;
  let flaggedPayloadPoints = 0;
  for (const point of points) {
    if (isWhitespaceOnlyPayload(payloadOf(point))) {
      emptyPayloadPoints += 1;
    }
    if (matchesFlagPatterns(payloadOf(point), patterns)) {
      flaggedPayloadPoints += 1;
    }
  }
  return { emptyPayloadPoints, flaggedPayloadPoints };
}

function payloadOf(point: { payload: unknown }): unknown {
  return point.payload;
}
