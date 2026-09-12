import { describe, expect, it } from "vitest";
import {
  candidateIdsFromFilter,
  matchFilter,
  UnsupportedFilterError,
} from "../qdrant-filter.js";

const rooCodeDeleteFilter = {
  should: [
    {
      must: [
        { key: "pathSegments.0", match: { value: "library_converted" } },
        {
          key: "pathSegments.1",
          match: { value: "01_Experimentation_Business_Requirements_Document.md" },
        },
      ],
    },
    { must: [{ key: "pathSegments.0", match: { value: "config.py" } }] },
    { must: [{ key: "pathSegments.0", match: { value: "api_client.py" } }] },
  ],
};

describe("matchFilter", () => {
  it("matches RooCode nested should/must pathSegments filters", () => {
    expect(
      matchFilter(
        { pathSegments: ["library_converted", "01_Experimentation_Business_Requirements_Document.md"] },
        rooCodeDeleteFilter
      )
    ).toBe(true);
    expect(
      matchFilter({ pathSegments: ["config.py"] }, rooCodeDeleteFilter)
    ).toBe(true);
    expect(
      matchFilter({ pathSegments: ["other.py"] }, rooCodeDeleteFilter)
    ).toBe(false);
  });

  it("supports must_not and match.any", () => {
    expect(
      matchFilter(
        { type: "code" },
        { must_not: [{ key: "type", match: { value: "code" } }] }
      )
    ).toBe(false);
    expect(
      matchFilter(
        { type: "md" },
        { must: [{ key: "type", match: { any: ["md", "txt"] } }] }
      )
    ).toBe(true);
  });

  it("matches any array element and is type-strict", () => {
    expect(
      matchFilter({ tags: ["red", "blue"] }, { key: "tags", match: { value: "red" } })
    ).toBe(true);
    expect(
      matchFilter({ tags: ["red", "blue"] }, { key: "tags", match: { value: "green" } })
    ).toBe(false);
    expect(matchFilter({ n: 1 }, { key: "n", match: { value: "1" } })).toBe(false);
    expect(matchFilter({ n: 1 }, { key: "n", match: { value: 1 } })).toBe(true);
  });

  it("supports match.except, range, datetime_range, has_id, is_empty, is_null, min_should", () => {
    expect(
      matchFilter({ type: "md" }, { key: "type", match: { except: ["code", "bin"] } })
    ).toBe(true);
    expect(
      matchFilter({ type: "code" }, { key: "type", match: { except: ["code"] } })
    ).toBe(false);
    expect(
      matchFilter({ n: 5 }, { key: "n", range: { gte: 1, lt: 10 } })
    ).toBe(true);
    expect(
      matchFilter({ n: 0 }, { key: "n", range: { gte: 1 } })
    ).toBe(false);
    expect(
      matchFilter(
        { ts: "2024-06-01T00:00:00Z" },
        { key: "ts", datetime_range: { gte: "2024-01-01T00:00:00Z", lt: "2025-01-01T00:00:00Z" } }
      )
    ).toBe(true);
    expect(matchFilter({ tag: "x" }, { has_id: [2] }, 2)).toBe(true);
    expect(matchFilter({ tag: "x" }, { has_id: [2] }, 3)).toBe(false);
    expect(matchFilter({ tags: [] }, { is_empty: { key: "tags" } })).toBe(true);
    expect(matchFilter({}, { is_empty: { key: "missing" } })).toBe(true);
    expect(matchFilter({ note: null }, { is_null: { key: "note" } })).toBe(true);
    expect(matchFilter({}, { is_null: { key: "note" } })).toBe(false);
    expect(
      matchFilter(
        { a: 1, b: 0 },
        {
          min_should: {
            conditions: [
              { key: "a", match: { value: 1 } },
              { key: "b", match: { value: 1 } },
            ],
            min_count: 1,
          },
        }
      )
    ).toBe(true);
    expect(
      matchFilter(
        { a: 0, b: 0 },
        {
          min_should: {
            conditions: [
              { key: "a", match: { value: 1 } },
              { key: "b", match: { value: 1 } },
            ],
            min_count: 1,
          },
        }
      )
    ).toBe(false);
  });

  it("throws UnsupportedFilterError for match.text", () => {
    expect(() =>
      matchFilter({ t: "hello" }, { key: "t", match: { text: "hello" } })
    ).toThrow(UnsupportedFilterError);
    expect(() =>
      matchFilter({ t: "hello" }, { key: "t", match: { text: "hello" } })
    ).toThrow(/match.text/);
  });

  it("does not use posting candidates for range or except", () => {
    const postings = new Map([
      ["n", new Map([["5", new Set(["1"])]])],
    ]);
    expect(candidateIdsFromFilter({ key: "n", range: { gte: 1 } }, postings)).toBeNull();
    expect(
      candidateIdsFromFilter({ key: "n", match: { except: [1] } }, postings)
    ).toBeNull();
    expect(
      candidateIdsFromFilter({ key: "n", match: { value: 5 } }, postings)?.has("1")
    ).toBe(true);
  });
});
