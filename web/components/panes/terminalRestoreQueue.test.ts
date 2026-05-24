import { describe, expect, it } from "vitest";
import { createRestoreLaunchQueue, isRestoreLaunchCancelled } from "./terminalRestoreQueue";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminal restore launch queue", () => {
  it("limits restore launches to the configured concurrency", async () => {
    const queue = createRestoreLaunchQueue(2);
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const third = createDeferred<string>();
    const started: string[] = [];
    const states: Record<string, string[]> = {
      first: [],
      second: [],
      third: [],
    };

    const firstResult = queue.run(() => {
      started.push("first");
      return first.promise;
    }, { onState: (state) => states.first.push(state) });
    const secondResult = queue.run(() => {
      started.push("second");
      return second.promise;
    }, { onState: (state) => states.second.push(state) });
    const thirdResult = queue.run(() => {
      started.push("third");
      return third.promise;
    }, { onState: (state) => states.third.push(state) });

    await flushMicrotasks();

    expect(started).toEqual(["first", "second"]);
    expect(queue.getSnapshot()).toEqual({ active: 2, pending: 1 });
    expect(states.first).toEqual(["launching"]);
    expect(states.second).toEqual(["launching"]);
    expect(states.third).toEqual(["queued"]);

    first.resolve("first");
    await flushMicrotasks();

    expect(started).toEqual(["first", "second", "third"]);
    expect(queue.getSnapshot()).toEqual({ active: 2, pending: 0 });
    expect(states.third).toEqual(["queued", "launching"]);

    second.resolve("second");
    third.resolve("third");
    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).resolves.toBe("second");
    await expect(thirdResult).resolves.toBe("third");
    expect(queue.getSnapshot()).toEqual({ active: 0, pending: 0 });
  });

  it("cancels a queued restore before it launches", async () => {
    const queue = createRestoreLaunchQueue(1);
    const first = createDeferred<string>();
    const started: string[] = [];
    const queuedStates: string[] = [];
    let cancelled = false;

    const firstResult = queue.run(() => {
      started.push("first");
      return first.promise;
    });
    const queuedResult = queue.run(() => {
      started.push("queued");
      return Promise.resolve("queued");
    }, {
      isCancelled: () => cancelled,
      onState: (state) => queuedStates.push(state),
    });

    await flushMicrotasks();
    expect(started).toEqual(["first"]);
    expect(queuedStates).toEqual(["queued"]);

    cancelled = true;
    first.resolve("first");

    await expect(firstResult).resolves.toBe("first");
    await expect(queuedResult).rejects.toSatisfy(isRestoreLaunchCancelled);
    expect(started).toEqual(["first"]);
    expect(queuedStates).toEqual(["queued", "idle"]);
    expect(queue.getSnapshot()).toEqual({ active: 0, pending: 0 });
  });
});
