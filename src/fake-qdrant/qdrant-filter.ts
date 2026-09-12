/**
 * Qdrant-style payload filters (must / should / must_not, nested groups).
 * Used by HTTP delete/query/scroll/count and MCP delete_points.
 */

export class UnsupportedFilterError extends Error {
  constructor(condition: string) {
    super(`Unsupported filter: ${condition}`);
    this.name = "UnsupportedFilterError";
  }
}

const FIELD_CONDITION_KEYS = new Set([
  "key",
  "match",
  "range",
  "datetime_range",
  "is_empty",
  "is_null",
]);

const GROUP_KEYS = new Set(["must", "should", "must_not", "min_should"]);

const MATCH_KEYS = new Set(["value", "any", "except"]);

const UNSUPPORTED_FIELD_KEYS = [
  "geo_bounding_box",
  "geo_radius",
  "geo_polygon",
  "values_count",
  "nested",
  "has_vector",
  "slice",
];

const UNSUPPORTED_MATCH_KEYS = ["text", "phrase", "text_any", "prefix"];

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

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a !== null && typeof a === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function asValues(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === "") {
    return true;
  }
  if (Array.isArray(value) && value.length === 0) {
    return true;
  }
  return false;
}

function idsMatch(pointId: string | number | undefined, candidate: unknown): boolean {
  if (pointId === undefined) {
    return false;
  }
  if (pointId === candidate) {
    return true;
  }
  return String(pointId) === String(candidate);
}

function inRange(
  value: number,
  range: { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown }
): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  if (range.gt !== undefined && !(value > Number(range.gt))) {
    return false;
  }
  if (range.gte !== undefined && !(value >= Number(range.gte))) {
    return false;
  }
  if (range.lt !== undefined && !(value < Number(range.lt))) {
    return false;
  }
  if (range.lte !== undefined && !(value <= Number(range.lte))) {
    return false;
  }
  return true;
}

function assertSupportedMatch(match: Record<string, unknown>): void {
  for (const key of Object.keys(match)) {
    if (UNSUPPORTED_MATCH_KEYS.includes(key)) {
      throw new UnsupportedFilterError(`match.${key}`);
    }
    if (!MATCH_KEYS.has(key)) {
      throw new UnsupportedFilterError(`match.${key}`);
    }
  }
}

function assertSupportedClause(clause: unknown): void {
  if (!isRecord(clause)) {
    throw new UnsupportedFilterError("clause");
  }
  if (
    Array.isArray(clause.must) ||
    Array.isArray(clause.should) ||
    Array.isArray(clause.must_not) ||
    isRecord(clause.min_should)
  ) {
    assertSupportedFilter(clause);
    return;
  }
  if (clause.has_id !== undefined) {
    if (!Array.isArray(clause.has_id)) {
      throw new UnsupportedFilterError("has_id");
    }
    return;
  }
  if (isRecord(clause.is_empty) && typeof clause.is_empty.key === "string") {
    return;
  }
  if (isRecord(clause.is_null) && typeof clause.is_null.key === "string") {
    return;
  }
  for (const key of UNSUPPORTED_FIELD_KEYS) {
    if (clause[key] !== undefined) {
      throw new UnsupportedFilterError(key);
    }
  }
  if (typeof clause.key === "string") {
    for (const key of Object.keys(clause)) {
      if (
        !FIELD_CONDITION_KEYS.has(key) &&
        !GROUP_KEYS.has(key) &&
        key !== "has_id"
      ) {
        throw new UnsupportedFilterError(key);
      }
    }
    if (isRecord(clause.match)) {
      assertSupportedMatch(clause.match);
    } else if (clause.match !== undefined) {
      throw new UnsupportedFilterError("match");
    }
    if (clause.range !== undefined && !isRecord(clause.range)) {
      throw new UnsupportedFilterError("range");
    }
    if (clause.datetime_range !== undefined && !isRecord(clause.datetime_range)) {
      throw new UnsupportedFilterError("datetime_range");
    }
    return;
  }
  throw new UnsupportedFilterError("clause");
}

export function assertSupportedFilter(filter: unknown): void {
  if (filter == null) {
    return;
  }
  if (!isRecord(filter)) {
    throw new UnsupportedFilterError("filter");
  }
  if (Object.keys(filter).length === 0) {
    return;
  }
  const hasGroup =
    Array.isArray(filter.must) ||
    Array.isArray(filter.should) ||
    Array.isArray(filter.must_not) ||
    isRecord(filter.min_should);
  if (hasGroup) {
    for (const key of Object.keys(filter)) {
      if (!GROUP_KEYS.has(key)) {
        throw new UnsupportedFilterError(key);
      }
    }
    if (Array.isArray(filter.must)) {
      for (const clause of filter.must) {
        assertSupportedClause(clause);
      }
    }
    if (Array.isArray(filter.should)) {
      for (const clause of filter.should) {
        assertSupportedClause(clause);
      }
    }
    if (Array.isArray(filter.must_not)) {
      for (const clause of filter.must_not) {
        assertSupportedClause(clause);
      }
    }
    if (filter.min_should !== undefined) {
      if (!isRecord(filter.min_should) || !Array.isArray(filter.min_should.conditions)) {
        throw new UnsupportedFilterError("min_should");
      }
      for (const clause of filter.min_should.conditions) {
        assertSupportedClause(clause);
      }
    }
    return;
  }
  assertSupportedClause(filter);
}

function matchHasId(pointId: string | number | undefined, ids: unknown): boolean {
  if (!Array.isArray(ids) || pointId === undefined) {
    return false;
  }
  return ids.some((item) => idsMatch(pointId, item));
}

