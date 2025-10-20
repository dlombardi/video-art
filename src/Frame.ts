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
            await Frame.workerPool.terminate();
            Frame.workerPool = null;
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
