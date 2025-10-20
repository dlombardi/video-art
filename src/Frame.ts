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
            // Default to CPU core count minus 1 for optimal parallelism (leave one core for system/main thread)
            const cpuCount = os.cpus().length;
            const optimalConcurrency = concurrency || Math.max(1, cpuCount - 1);

            Frame.workerPool = Pool(() => spawn(new Worker("./worker")), {
                name: 'frame-processor-pool',
                concurrency: optimalConcurrency
            });

            console.log(`Initialized worker pool with ${optimalConcurrency} workers (${cpuCount} CPU cores detected)`);
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
