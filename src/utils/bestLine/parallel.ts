/**
 * Waits for every task, then reports the first failure. Tasks run side by side
 * to use several engines at once; a failure must not return while the others
 * are still changing the tree, as the search then hands it over as it is.
 */
export async function settleAll(tasks: Promise<unknown>[]): Promise<void> {
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
        if (result.status === "rejected") throw result.reason;
    }
}
