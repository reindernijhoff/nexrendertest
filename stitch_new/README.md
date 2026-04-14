# Stitch

Video stitching tool with chroma-key transitions and audio overlay. TypeScript port of `stitch_videos.py`.

## Prerequisites

- **ffmpeg** and **ffprobe** must be installed and available in PATH
- **Node.js** >= 18
- **AWS CLI** (only needed for S3 mode)

## Install

```bash
cd stitch
npm install
```

## Usage

### Local mode

```bash
npx tsx src/index.ts --videos "clip1.mp4,clip2.mp4,clip3.mp4" -o output.mp4
```

### Local mode with audio

```bash
npx tsx src/index.ts \
  --videos "clip1.mp4,clip2.mp4,clip3.mp4" \
  --audio "voice1.wav,voice2.wav,voice3.wav" \
  --bg-audio-dir ./assets/audio \
  --overlap 1.0 \
  --chroma-key "#00fe00" \
  --similarity 0.05 \
  --blend 0.0 \
  --tmp-dir ./tmp \
  -o final_output.mp4
```

### S3 mode

When `--bucket` is provided, video/audio paths are treated as S3 keys and downloaded automatically (in parallel). The result is uploaded back to S3. All downloaded temp files are cleaned up after processing.

Video paths are resolved as `s3://{bucket}/{input-dir}/{video}`, audio paths as `s3://{bucket}/{audio-dir}/{audio}`. Full `s3://` URIs are also supported directly.

```bash
npx tsx src/index.ts \
  --bucket my-bucket \
  --input-dir renders/input \
  --output-dir renders/output \
  --audio-dir assets/audio \
  --videos "scene1.mp4,scene2.mp4,scene3.mp4" \
  --audio "voice1.wav,voice2.wav,voice3.wav" \
  --overlap 1.0 \
  --chroma-key "#00fe00" \
  --similarity 0.05 \
  -o final_output.mp4
```

This is equivalent to the Python script's positional args:
```bash
python stitch_videos.py my-bucket /tmp/stitch renders/input renders/output \
  --videos "scene1.mp4,scene2.mp4,scene3.mp4" \
  --audio "voice1.wav,voice2.wav,voice3.wav" \
  -o final_output.mp4
```

> **Note:** The Python script hardcodes `assets/audio` as the S3 audio prefix. In the TS version, use `--audio-dir assets/audio` to match.

### Production (compiled)

```bash
npm run build
node dist/index.js --videos "clip1.mp4,clip2.mp4,clip3.mp4" -o output.mp4
```

## CLI Options

| Option | Default | Description |
|---|---|---|
| `--videos` | *required* | Comma-separated video paths (local paths or S3 keys) |
| `-o, --output` | *required* | Output file path (.mp4) |
| `--audio` | *(none)* | Comma-separated per-segment audio paths (one per video) |
| `--bg-audio-dir` | *(none)* | Local directory with background tracks (bg54.wav–bg60.wav) |
| `--overlap` | `1.0` | Transition overlap duration (seconds) |
| `--chroma-key` | `#00fe00` | Chroma key color (hex) |
| `--similarity` | `0.05` | Chroma key similarity threshold (0.0–1.0) |
| `--blend` | `0.0` | Chroma key blend/smoothness (0.0–1.0) |
| `--tmp-dir` | `./tmp` | Temporary directory for intermediate files |
| `--bucket` | *(none)* | S3 bucket name (enables S3 mode) |
| `--input-dir` | *(none)* | S3 prefix for input videos |
| `--output-dir` | *(none)* | S3 prefix for uploaded result |
| `--audio-dir` | *(none)* | S3 prefix for segment and background audio |

## How It Works

1. **Resolve inputs** — use local files directly, or download from S3 when `--bucket` is set
2. **Analyze** — get duration of each input video via ffprobe
3. **Split** — cut each video into `first` / `middle` / `last` segments (overlap-sized)
4. **Transitions** — chroma-key composite `video[i].last` + `video[i+1].first` (only the incoming clip is keyed)
5. **Stitch** — concatenate: `middle₀ → transition₀₁ → middle₁ → ...`
6. **Timings** — calculate when each segment starts in the final timeline
7. **Background track** — select and loop a background music file to match duration
8. **Audio overlay** — mix background + per-segment audio (delayed to segment start times)
9. **Upload** — upload result to S3 (S3 mode only)
10. **Cleanup** — remove all intermediate files (splits, transitions, downloaded inputs)

## Programmatic API

```typescript
import { stitch } from './pipeline.js';

// Local mode
await stitch({
  videos: ['clip1.mp4', 'clip2.mp4'],
  audioFiles: ['voice1.wav', 'voice2.wav'],
  output: 'output.mp4',
  overlapDuration: 1.0,
  chromaKeyColor: '#00fe00',
  similarity: 0.05,
  blend: 0.0,
  tmpDir: './tmp',
  backgroundTrackDir: './assets/audio',
});

// S3 mode
await stitch({
  videos: ['scene1.mp4', 'scene2.mp4'],
  audioFiles: ['voice1.wav', 'voice2.wav'],
  output: 'final.mp4',
  overlapDuration: 1.0,
  chromaKeyColor: '#00fe00',
  similarity: 0.05,
  blend: 0.0,
  tmpDir: './tmp',
  bucket: 'my-bucket',
  inputDir: 'renders/input',
  outputDir: 'renders/output',
  audioDir: 'assets/audio',
});
```
