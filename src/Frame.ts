import os from 'os';
import { spawn, Pool, Worker } from "threads"
import BaseImage from "./BaseImage";

export default class Frame extends BaseImage {
    private imageMap: Map<number, string> | undefined;
    
    constructor(imagePath: string, imageOutPath: string, imageMap: Map<number, string>) {
        super(imagePath, imageOutPath);
        this.imageMap = imageMap;
    }


    // Static pool shared across all frames for better resource utilization
    private static workerPool: ReturnType<typeof Pool> | null = null;

    static async initializeWorkerPool(concurrency?: number) {
        if (!Frame.workerPool) {
            const cpuCount = os.cpus().length;
            // Conservative: Cap at 4 workers to prevent Sharp resource exhaustion
            // Each worker creates multiple Sharp instances, so too many workers = system overload
            const optimalConcurrency = concurrency || Math.min(4, Math.max(2, cpuCount - 2));

            Frame.workerPool = Pool(() => spawn(new Worker("./worker")), {
                name: 'frame-processor-pool',
                concurrency: optimalConcurrency
            });

            console.log(`Initialized worker pool with ${optimalConcurrency} workers (${cpuCount} CPU cores detected, capped at 4 for stability)`);
        }
        return Frame.workerPool;
    }

    static async terminateWorkerPool() {
        if (Frame.workerPool) {
            try {
                console.log('  Waiting for all workers to complete...');
                // First ensure all queued tasks are completed
                await Frame.workerPool.completed();
                console.log('  All workers completed, terminating pool...');

                // Then terminate with timeout
                const terminatePromise = Frame.workerPool.terminate();
                const timeoutPromise = new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('Worker pool termination timed out')), 5000)
                );

                await Promise.race([terminatePromise, timeoutPromise]);
                Frame.workerPool = null;
            } catch (e) {
                console.warn('⚠️  Worker pool termination failed or timed out:', e);
                // Force set to null anyway to prevent re-use
                Frame.workerPool = null;
            }
        }
    }

    async transformAndOutput() {
        if (!Frame.workerPool) {
            throw new Error('Worker pool not initialized. Call Frame.initializeWorkerPool() first.');
        }

        try {
            // Convert Map to array for serialization
            const imageMapArray = this.imageMap ? Array.from(this.imageMap.entries()) : [];

            // Queue the frame processing task
            await Frame.workerPool.queue(async processFrame => {
                await processFrame({
                    imagePath: this.imagePath,
                    imageOutPath: this.imageOutPath,
                    TILE_SIZE: 140,
                    imageMapArray
                })
            });
        } catch (e) {
            console.error(`Error processing frame ${this.imagePath}:`, e);
            throw e;
        }
    }
}
