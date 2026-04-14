export interface VideoParts {
  first?: string;
  middle: string;
  last?: string;
}

export interface AccelParams {
  decoder: string[];
  encoder: string;
  preset: string;
  extraParams: string[];
}

export interface StitchOptions {
  /** Local file paths to the input videos (in order) */
  videos: string[];
  /** Per-segment audio file paths (one per video, use empty string to skip) */
  audioFiles: string[];
  /** Output file path (.mp4) */
  output: string;
  /** Transition overlap duration in seconds (default 1.0). Single value or array of N-1 values for N videos. */
  overlapDuration: number | number[];
  /** Chroma key hex color (default #A6579B) */
  chromaKeyColor: string;
  /** Chroma key similarity threshold 0.0-1.0 (default 0.01) */
  similarity: number;
  /** Chroma key blend/smoothness 0.0-1.0 (default 0.0) */
  blend: number;
  /** Temporary working directory for intermediate files */
  tmpDir: string;
  /** Directory containing background audio tracks (bg54.wav - bg60.wav) */
  backgroundTrackDir?: string;

  // --- S3 options (all optional — omit for local-only mode) ---

  /** S3 bucket name */
  bucket?: string;
  /** S3 input directory (prefix for video keys) */
  inputDir?: string;
  /** S3 output directory (prefix for uploaded result) */
  outputDir?: string;
  /** S3 audio directory (prefix for per-segment and background audio) */
  audioDir?: string;

  // --- Settings ---

  /** Whether to delete downloaded/input files after stitching (default true) */
  cleanupInputFiles?: boolean;
}
