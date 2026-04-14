# Stitch

Video stitching tool with chroma-key transitions and audio overlay. All options are specified via a JSON job file.

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

```bash
npx tsx src/index.ts --file job.json
```

Override the output path from the command line:

```bash
npx tsx src/index.ts --file job.json -o custom_output.mp4
```

### Production (compiled)

```bash
npm run build
node dist/index.js --file job.json
```

## CLI Options

| Option | Required | Description |
|---|---|---|
| `--file <path>` | yes | Path to JSON job file |
| `-o, --output <path>` | no | Output path — overrides `output.file` in the JSON |

## Job File Format

```json
{
  "input": {
    "videos": ["clip0.mp4", "clip1.mp4", "clip2.mp4"],
    "audio": ["voice.mp3", "", ""],
    "bgAudioDir": "./assets/audio"
  },
  "output": {
    "file": "output.mp4"
  },
  "options": {
    "overlap": 1.0,
    "chromaKey": "#00fe00",
    "similarity": 0.05,
    "blend": 0.0
  },
  "settings": {
    "tmpDir": "./tmp",
    "cleanupInputFiles": true
  },
  "s3": {
    "bucket": "my-bucket",
    "inputDir": "renders/input",
    "outputDir": "renders/output",
    "audioDir": "assets/audio"
  }
}
```

### `input`

| Field | Required | Description |
|---|---|---|
| `videos` | yes | Array of video file paths (local paths or S3 keys) |
| `audio` | no | Array of per-segment audio paths, one per video. Use `""` to skip a segment. |
| `bgAudioDir` | no | Local directory containing background audio tracks (`bg54.wav`–`bg60.wav`) |

### `output`

| Field | Required | Description |
|---|---|---|
| `file` | yes* | Output file path (`.mp4`). Can be overridden with `-o` on the CLI. |

### `options`

| Field | Default | Description |
|---|---|---|
| `overlap` | `1.0` | Transition overlap in seconds. A single number applies to all transitions. An array of N−1 values (for N videos) sets each transition individually, e.g. `[1.0, 0]`. |
| `chromaKey` | `#00fe00` | Chroma key color (hex) |
| `similarity` | `0.05` | Chroma key similarity threshold (0.0–1.0) |
| `blend` | `0.0` | Chroma key blend/smoothness (0.0–1.0) |

### `settings`

| Field | Default | Description |
|---|---|---|
| `tmpDir` | `./tmp` | Temporary directory for intermediate files |
| `cleanupInputFiles` | `true` | Delete downloaded/input files after stitching. Set to `false` to keep them. |

### `s3` (optional — omit for local-only mode)

When `s3.bucket` is set, video/audio paths are treated as S3 keys and downloaded automatically. The result is uploaded back to S3.

| Field | Description |
|---|---|
| `bucket` | S3 bucket name |
| `inputDir` | S3 prefix for input videos |
| `outputDir` | S3 prefix for uploaded result |
| `audioDir` | S3 prefix for segment and background audio |

## How It Works

1. **Resolve inputs** — use local files directly, or download from S3 when `s3.bucket` is set
2. **Analyze** — get duration of each input video via ffprobe
3. **Split** — cut each video into `first` / `middle` / `last` segments using per-transition overlap values
4. **Transitions** — chroma-key composite `video[i].last` + `video[i+1].first` (only the incoming clip is keyed)
5. **Stitch** — concatenate: `middle₀ → transition₀₁ → middle₁ → ...`
6. **Timings** — calculate when each segment starts in the final timeline
7. **Background track** — select and loop a background music file to match duration
8. **Audio overlay** — mix background + per-segment audio (delayed to segment start times)
9. **Upload** — upload result to S3 (S3 mode only)
10. **Cleanup** — remove intermediate files (controlled by `settings.cleanupInputFiles`)
