/**
 * Positions waiting to be searched, most urgent first. A linear scan is enough:
 * the frontier holds at most a few thousand entries while every expansion costs
 * a network request.
 */
export class Frontier<T> {
    private entries: { item: T; priority: number }[] = [];

    push(item: T, priority: number) {
        this.entries.push({ item, priority });
    }

    get size() {
        return this.entries.length;
    }

    /** Removes and returns the most urgent entry. */
    pop(): T | undefined {
        if (this.entries.length === 0) return undefined;
        let best = 0;
        for (let i = 1; i < this.entries.length; i++) {
            if (this.entries[i].priority > this.entries[best].priority) best = i;
        }
        const [entry] = this.entries.splice(best, 1);
        return entry.item;
    }

    /** The `count` most urgent entries, left in place. */
    peek(count: number): T[] {
        return [...this.entries]
            .sort((a, b) => b.priority - a.priority)
            .slice(0, count)
            .map((entry) => entry.item);
    }
}
