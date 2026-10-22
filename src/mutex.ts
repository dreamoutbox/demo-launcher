/**
 * In-memory mutex to serialize asynchronous operations within a Durable Object instance.
 */
export class Mutex {
    private queue: Promise<void> = Promise.resolve();

    async lock(): Promise<() => void> {
        let unlockNext!: () => void;
        const nextLock = new Promise<void>((resolve) => {
            unlockNext = resolve;
        });
        const willWait = this.queue;
        this.queue = this.queue.then(() => nextLock);
        await willWait;
        return unlockNext;
    }
}
