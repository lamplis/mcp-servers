declare function sharp(..._args: unknown[]): SharpStub;

interface SharpStub {
  rotate(..._args: unknown[]): SharpStub;
  raw(..._args: unknown[]): SharpStub;
  resize(..._args: unknown[]): SharpStub;
  png(..._args: unknown[]): SharpStub;
  jpeg(..._args: unknown[]): SharpStub;
  webp(..._args: unknown[]): SharpStub;
  toBuffer(..._args: unknown[]): Promise<never>;
  metadata(..._args: unknown[]): Promise<never>;
  toFile(..._args: unknown[]): Promise<never>;
}

declare namespace sharp {
  function cache(..._args: unknown[]): void;
  function concurrency(..._args: unknown[]): number;
  function simd(..._args: unknown[]): boolean;
  const format: Record<string, unknown>;
  const versions: { vips: string };
}

export default sharp;
