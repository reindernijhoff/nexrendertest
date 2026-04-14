#!/usr/bin/env node
import {Command} from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {VideoSegment} from './types.js';
import {
    analyzeVideos,
    calculateTimings,
    createAllTransitions,
    overlayAudio,
    splitAllVideos,
    stitchSegments,
} from './pipeline.js';
import {resolveAudioFiles, resolveBackgroundTrack, resolveInputFiles, uploadToS3,} from './s3.js';
import {cleanupTempFiles} from './utils.js';

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
            .filter(Boolean);

        const rawAudio: string[] = input.audio ?? [];

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
        const bgTracks: Record<string, string> = input.bgTracks ?? {};

        try {
            const totalStart = Date.now();
            fs.mkdirSync(tmpDir, {recursive: true});

            const segments: VideoSegment[] = videos.map((v, i) => ({
                srcVideo: isS3 ? v : path.resolve(v),
                srcAudio: rawAudio[i]?.trim() || null,
                localVideo: '',
                localAudio: null,
                duration: 0,
                overlapBefore: i > 0 ? (Array.isArray(overlap) ? overlap[i - 1] : overlap) : 0,
                overlapAfter: i < videos.length - 1 ? (Array.isArray(overlap) ? overlap[i] : overlap) : 0,
                zIndex: (options.zIndex ?? [])[i] ?? (i + 1),
                startTime: 0,
                firstDuration: 0,
                middle: '',
                middleDuration: 0,
                lastDuration: 0,
            }));

            console.log(`\nStitch pipeline: ${segments.length} videos (${isS3 ? 'S3' : 'local'} mode)`);
            console.log(`  Overlap: ${Array.isArray(overlap) ? `[${overlap.join(', ')}]` : overlap}s | Chroma: ${chromaKey} | Similarity: ${similarity} | Blend: ${blend}`);
            console.log(`  Output: ${output}`);
            console.log(`  Tmp dir: ${tmpDir}`);
            if (isS3) console.log(`  S3: ${s3.bucket} | input: ${s3.inputDir} | output: ${s3.outputDir}`);
            console.log();

            await resolveInputFiles(segments, tmpDir, s3.bucket, s3.inputDir);
            await resolveAudioFiles(segments, tmpDir, s3.bucket, s3.audioDir);

            console.log(`\n=== Step 1: Analyzing ${segments.length} videos ===`);
            await analyzeVideos(segments);

            console.log(`\n=== Step 2: Splitting ${segments.length} videos ===`);
            await splitAllVideos(segments, tmpDir);

            console.log(`\n=== Step 3: Creating ${segments.length - 1} transitions ===`);
            const transitions = await createAllTransitions(segments, tmpDir, chromaKey, similarity, blend);

            console.log('\n=== Step 4: Stitching final video ===');
            const videoOnlyOutput = output.replace(/\.mp4$/, '_video_only.mp4');
            const stitchedDuration = await stitchSegments(segments, transitions, videoOnlyOutput);

            console.log('\n=== Step 5: Calculating segment timings ===');
            // const calculatedDuration = calculateTimings(segments, transitions);
            // console.log(`  Probed: ${stitchedDuration.toFixed(3)}s vs calculated: ${calculatedDuration.toFixed(3)}s`);

            console.log('\n=== Step 6: Background track ===');
            const bgTrack = await resolveBackgroundTrack(bgTracks, stitchedDuration, tmpDir, s3.bucket, s3.audioDir);

            console.log('\n=== Step 7: Audio overlay ===');
            await overlayAudio(videoOnlyOutput, segments, bgTrack, stitchedDuration, output);

            let resultPath = output;
            if (isS3 && s3.outputDir) {
                console.log('\n=== Step 8: Upload to S3 ===');
                const s3Key = `${s3.outputDir}/${path.basename(output)}`;
                resultPath = await uploadToS3(output, s3.bucket!, s3Key);
            }

            cleanupTempFiles(segments, transitions, [
                videoOnlyOutput,
                bgTrack,
                ...(cleanupInputFiles ? segments.map(s => s.localVideo) : []),
                ...(cleanupInputFiles ? segments.map(s => s.localAudio) : []),
            ]);

            const totalTime = (Date.now() - totalStart) / 1000;
            const stat = fs.statSync(output);

            console.log(`\n=== Done ===`);
            console.log(`  Output: ${resultPath}`);
            console.log(`  Duration: ${stitchedDuration.toFixed(1)}s`);
            console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
            console.log(`  Total time: ${totalTime.toFixed(1)}s`);
        } catch (err) {
            console.error('\nStitch failed:', err);
            process.exit(1);
        }
    });

program.parse();
