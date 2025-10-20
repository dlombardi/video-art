# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an image-to-video art project that processes videos by replacing tiles with images based on brightness matching. The main workflow:

1. Extract frames from a video using ffmpeg
2. Process reference images to normalize size and calculate mean brightness
3. For each video frame, split into tiles and replace each tile with the reference image that has the closest matching brightness
4. Output the processed frames

**Key Technologies:**
- Bun runtime (not Node.js)
- Sharp for image processing
- fluent-ffmpeg for video frame extraction
- TypeScript

## Development Commands

**Run the main script:**
```bash
bun run start
# or
bun ./src/index.ts
```

**Install dependencies:**
```bash
bun install
```

**Run tests (when added):**
```bash
bun test
```

## Architecture

**Entry Point:** `src/index.ts`

**Core Classes:**

- `BaseImage` - Abstract base class with shared image processing utilities
  - `deriveMeanBrightness()` - Calculates mean brightness from grayscale data

- `SwapImage` - Processes reference images for the brightness mapping
  - Normalizes images to 700x700
  - Calculates mean brightness for matching
  - Outputs processed images to `video-images-processed/`

- `VideoFrame` - Processes individual video frames
  - Splits frames into tiles (default 16x16 pixels, set by `TILE_SIZE`)
  - Matches each tile to nearest brightness reference image
  - Uses concurrent tile processing with max 10 in-flight operations
  - Composites all replacement tiles into final frame

- `Sem` - Simple semaphore for concurrency control

**Directory Structure:**
- `./video-images/` - Input reference images
- `./video-images-processed/` - Processed reference images
- `./frames/` - Extracted video frames
- `./frames-processed/` - Processed video frames with tile replacements
- `./video/` - Input video files
- `./video-out/` - Output processed videos

## Important Implementation Details

**Image Processing:**
- All reference images are normalized to 700x700 before processing
- Brightness matching uses grayscale conversion and mean pixel value
- Tile processing is parallelized with a max concurrency of 10

**Video Processing:**
- Frame extraction is currently commented out (lines 278-284)
- Target framerate: 30fps
- Hardcoded video path: `./video/IMG_3403.MOV`

**Brightness Matching Algorithm:**
- Images stored in a Map with brightness as key, file path as value
- `matchNearestImage()` finds the smallest positive delta above the target brightness
- Note: Current algorithm only matches images brighter than the target (potential improvement area)

## Bun-Specific Notes

- Use `bun ./src/index.ts` instead of `node ./src/index.ts`
- Bun automatically loads .env files (no dotenv needed)
- Prefer `Bun.file()` over Node.js fs when possible
- Use `bun:test` for testing framework

## Common Tasks

**Adding new image transformations:**
- Extend `BaseImage` or modify `SwapImage`/`VideoFrame` classes
- Image processing happens in `transformAndOutput()` methods

**Adjusting tile size:**
- Modify the `TILE_SIZE` constant (line 13)

**Changing concurrency:**
- Modify `MAX_IN_FLIGHT` constant in `VideoFrame.transformAndOutput()` (line 183)

**Processing different videos:**
- Update the hardcoded video path in `processVideo()` (line 274)
- Uncomment the ffmpeg frame extraction code (lines 278-284) if needed
