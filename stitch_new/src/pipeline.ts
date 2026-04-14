import * as fs from 'node:fs';
import * as path from 'node:path';
import type {AccelParams, VideoSegment} from './types.js';
import {detectAcceleration, getVideoDuration, hexToChromaKeyColor, runFfmpeg,} from './ffmpeg.js';
import {pLimit} from './utils.js';

export async function analyzeVideos(segments: VideoSegment[]): Promise<void> {
    const limit = pLimit(8);

    await Promise.all(
        segments.map((seg, i) =>
            limit(async () => {
                seg.duration = await getVideoDuration(seg.localVideo);
                const stat = fs.statSync(seg.localVideo);
                console.log(
                    `[${i}] ${path.basename(seg.localVideo)}: ${seg.duration.toFixed(1)}s (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
                );
            }),
        ),
    );
}

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

async function splitVideo(seg: VideoSegment, index: number, outputDir: string, accel: AccelParams): Promise<void> {
    console.log(`Splitting video ${index}: ${path.basename(seg.localVideo)} (overlap before=${seg.overlapBefore}s after=${seg.overlapAfter}s)`);

    if (seg.overlapBefore > 0) {
        seg.first = path.join(outputDir, `video_${index}_first.mp4`);
        await createSegment(seg.localVideo, seg.first, accel, 0, seg.overlapBefore);
        seg.firstDuration = await getVideoDuration(seg.first);
    }

    if (seg.overlapAfter > 0 && seg.duration > seg.overlapAfter) {
        seg.last = path.join(outputDir, `video_${index}_last.mp4`);
        await createSegment(seg.localVideo, seg.last, accel, seg.duration - seg.overlapAfter, seg.overlapAfter);
        seg.lastDuration = await getVideoDuration(seg.last);
    }

    seg.middle = path.join(outputDir, `video_${index}_middle.mp4`);

    if (seg.overlapBefore === 0) {
        await createSegment(seg.localVideo, seg.middle, accel, 0, seg.duration - seg.overlapAfter);
    } else {
        const middleDuration = seg.duration - seg.overlapBefore - seg.overlapAfter;
        if (middleDuration > 0) {
            await createSegment(seg.localVideo, seg.middle, accel, seg.overlapBefore, middleDuration);
        } else {
            // Video too short for a proper middle — create minimal placeholder
            await runFfmpeg([
                '-y', '-f', 'lavfi', '-i', 'color=black:size=1920x1080:duration=0.033:rate=30',
                '-c:v', 'libx264', '-preset', 'ultrafast', seg.middle,
            ]);
        }
    }
    seg.middleDuration = await getVideoDuration(seg.middle);
}

export async function splitAllVideos(segments: VideoSegment[], tmpDir: string): Promise<void> {
    const accel = await detectAcceleration();
    const limit = pLimit(4);

    await Promise.all(
        segments.map((seg, i) =>
            limit(() => splitVideo(seg, i, tmpDir, accel)),
        ),
    );
}

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
    segments: VideoSegment[],
    tmpDir: string,
    chromaKeyColor: string,
    similarity: number,
    blend: number,
): Promise<(string | null)[]> {
    const accel = await detectAcceleration();
    const limit = pLimit(2);

    const transitions: (string | null)[] = new Array(segments.length - 1).fill(null);

    await Promise.all(
        Array.from({length: segments.length - 1}, (_, i) =>
            limit(async () => {
                const endVideo = segments[i].last;
                const startVideo = segments[i + 1].first;
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

export async function stitchSegments(
    segments: VideoSegment[],
    transitions: (string | null)[],
    outputPath: string,
): Promise<number> {
    const sequenceFiles: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        if (segments[i].middle && fs.existsSync(segments[i].middle)) {
            sequenceFiles.push(segments[i].middle);
        }
        if (i < transitions.length && transitions[i] && fs.existsSync(transitions[i]!)) {
            sequenceFiles.push(transitions[i]!);
        }
    }

    const concatFile = path.join(path.dirname(outputPath), 'concat_list.txt');
    const lines = sequenceFiles.map((f, i) => {
        const normalized = f.replace(/\\/g, '/');
        // Skip first 0.033s of the first file to avoid black-frame artifact
        if (i === 0) return `file '${normalized}'\ninpoint 0.033`;
        return `file '${normalized}'`;
    });
    fs.writeFileSync(concatFile, lines.join('\n'));

    try {
        await runFfmpeg([
            '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
            '-c', 'copy', '-movflags', '+faststart', outputPath,
        ]);
    } catch {
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

    try {
        fs.unlinkSync(concatFile);
    } catch { /* ignore */
    }

    const stat = fs.statSync(outputPath);
    console.log(`Stitched video: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    return await getVideoDuration(outputPath);
}

export function calculateTimings(
    segments: VideoSegment[],
    transitions: (string | null)[],
): number {
    let currentTime = 0;

    for (let i = 0; i < segments.length; i++) {
        segments[i].startTime = currentTime;
        console.log(`  Segment ${i} starts at ${currentTime.toFixed(3)}s`);

        currentTime += segments[i].middleDuration;

        if (i < transitions.length && transitions[i]) {
            currentTime += Math.min(segments[i].lastDuration, segments[i + 1].firstDuration);
        }
    }

    console.log(`Total calculated duration: ${currentTime.toFixed(3)}s`);
    return currentTime;
}

export async function overlayAudio(
    videoFile: string,
    segments: VideoSegment[],
    backgroundTrack: string | null,
    videoDuration: number,
    outputFile: string,
): Promise<string> {
    const args = ['-y', '-i', videoFile];
    let inputCount = 1;

    let bgInputIndex: number | null = null;
    if (backgroundTrack && fs.existsSync(backgroundTrack)) {
        args.push('-i', backgroundTrack);
        bgInputIndex = inputCount++;
        console.log(`  Background track: input ${bgInputIndex} (${path.basename(backgroundTrack)})`);
    }

    const audioInputMap = new Map<number, number>();
    for (let i = 0; i < segments.length; i++) {
        const af = segments[i].localAudio;
        if (af && fs.existsSync(af)) {
            args.push('-i', af);
            audioInputMap.set(i, inputCount++);
            console.log(`  Segment ${i} audio: input ${inputCount - 1} (delay ${segments[i].startTime.toFixed(1)}s)`);
        }
    }

    const hasAnyAudio = bgInputIndex !== null || audioInputMap.size > 0;

    if (!hasAnyAudio) {
        console.log('  No audio sources found, copying video as-is...');
        await runFfmpeg(['-y', '-i', videoFile, '-c:v', 'copy', '-movflags', '+faststart', outputFile]);
        return outputFile;
    }

    const filters: string[] = [];
    const audioStreams: string[] = [];

    if (bgInputIndex !== null) {
        filters.push(`[${bgInputIndex}:a]aloop=loop=-1:size=2e+09,atrim=duration=${videoDuration}[bg]`);
        audioStreams.push('[bg]');
    }

    for (const [segIdx, audioIdx] of audioInputMap) {
        const delayMs = Math.round(segments[segIdx].startTime * 1000);
        const label = `delayed_${segIdx}`;
        filters.push(`[${audioIdx}:a]adelay=${delayMs}|${delayMs}[${label}]`);
        audioStreams.push(`[${label}]`);
    }

    if (audioStreams.length > 1) {
        filters.push(
            `${audioStreams.join('')}amix=inputs=${audioStreams.length}:duration=longest:dropout_transition=2[mixed_audio]`,
        );
        args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[mixed_audio]');
    } else if (audioStreams.length === 1) {
        args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', audioStreams[0]);
    }

    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputFile);

    const start = Date.now();
    await runFfmpeg(args);
    console.log(`Audio overlay completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);

    return outputFile;
}
