
import { expose } from "threads/worker"
import fs from 'fs';
import sharp from 'sharp';

import { deriveMeanBrightness, matchNearestImage } from './helpers.ts';


sharp.concurrency(1); // Process one Sharp operation at a time per worker

// Cache for resized reference images to avoid repeated disk I/O and processing
const imageCache = new Map<string, Buffer>();

async function getCachedResizedImage(framePath: string, width: number, height: number): Promise<Buffer> {
    const cacheKey = `${framePath}:${width}x${height}`;

    if (!imageCache.has(cacheKey)) {
        const resizedBuffer = await sharp(framePath)
            .resize(width, height)
            .toBuffer();
        imageCache.set(cacheKey, resizedBuffer);
    }

    return imageCache.get(cacheKey)!;
}

expose(async function processFrame({
    framePath,
    frameOutPath,
    TILE_SIZE,
    imageMapArray
}: {
    framePath: string;
    frameOutPath: string;
    TILE_SIZE: number;
    imageMapArray: Array<[number, string]>;
}) {
    let grayscaleImage: sharp.Sharp | undefined;;
    let processedImage: sharp.Sharp | undefined;

    try {
        // Read frame from disk
        const imageBuffer = await fs.promises.readFile(framePath);
        const metadata = await sharp(imageBuffer).metadata();
        const { width, height } = metadata;

        if (!width || !height) {
            throw new Error("Failed to get image dimensions.");
        }

        // Apply high contrast to the original frame BEFORE processing
        // This expands the brightness range to utilize more swap images
        grayscaleImage = sharp(imageBuffer)
            .linear(1.2, -80)  // Increase contrast: multiply by 2.0, subtract 80
            .grayscale();

        const grayscalePngBuffer = await grayscaleImage.raw().toBuffer();

        const tilesX = Math.ceil(width / TILE_SIZE);
        const tilesY = Math.ceil(height / TILE_SIZE);

        // Blank canvas for composite operations
        let processedImage = sharp({
            create: {
                width: width,
                height: height,
                channels: 3,
                background: { r: 0, g: 0, b: 0 }
            }
        });

        const compositeOperations: Array<{input: Buffer, left: number, top: number}> = [];
        const totalTiles = tilesX * tilesY;

        let completedTiles = 0;
        let lastLogged = 0;

        for (let tileY = 0; tileY < tilesY; tileY++) {
            for (let tileX = 0; tileX < tilesX; tileX++) {
                const x = tileX * TILE_SIZE;
                const y = tileY * TILE_SIZE;
                const tileWidth = Math.min(TILE_SIZE, width - x);
                const tileHeight = Math.min(TILE_SIZE, height - y);

                // Prepare buffer slice for this tile (grayscale, so channels = 1)
                const rowStride = width;
                const tileSize = tileWidth * tileHeight;
                const tileRaw = Buffer.allocUnsafe(tileSize);

                // Extract tile data row by row from the full frame grayscale buffer
                for (let row = 0; row < tileHeight; row++) {
                    grayscalePngBuffer.copy(
                        tileRaw,
                        row * tileWidth,
                        (y + row) * rowStride + x,
                        (y + row) * rowStride + (x + tileWidth)
                    );
                }

                // Process tile
                try {
                    const { meanBrightness } = await deriveMeanBrightness(tileRaw);
                    const nearestImage = matchNearestImage(meanBrightness, imageMapArray);

                    if (nearestImage) {
                        // Use cached resized image
                        const replacementBuffer = await getCachedResizedImage(nearestImage, tileWidth, tileHeight);
                        compositeOperations.push({
                            input: replacementBuffer,
                            left: x,
                            top: y
                        });
                    }
                } catch(e) {
                    console.error(`Error processing tile at (${x}, ${y}):`, e);
                }

                completedTiles++;
                // Log progress every 20%
                const p = Math.floor((completedTiles/totalTiles)*5);
                if (p !== lastLogged) {
                    lastLogged = p;
                    console.log(`  ${(completedTiles/totalTiles*100).toFixed(0)}% of tiles`);
                }
            }
        }


        console.log(`  Applying ${compositeOperations.length} composite operations...`);
        console.log(`  Match rate: ${compositeOperations.length}/${totalTiles} tiles (${Math.round(compositeOperations.length/totalTiles*100)}%)`);

        // Apply all composite operations at once
        if (compositeOperations.length > 0) {
            processedImage = processedImage.composite(compositeOperations);
        }
        console.log("  Saving processed frame...");
        await processedImage.png().toFile(frameOutPath);
    } catch (e) {
        console.error(`Failed to process frame ${framePath}:`, e);
        throw e;
    } finally {
        // Clean up Sharp instances to prevent memory leaks
        if (grayscaleImage) {
            try {
                grayscaleImage.destroy();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        if (processedImage) {
            try {
                processedImage.destroy();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }
})