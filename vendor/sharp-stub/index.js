/**
 * Pure-JS stand-in for `sharp`. No native addon, no libvips download.
 * `@xenova/transformers` imports this module on load; text pipelines never call it.
 */

const IMAGE_UNSUPPORTED =
  "Native sharp/libvips is not available on this workstation. Text embeddings work; image pipelines do not. Keep ENABLE_IMAGE_TO_TEXT=false and do not pass images to Transformers.js.";

function fail() {
  return Promise.reject(new Error(IMAGE_UNSUPPORTED));
}

function chain() {
  return {
    rotate() {
      return this;
    },
    raw() {
      return this;
    },
    resize() {
      return this;
    },
    png() {
      return this;
    },
    jpeg() {
      return this;
    },
    webp() {
      return this;
    },
    toBuffer() {
      return fail();
    },
    metadata() {
      return fail();
    },
    toFile() {
      return fail();
    },
  };
}

function sharp() {
  return chain();
}

sharp.cache = function cache() {};
sharp.concurrency = function concurrency() {
  return 1;
};
sharp.simd = function simd() {
  return false;
};
sharp.format = {};
sharp.versions = { vips: "stub" };

export default sharp;
