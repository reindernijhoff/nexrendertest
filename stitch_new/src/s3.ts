import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {VideoSegment} from './types.js';

const execFileAsync = promisify(execFile) as (
    file: string,
    args: string[],
    options: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Download a file from S3 to a local path using AWS CLI.
 */
export async function downloadFromS3(s3Path: string, localPath: string): Promise<void> {
  console.log(`Downloading ${s3Path}...`);
  const start = Date.now();

  try {
    await execFileAsync('aws', ['s3', 'cp', s3Path, localPath], { timeout: 120_000 });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`S3 download failed: ${stderr || (err as Error).message}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const size = fs.existsSync(localPath)
    ? `${(fs.statSync(localPath).size / 1024 / 1024).toFixed(1)}MB`
    : '?';
  console.log(`  Downloaded in ${elapsed}s (${size})`);
}

/**
 * Upload a local file to S3 using AWS CLI.
 */
export async function uploadToS3(localPath: string, bucket: string, s3Key: string): Promise<string> {
  const s3Path = `s3://${bucket}/${s3Key}`;
  console.log(`Uploading to ${s3Path}...`);

  try {
    await execFileAsync('aws', ['s3', 'cp', localPath, s3Path], { timeout: 120_000 });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    throw new Error(`S3 upload failed: ${stderr || (err as Error).message}`);
  }

  console.log(`  Uploaded to ${s3Path}`);
  return s3Path;
}

/**
 * Download a single file from S3 with validation (min file size check).
 */
async function downloadAndValidate(s3Path: string, localFile: string, minSize = 1024): Promise<void> {
  await downloadFromS3(s3Path, localFile);

  if (!fs.existsSync(localFile)) {
    throw new Error(`Download produced no file: ${s3Path}`);
  }
  const size = fs.statSync(localFile).size;
  if (size < minSize) {
    throw new Error(`Downloaded file too small (${size} bytes): ${s3Path}`);
  }
}

/**
 * Resolve video paths: download from S3 if needed, otherwise validate local.
 * Sets localVideo on each segment. Downloads in parallel (up to 8 concurrent).
 */
export async function resolveInputFiles(
    segments: VideoSegment[],
    tmpDir: string,
    bucket?: string,
    inputDir?: string,
): Promise<void> {
    const tasks = segments.map((seg, i) => async () => {
        const p = seg.srcVideo;
        if (p.startsWith('s3://')) {
            const localFile = path.join(tmpDir, `input_${i}${path.extname(p) || '.mp4'}`);
            await downloadAndValidate(p, localFile);
            seg.localVideo = localFile;
        } else if (bucket && inputDir) {
            const s3Path = `s3://${bucket}/${inputDir}/${p}`;
            const localFile = path.join(tmpDir, `input_${i}${path.extname(p) || '.mp4'}`);
            await downloadAndValidate(s3Path, localFile);
            seg.localVideo = localFile;
        } else {
            if (!fs.existsSync(p)) {
                throw new Error(`Input file not found: ${p}`);
            }
            seg.localVideo = path.resolve(p);
        }
    });

    await runParallel(tasks, 8);
}

/**
 * Resolve audio paths: download from S3 if needed, otherwise validate local.
 * Sets localAudio on each segment. Downloads in parallel (up to 4 concurrent).
 */
export async function resolveAudioFiles(
    segments: VideoSegment[],
    tmpDir: string,
    bucket?: string,
    audioDir?: string,
): Promise<void> {
    const tasks = segments.map((seg, i) => async () => {
        const p = seg.srcAudio;
        if (!p || p.trim() === '') return;

        if (p.startsWith('s3://')) {
            const localFile = path.join(tmpDir, `audio_${i}${path.extname(p) || '.wav'}`);
            await downloadAndValidate(p, localFile);
            seg.localAudio = localFile;
        } else if (bucket && audioDir) {
            const s3Path = `s3://${bucket}/${audioDir}/${p}`;
            const localFile = path.join(tmpDir, `audio_${i}${path.extname(p) || '.wav'}`);
            await downloadAndValidate(s3Path, localFile);
            seg.localAudio = localFile;
        } else {
            if (fs.existsSync(p)) {
                seg.localAudio = path.resolve(p);
            } else {
                console.warn(`  Audio file not found, skipping: ${p}`);
            }
        }
    });

    await runParallel(tasks, 4);
}

/**
 * Simple parallel task runner with concurrency limit.
 */
async function runParallel(tasks: (() => Promise<void>)[], concurrency: number): Promise<void> {
  let active = 0;
  let index = 0;
  const errors: Error[] = [];

  await new Promise<void>((resolve) => {
    const next = () => {
      while (active < concurrency && index < tasks.length) {
        const task = tasks[index++];
        active++;
        task()
          .catch((err) => errors.push(err as Error))
          .finally(() => {
            active--;
            if (index < tasks.length) next();
            else if (active === 0) resolve();
          });
      }
      if (tasks.length === 0) resolve();
    };
    next();
  });

  if (errors.length > 0) {
    throw new Error(`${errors.length} download(s) failed:\n${errors.map(e => e.message).join('\n')}`);
  }
}

/**
 * Download a background track from S3.
 */
export async function downloadBackgroundTrack(
  bgFile: string,
  tmpDir: string,
  bucket: string,
  audioDir: string,
): Promise<string | null> {
  const localFile = path.join(tmpDir, bgFile);
  const s3Path = `s3://${bucket}/${audioDir}/${bgFile}`;

  try {
    await downloadFromS3(s3Path, localFile);
    return localFile;
  } catch (err) {
    console.warn(`  Could not download background track ${bgFile}: ${(err as Error).message}`);
    return null;
  }
}
