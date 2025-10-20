import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { spawn, Pool, Worker } from "threads"

const IMAGES_DIR = path.join(__dirname, `./video-images`);
const FRAMES_DIR = path.join(__dirname, `./frames`);
const FRAMES_OUT_DIR = path.join(__dirname, `./frames-processed`);
const IMAGES_OUT_DIR = path.join(__dirname, `./video-images-processed`);
const VIDEO_DIR = path.join(__dirname, `./video`);
const VIDEO_OUT = path.join(__dirname, `./video-out`);

const TILE_SIZE = 120;

class BaseImage {
    imagePath: string = '';
    imageOutPath: string = '';

    constructor(imagePath: string, imageOutPath: string) {
        this.imagePath = imagePath;
        this.imageOutPath = imageOutPath;
    }


    async deriveMeanBrightness(rawGrayscaleData: Uint8Array): Promise<{data: Uint8Array, meanBrightness: number}> {        
        let sum = 0;
        for (let i = 0; i < rawGrayscaleData.length; i++) {
            sum += rawGrayscaleData[i];
        }
        
        const meanBrightness = sum / rawGrayscaleData.length;
        
        return {
            data: rawGrayscaleData,
            meanBrightness
        }
    }
}

class SwapImage extends BaseImage {
    constructor(imagePath: string, imageOutPath: string) {
        super(imagePath, imageOutPath);
    }

    async normalizeImageSize(imageBuffer: Uint8Array): Promise<Buffer> {
        // Always output PNG to avoid unsupported formats in later steps
        return await sharp(imageBuffer)
            .resize(200, 200)
            .png()
            .toBuffer();
    }

    async transformAndOutput() {
        const imageBuffer = await fs.promises.readFile(this.imagePath);
        // Only normalize size, no grayscale conversion
        const normalizedImageBuffer = await this.normalizeImageSize(imageBuffer);

        const rawData = await sharp(normalizedImageBuffer)
            .grayscale()
            .raw()
            .toBuffer();

        const { meanBrightness } = await this.deriveMeanBrightness(rawData);

        // Write the output back to PNG in the original color format
        await sharp(normalizedImageBuffer)
            .png()
            .toFile(this.imageOutPath);

        return {
            imageOutPath: this.imageOutPath,
            meanBrightness: meanBrightness
        }
    }
}

class VideoFrame extends BaseImage {
    private imageMap: Map<number, string> | undefined;
    
    constructor(imagePath: string, imageOutPath: string, imageMap: Map<number, string>) {
        super(imagePath, imageOutPath);
        this.imageMap = imageMap;
    }


    // Static pool shared across all frames for better resource utilization
    private static workerPool: ReturnType<typeof Pool> | null = null;

    static async initializeWorkerPool(concurrency: number = 4) {
        if (!VideoFrame.workerPool) {
            VideoFrame.workerPool = Pool(() => spawn(new Worker("./worker")), {
                name: 'frame-processor-pool',
                concurrency
            });
        }
        return VideoFrame.workerPool;
    }

    static async terminateWorkerPool() {
        if (VideoFrame.workerPool) {
            await VideoFrame.workerPool.terminate();
            VideoFrame.workerPool = null;
        }
    }

    async transformAndOutput() {
        if (!VideoFrame.workerPool) {
            throw new Error('Worker pool not initialized. Call VideoFrame.initializeWorkerPool() first.');
        }

        try {
            // Convert Map to array for serialization
            const imageMapArray = this.imageMap ? Array.from(this.imageMap.entries()) : [];

            // Queue the frame processing task
            await VideoFrame.workerPool.queue(async processFrame => {
                await processFrame({
                    imagePath: this.imagePath,
                    imageOutPath: this.imageOutPath,
                    TILE_SIZE,
                    imageMapArray
                })
            });
        } catch (e) {
            console.error(`Error processing frame ${this.imagePath}:`, e);
            throw e;
        }
    }
}

const processImage = async (imagePath: string) => {
    try {
        const image = new SwapImage(path.join(IMAGES_DIR, imagePath), path.join(IMAGES_OUT_DIR, imagePath));
        return await image.transformAndOutput();
    } catch (e) {
        throw e;
    }
};

