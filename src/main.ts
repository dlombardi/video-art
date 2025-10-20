import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';

import Frame from './Frame';
import SwapImage from './SwapImage.ts';

const ASSETS_DIR = path.join(__dirname, '../assets');
const SWAP_IMAGES_DIR = path.join(ASSETS_DIR, `./swap-images`);
const FRAMES_DIR = path.join(ASSETS_DIR, `./frames`);
const VIDEO_DIR = path.join(ASSETS_DIR, `./video`);
const FRAMES_OUT_DIR = path.join(ASSETS_DIR, `./frames-out`);
const IMAGES_OUT_DIR = path.join(ASSETS_DIR, `./video-images-out`);
const VIDEO_OUT = path.join(ASSETS_DIR, `./video-out`);

const resetDirectories = async () => {
    // Reset frames dir
    await fs.promises.rm(FRAMES_DIR, { recursive: true, force: true });
    await fs.promises.mkdir(FRAMES_DIR);

    // Reset frames out dir
    await fs.promises.rm(FRAMES_OUT_DIR, { recursive: true, force: true });
    await fs.promises.mkdir(FRAMES_OUT_DIR);

    // Reset video out dir
    await fs.promises.rm(VIDEO_OUT, { recursive: true, force: true });
    await fs.promises.mkdir(VIDEO_OUT);
}

const processSwapImages = async (): Promise<Map<number, string>> => {
    const swapImageMap = new Map<number, string>();
    const imagePaths = await fs.promises.readdir(SWAP_IMAGES_DIR);

    // process images
    console.log(`Processing ${imagePaths.length} reference images...`);
    for (const imagePath of imagePaths) {
        try {
            const image = new SwapImage(path.join(SWAP_IMAGES_DIR, imagePath), path.join(IMAGES_OUT_DIR, imagePath));
            const { meanBrightness, imageOutPath } = await image.transformAndOutput();
            if (!swapImageMap.has(meanBrightness)) swapImageMap.set(meanBrightness, imageOutPath);
        } catch (e) {
            throw e;
        }
    }

    return swapImageMap;
}

const processVideo = async () => {
    try {
        const videoPath = path.join(VIDEO_DIR, 'IMG_3403.MOV');

        await resetDirectories();

        const swapImageMap = await processSwapImages();

        const processedFrames = new Set<string>();
        const frameProcessingPromises: Promise<void>[] = [];
        let frameCount = 0;

        // Promise to track when all processing is complete
        const { promise: processingComplete, resolve, reject } = Promise.withResolvers<void>();

        // Initialize worker pool - will auto-detect CPU cores and create optimal number of workers
        await Frame.initializeWorkerPool();

        const processFrame = async (framePath: string) => {
            try {
                const frameImage = new Frame(
                    path.join(FRAMES_DIR, framePath),
                    path.join(FRAMES_OUT_DIR, framePath),
                    swapImageMap
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

        const watcher = fs.watch(FRAMES_DIR, async (_eventType, fileName) => {
            if (fileName && fileName.endsWith('.png') && !processedFrames.has(fileName)) {
                try {
                    const { size } = await fs.promises.stat(path.join(FRAMES_DIR, fileName));
                    if (size > 0) {
                        // Queue frame processing - worker pool handles concurrency automatically
                        const promise = processFrame(fileName).catch(reject);
                        frameProcessingPromises.push(promise);
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
                            const promise = processFrame(frame).catch(reject);
                            frameProcessingPromises.push(promise);
                        }
                    }

                    // Wait for all frame processing to complete
                    await Promise.allSettled(frameProcessingPromises);

                    // Clean up and resolve
                    watcher.close();
                    await Frame.terminateWorkerPool();
                    console.log(`\n✓ All ${frameCount} frames processed successfully`);
                    resolve();
                } catch (err) {
                    watcher.close();
                    await Frame.terminateWorkerPool();
                    reject(err as Error);
                }
            })
            .on('error', async (err) => {
                watcher.close();
                await Frame.terminateWorkerPool();
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