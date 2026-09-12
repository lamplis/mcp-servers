import { describe, expect, it } from "vitest";
import {
  countPayloadHygiene,
  isWhitespaceOnlyPayload,
  matchesFlagPatterns,
} from "../payload-hygiene.js";

describe("payload hygiene", () => {
  it("detects whitespace-only codeChunk payloads", () => {
    expect(isWhitespaceOnlyPayload({ codeChunk: "   \n" })).toBe(true);
    expect(isWhitespaceOnlyPayload({ codeChunk: "fn main() {}" })).toBe(false);
    expect(isWhitespaceOnlyPayload({ path: "/a.ts" })).toBe(false);
  });

  it("flags conversion-error text without dropping it", () => {
    expect(
      matchesFlagPatterns(
        { codeChunk: "Error converting DOCX file foo.docx" },
        ["Error converting", "Traceback"]
      )
    ).toBe(true);
    expect(matchesFlagPatterns({ codeChunk: "ok" }, ["Error converting"])).toBe(
      false
    );
  });

  it("counts empty and flagged points separately", () => {
    const counts = countPayloadHygiene(
      [
        { payload: { codeChunk: "   " } },
        { payload: { codeChunk: "Error converting DOCX" } },
        { payload: { codeChunk: "real code" } },
      ],
      ["Error converting"]
    );
    expect(counts.emptyPayloadPoints).toBe(1);
    expect(counts.flaggedPayloadPoints).toBe(1);
  });
});
