import { describe, it, expect } from "vitest";
import { Semaphore } from "../semaphore.js";

describe("Semaphore", () => {
  it("should reject non-positive concurrency", () => {
    expect(() => new Semaphore(0)).toThrow("positive integer");
    expect(() => new Semaphore(-1)).toThrow("positive integer");
    expect(() => new Semaphore(1.5)).toThrow("positive integer");
  });

  it("should allow immediate acquisition under limit", async () => {
    const sem = new Semaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();

    expect(typeof release1).toBe("function");
    expect(typeof release2).toBe("function");

    release1();
    release2();
  });

  it("should queue acquisitions beyond the limit", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const release1 = await sem.acquire();
    order.push(1);

    const pending = sem.acquire().then((release) => {
      order.push(2);
      return release;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]);

    release1();

    const release2 = await pending;
    expect(order).toEqual([1, 2]);
    release2();
  });

  it("should release slots in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];

    const r1 = await sem.acquire();

    const p2 = sem.acquire().then((rel) => {
      order.push("second");
      return rel;
    });
    const p3 = sem.acquire().then((rel) => {
      order.push("third");
      return rel;
    });

    r1();
    const r2 = await p2;
    r2();
    const r3 = await p3;
    r3();

    expect(order).toEqual(["second", "third"]);
  });
});
