#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stitch } from './pipeline.js';

const program = new Command();

program
  .name('stitch')
  .description('Stitch videos with chroma-key transitions and audio overlay')
  .requiredOption('--file <path>', 'Path to JSON job file containing all stitch options')
  .option('-o, --output <path>', 'Output video file path (.mp4) — overrides value in JSON')
  .action(async (opts) => {
    const jobPath = path.resolve(opts.file);
    if (!fs.existsSync(jobPath)) {
      console.error(`Error: Job file not found: ${jobPath}`);
      process.exit(1);
    }

    const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));

    const input = job.input ?? {};
    const jobOutput = job.output ?? {};
    const options = job.options ?? {};
    const settings = job.settings ?? {};
    const s3 = job.s3 ?? {};

    const isS3 = !!s3.bucket;

    const videos: string[] = (input.videos ?? [])
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((s: string) => (isS3 ? s : path.resolve(s)));

    const audioFiles: string[] = (input.audio ?? [])
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((s: string) => (isS3 ? s : path.resolve(s)));

    if (videos.length === 0) {
      console.error('Error: No video paths provided in job file');
      process.exit(1);
    }

    const outputFile = opts.output ?? jobOutput.file;
    if (!outputFile) {
      console.error('Error: No output path provided (set output.file in JSON or use -o)');
      process.exit(1);
    }
    const output = path.resolve(outputFile);

    const overlap = options.overlap ?? 1.0;
    const chromaKey = options.chromaKey ?? '#00fe00';
    const similarity = options.similarity ?? 0.05;
    const blend = options.blend ?? 0.0;
    const tmpDir = path.resolve(settings.tmpDir ?? './tmp');
    const cleanupInputFiles = settings.cleanupInputFiles ?? true;
    const bgAudioDir = input.bgAudioDir ? path.resolve(input.bgAudioDir) : undefined;

    try {
      await stitch({
        videos,
        audioFiles,
        output,
        overlapDuration: overlap,
        chromaKeyColor: chromaKey,
        similarity,
        blend,
        tmpDir,
        backgroundTrackDir: bgAudioDir,
        cleanupInputFiles,
        bucket: s3.bucket,
        inputDir: s3.inputDir,
        outputDir: s3.outputDir,
        audioDir: s3.audioDir,
      });
    } catch (err) {
      console.error('\nStitch failed:', err);
      process.exit(1);
    }
  });

program.parse();