function matchCondition(
  payload: unknown,
  condition: Record<string, unknown>
): boolean {
  if (typeof condition.key !== "string") {
    return false;
  }
  const value = getNestedValue(payload, condition.key);

  if (condition.is_empty === true) {
    return isEmptyValue(value);
  }
  if (condition.is_null === true) {
    return value === null;
  }

  if (isRecord(condition.match)) {
    const match = condition.match;
    const values = asValues(value);
    if (match.value !== undefined) {
      return values.some((item) => valuesEqual(item, match.value));
    }
    if (Array.isArray(match.any)) {
      const anyValues = match.any as unknown[];
      return values.some((item) =>
        anyValues.some((candidate) => valuesEqual(item, candidate))
      );
    }
    if (Array.isArray(match.except)) {
      const exceptValues = match.except as unknown[];
      if (values.length === 0) {
        return false;
      }
      return values.every(
        (item) =>
          !exceptValues.some((candidate) => valuesEqual(item, candidate))
      );
    }
    return false;
  }

  if (isRecord(condition.range)) {
    return asValues(value).some((item) => {
      const num = typeof item === "number" ? item : Number(item);
      return inRange(num, condition.range as { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown });
    });
  }

  if (isRecord(condition.datetime_range)) {
    return asValues(value).some((item) => {
      if (typeof item !== "string" && typeof item !== "number") {
        return false;
      }
      const parsed = Date.parse(String(item));
      if (!Number.isFinite(parsed)) {
        return false;
      }
      const range = condition.datetime_range as {
        gt?: unknown;
        gte?: unknown;
        lt?: unknown;
        lte?: unknown;
      };
      const bound = {
        gt: range.gt != null ? Date.parse(String(range.gt)) : undefined,
        gte: range.gte != null ? Date.parse(String(range.gte)) : undefined,
        lt: range.lt != null ? Date.parse(String(range.lt)) : undefined,
        lte: range.lte != null ? Date.parse(String(range.lte)) : undefined,
      };
      return inRange(parsed, bound);
    });
  }

  return false;
}

function matchClause(
  payload: unknown,
  clause: unknown,
  pointId?: string | number
): boolean {
  if (!isRecord(clause)) {
    return false;
  }
  if (
    Array.isArray(clause.must) ||
    Array.isArray(clause.should) ||
    Array.isArray(clause.must_not) ||
    isRecord(clause.min_should)
  ) {
    return matchFilterInner(payload, clause, pointId);
  }
  if (clause.has_id !== undefined) {
    return matchHasId(pointId, clause.has_id);
  }
  if (isRecord(clause.is_empty) && typeof clause.is_empty.key === "string") {
    return isEmptyValue(getNestedValue(payload, clause.is_empty.key));
  }
  if (isRecord(clause.is_null) && typeof clause.is_null.key === "string") {
    return getNestedValue(payload, clause.is_null.key) === null;
  }
  if (typeof clause.key === "string") {
    return matchCondition(payload, clause);
  }
  return false;
}

function matchFilterInner(
  payload: unknown,
  filter: unknown,
  pointId?: string | number
): boolean {
  if (filter == null) {
    return true;
  }
  if (!isRecord(filter)) {
    return false;
  }
  if (Object.keys(filter).length === 0) {
    return true;
  }

  const hasGroup =
    Array.isArray(filter.must) ||
    Array.isArray(filter.should) ||
    Array.isArray(filter.must_not) ||
    isRecord(filter.min_should);

  if (hasGroup) {
    if (Array.isArray(filter.must) && filter.must.length > 0) {
      if (!filter.must.every((clause) => matchClause(payload, clause, pointId))) {
        return false;
      }
    }
    if (Array.isArray(filter.should) && filter.should.length > 0) {
      if (!filter.should.some((clause) => matchClause(payload, clause, pointId))) {
        return false;
      }
    }
    if (Array.isArray(filter.must_not) && filter.must_not.length > 0) {
      if (filter.must_not.some((clause) => matchClause(payload, clause, pointId))) {
        return false;
      }
    }
    if (isRecord(filter.min_should) && Array.isArray(filter.min_should.conditions)) {
      const minCount = Number(filter.min_should.min_count ?? 1);
      const matched = filter.min_should.conditions.filter((clause) =>
        matchClause(payload, clause, pointId)
      ).length;
      if (matched < minCount) {
        return false;
      }
    }
    return true;
  }

  return matchClause(payload, filter, pointId);
}

export function matchFilter(
  payload: unknown,
  filter: unknown,
  pointId?: string | number
): boolean {
  if (filter == null) {
    return true;
  }
  assertSupportedFilter(filter);
  return matchFilterInner(payload, filter, pointId);
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

function isEqualityMatch(match: unknown): match is Record<string, unknown> {
  if (!isRecord(match)) {
    return false;
  }
  if (match.except !== undefined) {
    return false;
  }
  return match.value !== undefined || Array.isArray(match.any);
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
    Array.isArray(clause.must_not) ||
    isRecord(clause.min_should)
  ) {
    return candidateIdsFromFilter(clause, postings);
  }
  if (typeof clause.key !== "string") {
    return null;
  }
  const match = clause.match;
  if (!isEqualityMatch(match)) {
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
    Array.isArray(filter.must_not) ||
    isRecord(filter.min_should);
  if (!hasGroup) {
    return candidateIdsFromClause(filter, postings);
  }
  if (Array.isArray(filter.must_not) && filter.must_not.length > 0) {
    return null;
  }
  if (isRecord(filter.min_should)) {
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

export function payloadFieldTokens(payload: unknown, field: string): string[] {
  const value = getNestedValue(payload, field);
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyValue(item));
  }
  return [stringifyValue(value)];
}
