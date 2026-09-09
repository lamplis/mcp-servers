import { describe, expect, it } from "vitest";
import { matchFilter } from "../qdrant-filter.js";

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
});
