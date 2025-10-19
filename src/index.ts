import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';

const IMAGES_DIR = path.join(__dirname, `./video-images`);
const FRAMES_DIR = path.join(__dirname, `./frames`);
const FRAMES_OUT_DIR = path.join(__dirname, `./frames-processed`);
const IMAGES_OUT_DIR = path.join(__dirname, `./video-images-processed`);
const VIDEO_DIR = path.join(__dirname, `./video`);
const VIDEO_OUT = path.join(__dirname, `./video-out`);

const TILE_SIZE = 16

class BaseImage {
    imagePath: string = '';
    imageOutPath: string = '';

    constructor(imagePath: string, imageOutPath: string) {
        this.imagePath = imagePath;
        this.imageOutPath = imageOutPath;
    }


    async deriveMeanBrightness(imageBuffer: Uint8Array): Promise<{data: Uint8Array, meanBrightness: number}>  {
        const { data } = await sharp(imageBuffer)
            .raw()
            .toBuffer({ resolveWithObject: true });
                
        let sum = 0;
        for (let i = 0; i < data.length; i += 3) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            
            if (r && g && b) {
                const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
                sum += luminance;
            }
        }
        
        const meanBrightness = sum / (data.length / 3); // Divide by pixel count
        
        return {
            data,
            meanBrightness
        }
    }
}

class SwapImage extends BaseImage {
    constructor(imagePath: string, imageOutPath: string) {
        super(imagePath, imageOutPath);
    }

    async normalizeImageSize(imageBuffer: Uint8Array): Promise<Uint8Array> {
        return await sharp(imageBuffer)
            .resize(700, 700)
            .toBuffer()
    }

    async transformAndOutput() {
        const imageBuffer = new Uint8Array(await fs.promises.readFile(this.imagePath))
        const normalizedImageBuffer = await this.normalizeImageSize(imageBuffer);

        // Calculate brightness from the normalized image
        const { meanBrightness } = await this.deriveMeanBrightness(normalizedImageBuffer);
        
        // Save the normalized image (not the raw data)
        await sharp(normalizedImageBuffer).png().toFile(this.imageOutPath);

        return {
            imageOutPath: this.imageOutPath,
            meanBrightness: meanBrightness
        }
    }
}

class VideoFrame extends BaseImage {
    private imageMap: Map<number, []> | undefined;
    
    constructor(imagePath: string, imageOutPath: string, imageMap: Map<number, []>) {
        super(imagePath, imageOutPath);
        this.imageMap = imageMap;
    }

    splitAndProcessTiles = () => {

    }

    matchNearestImage = (meanTileBrightness: number) => {
        if (!this.imageMap) return;

        let winningKey = 0;
        let winningDelta = Infinity;
        for (const [brightness, imagePath] of this.imageMap?.entries()) {
            const delta = brightness - meanTileBrightness
            if (delta > 0 && delta < winningKey) {
                winningKey = brightness;
            }
        }

        console.log(winningKey)
    }

    async transformAndOutput() {
        const imageBuffer = new Uint8Array(await fs.promises.readFile(this.imagePath))
        const grayscaleBuffer = await sharp(imageBuffer)
            .grayscale()
            .toBuffer();
        
        const { width, height } = await sharp(grayscaleBuffer).metadata();

        const tilesX = Math.ceil(width! / TILE_SIZE);
        const tilesY = Math.ceil(height! / TILE_SIZE);
                
        for (let tileY = 0; tileY < tilesY; tileY++) {
            for (let tileX = 0; tileX < tilesX; tileX++) {
                const x = tileX * TILE_SIZE;
                const y = tileY * TILE_SIZE;
                const tileWidth = Math.min(TILE_SIZE, width! - x);
                const tileHeight = Math.min(TILE_SIZE, height! - y);

                // Extract tile
                const tileBuffer = await sharp(grayscaleBuffer)
                    .extract({ left: x, top: y, width: tileWidth, height: tileHeight })
                    .raw()
                    .toBuffer();
                
                const { meanBrightness } = await this.deriveMeanBrightness(tileBuffer);
                
                const nearestImage = this.matchNearestImage(meanBrightness)
            }
        }
        // Calculate brightness from the normalized image
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
        const imagePaths = await fs.promises.readdir(IMAGES_DIR);
        const framePaths = await fs.promises.readdir(FRAMES_DIR);

        const imageMap = new Map();
    
        // process images
        for (const imagePath of imagePaths) {
            try {
                const { meanBrightness, imageOutPath } = await processImage(imagePath)
                if (!imageMap.has(meanBrightness)) imageMap.set(meanBrightness, []);
                imageMap.get(meanBrightness).push(imageOutPath);
            } catch (e) {
                throw e;
            }
        }

        const videoPath = path.join(VIDEO_DIR, 'IMG_3403.MOV');
        const framesDir = path.join(__dirname, './frames');
        const outputDir = path.join(__dirname, './frames-processed');

        // await new Promise((resolve, reject) => {
        //     ffmpeg(videoPath)
        //         .fps(30) // Extract at 30fps
        //         .on('end', resolve)
        //         .on('error', reject)
        //         .save(path.join(framesDir, 'frame_%04d.png'));
        // });

        for (const framePath of framePaths) {
            const frameImage = new VideoFrame(path.join(FRAMES_DIR, framePath), path.join(FRAMES_OUT_DIR, framePath));
            frameImage.transformAndOutput(imageMap)
        }

        // apply processed images to video
            // - iterate through frames of image (60fps)
            // -- apply greyscale to each frame
            // -- chunk each video frame by a size constant
            // -- find mean tone of chunk, replace chunk with image with nearest matching tone
            // - render video
        // return video
    } catch (e) {
        throw e;
    }
};


(async () => {
const startTime = Date.now();

const processedVideo = await processVideo();

const endTime = Date.now();

const durationMs = endTime - startTime;

console.log({
    durationMs
})
})();