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

const TILE_SIZE = 100;


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

    matchNearestImage = (meanTileBrightness: number) => {
        if (!this.imageMap) return;

        let nearestKey: number | null = null;
        let smallestDelta = Infinity;
        for (const [brightness] of this.imageMap?.entries()) {
            const delta = Math.abs(brightness - meanTileBrightness);
            if (delta < smallestDelta) {
                smallestDelta = delta;
                nearestKey = brightness;
            }
        }

        if (nearestKey === null) return;
        return this.imageMap.get(nearestKey);
    }

    async processTileWorker(data: { x: number, y: number, tileWidth: number, tileHeight: number, buffer: Uint8Array }) {
        try {
            const {x, y, tileWidth, tileHeight, buffer} = data;
            const tileBuffer = await sharp(buffer)
                .extract({ left: x, top: y, width: tileWidth, height: tileHeight })
                .raw()
                .toBuffer();

            const { meanBrightness } = await this.deriveMeanBrightness(tileBuffer);

            const nearestImage = this.matchNearestImage(meanBrightness);

            if (nearestImage) {
                const replacementBuffer = await sharp(nearestImage)
                    .resize(tileWidth, tileHeight)
                    .toBuffer();

                return {
                    input: replacementBuffer,
                    left: x,
                    top: y
                }
            } else {
                console.warn(`No matching image found for tile at (${x}, ${y}) with brightness ${meanBrightness.toFixed(2)}`);
            }
        } catch (e) {
            throw e
        }
    }

    async transformAndOutput() {
        try {
            // Convert Map to array for serialization
            const imageMapArray = this.imageMap ? Array.from(this.imageMap.entries()) : [];

            const pool = Pool(() => spawn(new Worker("./worker")), { name: 'process-frame-worker', concurrency: 10 })

            pool.queue(async processFrame => {
                await processFrame({
                    imagePath: this.imagePath,
                    imageOutPath: this.imageOutPath,
                    TILE_SIZE,
                    imageMapArray
                })
            });

            await pool.completed()
            await pool.terminate()
        } catch (e) {
            console.log(e)
            throw e
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
        await fs.promises.rm(FRAMES_DIR, { recursive: true, force: true });
        await fs.promises.mkdir(FRAMES_DIR);

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

        const frameQueue: string[] = [];
        const processedFrames = new Set<string>();
        let isProcessing = false;
        let frameCount = 0;
        let ffmpegComplete = false;

        // Promise to track when all processing is complete
        const { promise: processingComplete, resolve, reject } = Promise.withResolvers<void>();

        const processFrameQueue = async () => {
            if (isProcessing) return;
            isProcessing = true;

            while (frameQueue.length > 0) {
                const framePath = frameQueue.shift()!

                console.log(`\nProcessing frame: ${framePath}`);
                const frameImage = new VideoFrame(path.join(FRAMES_DIR, framePath), path.join(FRAMES_OUT_DIR, framePath), imageMap);
                await frameImage.transformAndOutput()
                processedFrames.add(framePath);
                frameCount++;
            }

            isProcessing = false;

            // Check if we're completely done
            if (ffmpegComplete && frameQueue.length === 0) {
                watcher.close();
                console.log(`\n✓ Processed ${frameCount} frames`);
                resolve();
            }
        }

        const watcher = fs.watch(FRAMES_DIR, async (_eventType, fileName) => {
            if (fileName && fileName.endsWith('.png') && !processedFrames.has(fileName)) {
                try {
                    const { size } = await fs.promises.stat(path.join(FRAMES_DIR, fileName));
                    if (size > 0 && !frameQueue.includes(fileName)) {
                        frameQueue.push(fileName)
                        processFrameQueue()
                    }
                } catch (e) {
                    throw e;
                }
            }
        });

        console.log('Starting video frame extraction and processing...');
        ffmpeg(videoPath)
            .fps(30) // Extract at 30fps
            .on('end', async () => {
                console.log('Frame extraction complete, waiting for processing to finish...');
                ffmpegComplete = true;

                // Process any remaining frames that might have been missed
                const remainingFrames = await fs.promises.readdir(FRAMES_DIR);
                for (const frame of remainingFrames) {
                    if (!processedFrames.has(frame) && !frameQueue.includes(frame) && frame.endsWith('.png')) {
                        frameQueue.push(frame);
                    }
                }

                await processFrameQueue();
            })
            .on('error', (err) => {
                watcher.close();
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