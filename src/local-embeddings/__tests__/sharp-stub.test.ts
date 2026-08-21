import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { env } from "@xenova/transformers";

describe("sharp stub (no native libvips)", () => {
  it("exports a function so Transformers.js can load", () => {
    expect(typeof sharp).toBe("function");
    expect(sharp.versions.vips).toBe("stub");
  });

  it("rejects image operations with a workstation message", async () => {
    await expect(sharp().metadata()).rejects.toThrow(/libvips|workstation|image/i);
  });

  it("lets @xenova/transformers import for text embeddings", () => {
    expect(env).toBeDefined();
    expect(env.allowLocalModels).toBeTypeOf("boolean");
  });
});
