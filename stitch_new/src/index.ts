#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  analyzeVideos,
  splitAllVideos,
  createAllTransitions,
  stitchSegments,
  calculateTimings,
  selectBackgroundTrack,
  selectBackgroundTrackName,
  overlayAudio,
  cleanupTempFiles,
} from './pipeline.js';
import { getVideoDuration } from './ffmpeg.js';
import {
  resolveInputFiles,
  resolveAudioFiles,
  downloadBackgroundTrack,
  uploadToS3,
} from './s3.js';

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
      const totalStart = Date.now();

      // Ensure tmp dir exists
      fs.mkdirSync(tmpDir, { recursive: true });

      // Normalize overlap into a per-transition array of length N-1
      const overlaps: number[] = Array.isArray(overlap)
        ? overlap
        : new Array(Math.max(0, videos.length - 1)).fill(overlap);

      if (overlaps.length !== Math.max(0, videos.length - 1)) {
        throw new Error(
          `overlap array length (${overlaps.length}) must be ${videos.length - 1} (N-1 for ${videos.length} videos)`,
        );
      }

      console.log(`\nStitch pipeline: ${videos.length} videos (${isS3 ? 'S3' : 'local'} mode)`);
      console.log(`  Overlaps: [${overlaps.join(', ')}]s | Chroma: ${chromaKey} | Similarity: ${similarity} | Blend: ${blend}`);
      console.log(`  Output: ${output}`);
      console.log(`  Tmp dir: ${tmpDir}`);
      if (isS3) console.log(`  S3: ${s3.bucket} | input: ${s3.inputDir} | output: ${s3.outputDir}`);
      console.log();

      // 0. Resolve inputs — download from S3 if needed, or validate local paths
      const localVideos = await resolveInputFiles(videos, tmpDir, s3.bucket, s3.inputDir);
      const localAudio = await resolveAudioFiles(audioFiles, tmpDir, s3.bucket, s3.audioDir);

      // 1. Analyze
      const durations = await analyzeVideos(localVideos);

      // 2. Split
      const videoParts = await splitAllVideos(localVideos, durations, tmpDir, overlaps);

      // 3. Transitions
      const transitions = await createAllTransitions(videoParts, tmpDir, chromaKey, similarity, blend);

      // 4. Stitch video segments
      const videoOnlyOutput = output.replace(/\.mp4$/, '_video_only.mp4');
      await stitchSegments(videoParts, transitions, videoOnlyOutput);

      // 5. Calculate audio timings
      const timings = await calculateTimings(videoParts, transitions);

      // 6. Background track
      const videoDuration = await getVideoDuration(videoOnlyOutput);
      let bgTrack: string | null = null;
      if (bgAudioDir) {
        bgTrack = selectBackgroundTrack(videoDuration, bgAudioDir);
      } else if (isS3 && s3.audioDir) {
        const bgFile = selectBackgroundTrackName(videoDuration);
        if (bgFile) {
          bgTrack = await downloadBackgroundTrack(bgFile, tmpDir, s3.bucket!, s3.audioDir);
        }
      }

      // 7. Audio overlay
      await overlayAudio(videoOnlyOutput, localAudio, bgTrack, timings, output);

      // 8. Upload to S3 if in S3 mode
      let resultPath = output;
      if (isS3 && s3.outputDir) {
        const s3Key = `${s3.outputDir}/${path.basename(output)}`;
        resultPath = await uploadToS3(output, s3.bucket!, s3Key);
      }

      // Cleanup — remove all intermediate and downloaded temp files
      cleanupTempFiles(videoParts, transitions, [
        videoOnlyOutput,
        bgTrack,
        ...(cleanupInputFiles ? localVideos : []),
        ...(cleanupInputFiles ? localAudio : []),
      ]);

      const totalTime = (Date.now() - totalStart) / 1000;
      const stat = fs.statSync(output);

      console.log(`\n=== Done ===`);
      console.log(`  Output: ${resultPath}`);
      console.log(`  Duration: ${videoDuration.toFixed(1)}s`);
      console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
      console.log(`  Total time: ${totalTime.toFixed(1)}s`);
    } catch (err) {
      console.error('\nStitch failed:', err);
      process.exit(1);
    }
  });

program.parse();
