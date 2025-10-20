import sharp from 'sharp';
import BaseImage from './BaseImage';
import fs from 'fs';
import { deriveMeanBrightness } from './helpers.ts';

export default class SwapImage extends BaseImage {
    constructor(imagePath: string, imageOutPath: string) {
        super(imagePath, imageOutPath);
    }



    async transformAndOutput() {
        const imageBuffer = await fs.promises.readFile(this.imagePath);

        const normalized = sharp(imageBuffer).resize(200, 200);

        const normalizedImageBuffer = await normalized.toBuffer();

        const grayscaleBuffer = await sharp(normalizedImageBuffer)
            .grayscale()
            .raw()
            .toBuffer();

        const { meanBrightness } = await deriveMeanBrightness(grayscaleBuffer);

        // Write the normalized (color) image back out, ensuring it's in a supported format
        await sharp(normalizedImageBuffer)
            .png()
            .toFile(this.imageOutPath);

        return {
            imageOutPath: this.imageOutPath,
            meanBrightness: meanBrightness
        }
    }
}
