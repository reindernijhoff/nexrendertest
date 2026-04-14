import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VideoParts, AccelParams, StitchOptions } from './types.js';
import {
  getVideoDuration,
  detectAcceleration,
  runFfmpeg,
  hexToChromaKeyColor,
} from './ffmpeg.js';
import {
  resolveInputFiles,
  resolveAudioFiles,
  downloadBackgroundTrack,
  uploadToS3,
} from './s3.js';

// ---------------------------------------------------------------------------
// Concurrency helper (avoids external dependency)
// ---------------------------------------------------------------------------

function pLimit(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            if (queue.length > 0) queue.shift()!();
          });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

// ---------------------------------------------------------------------------
// Step 1: Analyze — get durations for all input videos
// ---------------------------------------------------------------------------

export async function analyzeVideos(videoPaths: string[]): Promise<number[]> {
  console.log(`\n=== Step 1: Analyzing ${videoPaths.length} videos ===`);
  const limit = pLimit(8);

  const durations = await Promise.all(
    videoPaths.map((videoPath, i) =>
      limit(async () => {
        const duration = await getVideoDuration(videoPath);
        const stat = fs.statSync(videoPath);
        console.log(
          `[${i}] ${path.basename(videoPath)}: ${duration.toFixed(1)}s (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
        );
        return duration;
      }),
    ),
  );

  return durations;
}

// ---------------------------------------------------------------------------
// Step 2: Split each video into first / middle / last segments
// ---------------------------------------------------------------------------

async function createSegment(
  inputFile: string,
  output: string,
  accel: AccelParams,
  startTime?: number,
  segDuration?: number,
): Promise<void> {
  const args = ['-y'];

  if (accel.encoder === 'h264_nvenc') args.push('-hwaccel', 'cuda');
  args.push('-i', inputFile);

  if (startTime !== undefined) args.push('-ss', String(startTime));
  if (segDuration !== undefined) args.push('-t', String(segDuration));

  args.push('-map', '0:v:0', '-map', '0:a?');

  if (accel.encoder === 'h264_nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p2', '-cq', '23', '-gpu', '0');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
  }

  args.push('-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p', output);
  await runFfmpeg(args);
}

async function splitVideo(
  inputFile: string,
  outputDir: string,
  videoIndex: number,
  duration: number,
  overlapBefore: number,
  overlapAfter: number,
  accel: AccelParams,
): Promise<VideoParts> {
  console.log(`Splitting video ${videoIndex}: ${path.basename(inputFile)} (overlap before=${overlapBefore}s after=${overlapAfter}s)`);
  const parts: VideoParts = { middle: '' };

  // First part (transition layer) — skip for video 0 (nothing to transition from)
  if (overlapBefore > 0) {
    const firstPath = path.join(outputDir, `video_${videoIndex}_first.mp4`);
    await createSegment(inputFile, firstPath, accel, 0, overlapBefore);
    parts.first = firstPath;
  }

  // Last part (transition layer)
  if (overlapAfter > 0 && duration > overlapAfter) {
    const lastPath = path.join(outputDir, `video_${videoIndex}_last.mp4`);
    await createSegment(inputFile, lastPath, accel, duration - overlapAfter, overlapAfter);
    parts.last = lastPath;
  }

  // Middle part (plays as-is between transitions)
  const middlePath = path.join(outputDir, `video_${videoIndex}_middle.mp4`);

  if (overlapBefore === 0) {
    // First video: middle = everything except the last overlap
    await createSegment(inputFile, middlePath, accel, 0, duration - overlapAfter);
  } else {
    const middleDuration = duration - overlapBefore - overlapAfter;
    if (middleDuration > 0) {
      await createSegment(inputFile, middlePath, accel, overlapBefore, middleDuration);
    } else {
      // Video too short for a proper middle — create minimal placeholder
      await runFfmpeg([
        '-y', '-f', 'lavfi', '-i', 'color=black:size=1920x1080:duration=0.033:rate=30',
        '-c:v', 'libx264', '-preset', 'ultrafast', middlePath,
      ]);
    }
  }

  parts.middle = middlePath;
  return parts;
}

export async function splitAllVideos(
  videoPaths: string[],
  durations: number[],
  tmpDir: string,
  overlaps: number[],
): Promise<VideoParts[]> {
  console.log(`\n=== Step 2: Splitting ${videoPaths.length} videos ===`);
  const accel = await detectAcceleration();
  const limit = pLimit(4);

  const parts = await Promise.all(
    videoPaths.map((videoPath, i) => {
      const overlapBefore = i > 0 ? overlaps[i - 1] : 0;
      const overlapAfter = i < videoPaths.length - 1 ? overlaps[i] : 0;
      return limit(() => splitVideo(videoPath, tmpDir, i, durations[i], overlapBefore, overlapAfter, accel));
    }),
  );

  return parts;
}

// ---------------------------------------------------------------------------
// Step 3: Create chroma-key transitions between adjacent videos
// ---------------------------------------------------------------------------

async function createTransition(
  endVideo: string,
  startVideo: string,
  outputPath: string,
  chromaKeyColor: string,
  similarity: number,
  blend: number,
  accel: AccelParams,
): Promise<string> {
  console.log(`Transition: ${path.basename(endVideo)} → ${path.basename(startVideo)}`);

  const ckColor = hexToChromaKeyColor(chromaKeyColor);
  const filterComplex =
    `[1:v]chromakey=${ckColor}:${similarity}:${blend}[key];[0:v][key]overlay=shortest=1[out]`;

  const args = [
    '-y', '-v', 'error',
    '-f', 'mp4', '-i', endVideo,
    '-f', 'mp4', '-i', startVideo,
    '-filter_complex', filterComplex,
    '-map', '[out]', '-map', '0:a:0?',
  ];

  if (accel.encoder === 'h264_nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p2', '-cq', '23', '-gpu', '0', '-rc', 'vbr', '-b:v', '0');
  } else if (accel.encoder === 'h264_qsv') {
    args.push('-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '23');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'faster', '-crf', '25', '-threads', '0');
  }

  args.push('-c:a', 'copy', '-f', 'mp4', '-shortest', outputPath);

  const start = Date.now();
  await runFfmpeg(args);
  console.log(`  Transition completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  return outputPath;
}

export async function createAllTransitions(
  videoParts: VideoParts[],
  tmpDir: string,
  chromaKeyColor: string,
  similarity: number,
  blend: number,
): Promise<(string | null)[]> {
  console.log(`\n=== Step 3: Creating ${videoParts.length - 1} transitions ===`);
  const accel = await detectAcceleration();
  // Limit to 2 concurrent transitions — NVENC has limited encoding sessions
  const limit = pLimit(2);

  const transitions: (string | null)[] = new Array(videoParts.length - 1).fill(null);

  await Promise.all(
    Array.from({ length: videoParts.length - 1 }, (_, i) =>
      limit(async () => {
        const endVideo = videoParts[i].last;
        const startVideo = videoParts[i + 1].first;
        if (!endVideo || !startVideo) return;

        const output = path.join(tmpDir, `transition_${i}_${i + 1}.mp4`);
        transitions[i] = await createTransition(
          endVideo, startVideo, output, chromaKeyColor, similarity, blend, accel,
        );
      }),
    ),
  );

  console.log(`Created ${transitions.filter(Boolean).length} transitions`);
  return transitions;
}

// ---------------------------------------------------------------------------
// Step 4: Concatenate all segments into the final video
// ---------------------------------------------------------------------------

export async function stitchSegments(
  videoParts: VideoParts[],
  transitions: (string | null)[],
  outputPath: string,
): Promise<string> {
  console.log('\n=== Step 4: Stitching final video ===');

  // Build the sequence: middle₀ → transition₀₁ → middle₁ → transition₁₂ → ...
  const sequenceFiles: string[] = [];
  for (let i = 0; i < videoParts.length; i++) {
    if (videoParts[i].middle && fs.existsSync(videoParts[i].middle)) {
      sequenceFiles.push(videoParts[i].middle);
    }
    if (i < transitions.length && transitions[i] && fs.existsSync(transitions[i]!)) {
      sequenceFiles.push(transitions[i]!);
    }
  }

  // Write ffmpeg concat demuxer file
  const concatFile = path.join(path.dirname(outputPath), 'concat_list.txt');
  const lines = sequenceFiles.map((f, i) => {
    const normalized = f.replace(/\\/g, '/');
    // Skip first 0.033s of the first file to avoid black-frame artifact
    if (i === 0) return `file '${normalized}'\ninpoint 0.033`;
    return `file '${normalized}'`;
  });
  fs.writeFileSync(concatFile, lines.join('\n'));

  // Try stream copy first (fastest — no re-encoding)
  try {
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c', 'copy', '-movflags', '+faststart', outputPath,
    ]);
  } catch {
    // Fallback: re-encode if codec parameters differ between segments
    console.log('Stream copy failed, re-encoding...');
    const accel = await detectAcceleration();
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile];

    if (accel.encoder === 'h264_nvenc') {
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '18', '-gpu', '0');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18');
    }
    args.push('-c:a', 'copy', '-movflags', '+faststart', outputPath);

    await runFfmpeg(args);
  }

  try { fs.unlinkSync(concatFile); } catch { /* ignore */ }

  const stat = fs.statSync(outputPath);
  console.log(`Stitched video: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
  return outputPath;
}

// ---------------------------------------------------------------------------
// Step 5: Calculate when each video segment starts in the final timeline
// ---------------------------------------------------------------------------

export async function calculateTimings(
  videoParts: VideoParts[],
  transitions: (string | null)[],
): Promise<number[]> {
  console.log('\n=== Step 5: Calculating segment timings ===');

  const timings: number[] = [];
  let currentTime = 0;

  for (let i = 0; i < videoParts.length; i++) {
    timings.push(currentTime);
    console.log(`  Segment ${i} starts at ${currentTime.toFixed(1)}s`);

    if (videoParts[i].middle && fs.existsSync(videoParts[i].middle)) {
      currentTime += await getVideoDuration(videoParts[i].middle);
    }
    if (i < transitions.length && transitions[i]) {
      currentTime += await getVideoDuration(transitions[i]!);
    }
  }

  console.log(`Total calculated duration: ${currentTime.toFixed(1)}s`);
  return timings;
}

// ---------------------------------------------------------------------------
// Step 6: Select the best-matching background music track
// ---------------------------------------------------------------------------

export function selectBackgroundTrackName(videoDuration: number): string {
  if (videoDuration <= 54) return 'bg54.wav';
  if (videoDuration <= 55) return 'bg55.wav';
  if (videoDuration <= 56) return 'bg56.wav';
  if (videoDuration <= 57) return 'bg57.wav';
  if (videoDuration <= 58) return 'bg58.wav';
  if (videoDuration <= 59) return 'bg59.wav';
  return 'bg60.wav';
}

export function selectBackgroundTrack(videoDuration: number, bgDir: string): string | null {
  if (!bgDir || !fs.existsSync(bgDir)) return null;

  const bgFile = selectBackgroundTrackName(videoDuration);
  const fullPath = path.join(bgDir, bgFile);
  if (fs.existsSync(fullPath)) {
    console.log(`Selected background track: ${bgFile}`);
    return fullPath;
  }

  console.warn(`Background track not found: ${fullPath}`);
  return null;
}

// ---------------------------------------------------------------------------
// Step 7: Mix audio — background track + per-segment audio with delays
// ---------------------------------------------------------------------------

export async function overlayAudio(
  videoFile: string,
  audioFiles: (string | null)[],
  backgroundTrack: string | null,
  timings: number[],
  outputFile: string,
): Promise<string> {
  console.log('\n=== Step 7: Audio overlay ===');

  const videoDuration = await getVideoDuration(videoFile);
  const args = ['-y', '-i', videoFile];
  let inputCount = 1;

  // Background track input
  let bgInputIndex: number | null = null;
  if (backgroundTrack && fs.existsSync(backgroundTrack)) {
    args.push('-i', backgroundTrack);
    bgInputIndex = inputCount++;
    console.log(`  Background track: input ${bgInputIndex} (${path.basename(backgroundTrack)})`);
  }

  // Per-segment audio inputs
  const audioInputMap = new Map<number, number>();
  for (let i = 0; i < audioFiles.length; i++) {
    const af = audioFiles[i];
    if (af && fs.existsSync(af)) {
      args.push('-i', af);
      audioInputMap.set(i, inputCount++);
      console.log(`  Segment ${i} audio: input ${inputCount - 1} (delay ${(timings[i] ?? 0).toFixed(1)}s)`);
    }
  }

  const hasAnyAudio = bgInputIndex !== null || audioInputMap.size > 0;

  if (!hasAnyAudio) {
    console.log('  No audio sources found, copying video as-is...');
    await runFfmpeg(['-y', '-i', videoFile, '-c:v', 'copy', '-movflags', '+faststart', outputFile]);
    return outputFile;
  }

  // Build filter_complex
  const filters: string[] = [];
  const audioStreams: string[] = [];

  // Background: loop to fill video duration, then trim
  if (bgInputIndex !== null) {
    filters.push(`[${bgInputIndex}:a]aloop=loop=-1:size=2e+09,atrim=duration=${videoDuration}[bg]`);
    audioStreams.push('[bg]');
  }

  // Per-segment audio: delay each to its segment start time
  for (const [segIdx, audioIdx] of audioInputMap) {
    const delayMs = Math.round((timings[segIdx] ?? 0) * 1000);
    const label = `delayed_${segIdx}`;
    filters.push(`[${audioIdx}:a]adelay=${delayMs}|${delayMs}[${label}]`);
    audioStreams.push(`[${label}]`);
  }

  // Mix all audio streams
  if (audioStreams.length > 1) {
    filters.push(
      `${audioStreams.join('')}amix=inputs=${audioStreams.length}:duration=longest:dropout_transition=2[mixed_audio]`,
    );
    args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[mixed_audio]');
  } else if (audioStreams.length === 1) {
    if (filters.length > 0) {
      args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', audioStreams[0]);
    } else {
      args.push('-map', '0:v', '-map', '1:a');
    }
  }

  // Copy video (no re-encode), encode audio to AAC
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputFile);

  const start = Date.now();
  await runFfmpeg(args);
  console.log(`Audio overlay completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  return outputFile;
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

export function cleanupTempFiles(
  videoParts: VideoParts[],
  transitions: (string | null)[],
  extras: (string | null | undefined)[],
) {
  const files = new Set<string>();

  for (const parts of videoParts) {
    if (parts.first) files.add(parts.first);
    if (parts.middle) files.add(parts.middle);
    if (parts.last) files.add(parts.last);
  }
  for (const t of transitions) {
    if (t) files.add(t);
  }
  for (const f of extras) {
    if (f) files.add(f);
  }

  let removed = 0;
  for (const f of files) {
    try {
      if (fs.existsSync(f)) { fs.unlinkSync(f); removed++; }
    } catch { /* ignore */ }
  }
  console.log(`Cleanup: removed ${removed} temp files`);
}

// ---------------------------------------------------------------------------
// Main pipeline — orchestrates all steps
// ---------------------------------------------------------------------------

export async function stitch(options: StitchOptions): Promise<string> {
  const totalStart = Date.now();

  const {
    videos,
    audioFiles,
    output,
    overlapDuration,
    chromaKeyColor,
    similarity,
    blend,
    tmpDir,
    backgroundTrackDir,
    bucket,
    inputDir,
    outputDir,
    audioDir,
    cleanupInputFiles = true,
  } = options;

  const isS3Mode = !!bucket;

  // Ensure tmp dir exists
  fs.mkdirSync(tmpDir, { recursive: true });

  // Normalize overlapDuration into a per-transition array of length N-1
  const overlaps: number[] = Array.isArray(overlapDuration)
    ? overlapDuration
    : new Array(Math.max(0, videos.length - 1)).fill(overlapDuration);

  if (overlaps.length !== Math.max(0, videos.length - 1)) {
    throw new Error(
      `overlap array length (${overlaps.length}) must be ${videos.length - 1} (N-1 for ${videos.length} videos)`,
    );
  }

  console.log(`\nStitch pipeline: ${videos.length} videos (${isS3Mode ? 'S3' : 'local'} mode)`);
  console.log(`  Overlaps: [${overlaps.join(', ')}]s | Chroma: ${chromaKeyColor} | Similarity: ${similarity} | Blend: ${blend}`);
  console.log(`  Output: ${output}`);
  console.log(`  Tmp dir: ${tmpDir}`);
  if (isS3Mode) console.log(`  S3: ${bucket} | input: ${inputDir} | output: ${outputDir}`);
  console.log();

  // 0. Resolve inputs — download from S3 if needed, or validate local paths
  const localVideos = await resolveInputFiles(videos, tmpDir, bucket, inputDir);
  const localAudio = await resolveAudioFiles(audioFiles, tmpDir, bucket, audioDir);

  // 1. Analyze
  const durations = await analyzeVideos(localVideos);

  // 2. Split
  const videoParts = await splitAllVideos(localVideos, durations, tmpDir, overlaps);

  // 3. Transitions
  const transitions = await createAllTransitions(videoParts, tmpDir, chromaKeyColor, similarity, blend);

  // 4. Stitch video segments
  const videoOnlyOutput = output.replace(/\.mp4$/, '_video_only.mp4');
  await stitchSegments(videoParts, transitions, videoOnlyOutput);

  // 5. Calculate audio timings
  const timings = await calculateTimings(videoParts, transitions);

  // 6. Background track
  const videoDuration = await getVideoDuration(videoOnlyOutput);
  let bgTrack: string | null = null;
  if (backgroundTrackDir) {
    bgTrack = selectBackgroundTrack(videoDuration, backgroundTrackDir);
  } else if (isS3Mode && audioDir) {
    // Select and download background track from S3
    const bgFile = selectBackgroundTrackName(videoDuration);
    if (bgFile) {
      bgTrack = await downloadBackgroundTrack(bgFile, tmpDir, bucket!, audioDir);
    }
  }

  // 7. Audio overlay
  await overlayAudio(videoOnlyOutput, localAudio, bgTrack, timings, output);

  // 8. Upload to S3 if in S3 mode
  let resultPath = output;
  if (isS3Mode && outputDir) {
    const s3Key = `${outputDir}/${path.basename(output)}`;
    resultPath = await uploadToS3(output, bucket!, s3Key);
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

  return resultPath;
}
