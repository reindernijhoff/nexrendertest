import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {VideoSegment} from './types.js';
import { runParallel } from './utils.js';

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
 * Resolve a single file: download from S3 if needed, otherwise validate local.
 * Handles full s3:// URIs, relative S3 keys (via bucket + s3Dir), and local paths.
 */
async function resolveFile(
    srcPath: string,
    localName: string,
    tmpDir: string,
    bucket?: string,
    s3Dir?: string,
): Promise<string> {
    if (srcPath.startsWith('s3://')) {
        const localFile = path.join(tmpDir, localName);
        await downloadFromS3(srcPath, localFile);
        return localFile;
    }
    if (bucket && s3Dir) {
        const s3Path = `s3://${bucket}/${s3Dir}/${srcPath}`;
        const localFile = path.join(tmpDir, localName);
        await downloadFromS3(s3Path, localFile);
        return localFile;
    }
    const resolved = path.resolve(srcPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }
    return resolved;
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
        seg.localVideo = await resolveFile(
            seg.srcVideo, `input_${i}${path.extname(seg.srcVideo) || '.mp4'}`, tmpDir, bucket, inputDir,
        );
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
        if (!seg.srcAudio || seg.srcAudio.trim() === '') return;
        try {
            seg.localAudio = await resolveFile(
                seg.srcAudio, `audio_${i}${path.extname(seg.srcAudio) || '.wav'}`, tmpDir, bucket, audioDir,
            );
        } catch {
            console.warn(`  Audio file not found, skipping: ${seg.srcAudio}`);
        }
    });
    await runParallel(tasks, 4);
}

/**
 * Select and resolve a background track from the bgTracks map.
 * Keys are max-duration thresholds (seconds), values are file paths (local, S3 key, or s3:// URI).
 * Picks the smallest key >= videoDuration, or the largest key if none qualify.
 */
export async function resolveBackgroundTrack(
    bgTracks: Record<string, string>,
    videoDuration: number,
    tmpDir: string,
    bucket?: string,
    audioDir?: string,
): Promise<string | null> {
    const keys = Object.keys(bgTracks).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (keys.length === 0) return null;

    const selected = keys.find(k => k >= videoDuration) ?? keys[keys.length - 1];
    const trackPath = bgTracks[String(selected)];
    if (!trackPath) return null;

    console.log(`Selected background track: ${trackPath} (threshold ${selected}s for ${videoDuration.toFixed(1)}s video)`);

    try {
        return await resolveFile(
            trackPath, `bg_${selected}${path.extname(trackPath) || '.wav'}`, tmpDir, bucket, audioDir,
        );
    } catch (err) {
        console.warn(`  Could not resolve background track: ${(err as Error).message}`);
        return null;
    }
}