const processVideo = async () => {
    try {
        // Reset frames dir
        await fs.promises.rm(FRAMES_DIR, { recursive: true, force: true });
        await fs.promises.mkdir(FRAMES_DIR);

        // Reset frames out dir
        await fs.promises.rm(FRAMES_OUT_DIR, { recursive: true, force: true });
        await fs.promises.mkdir(FRAMES_OUT_DIR);

        const imagePaths = await fs.promises.readdir(IMAGES_DIR);

        const imageMap = new Map<number, string>();
    
        // process images
        console.log(`Processing ${imagePaths.length} reference images...`);
        for (const imagePath of imagePaths) {
            try {
                const { meanBrightness, imageOutPath } = await processImage(imagePath)
                if (!imageMap.has(meanBrightness)) imageMap.set(meanBrightness, imageOutPath);
            } catch (e) {
                throw e;
            }
        }

        const brightnesses = Array.from(imageMap.keys()).sort((a, b) => a - b);
        console.log(`Processed ${imageMap.size} reference images`);
        console.log(`Brightness range: ${brightnesses[0]?.toFixed(2)} - ${brightnesses[brightnesses.length - 1]?.toFixed(2)}`);
        console.log(`Sample brightnesses: ${brightnesses.slice(0, 5).map(b => b.toFixed(2)).join(', ')}`);

        const videoPath = path.join(VIDEO_DIR, 'IMG_3403.MOV');

        const processedFrames = new Set<string>();
        const activeProcessing = new Set<Promise<void>>();
        let frameCount = 0;
        const MAX_CONCURRENT_FRAMES = 3; // Process up to 3 frames in parallel (conservative to avoid memory issues)

        // Promise to track when all processing is complete
        const { promise: processingComplete, resolve, reject } = Promise.withResolvers<void>();

        // Initialize worker pool once for all frames
        await VideoFrame.initializeWorkerPool(MAX_CONCURRENT_FRAMES);

        const processFrame = async (framePath: string) => {
            try {
                const frameImage = new VideoFrame(
                    path.join(FRAMES_DIR, framePath),
                    path.join(FRAMES_OUT_DIR, framePath),
                    imageMap
                );
                await frameImage.transformAndOutput();
                frameCount++;

                // Log memory usage every 10 frames
                if (frameCount % 10 === 0) {
                    const memUsage = process.memoryUsage();
                    console.log(`✓ Completed ${frameCount} frames | Memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(0)}MB / ${(memUsage.heapTotal / 1024 / 1024).toFixed(0)}MB`);
                } else {
                    console.log(`✓ Completed frame ${frameCount}: ${framePath}`);
                }
            } catch (e) {
                console.error(`✗ Failed to process frame: ${framePath}`, e);
                throw e;
            } finally {
                processedFrames.add(framePath);
            }
        };

        const processFrameQueue = async (framePath: string) => {
            // Wait if we hit max concurrency
            while (activeProcessing.size >= MAX_CONCURRENT_FRAMES) {
                await Promise.race(activeProcessing);
            }

            const processingPromise = processFrame(framePath)
                .finally(() => activeProcessing.delete(processingPromise));

            activeProcessing.add(processingPromise);
        };

        const watcher = fs.watch(FRAMES_DIR, async (_eventType, fileName) => {
            if (fileName && fileName.endsWith('.png') && !processedFrames.has(fileName)) {
                try {
                    const { size } = await fs.promises.stat(path.join(FRAMES_DIR, fileName));
                    if (size > 0) {
                        // Process frame immediately (with concurrency control)
                        processFrameQueue(fileName).catch(reject);
                    }
                } catch (e) {
                    // File might not be fully written yet, will catch it on next event
                }
            }
        });

        console.log('Starting video frame extraction and processing...');
        ffmpeg(videoPath)
            .fps(30) // Extract at 30fps
            .on('end', async () => {
                console.log('Frame extraction complete, waiting for processing to finish...');

                try {
                    // Process any remaining frames that might have been missed
                    const remainingFrames = await fs.promises.readdir(FRAMES_DIR);
                    for (const frame of remainingFrames) {
                        if (!processedFrames.has(frame) && frame.endsWith('.png')) {
                            await processFrameQueue(frame);
                        }
                    }

                    // Wait for all active processing to complete
                    await Promise.allSettled(activeProcessing);

                    // Clean up and resolve
                    watcher.close();
                    await VideoFrame.terminateWorkerPool();
                    console.log(`\n✓ All ${frameCount} frames processed successfully`);
                    resolve();
                } catch (err) {
                    watcher.close();
                    await VideoFrame.terminateWorkerPool();
                    reject(err as Error);
                }
            })
            .on('error', async (err) => {
                watcher.close();
                await VideoFrame.terminateWorkerPool();
                reject(err);
            })
            .save(path.join(FRAMES_DIR, 'frame_%04d.png'));

        // Wait for all frame processing to complete
        await processingComplete;

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(path.join(FRAMES_OUT_DIR, 'frame_%04d.png'))
                .inputFPS(30)
                .outputFPS(30)
                .videoCodec('libx264')
                .outputOptions([
                    '-pix_fmt yuv420p',
                    '-crf 18'
                ])
                .on('start', (commandLine) => {
                    console.log('FFmpeg process started:', commandLine);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`Video creation: ${progress.percent.toFixed(1)}% done`);
                    }
                })
                .on('end', () => {
                    console.log('Video creation completed successfully!');
                    resolve(undefined);
                })
                .on('error', (err) => {
                    console.error('Error creating video:', err);
                    reject(err);
                })
                .save(path.join(VIDEO_OUT, 'artistic_video.mp4'));
        });
    } catch (e) {
        throw e;
    }
};


(async () => {
const startTime = Date.now();

await processVideo();

const endTime = Date.now();

const durationMs = endTime - startTime;

console.log({
    durationMs
})
})();