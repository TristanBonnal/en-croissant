/**
 * Engines for the best-line search. One engine given all the machine's threads
 * is a poor use of them for this work: the search asks for many short,
 * independent analyses, and an engine's threads help a single search little
 * (on 16 threads, 96 analyses of a search took 40 s; as 4 engines of 4 threads
 * side by side they took 13 s, as 16 engines of one thread 6 s). So the
 * analyses run on a few engines, and the search starts the ones it will soon
 * need while it waits (`speculate`).
 */

/** Most engines run side by side for a search. */
export const MAX_WORKERS = 4;
/** Threads of each engine when the machine has many. */
export const THREADS_PER_WORKER = 4;

export type WorkerPool = {
    /** Number of workers. */
    readonly size: number;
    /** Runs `task` on the first idle worker, or as soon as one is free, in the order asked. */
    run<T>(task: (worker: number) => Promise<T>): Promise<T>;
    /**
     * Starts `task` ahead of need on an idle worker, or returns undefined: it
     * never waits, and leaves `reserve` workers to the tasks the search waits on.
     */
    speculate<T>(task: (worker: number) => Promise<T>): Promise<T> | undefined;
    /** Workers running nothing. */
    idle(): number;
    /** Workers a speculation may still take. */
    spare(): number;
    /** Workers running a task. */
    busy(): number[];
};

export function createWorkerPool(size: number, reserve = 1): WorkerPool {
    const free = Array.from({ length: size }, (_, worker) => worker);
    const waiting: ((worker: number) => void)[] = [];

    function start<T>(worker: number, task: (worker: number) => Promise<T>): Promise<T> {
        return task(worker).finally(() => {
            const next = waiting.shift();
            if (next) next(worker);
            else free.push(worker);
        });
    }

    const spare = () => (waiting.length > 0 ? 0 : Math.max(0, free.length - reserve));

    return {
        size,
        run(task) {
            const worker = free.shift();
            if (worker !== undefined) return start(worker, task);
            return new Promise<number>((resolve) => waiting.push(resolve)).then((w) =>
                start(w, task),
            );
        },
        speculate(task) {
            if (spare() === 0) return undefined;
            return start(free.shift() as number, task);
        },
        idle: () => free.length,
        spare,
        busy: () =>
            Array.from({ length: size }, (_, worker) => worker).filter((w) => !free.includes(w)),
    };
}

/**
 * Lets at most `max` calls run at once, the others waiting their turn. A place
 * freed goes straight to the call waiting, so the limit holds at every moment.
 */
export function createLimiter(max: number) {
    let running = 0;
    const waiting: (() => void)[] = [];
    return async function limit<T>(fn: () => Promise<T>): Promise<T> {
        if (running < max) running++;
        else await new Promise<void>((resolve) => waiting.push(resolve));
        try {
            return await fn();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else running--;
        }
    };
}

/** How the engine's threads and memory are shared among the engines of a search. */
export type EnginePlan = {
    workers: number;
    /** Threads and hash (MB) of each engine; unset when the engine's own settings stand. */
    threads?: number;
    hash?: number;
};

type EngineSetting = { name: string; value?: string | number | boolean | null };

function numberSetting(settings: EngineSetting[], name: string): number | undefined {
    const value = Number(settings.find((s) => s.name === name)?.value);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Engines to run for the settings of an engine on a machine with `cores`
 * threads: the engine's own thread count, capped at the machine's, is shared
 * among up to `MAX_WORKERS` engines of `THREADS_PER_WORKER` threads, and so is
 * its hash. An engine without thread and hash options (one that runs on a GPU,
 * say) or with few threads is left alone.
 */
export function planEngines(settings: EngineSetting[] | undefined, cores: number): EnginePlan {
    const threads = settings && numberSetting(settings, "Threads");
    const hash = settings && numberSetting(settings, "Hash");
    if (!settings || !threads || !hash) return { workers: 1 };
    const budget = Math.floor(Math.min(threads, cores));
    const workers = Math.min(MAX_WORKERS, Math.floor(budget / THREADS_PER_WORKER));
    if (workers < 2) return { workers: 1 };
    return {
        workers,
        threads: Math.floor(budget / workers),
        hash: Math.max(16, Math.floor(hash / workers)),
    };
}
