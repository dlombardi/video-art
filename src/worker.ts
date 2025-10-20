
import { expose } from "threads/worker"
import fs from 'fs';
import sharp from 'sharp';

import { deriveMeanBrightness, matchNearestImage } from './helpers.ts';

// Limit Sharp's internal concurrency to prevent resource exhaustion
// With multiple workers, we need to be conservative
sharp.concurrency(1); // Process one Sharp operation at a time per worker
sharp.cache({ memory: 50, files: 0, items: 20 }); // Limit cache size

// Cache for resized reference images to avoid repeated disk I/O and processing
const imageCache = new Map<string, Buffer>();

async function getCachedResizedImage(imagePath: string, width: number, height: number): Promise<Buffer> {
    const cacheKey = `${imagePath}:${width}x${height}`;

    if (!imageCache.has(cacheKey)) {
        const resizedBuffer = await sharp(imagePath)
            .resize(width, height)
            .toBuffer();
        imageCache.set(cacheKey, resizedBuffer);
    }

    return imageCache.get(cacheKey)!;
}

expose(async function processFrame({
    imagePath,
    imageOutPath,
    TILE_SIZE,
    imageMapArray
}: {
    imagePath: string;
    imageOutPath: string;
    TILE_SIZE: number;
    imageMapArray: Array<[number, string]>;
}) {
    let grayscaleImage;
    let processedImage;

    try {
        // Read frame from disk
        const imageBuffer = await fs.promises.readFile(imagePath);
        const metadata = await sharp(imageBuffer).metadata();
        const { width, height } = metadata;

        if (!width || !height) {
            throw new Error("Failed to get image dimensions.");
        }

        // Precompute grayscale once with error handling
        grayscaleImage = sharp(imageBuffer)
            .grayscale()
            .linear(2.0, -80);

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

        // Process tiles sequentially - parallelism comes from multiple workers processing different frames
        for (let tileY = 0; tileY < tilesY; tileY++) {
            for (let tileX = 0; tileX < tilesX; tileX++) {
                const x = tileX * TILE_SIZE;
                const y = tileY * TILE_SIZE;
                const tileWidth = Math.min(TILE_SIZE, width - x);
                const tileHeight = Math.min(TILE_SIZE, height - y);

                // Prepare buffer slice for this tile
                const channelsCount = 1; // grayscale
                const rowStride = width * channelsCount;
                const tileSize = tileWidth * tileHeight * channelsCount;
                const tileRaw = Buffer.allocUnsafe(tileSize);

                // Extract tile data row by row from the full frame grayscale buffer
                for (let row = 0; row < tileHeight; row++) {
                    grayscalePngBuffer.copy(
                        tileRaw,
                        row * tileWidth,
                        (y + row) * rowStride + x * channelsCount,
                        (y + row) * rowStride + (x + tileWidth) * channelsCount
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
        await processedImage.png().toFile(imageOutPath);
    } catch (e) {
        console.error(`Failed to process frame ${imagePath}:`, e);
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