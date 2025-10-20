// Helper function to calculate mean brightness from grayscale data
export async function deriveMeanBrightness(rawGrayscaleData: Uint8Array): Promise<{data: Uint8Array, meanBrightness: number}> {
    if (!rawGrayscaleData || rawGrayscaleData.length === 0) {
        throw new Error('No grayscale data provided');
    }

    let sum = 0;
    for (let i = 0; i < rawGrayscaleData.length; i++) {
        sum += rawGrayscaleData[i] ?? 0;
    }

    const meanBrightness = rawGrayscaleData && rawGrayscaleData.length > 0 ? sum / rawGrayscaleData.length : 0;

    return {
        data: rawGrayscaleData,
        meanBrightness
    }
}
