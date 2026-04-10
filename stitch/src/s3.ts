import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

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
 * Resolve video paths: download from S3 if needed, otherwise return local path.
 * Supports both full S3 URIs (s3://bucket/key) and relative keys
 * (resolved against bucket/inputDir).
 * Downloads happen in parallel (up to 8 concurrent).
 */
export async function resolveInputFiles(
  paths: string[],
  tmpDir: string,
  bucket?: string,
  inputDir?: string,
): Promise<string[]> {
  const localPaths: string[] = new Array(paths.length);

  const tasks = paths.map((p, i) => async () => {
    if (p.startsWith('s3://')) {
      const localFile = path.join(tmpDir, `input_${i}${path.extname(p) || '.mp4'}`);
      await downloadAndValidate(p, localFile);
      localPaths[i] = localFile;
    } else if (bucket && inputDir) {
      const s3Path = `s3://${bucket}/${inputDir}/${p}`;
      const localFile = path.join(tmpDir, `input_${i}${path.extname(p) || '.mp4'}`);
      await downloadAndValidate(s3Path, localFile);
      localPaths[i] = localFile;
    } else {
      if (!fs.existsSync(p)) {
        throw new Error(`Input file not found: ${p}`);
      }
      localPaths[i] = path.resolve(p);
    }
  });

  // Run downloads in parallel (max 8)
  await runParallel(tasks, 8);
  return localPaths;
}

/**
 * Resolve audio paths: download from S3 if needed, otherwise return local path.
 * Downloads happen in parallel (up to 4 concurrent).
 * Empty strings are passed through as null.
 */
export async function resolveAudioFiles(
  paths: string[],
  tmpDir: string,
  bucket?: string,
  audioDir?: string,
): Promise<(string | null)[]> {
  const localPaths: (string | null)[] = new Array(paths.length).fill(null);

  const tasks = paths.map((p, i) => async () => {
    if (!p || p.trim() === '') return;

    if (p.startsWith('s3://')) {
      const localFile = path.join(tmpDir, `audio_${i}${path.extname(p) || '.wav'}`);
      await downloadAndValidate(p, localFile);
      localPaths[i] = localFile;
    } else if (bucket && audioDir) {
      const s3Path = `s3://${bucket}/${audioDir}/${p}`;
      const localFile = path.join(tmpDir, `audio_${i}${path.extname(p) || '.wav'}`);
      await downloadAndValidate(s3Path, localFile);
      localPaths[i] = localFile;
    } else {
      if (fs.existsSync(p)) {
        localPaths[i] = path.resolve(p);
      } else {
        console.warn(`  Audio file not found, skipping: ${p}`);
      }
    }
  });

  // Run downloads in parallel (max 4)
  await runParallel(tasks, 4);
  return localPaths;
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
