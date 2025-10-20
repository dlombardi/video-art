export default class BaseImage {
    imagePath: string = '';
    imageOutPath: string = '';

    constructor(imagePath: string, imageOutPath: string) {
        this.imagePath = imagePath;
        this.imageOutPath = imageOutPath;
    }
}