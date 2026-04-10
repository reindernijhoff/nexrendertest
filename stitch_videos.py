#!/usr/bin/env python3
import time
start_time = time.time()

print(f"Starting: {start_time}")
import subprocess
import tempfile
import os
import argparse
from typing import List
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
print(f"All imports done: {time.time() - start_time:.2f}s")

audio_dir = "assets/audio"

def get_video_duration_robust(filepath: str, max_retries: int = 3) -> float:
    """Get video duration with robust error handling and retries"""
    print(f"Getting duration for {os.path.basename(filepath)}")
    
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"File not found: {filepath}")
    
    # Wait a moment to ensure file is fully written
    time.sleep(0.1)
    
    for attempt in range(max_retries):
        try:
            cmd = [
                'ffprobe', '-v', 'error',  # Show errors instead of quiet
                '-show_entries', 'format=duration',
                '-of', 'csv=p=0', 
                filepath
            ]
            
            print(f"   Attempt {attempt + 1}: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)  # Add timeout
            
            if result.returncode == 0 and result.stdout.strip():
                duration = float(result.stdout.strip())
                print(f"   Duration: {duration:.2f}s")
                return duration
            else:
                print(f"    Attempt {attempt + 1} failed:")
                print(f"      Return code: {result.returncode}")
                print(f"      Stdout: '{result.stdout.strip()}'")
                print(f"      Stderr: '{result.stderr.strip()}'")
                
                if attempt < max_retries - 1:
                    wait_time = (attempt + 1) * 0.5  # Exponential backoff
                    print(f"   Waiting {wait_time}s before retry...")
                    time.sleep(wait_time)
                
        except subprocess.TimeoutExpired:
            print(f"   Attempt {attempt + 1} timed out")
            if attempt < max_retries - 1:
                time.sleep(1)
        except ValueError as e:
            print(f"   Could not parse duration: {e}")
            if attempt < max_retries - 1:
                time.sleep(0.5)
        except Exception as e:
            print(f"   Unexpected error: {e}")
            if attempt < max_retries - 1:
                time.sleep(0.5)
    
    # If all retries failed, try alternative method
    print(f"   All ffprobe attempts failed, trying alternative method...")
    return get_duration_alternative(filepath)

def get_duration_alternative(filepath: str) -> float:
    """Alternative method to get video duration using ffmpeg"""
    try:
        cmd = [
            'ffmpeg', '-i', filepath,
            '-f', 'null', '-'
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        
        # Parse duration from ffmpeg output
        import re
        duration_pattern = r'Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})'
        match = re.search(duration_pattern, result.stderr)
        
        if match:
            hours, minutes, seconds = match.groups()
            total_seconds = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
            print(f"   Alternative method found duration: {total_seconds:.2f}s")
            return total_seconds
        else:
            print(f"   Could not parse duration from ffmpeg output")
            # Last resort: assume a default duration
            file_size_mb = os.path.getsize(filepath) / (1024 * 1024)
            estimated_duration = max(1.0, file_size_mb / 2)  # Rough estimate: 2MB per second
            print(f"   Using estimated duration based on file size: {estimated_duration:.2f}s")
            return estimated_duration
            
    except Exception as e:
        print(f"   Alternative method failed: {e}")
        # Final fallback
        print(f"   Using fallback duration of 10.0s")
        return 10.0

def download_single_file_robust(args: tuple[str, str, str, str, int]) -> tuple[int, str, float]:
    """Download a single file and get its duration with robust error handling"""
    bucket, inputdir, video_path, tmpdir, index = args
    
    download_start = time.time()
    
    local_file = os.path.join(tmpdir, f"video_{index}.mp4")
    
    if video_path.startswith('s3://'):
        s3_path = f"{video_path}"
    else:
        s3_path = f"s3://{bucket}/{inputdir}/{video_path}"
    
    print(f"[{index}] Downloading {os.path.basename(s3_path)}...")
    
    try:
        # Download file
        download_from_s3(s3_path, local_file)
        
        if not os.path.isfile(local_file):
            raise FileNotFoundError(f"Could not download {s3_path} to {local_file}")
        
        download_time = time.time() - download_start
        
        # Verify file integrity
        file_size = os.path.getsize(local_file)
        if file_size < 1024:  # Less than 1KB is suspicious
            raise RuntimeError(f"Downloaded file {local_file} is too small ({file_size} bytes)")
        
        print(f"[{index}] Downloaded {os.path.basename(s3_path)} ({file_size/1024/1024:.1f}MB) in {download_time:.1f}s")
        
        # Get duration with robust method
        duration_start = time.time()
        duration = get_video_duration_robust(local_file)
        duration_time = time.time() - duration_start
        
        total_time = time.time() - download_start
        
        print(f"[{index}] Completed {os.path.basename(s3_path)} - {duration:.1f}s duration (analysis: {duration_time:.1f}s, total: {total_time:.1f}s)")
        
        return index, local_file, duration
        
    except Exception as e:
        print(f"[{index}] Error processing {os.path.basename(video_path)}: {e}")
        raise

def download_and_analyze_parallel_robust(bucket: str, inputdir: str, video_paths: List[str], 
                                         tmpdir: str, output_filename: str) -> tuple[List[str], List[float], str]:
    """Robust parallel download with better error handling"""
        
    print(f"Starting robust parallel download of {len(video_paths)} videos...")
    
    # Prepare download tasks
    download_tasks = []
    for i, video_path in enumerate(video_paths):
        task = (bucket, inputdir, video_path, tmpdir, i)
        download_tasks.append(task)
    
    # Execute downloads in parallel with reduced concurrency to avoid ffprobe conflicts
    local_files = [None] * len(video_paths)
    durations = [None] * len(video_paths)
    
    # Reduce max workers to avoid ffprobe conflicts
    max_workers = min(len(video_paths), 8)  # Reduced from 8 to 4
    print(f"Using {max_workers} parallel workers (reduced to avoid ffprobe conflicts)...")
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit all download tasks
        future_to_index = {}
        for task in download_tasks:
            future = executor.submit(download_single_file_robust, task)
            future_to_index[future] = task[4]  # Store the index
        
        # Collect results as they complete
        completed = 0
        failed = []
        
        for future in as_completed(future_to_index):
            try:
                index, local_file, duration = future.result()
                local_files[index] = local_file
                durations[index] = duration
                completed += 1
                
                print(f"Progress: {completed}/{len(video_paths)} files completed successfully")
                
            except Exception as e:
                index = future_to_index[future]
                failed.append((index, str(e)))
                print(f"Failed to process file {index}: {e}")
    
    # Check for failures
    if failed:
        print(f"{len(failed)} files failed to process:")
        for index, error in failed:
            print(f"   File {index} ({video_paths[index]}): {error}")
        raise RuntimeError(f"{len(failed)} files failed to download/analyze")
    
    # Verify all downloads completed
    if None in local_files or None in durations:
        missing = [i for i, f in enumerate(local_files) if f is None]
        raise RuntimeError(f"Failed to process files at indices: {missing}")
    
    local_output = os.path.join(tmpdir, f"{output_filename}")
        
    print(f"Successfully processed files:")
    for i, (file, duration) in enumerate(zip(local_files, durations)):
        file_size_mb = os.path.getsize(file) / (1024 * 1024)
        print(f"   {i}: {os.path.basename(file)} - {duration:.1f}s ({file_size_mb:.1f}MB)")
    
    return local_files, durations, local_output

def download_from_s3(s3_path: str, local_path: str):
    """Download file from S3 to local path using AWS CLI"""
    print(f"Downloading {s3_path}...")
    cmd = ['aws', 's3', 'cp', s3_path, local_path]

    start_time = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True)
    duration = time.time() - start_time
    print(f"Download completed in {duration:.2f}s")

    if result.returncode != 0:
        raise RuntimeError(f"AWS CLI download failed: {result.stderr}")

def upload_to_s3(local_path: str, bucket: str, s3_key: str, user_id: str = None):
    """Upload local file to S3 using AWS CLI.
    If user_id is provided, skip upload when an object with a name starting with
    '<user_id>_' already exists in the same output directory.
    """

    s3_path = f"s3://{bucket}/{s3_key}"

    # Optional: check for existing object for this user in the same directory
    # if user_id:
    #     prefix_dir = os.path.dirname(s3_key).rstrip('/')
    #     if s3_has_user_prefixed_object(bucket, prefix_dir, user_id):
    #         print(f"Skipping upload: object(s) for user '{user_id}' already exist in s3://{bucket}/{prefix_dir or ''}")
    #         return

    cmd = ['aws', 's3', 'cp', local_path, s3_path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"AWS CLI upload failed: {result.stderr}")
    print(f"Uploaded to {s3_path}")

def s3_has_user_prefixed_object(bucket: str, directory_prefix: str, user_id: str) -> bool:
    """Return True if any object exists in `directory_prefix` whose key starts with `<user_id>_`.
    directory_prefix: S3 key prefix representing the output directory (no leading/trailing slash needed).
    """
    import json

    normalized_prefix_dir = (directory_prefix or '').strip('/')
    s3_prefix = f"{normalized_prefix_dir}/{user_id}_" if normalized_prefix_dir else f"{user_id}_"

    check_cmd = [
        'aws', 's3api', 'list-objects-v2',
        '--bucket', bucket,
        '--prefix', s3_prefix,
        '--max-keys', '1'
    ]
    check_proc = subprocess.run(check_cmd, capture_output=True, text=True)
    if check_proc.returncode != 0:
        print(f"Warning: could not check for existing objects with prefix '{s3_prefix}': {check_proc.stderr.strip()}")
        return False

    try:
        data = json.loads(check_proc.stdout or '{}')
        key_count = int(data.get('KeyCount', 0))
    except Exception:
        key_count = 0

    return key_count > 0

def hex_to_chromakey_color(hex_color: str) -> str:
    """Convert hex color to chromakey filter format"""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) != 6:
        raise ValueError("Hex color must be 6 characters (e.g., #FF0000)")
    
    # Convert to 0xRRGGBB format for chromakey
    return f"0x{hex_color}"

