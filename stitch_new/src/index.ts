#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'node:path';
import { stitch } from './pipeline.js';

const program = new Command();

program
  .name('stitch')
  .description('Stitch videos with chroma-key transitions and audio overlay')
  .requiredOption('--videos <paths>', 'Comma-separated video file paths')
  .requiredOption('-o, --output <path>', 'Output video file path (.mp4)')
  .option('--audio <paths>', 'Comma-separated per-segment audio file paths (one per video)', '')
  .option('--bg-audio-dir <dir>', 'Directory containing background audio tracks (bg54.wav–bg60.wav)')
  .option('--overlap <seconds>', 'Transition overlap duration in seconds', '1.0')
  .option('--chroma-key <hex>', 'Chroma key color in hex format', '#00fe00')
  .option('--similarity <value>', 'Chroma key similarity threshold 0.0–1.0', '0.05')
  .option('--blend <value>', 'Chroma key blend/smoothness 0.0–1.0', '0.0')
  .option('--tmp-dir <dir>', 'Temporary working directory for intermediate files', './tmp')
  .option('--bucket <name>', 'S3 bucket name (enables S3 mode)')
  .option('--input-dir <prefix>', 'S3 input directory prefix for videos')
  .option('--output-dir <prefix>', 'S3 output directory prefix for result')
  .option('--audio-dir <prefix>', 'S3 audio directory prefix for segment and background audio')
  .action(async (opts) => {
    const isS3 = !!opts.bucket;

    const videos = opts.videos
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((s: string) => (isS3 ? s : path.resolve(s)));

    const audioFiles = opts.audio
      ? opts.audio
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((s: string) => (isS3 ? s : path.resolve(s)))
      : [];

    if (videos.length === 0) {
      console.error('Error: No video paths provided');
      process.exit(1);
    }

    const output = path.resolve(opts.output);

    try {
      await stitch({
        videos,
        audioFiles,
        output,
        overlapDuration: parseFloat(opts.overlap),
        chromaKeyColor: opts.chromaKey,
        similarity: parseFloat(opts.similarity),
        blend: parseFloat(opts.blend),
        tmpDir: path.resolve(opts.tmpDir),
        backgroundTrackDir: opts.bgAudioDir ? path.resolve(opts.bgAudioDir) : undefined,
        bucket: opts.bucket,
        inputDir: opts.inputDir,
        outputDir: opts.outputDir,
        audioDir: opts.audioDir,
      });
    } catch (err) {
      console.error('\nStitch failed:', err);
      process.exit(1);
    }
  });

program.parse();
