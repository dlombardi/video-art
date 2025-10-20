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

        // Step 1: Extract all frames from video
        console.log('🎬 Extracting frames from video...');
        await new Promise<void>((resolve, reject) => {
            ffmpeg(videoPath)
                .fps(30)
                .on('end', () => {
                    console.log('✓ Frame extraction complete');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('✗ Frame extraction failed:', err);
                    reject(err);
                })
                .save(path.join(FRAMES_DIR, 'frame_%04d.png'));
        });

        // Step 2: Process all extracted frames in parallel
        console.log('\n🖼️  Processing frames with tile replacement...');
        const frameFiles = await fs.promises.readdir(FRAMES_DIR);
        const frameNames = frameFiles.filter(f => f.endsWith('.png')).sort();

        console.log(`Found ${frameNames.length} frames to process`);

        // Initialize worker pool
        await Frame.initializeWorkerPool();

        const failedFrames: string[] = [];
        let successCount = 0;

        try {
            // Process all frames in parallel (worker pool manages concurrency)
            await Promise.all(frameNames.map(async (frameName) => {
                try {
                    const frameImage = new Frame(
                        path.join(FRAMES_DIR, frameName),
                        path.join(FRAMES_OUT_DIR, frameName),
                        swapImageMap
                    );
                    await frameImage.transformAndOutput();
                    successCount++;

                    // Log progress
                    if (successCount % 10 === 0) {
                        const memUsage = process.memoryUsage();
                        console.log(`✓ Completed ${successCount}/${frameNames.length} frames | Memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(0)}MB`);
                    }
                } catch (e) {
                    console.error(`✗ Failed to process frame: ${frameName}`, e);
                    failedFrames.push(frameName);
                }
            }));

            console.log(`\n📊 Processing Summary:`);
            console.log(`  Total frames: ${frameNames.length}`);
            console.log(`  Successful: ${successCount}`);
            console.log(`  Failed: ${failedFrames.length}`);

            if (failedFrames.length > 0) {
                console.log(`  Failed frames: ${failedFrames.slice(0, 5).join(', ')}${failedFrames.length > 5 ? ` and ${failedFrames.length - 5} more` : ''}`);
            }
        } finally {
            // Skip worker pool termination - threads library hangs with Bun
            // Workers will be cleaned up when process exits
            console.log('\n✓ Frame processing complete (skipping worker cleanup)');
        }

        // Step 3: Encode video from processed frames
        console.log('\n📹 Step 3: Starting video encoding...');
        const processedFrameFiles = await fs.promises.readdir(FRAMES_OUT_DIR);
        const validFrames = processedFrameFiles.filter(f => f.endsWith('.png'));

        console.log(`\n🎬 Creating video from ${validFrames.length} processed frames...`);

        if (validFrames.length === 0) {
            console.error('❌ No processed frames found! Cannot create video.');
            throw new Error('No processed frames available for video creation');
        }

        if (failedFrames.length > 0 && failedFrames.length / frameNames.length > 0.1) {
            console.warn(`⚠️  Warning: ${((failedFrames.length / frameNames.length) * 100).toFixed(1)}% of frames failed. Video may have gaps or artifacts.`);
        }

        await new Promise((resolve, reject) => {
            const command = ffmpeg()
                .input(path.join(FRAMES_OUT_DIR, 'frame_%04d.png'))
                .inputFPS(30)
                .outputFPS(30)
                .videoCodec('libx264')
                .outputOptions([
                    '-pix_fmt yuv420p',
                    '-crf 18',
                    '-preset fast',           // Faster encoding, less memory
                    '-max_muxing_queue_size 1024'  // Limit buffer size
                ])
                .on('start', (commandLine) => {
                    console.log('\n🎥 FFmpeg encoding started...');
                    console.log(`Command: ${commandLine}`);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`  Encoding: ${progress.percent.toFixed(1)}% complete`);
                    }
                })
                .on('end', () => {
                    console.log('\n✅ Video creation completed successfully!');
                    console.log(`📹 Output: ${path.join(VIDEO_OUT, 'artistic_video.mp4')}`);
                    resolve(undefined);
                })
                .on('error', (err) => {
                    console.error('\n❌ Error creating video:', err);
                    console.error('Error details:', err.message || err);
                    reject(err);
                });

            // Kill ffmpeg if it's taking too long or hanging
            const timeout = setTimeout(() => {
                console.error('\n⏱️  FFmpeg encoding timed out after 5 minutes');
                command.kill('SIGKILL');
                reject(new Error('FFmpeg encoding timeout'));
            }, 5 * 60 * 1000); // 5 minute timeout

            command.on('end', () => clearTimeout(timeout));
            command.on('error', () => clearTimeout(timeout));

            command.save(path.join(VIDEO_OUT, 'artistic_video.mp4'));
        });
    } catch (e) {
        throw e;
    }
};


(async () => {
    const startTime = Date.now();

    try {
        await processVideo();

        const endTime = Date.now();
        const durationMs = endTime - startTime;
        const durationSec = (durationMs / 1000).toFixed(1);

        console.log(`\n⏱️  Total time: ${durationSec}s (${(durationMs / 60000).toFixed(1)} minutes)`);
    } catch (error) {
        console.error('\n💥 Fatal error during video processing:');
        console.error(error);
        process.exit(1);
    }
})();