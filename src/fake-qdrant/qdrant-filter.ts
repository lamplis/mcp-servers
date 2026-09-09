/**
 * Qdrant-style payload filters (must / should / must_not, nested groups).
 * Used by HTTP delete/query/scroll/count and MCP delete_points.
 */

export function getNestedValue(obj: unknown, keyPath: string): unknown {
  const keys = keyPath.split(".");
  let value: unknown = obj;
  for (const key of keys) {
    if (value && typeof value === "object" && key in (value as object)) {
      value = (value as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return value;
}

function stringifyValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function matchCondition(payload: unknown, condition: Record<string, unknown>): boolean {
  if (typeof condition.key !== "string") {
    return false;
  }
  const value = getNestedValue(payload, condition.key);
  if (value === undefined) {
    return false;
  }
  const match = condition.match;
  if (!isRecord(match)) {
    return false;
  }
  if (match.value !== undefined) {
    return stringifyValue(value) === stringifyValue(match.value);
  }
  if (Array.isArray(match.any)) {
    const needle = stringifyValue(value);
    return match.any.some((item) => stringifyValue(item) === needle);
  }
  return false;
}

function matchClause(payload: unknown, clause: unknown): boolean {
  if (!isRecord(clause)) {
    return false;
  }
  if (
    Array.isArray(clause.must) ||
    Array.isArray(clause.should) ||
    Array.isArray(clause.must_not)
  ) {
    return matchFilter(payload, clause);
  }
  if (typeof clause.key === "string") {
    return matchCondition(payload, clause);
  }
  return false;
}

export function matchFilter(payload: unknown, filter: unknown): boolean {
  if (filter == null) {
    return true;
  }
  if (!isRecord(filter)) {
    return false;
  }

  const hasGroup =
    Array.isArray(filter.must) ||
    Array.isArray(filter.should) ||
    Array.isArray(filter.must_not);

  if (hasGroup) {
    if (Array.isArray(filter.must) && filter.must.length > 0) {
      if (!filter.must.every((clause) => matchClause(payload, clause))) {
        return false;
      }
    }
    if (Array.isArray(filter.should) && filter.should.length > 0) {
      if (!filter.should.some((clause) => matchClause(payload, clause))) {
        return false;
      }
    }
    if (Array.isArray(filter.must_not) && filter.must_not.length > 0) {
      if (filter.must_not.some((clause) => matchClause(payload, clause))) {
        return false;
      }
    }
    return true;
  }

  if (typeof filter.key === "string") {
    return matchCondition(payload, filter);
  }
  return false;
}

export type KeywordPostings = Map<string, Map<string, Set<string>>>;

function idsForEquality(
  postings: KeywordPostings,
  field: string,
  value: unknown
): Set<string> | null {
  const byValue = postings.get(field);
  if (!byValue) {
    return null;
  }
  const ids = byValue.get(stringifyValue(value));
  return ids ? new Set(ids) : new Set();
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const id of a) {
    if (b.has(id)) {
      out.add(id);
    }
  }
  return out;
}

function union(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set(a);
  for (const id of b) {
    out.add(id);
  }
  return out;
}

function candidateIdsFromClause(
  clause: unknown,
  postings: KeywordPostings
): Set<string> | null {
  if (!isRecord(clause)) {
    return null;
  }
  if (
    Array.isArray(clause.must) ||
    Array.isArray(clause.should) ||
    Array.isArray(clause.must_not)
  ) {
    return candidateIdsFromFilter(clause, postings);
  }
  if (typeof clause.key !== "string") {
    return null;
  }
  const match = clause.match;
  if (!isRecord(match)) {
    return null;
  }
  if (match.value !== undefined) {
    return idsForEquality(postings, clause.key, match.value);
  }
  if (Array.isArray(match.any)) {
    let acc: Set<string> | null = new Set();
    for (const item of match.any) {
      const ids = idsForEquality(postings, clause.key, item);
      if (ids == null) {
        return null;
      }
      acc = union(acc, ids);
    }
    return acc;
  }
  return null;
}

/**
 * Resolve candidate point ids from keyword postings. Returns null when the
 * filter cannot be answered from indexes (caller must scan).
 */
export function candidateIdsFromFilter(
  filter: unknown,
  postings: KeywordPostings
): Set<string> | null {
  if (filter == null || !isRecord(filter)) {
    return null;
  }
  const hasGroup =
    Array.isArray(filter.must) ||
    Array.isArray(filter.should) ||
    Array.isArray(filter.must_not);
  if (!hasGroup) {
    return candidateIdsFromClause(filter, postings);
  }
  if (Array.isArray(filter.must_not) && filter.must_not.length > 0) {
    return null;
  }

  let acc: Set<string> | null = null;

  if (Array.isArray(filter.must) && filter.must.length > 0) {
    for (const clause of filter.must) {
      const ids = candidateIdsFromClause(clause, postings);
      if (ids == null) {
        return null;
      }
      acc = acc == null ? ids : intersect(acc, ids);
    }
  }

  if (Array.isArray(filter.should) && filter.should.length > 0) {
    let shouldIds: Set<string> | null = new Set();
    for (const clause of filter.should) {
      const ids = candidateIdsFromClause(clause, postings);
      if (ids == null) {
        return null;
      }
      shouldIds = union(shouldIds, ids);
    }
    acc = acc == null ? shouldIds : intersect(acc, shouldIds);
  }

  return acc;
}

export function payloadFieldString(
  payload: unknown,
  field: string
): string | undefined {
  const value = getNestedValue(payload, field);
  if (value === undefined) {
    return undefined;
  }
  return stringifyValue(value);
}
