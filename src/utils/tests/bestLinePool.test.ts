import { expect, test } from "vitest";
import { createLimiter, createWorkerPool, planEngines } from "../bestLinePool";

/** A task that ends when `release()` is called, and records the worker it ran on. */
function gate() {
    let release: (value?: string) => void = () => {};
    const done = new Promise<string>((resolve) => {
        release = (value = "ok") => resolve(value);
    });
    const ran: number[] = [];
    return { task: async (worker: number) => (ran.push(worker), done), release, ran };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a task runs at once when a worker is idle, and frees it when done", async () => {
    const pool = createWorkerPool(2);
    const a = gate();
    const result = pool.run(a.task);
    await tick();
    expect(a.ran).toEqual([0]);
    expect(pool.idle()).toBe(1);
    a.release("done");
    expect(await result).toBe("done");
    expect(pool.idle()).toBe(2);
});

test("tasks wait for a worker in the order they were asked", async () => {
    const pool = createWorkerPool(1);
    const first = gate();
    const second = gate();
    const third = gate();
    const results = [pool.run(first.task), pool.run(second.task), pool.run(third.task)];
    await tick();
    expect([first.ran, second.ran, third.ran]).toEqual([[0], [], []]);
    first.release();
    await tick();
    expect([second.ran, third.ran]).toEqual([[0], []]);
    second.release();
    third.release();
    await Promise.all(results);
    expect(third.ran).toEqual([0]);
});

test("a failing task frees its worker and rejects its caller", async () => {
    const pool = createWorkerPool(1);
    await expect(
        pool.run(async () => {
            throw new Error("engine died");
        }),
    ).rejects.toThrow("engine died");
    expect(pool.idle()).toBe(1);
    expect(await pool.run(async () => 7)).toBe(7);
});

test("workers keep their number from one task to the next", async () => {
    const pool = createWorkerPool(3);
    const gates = [gate(), gate(), gate()];
    const all = gates.map((g) => pool.run(g.task));
    await tick();
    expect(gates.map((g) => g.ran[0]).sort()).toEqual([0, 1, 2]);
    gates[1].release();
    await all[1];
    const again = gate();
    void pool.run(again.task);
    await tick();
    expect(again.ran).toEqual([gates[1].ran[0]]);
    for (const g of [gates[0], gates[2], again]) g.release();
});

test("speculation only takes the workers beyond the reserved ones", async () => {
    const pool = createWorkerPool(3, 1);
    const gates = [gate(), gate(), gate()];
    expect(pool.spare()).toBe(2);
    expect(pool.speculate(gates[0].task)).toBeDefined();
    expect(pool.speculate(gates[1].task)).toBeDefined();
    // One worker is left for the search itself.
    expect(pool.spare()).toBe(0);
    expect(pool.speculate(gates[2].task)).toBeUndefined();
    expect(gates[2].ran).toEqual([]);
    for (const g of gates) g.release();
    await tick();
    expect(pool.spare()).toBe(2);
});

test("a pool of one worker never speculates", () => {
    const pool = createWorkerPool(1, 1);
    expect(pool.spare()).toBe(0);
    expect(pool.speculate(async () => 1)).toBeUndefined();
});

test("speculation never queues, and does not run while someone waits for a worker", async () => {
    const pool = createWorkerPool(2, 1);
    const busy = [gate(), gate()];
    void pool.run(busy[0].task);
    void pool.run(busy[1].task);
    const waiting = gate();
    void pool.run(waiting.task);
    await tick();
    busy[0].release();
    // The freed worker goes to the one waiting, not to a speculation.
    await tick();
    expect(waiting.ran).toEqual([busy[0].ran[0]]);
    expect(pool.speculate(async () => 1)).toBeUndefined();
    for (const g of [busy[1], waiting]) g.release();
});

test("busy lists the workers running a task", async () => {
    const pool = createWorkerPool(3);
    const a = gate();
    const b = gate();
    void pool.run(a.task);
    void pool.run(b.task);
    await tick();
    expect(pool.busy().sort()).toEqual([0, 1]);
    a.release();
    b.release();
    await tick();
    expect(pool.busy()).toEqual([]);
});

const engine = (threads: number, hash: number) => [
    { name: "Threads", value: threads },
    { name: "Hash", value: hash },
    { name: "MultiPV", value: 5 },
];

test("planEngines splits the threads of an engine that has some over several engines", () => {
    expect(planEngines(engine(16, 2048), 16)).toEqual({ workers: 4, threads: 4, hash: 512 });
    expect(planEngines(engine(8, 1024), 16)).toEqual({ workers: 2, threads: 4, hash: 512 });
    expect(planEngines(engine(12, 1200), 16)).toEqual({ workers: 3, threads: 4, hash: 400 });
});

test("planEngines never uses more threads than the machine has or the engine was given", () => {
    expect(planEngines(engine(64, 2048), 16)).toEqual({ workers: 4, threads: 4, hash: 512 });
    expect(planEngines(engine(16, 2048), 8)).toEqual({ workers: 2, threads: 4, hash: 1024 });
});

test("planEngines leaves a small engine as it is", () => {
    expect(planEngines(engine(4, 256), 16)).toEqual({ workers: 1 });
    expect(planEngines(engine(1, 16), 16)).toEqual({ workers: 1 });
    expect(planEngines(engine(16, 2048), 2)).toEqual({ workers: 1 });
});

test("planEngines leaves an engine without threads or hash options as it is", () => {
    expect(planEngines([{ name: "MultiPV", value: 5 }], 16)).toEqual({ workers: 1 });
    expect(planEngines([{ name: "Threads", value: 16 }], 16)).toEqual({ workers: 1 });
    expect(planEngines(undefined, 16)).toEqual({ workers: 1 });
});

test("planEngines reads values stored as text", () => {
    expect(
        planEngines(
            [
                { name: "Threads", value: "16" },
                { name: "Hash", value: "2048" },
            ],
            16,
        ),
    ).toEqual({ workers: 4, threads: 4, hash: 512 });
});

test("a limiter runs at most as many calls at once as it was given, in the order asked", async () => {
    const limit = createLimiter(2);
    const gates = [gate(), gate(), gate(), gate()];
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const calls = gates.map((g, i) =>
        limit(async () => {
            started.push(i);
            most = Math.max(most, ++running);
            try {
                return await g.task(0);
            } finally {
                running--;
            }
        }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    gates[0].release();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[1].release();
    gates[2].release();
    gates[3].release();
    await Promise.all(calls);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(most).toBe(2);
});

test("a limiter frees its place when a call fails", async () => {
    const limit = createLimiter(1);
    await expect(
        limit(async () => {
            throw new Error("no answer");
        }),
    ).rejects.toThrow("no answer");
    expect(await limit(async () => "next")).toBe("next");
});