def get_nvidia_acceleration_params():
    """Get NVIDIA hardware acceleration parameters if available"""
    # Test if NVENC is available
    test_cmd = ['ffmpeg', '-hide_banner', '-encoders']
    try:
        result = subprocess.run(test_cmd, capture_output=True, text=True, timeout=10)
        if 'h264_nvenc' in result.stdout:
            print("NVENC detected and available")
            return {
                'decoder': ['-hwaccel', 'cuda'],  # Simplified decoder setup
                'encoder': 'h264_nvenc',
                'preset': 'p2',  # Medium quality/speed balance
                'extra_params': ['-gpu', '0', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
            }
        else:
            print("NVENC not found in available encoders")
    except Exception as e:
        print(f"Could not detect NVENC: {e}")
    
    # Fallback to CPU
    print("Using CPU encoding")
    return {
        'decoder': [],
        'encoder': 'libx264',
        'preset': 'medium',
        'extra_params': ['-crf', '23']
    }

def get_acceleration_params():
    """Auto-detect best encoding parameters for current system"""
    # First check for hardware acceleration
    test_cmd = ['ffmpeg', '-hide_banner', '-encoders']
    try:
        result = subprocess.run(test_cmd, capture_output=True, text=True, timeout=10)
        
        # Check for NVENC (NVIDIA GPU)
        if 'h264_nvenc' in result.stdout:
            # Test if NVENC actually works
            test_nvenc_cmd = [
                'ffmpeg', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=1',
                '-c:v', 'h264_nvenc', '-f', 'null', '-'
            ]
            nvenc_test = subprocess.run(test_nvenc_cmd, capture_output=True, text=True, timeout=5)
            
            if nvenc_test.returncode == 0:
                print("NVENC detected and working")
                return {
                    'decoder': ['-hwaccel', 'cuda'],
                    'encoder': 'h264_nvenc',
                    'preset': 'p2',
                    'extra_params': ['-gpu', '0', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
                }
        
        # Check for Intel Quick Sync (if available)
        if 'h264_qsv' in result.stdout:
            print("Intel Quick Sync detected")
            return {
                'decoder': ['-hwaccel', 'qsv'],
                'encoder': 'h264_qsv',
                'preset': 'medium',
                'extra_params': ['-global_quality', '23']
            }
        
    except Exception as e:
        print(f"Hardware detection failed: {e}")
    
    # Fallback to optimized CPU encoding
    import multiprocessing
    cpu_count = multiprocessing.cpu_count()
    
    print(f"Using CPU encoding with {cpu_count} threads")
    return {
        'decoder': [],
        'encoder': 'libx264',
        'preset': 'faster',  # Faster than 'fast' for CPU instances
        'extra_params': ['-crf', '23', '-threads', str(cpu_count)]
    }

def split_video_simple_clean(input_file: str, output_dir: str, video_index: int, duration: float, 
                            transition_duration: float = 1.0) -> dict:
    """Simple clean video splitting without padding"""
    print(f"Clean splitting video {video_index}: {os.path.basename(input_file)}")
    
    accel = get_acceleration_params()
    parts = {}
    
    def create_clean_segment(input_file: str, output_file: str, start_time: float = None, duration_limit: float = None):
        """Create segment without any padding"""
        cmd = ['ffmpeg', '-y']
        
        if accel['encoder'] == 'h264_nvenc':
            cmd.extend(['-hwaccel', 'cuda'])
        
        cmd.extend(['-i', input_file])
        
        # Precise timing
        if start_time is not None:
            cmd.extend(['-ss', str(start_time)])
        if duration_limit is not None:
            cmd.extend(['-t', str(duration_limit)])
        
        # Clean encoding without padding
        cmd.extend(['-map', '0:v:0', '-map', '0:a?'])
        
        if accel['encoder'] == 'h264_nvenc':
            cmd.extend([
                '-c:v', 'h264_nvenc', '-preset', 'p2', '-cq', '23', '-gpu', '0'
            ])
        else:
            cmd.extend([
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '23'
            ])
        
        cmd.extend([
            '-c:a', 'aac', '-b:a', '128k',
            '-pix_fmt', 'yuv420p',
            output_file
        ])
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            raise RuntimeError(f"Clean segment creation failed: {result.stderr}")
        
        return output_file
    
    # Create segments
    if video_index > 0:
        first_part = os.path.join(output_dir, f"video_{video_index}_first.mp4")
        create_clean_segment(input_file, first_part, 0.0, transition_duration)
        parts['first'] = first_part
    
    if duration > transition_duration:
        last_part = os.path.join(output_dir, f"video_{video_index}_last.mp4")
        start_time = duration - transition_duration
        create_clean_segment(input_file, last_part, start_time, transition_duration)
        parts['last'] = last_part
    
    middle_part = os.path.join(output_dir, f"video_{video_index}_middle.mp4")
    if video_index == 0:
        middle_duration = duration - transition_duration
        create_clean_segment(input_file, middle_part, 0.0, middle_duration)
    else:
        start_time = transition_duration
        middle_duration = duration - (2 * transition_duration)
        if middle_duration > 0:
            create_clean_segment(input_file, middle_part, start_time, middle_duration)
        else:
            # Minimal placeholder
            cmd = [
                'ffmpeg', '-y', 
                '-f', 'lavfi', '-i', 'color=black:size=1920x1080:duration=0.033:rate=30',
                '-c:v', 'libx264', '-preset', 'ultrafast',
                middle_part
            ]
            subprocess.run(cmd, capture_output=True, text=True)
    
    parts['middle'] = middle_part
    return parts

def create_transition_segment_optimized(end_video: str, start_video: str, output_path: str,
                                       chroma_key_color: str = "#00FF00", similarity: float = 0.1, 
                                       blend: float = 0.0) -> str:
    """Auto-detect best transition processing method"""
    print(f"Creating optimized transition: {os.path.basename(end_video)} + {os.path.basename(start_video)}")
    
    chromakey_color = hex_to_chromakey_color(chroma_key_color)
    accel = get_acceleration_params() 
    
    cmd = [
        'ffmpeg', '-y', '-v', 'error',
        '-f', 'mp4', '-i', end_video,
        '-f', 'mp4', '-i', start_video,
        '-filter_complex', f'[1:v]chromakey={chromakey_color}:{similarity}:{blend}[key];[0:v][key]overlay=shortest=1[out]',
        '-map', '[out]', '-map', '0:a:0?'
    ]
    
    # Add encoder-specific parameters
    if accel['encoder'] == 'h264_nvenc':
        # GPU (NVENC) parameters
        cmd.extend([
            '-c:v', 'h264_nvenc',
            '-preset', 'p2',
            '-cq', '23',
            '-gpu', '0',
            '-rc', 'vbr',
            '-b:v', '0'
        ])
        print("   Using GPU acceleration (NVENC)")
        
    elif accel['encoder'] == 'h264_qsv':
        # Intel Quick Sync parameters
        cmd.extend([
            '-c:v', 'h264_qsv',
            '-preset', 'medium',
            '-global_quality', '23'
        ])
        print("   Using Intel Quick Sync acceleration")
        
    else:
        # CPU (libx264) parameters
        cmd.extend([
            '-c:v', 'libx264',
            '-preset', 'faster',
            '-crf', '25',
            '-threads', '0'
        ])
        print("   Using CPU encoding")
    
    cmd.extend([
        '-c:a', 'copy',
        '-f', 'mp4',
        '-shortest',
        output_path
    ])
    
    start_time = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True)
    duration = time.time() - start_time
    
    if result.returncode != 0:
        raise RuntimeError(f"Transition creation failed: {result.stderr}")
    
    acceleration_type = "GPU" if accel['encoder'] in ['h264_nvenc', 'h264_qsv'] else "CPU"
    print(f"{acceleration_type} transition completed in {duration:.1f}s")
    return output_path

def process_transitions_parallel(video_parts: List[dict], tmpdir: str,
                                chroma_key_color: str = "#00FF00", 
                                similarity: float = 0.1, blend: float = 0.0) -> List[str]:
    """Create all transitions in parallel with optimized GPU usage"""
    print("Starting parallel transition processing...")
    
    transitions = [None] * (len(video_parts) - 1)
    
    # Use fewer workers to avoid GPU contention (NVENC has limited concurrent sessions)
    max_workers = min(2, len(video_parts) - 1)  # Limit to 2 concurrent GPU operations
    print(f"Using {max_workers} parallel workers for transitions")
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_index = {}
        
        for i in range(len(video_parts) - 1):
            if 'last' in video_parts[i] and 'first' in video_parts[i + 1]:
                end_video = video_parts[i]['last']
                start_video = video_parts[i + 1]['first']
                transition_output = os.path.join(tmpdir, f"transition_{i}_{i+1}.mp4")
                
                future = executor.submit(
                    create_transition_segment_optimized, end_video, start_video, transition_output,
                    chroma_key_color, similarity, blend
                )
                future_to_index[future] = i
        
        for future in as_completed(future_to_index):
            transition_index = future_to_index[future]
            try:
                transition_path = future.result()
                transitions[transition_index] = transition_path
                print(f"Completed transition {transition_index}: {transition_path}")
            except Exception as e:
                print(f"Error creating transition {transition_index}: {e}")
                raise
    
    valid_transitions = [t for t in transitions if t is not None]
    print(f"Created {len(valid_transitions)} transitions")
    return valid_transitions

def stitch_final_video_no_black_frame_simple(video_parts: List[dict], transitions: List[str], 
                                            output_path: str, quality_preset: str = "high"):
    """Stitch without black frame by using proper input seeking"""
    print("Final stitching with black frame prevention...")
    
    accel = get_nvidia_acceleration_params()
    
    # Build sequence
    sequence_files = []
    for i, parts in enumerate(video_parts):
        if 'middle' in parts and os.path.exists(parts['middle']):
            sequence_files.append(parts['middle'])
        if i < len(transitions) and transitions[i] and os.path.exists(transitions[i]):
            sequence_files.append(transitions[i])
    
    # Create concat file but seek 0.1s into the FIRST file only
    concat_file = os.path.join(os.path.dirname(output_path), "concat_list.txt")
    with open(concat_file, 'w') as f:
        for i, file_path in enumerate(sequence_files):
            normalized_path = file_path.replace('\\', '/')
            if i == 0:
                # For first file, add inpoint to skip black frame
                f.write(f"file '{normalized_path}'\n")
                f.write(f"inpoint 0.033\n")  # Skip first 0.1 seconds of first file
            else:
                f.write(f"file '{normalized_path}'\n")
    
    cmd = [
        'ffmpeg', '-y',
        '-f', 'concat', '-safe', '0', '-i', concat_file
    ]
    
    # Quality settings (copy if possible to avoid re-encoding)
    cmd.extend([
        '-c', 'copy',  # Try stream copy first
        '-movflags', '+faststart',
        output_path
    ])
    
    start_time = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True)
    stitch_time = time.time() - start_time
    
    if result.returncode != 0:
        print(f"Stream copy failed, trying with re-encoding...")
        
        # Fallback with re-encoding
        cmd = [
            'ffmpeg', '-y',
            '-f', 'concat', '-safe', '0', '-i', concat_file
        ]
        
        if accel['encoder'] == 'h264_nvenc':
            cmd.extend(['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '18', '-gpu', '0'])
        else:
            cmd.extend(['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'])
        
        cmd.extend(['-c:a', 'copy', '-movflags', '+faststart', output_path])
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        stitch_time = time.time() - start_time
    
    try:
        os.remove(concat_file)
    except:
        pass
    
    if result.returncode != 0:
        raise RuntimeError(f"Stitching failed: {result.stderr}")
    
    # Check file size
    final_size = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Stitching completed in {stitch_time:.1f}s, size: {final_size:.1f}MB")
    
    return output_path

def process_splits_parallel(local_files: List[str], durations: List[float], 
                           tmpdir: str, transition_duration: float = 1.0) -> List[dict]:
    """Split all videos in parallel"""
    print("Starting parallel video splitting...")
    
    video_parts = [None] * len(local_files)  # Pre-allocate list
    
    with ThreadPoolExecutor(max_workers=min(len(local_files), 4)) as executor:
        future_to_index = {}  # Map futures to their video indices
        
        for i, (file, duration) in enumerate(zip(local_files, durations)):
            future = executor.submit(split_video_simple_clean, file, tmpdir, i, duration, transition_duration)
            future_to_index[future] = i
        
        # Process completed futures
        for future in as_completed(future_to_index):
            video_index = future_to_index[future]
            try:
                start_time = time.time()
                result = future.result()
                duration = time.time() - start_time
                video_parts[video_index] = result  # Place in correct position
                print(f"Completed splitting video {video_index}. Duration: {duration:.1f}s")
            except Exception as e:
                print(f"Error splitting video {video_index}: {e}")
                raise
    
    print(f"Split {len(video_parts)} videos in correct order")
    return video_parts

def parse_comma_separated_values(input: str) -> List[str]:
    """Parse comma-separated list"""
    return [path.strip() for path in input.split(',') if path.strip()]

def process_audio_overlay(video_file: str, audio_files: List[str], background_track: str, 
                         transition_timings: List[float], output_file: str) -> str:
    """Add audio overlay as final separate step with proper stream handling"""
    print("Processing audio overlay...")
    
    # Get video duration and check for audio stream
    video_duration = get_video_duration_robust(video_file)
    has_original_audio = check_has_audio_stream(video_file)
    
    print(f"   Video duration: {video_duration:.1f}s")
    print(f"   Original audio: {has_original_audio}")
    
    cmd = ['ffmpeg', '-y']
    
    # Input: video file
    cmd.extend(['-i', video_file])
    
    # Input: background track
    if background_track and os.path.exists(background_track):
        cmd.extend(['-i', background_track])
        bg_input_index = 1
        print(f"   Background track: {os.path.basename(background_track)}")
    else:
        bg_input_index = None
        print("   No background track provided")
    
    # Input: segment audio files
    audio_input_map = {}
    current_input_index = 2 if bg_input_index else 1
    
    for i, audio_file in enumerate(audio_files):
        if audio_file and os.path.exists(audio_file):
            cmd.extend(['-i', audio_file])
            audio_input_map[i] = current_input_index
            current_input_index += 1
            print(f"   Added audio {i}: {os.path.basename(audio_file)}")
    
    # Check if we have any audio to process
    has_any_audio = has_original_audio or bg_input_index or audio_input_map
    
    if not has_any_audio:
        print("   No audio sources found, copying video as-is...")
        # Just copy video without audio processing
        cmd = [
            'ffmpeg', '-y',
            '-i', video_file,
            '-c:v', 'copy',
            '-movflags', '+faststart',
            output_file
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"Video copy failed: {result.stderr}")
        
        print("Video copied without audio processing")
        return output_file
    
    # Build filter complex for audio mixing
    filters = []
    audio_streams = []
    
    # Add original video audio if it exists
    if has_original_audio:
        audio_streams.append('[0:a]')
        print("   Using original video audio")
    
    # Add background track if available
    if bg_input_index:
        # Loop background track to match video duration
        filters.append(f'[{bg_input_index}:a]aloop=loop=-1:size=2e+09,atrim=duration={video_duration}[bg]')
        audio_streams.append('[bg]')
        print("   Using background track (looped)")
    
    # Add segment audio files with delays
    for segment_idx, audio_input_idx in audio_input_map.items():
        # Calculate delay: when this segment starts (after transitions)
        delay = transition_timings[segment_idx] if segment_idx < len(transition_timings) else 0
        
        delay_ms = int(delay * 1000)  # Convert to milliseconds
        delayed_label = f'delayed_{segment_idx}'
        
        filters.append(f'[{audio_input_idx}:a]adelay={delay_ms}|{delay_ms}[{delayed_label}]')
        audio_streams.append(f'[{delayed_label}]')
        print(f"   Segment {segment_idx} audio delayed by {delay:.1f}s")
    
    # Handle different audio scenarios
    if len(audio_streams) == 0:
        # No audio at all - should not happen due to earlier check
        cmd.extend(['-map', '0:v', '-c:v', 'copy'])
    elif len(audio_streams) == 1:
        # Single audio stream
        if filters:
            filter_complex = ';'.join(filters)
            cmd.extend([
                '-filter_complex', filter_complex,
                '-map', '0:v',
                '-map', audio_streams[0].replace('[', '').replace(']', '') if not filters else audio_streams[0]
            ])
        else:
            # Direct mapping
            cmd.extend(['-map', '0:v', '-map', '0:a'])
    else:
        # Multiple audio streams - mix them
        audio_mix = f'{"".join(audio_streams)}amix=inputs={len(audio_streams)}:duration=longest:dropout_transition=2[mixed_audio]'
        filters.append(audio_mix)
        
        filter_complex = ';'.join(filters)
        cmd.extend([
            '-filter_complex', filter_complex,
            '-map', '0:v',
            '-map', '[mixed_audio]'
        ])
    
    # Output settings
    cmd.extend([
        '-c:v', 'copy',  # Copy video (no re-encoding)
        '-c:a', 'aac',   # Re-encode audio
        '-b:a', '128k',
        '-movflags', '+faststart',
        output_file
    ])
    
    print(f"Audio processing command: {' '.join(cmd[:15])}...")
    
    start_time = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True)
    process_time = time.time() - start_time
    
    if result.returncode != 0:
        print(f"Audio processing failed: {result.stderr}")
        
        # Fallback: create silent audio if no audio sources
        if not has_original_audio and not bg_input_index and not audio_input_map:
            print("Creating silent audio track fallback...")
            cmd_silent = [
                'ffmpeg', '-y',
                '-i', video_file,
                '-f', 'lavfi', '-i', f'anullsrc=channel_layout=stereo:sample_rate=48000:duration={video_duration}',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-shortest',
                '-movflags', '+faststart',
                output_file
            ]
            
            result = subprocess.run(cmd_silent, capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(f"Silent audio fallback failed: {result.stderr}")
            
            print("Added silent audio track")
        else:
            raise RuntimeError(f"Audio processing failed: {result.stderr}")
    
    print(f"Audio processing completed in {process_time:.1f}s")
    return output_file

def check_has_audio_stream(filepath: str) -> bool:
    """Check if file has audio stream"""
    try:
        cmd = ['ffprobe', '-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filepath]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return result.returncode == 0 and 'audio' in result.stdout
    except:
        return False

def calculate_transition_timings(video_parts: List[dict], transitions: List[str]) -> List[float]:
    """Calculate when each video segment starts (after transitions)"""
    print("Calculating transition timings...")
    
    timings = []
    current_time = 0.0
    
    for i, parts in enumerate(video_parts):
        # Each segment starts at current_time
        timings.append(current_time)
        print(f"   Segment {i} starts at: {current_time:.1f}s")
        
        # Add duration of middle section
        if 'middle' in parts:
            middle_duration = get_video_duration_robust(parts['middle'])
            current_time += middle_duration
        
        # Add duration of transition (if exists)
        if i < len(transitions) and transitions[i]:
            transition_duration = get_video_duration_robust(transitions[i])
            current_time += transition_duration
    
    print(f"Total calculated duration: {current_time:.1f}s")
    return timings

def select_background_track(video_duration: float, bucket: str, inputdir: str, tmpdir: str) -> str:
    """Select and download appropriate background track based on video duration"""
    print(f"Selecting background track for {video_duration:.1f}s video...")
    
    # Determine which background track to use (53-60 seconds)
    if video_duration <= 54:
        bg_file = "bg54.wav"
    elif video_duration <= 55:
        bg_file = "bg55.wav"
    elif video_duration <= 56:
        bg_file = "bg56.wav"
    elif video_duration <= 57:
        bg_file = "bg57.wav"
    elif video_duration <= 58:
        bg_file = "bg58.wav"
    elif video_duration <= 59:
        bg_file = "bg59.wav"
    else:
        bg_file = "bg60.wav"
    
    print(f"   Selected: {bg_file}")
    
    # Download background track
    local_bg_file = os.path.join(tmpdir, bg_file)
    s3_bg_path = f"s3://{bucket}/{audio_dir}/{bg_file}"
    
    try:
        download_from_s3(s3_bg_path, local_bg_file)
        print(f"   Downloaded: {bg_file}")
        return local_bg_file
    except Exception as e:
        print(f"   Warning: Could not download {bg_file}: {e}")
        return None

def download_audio_files_parallel(bucket: str, inputdir: str, audio_paths: List[str], tmpdir: str) -> List[str]:
    """Download audio files in parallel"""
    print(f"Downloading {len(audio_paths)} audio files...")
    
    def download_single_audio(args):
        bucket, inputdir, audio_path, tmpdir, index = args
        
        if not audio_path:
            return index, None
        
        local_audio = os.path.join(tmpdir, f"segment_audio_{index}.wav")
        
        if audio_path.startswith('s3://'):
            s3_path = audio_path
        else:
            s3_path = f"s3://{bucket}/{audio_dir}/{audio_path}"
        
        try:
            download_from_s3(s3_path, local_audio)
            print(f"   Downloaded audio {index}: {os.path.basename(audio_path)}")
            return index, local_audio
        except Exception as e:
            print(f"   Failed to download audio {index}: {e}")
            return index, None
    
    # Prepare download tasks
    download_tasks = []
    for i, audio_path in enumerate(audio_paths):
        task = (bucket, inputdir, audio_path, tmpdir, i)
        download_tasks.append(task)
    
    # Download in parallel
    local_audio_files = [None] * len(audio_paths)
    
    with ThreadPoolExecutor(max_workers=min(len(audio_paths), 4)) as executor:
        future_to_index = {}
        for task in download_tasks:
            future = executor.submit(download_single_audio, task)
            future_to_index[future] = task[4]
        
        for future in as_completed(future_to_index):
            index, local_file = future.result()
            local_audio_files[index] = local_file
    
    print(f"Downloaded {sum(1 for f in local_audio_files if f)} audio files")
    return local_audio_files

def stitch_videos_with_separate_audio(bucket: str, tmpdir: str, inputdir: str, outputdir: str, 
                                     video_paths: List[str], audio_paths: List[str], output_filename: str, 
                                     overlap_duration: float = 1.0, chroma_key_color: str = "#00FF00", 
                                     similarity: float = 0.1, blend: float = 0.0, quality_preset: str = "high"):
    """Main function with separate audio processing"""
        
    try:
        # Step 1: Process video (existing pipeline)
        print("Step 1: Processing video pipeline...")
        local_files, durations, local_output = download_and_analyze_parallel_robust(
            bucket, inputdir, video_paths, tmpdir, output_filename
        )
        
        video_parts = process_splits_parallel(local_files, durations, tmpdir, overlap_duration)
        transitions = process_transitions_parallel(video_parts, tmpdir, chroma_key_color, similarity, blend)
        
        # Create video-only output first
        video_only_output = local_output.replace('.mp4', '_video_only.mp4')
        stitch_final_video_no_black_frame_simple(video_parts, transitions, video_only_output, quality_preset)
        
        # Step 2: Download audio files
        print("Step 2: Downloading audio files...")
        local_audio_files = download_audio_files_parallel(bucket, inputdir, audio_paths, tmpdir)
        
        # Step 3: Select and download background track
        print("Step 3: Selecting background track...")
        video_duration = get_video_duration_robust(video_only_output)
        background_track = select_background_track(video_duration, bucket, inputdir, tmpdir)
        
        # Step 4: Calculate timing for audio overlay
        print("Step 4: Calculating audio timings...")
        transition_timings = calculate_transition_timings(video_parts, transitions)
        
        # Test all audio files first
        print("Testing audio files:")
        for i, audio_file in enumerate(local_audio_files):
            test_audio_file(audio_file, i)

        # Test background track
        if background_track:
            test_audio_file(background_track, 'BG')

        process_audio_overlay_debug(video_only_output, local_audio_files, background_track, 
                                transition_timings, local_output)
        
        # Cleanup video-only file
        try:
            os.remove(video_only_output)
        except:
            pass
        
        # Verify final output
        final_duration = get_video_duration_robust(local_output)
        file_size_mb = os.path.getsize(local_output) / (1024 * 1024)
        print(f"Final video with audio - Duration: {final_duration}s, Size: {file_size_mb:.1f}MB")
        
    except Exception as e:
        print(f"Video+Audio processing failed: {e}")
        raise
    
    # Upload and cleanup
    # Extract userId from output filename (format: <userId>_boom_town_<date>...)
    import re
    user_match = re.match(r'^([^_]+)_', output_filename)
    user_id = user_match.group(1) if user_match else None

    s3_output_key = f"{outputdir}/{output_filename}"
    upload_to_s3(local_output, bucket, s3_output_key, user_id)

    
    # Replace your existing cleanup with this enhanced version:
    cleanup_files = local_files + local_audio_files + [background_track, local_output]

    # Add video parts
    if 'video_parts' in locals():
        for parts in video_parts:
            for part_file in parts.values():
                if part_file:
                    cleanup_files.append(part_file)

    # Add transitions  
    if 'transitions' in locals():
        cleanup_files.extend([t for t in transitions if t])

    # Add other temp files
    if 'video_only_output' in locals():
        cleanup_files.append(video_only_output)

    # Remove duplicates and None values
    cleanup_files = list(set([f for f in cleanup_files if f]))

    # Your existing cleanup loop (unchanged)
    for file_path in cleanup_files:
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
                print(f"Removed: {os.path.basename(file_path)}")  # Added logging
            except:
                pass

    print(f"Cleanup complete: {len([f for f in cleanup_files if not os.path.exists(f)])} files removed")

    
    return f"s3://{bucket}/{s3_output_key}"


#m06 fix attemp
def calculate_transition_timings_fixed(video_parts: List[dict], transitions: List[str]) -> List[float]:
    """Calculate when each audio should start (AFTER transitions end)"""
    print("Calculating transition timings (audio starts after transitions)...")
    
    timings = []
    current_time = 0.0
    
    for i, parts in enumerate(video_parts):
        # Audio should start AFTER the transition into this segment
        if i == 0:
            # First segment: audio starts immediately
            audio_start_time = 0.0
        else:
            # Other segments: audio starts after transition ends
            audio_start_time = current_time
        
        timings.append(audio_start_time)
        print(f"   Segment {i} audio starts at: {audio_start_time:.1f}s (after transition)")
        
        # Add duration of middle section
        if 'middle' in parts:
            middle_duration = get_video_duration_robust(parts['middle'])
            current_time += middle_duration
        
        # Add duration of transition (if exists)
        if i < len(transitions) and transitions[i]:
            transition_duration = get_video_duration_robust(transitions[i])
            current_time += transition_duration
    
    print(f"Total calculated duration: {current_time:.1f}s")
    return timings

def process_audio_overlay_debug(video_file: str, audio_files: List[str], background_track: str, 
                               transition_timings: List[float], output_file: str) -> str:
    """Debug version with full FFmpeg command logging"""
    print("Processing audio overlay with debug...")
    
    video_duration = get_video_duration_robust(video_file)
    has_original_audio = check_has_audio_stream(video_file)
    
    print(f"   Video duration: {video_duration:.1f}s")
    print(f"   Original audio: {has_original_audio}")
    
    cmd = ['ffmpeg', '-y']
    
    # Input: video file
    cmd.extend(['-i', video_file])
    input_count = 1
    
    # Input: background track
    if background_track and os.path.exists(background_track):
        cmd.extend(['-i', background_track])
        bg_input_index = input_count
        input_count += 1
        print(f"   Background track: input {bg_input_index} = {os.path.basename(background_track)}")
    else:
        bg_input_index = None
    
    # Input: segment audio files
    audio_input_map = {}
    for i, audio_file in enumerate(audio_files):
        if audio_file and os.path.exists(audio_file):
            cmd.extend(['-i', audio_file])
            audio_input_map[i] = input_count
            print(f"   Segment {i} audio: input {input_count} = {os.path.basename(audio_file)} (delay: {transition_timings[i]:.1f}s)")
            input_count += 1
    
    # Build filter complex
    filters = []
    audio_streams = []
    
    # Add background track if available
    if bg_input_index:
        filters.append(f'[{bg_input_index}:a]aloop=loop=-1:size=2e+09,atrim=duration={video_duration}[bg]')
        audio_streams.append('[bg]')
        print(f"   Background filter: [{bg_input_index}:a]aloop=loop=-1:size=2e+09,atrim=duration={video_duration}[bg]")
    
    # Add segment audio files with delays
    for segment_idx, audio_input_idx in audio_input_map.items():
        delay = transition_timings[segment_idx] if segment_idx < len(transition_timings) else 0
        delay_ms = int(delay * 1000)
        delayed_label = f'delayed_{segment_idx}'
        
        delay_filter = f'[{audio_input_idx}:a]adelay={delay_ms}|{delay_ms}[{delayed_label}]'
        filters.append(delay_filter)
        audio_streams.append(f'[{delayed_label}]')
        print(f"   Segment {segment_idx} delay filter: {delay_filter}")
    
    # Mix all audio streams
    if len(audio_streams) > 1:
        audio_mix = f'{"".join(audio_streams)}amix=inputs={len(audio_streams)}:duration=longest:dropout_transition=2[mixed_audio]'
        filters.append(audio_mix)
        print(f"   Audio mix filter: {audio_mix}")
        
        filter_complex = ';'.join(filters)
        cmd.extend([
            '-filter_complex', filter_complex,
            '-map', '0:v',
            '-map', '[mixed_audio]'
        ])
    else:
        # Single audio stream
        filter_complex = ';'.join(filters) if filters else None
        if filter_complex:
            cmd.extend(['-filter_complex', filter_complex, '-map', '0:v', '-map', audio_streams[0]])
        else:
            cmd.extend(['-map', '0:v', '-map', '1:a'])  # Direct mapping
    
    cmd.extend([
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        output_file
    ])
    
    print("FULL FFmpeg command:")
    print(" ".join(cmd))
    
    print("Filter complex breakdown:")
    if filters:
        for i, filter_part in enumerate(filters):
            print(f"   Filter {i+1}: {filter_part}")
    
    start_time = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True)
    process_time = time.time() - start_time
    
    if result.returncode != 0:
        print(f"Audio processing failed: {result.stderr}")
        raise RuntimeError(f"Audio processing failed: {result.stderr}")
    
    print(f"Audio processing completed in {process_time:.1f}s")
    return output_file

def test_audio_file(audio_file: str, segment_idx: int):
    """Test if audio file is valid and get its info"""
    if not audio_file or not os.path.exists(audio_file):
        print(f"   Audio {segment_idx}: File missing")
        return False
    
    try:
        # Get audio info
        cmd = ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration,format=size', 
               '-show_entries', 'stream=codec_name,sample_rate,channels', 
               '-of', 'json', audio_file]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        
        if result.returncode == 0:
            import json
            info = json.loads(result.stdout)
            
            format_info = info.get('format', {})
            stream_info = info.get('streams', [{}])[0]
            
            duration = float(format_info.get('duration', 0))
            size = int(format_info.get('size', 0))
            codec = stream_info.get('codec_name', 'unknown')
            sample_rate = stream_info.get('sample_rate', 'unknown')
            channels = stream_info.get('channels', 'unknown')
            
            print(f"   Audio {segment_idx}: {duration:.1f}s, {size/1024:.1f}KB, {codec}, {sample_rate}Hz, {channels}ch")
            
            if duration < 0.1:
                print(f"        Warning: Very short audio file ({duration:.3f}s)")
            
            return True
        else:
            print(f"   Audio {segment_idx}: ffprobe failed - {result.stderr}")
            return False
            
    except Exception as e:
        print(f"   Audio {segment_idx}: Error testing file - {e}")
        return False


def main():
    print(f"Starting:")

    parser = argparse.ArgumentParser(description='Stitch MP4 videos with chroma key transparency transitions')
    
    parser.add_argument('bucket', type=str, help="S3 bucket name")
    parser.add_argument('tmpdir', type=str, help="tmp directory")
    parser.add_argument('inputdir', type=str, help="S3 input directory")
    parser.add_argument('outputdir', type=str, help="S3 output directory")
    parser.add_argument('--videos', type=str, required=True,
                       help='Comma-separated video paths: "vid1,vid2,vid3"')
    parser.add_argument('--audio', type=str, required=True,
                       help='Comma-separated video paths: "vid1,vid2,vid3"')
    parser.add_argument('-o', '--output', required=True, help='Output video filename (without extension)')
    parser.add_argument('--overlap', type=float, default=1.0, 
                       help='Overlap duration in seconds (default: 1.0)')
    parser.add_argument('--chroma-key', type=str, default="#A6579B",
                       help='Chroma key color in hex format (default: #A6579B)')
    parser.add_argument('--similarity', type=float, default=0.01,
                       help='Chroma key similarity threshold 0.0-1.0 (default: 0.01)')
    parser.add_argument('--blend', type=float, default=0.0,
                       help='Chroma key blend/smoothness 0.0-1.0 (default: 0.0)')
    parser.add_argument('--quality', type=str, choices=['low', 'medium', 'high', 'max'], 
                       default='high', help='Output quality preset (default: high)')
    
    args = parser.parse_args()

    print(f"Check Temporary directory: {args.tmpdir}")

    # create temp directory if it doesn't exist
    Path(args.tmpdir).mkdir(parents=True, exist_ok=True)
    print(f"Temporary directory: {args.tmpdir}")
    
    try:
        video_paths = parse_comma_separated_values(args.videos)
        audio_paths = parse_comma_separated_values(args.audio)
        
        if not video_paths:
            raise ValueError("No video paths provided")
        
        print(f"Processing {len(video_paths)} MP4 videos with chroma key:")
        for i, path in enumerate(video_paths, 1):
            print(f"  {i}. {path}")

        output_s3_path = stitch_videos_with_separate_audio(
            args.bucket, 
            args.tmpdir, 
            args.inputdir,
            args.outputdir,
            video_paths,
            audio_paths,
            args.output, 
            args.overlap,
            args.chroma_key,
            args.similarity,
            args.blend,
            args.quality
        )
        
        print(f"Final MP4 output uploaded to: {output_s3_path}")
        
    except Exception as e:
        print(f"Error: {e}")
        return 1
    
    return 0

if __name__ == "__main__":
    exit(main())