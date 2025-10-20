export function matchNearestImage(meanTileBrightness: number, imageMapArray: Array<[number, string]>): string | undefined {
    let nearestKey: number | null = null;
    let smallestDelta = Infinity;

    for (const [brightness, _imagePath] of imageMapArray) {
        const delta = Math.abs(brightness - meanTileBrightness);
        if (delta < smallestDelta) {
            smallestDelta = delta;
            nearestKey = brightness;
        }
    }

    if (nearestKey === null) return undefined;

    const match = imageMapArray.find(([brightness]) => brightness === nearestKey);
    return match?.[1];
}