import { Platform } from 'react-native';
import RNFS from 'react-native-fs';
import { FFmpegKitConfig } from 'ffmpeg-kit-react-native';

const CACHE_FILE_PREFIXES = ['remux_', 'proxy_', 'staged_input_'];

/**
 * Returns the URI handed to the players. Never copies the file: ExoPlayer reads
 * content:// natively, and our patched LibVLC opens it via a file descriptor.
 * Bare paths are normalised to file:// URIs.
 */
export function toPlayableUri(uri: string): string {
  if (!uri) throw new Error('Video URI is empty or invalid.');
  if (uri.startsWith('/')) return `file://${uri}`;
  return uri;
}

/**
 * Returns an input string FFmpeg/FFprobe can open, without copying the file.
 * content:// URIs are mapped to an FFmpegKit "saf:" parameter. Each saf: parameter
 * wraps one file descriptor that FFmpegKit closes when the session ends, so call
 * this once PER FFmpeg/FFprobe session — never reuse the result.
 */
export async function getFfmpegInput(uri: string): Promise<string> {
  if (!uri) throw new Error('Video URI is empty or invalid.');
  if (uri.startsWith('file://')) {
    return decodeURI(uri.replace('file://', ''));
  }
  if (Platform.OS === 'android' && uri.startsWith('content://')) {
    return FFmpegKitConfig.getSafParameterForRead(uri);
  }
  return uri;
}

/**
 * Scans the application cache directory and removes previous remuxed, proxy, or staged temporary files.
 * Keeps storage lean and prevents app cache bloating.
 */
export async function cleanOldEngineCacheFiles(currentActiveUri?: string | null): Promise<void> {
  try {
    const files = await RNFS.readDir(RNFS.CachesDirectoryPath);
    const activeFileName = currentActiveUri ? currentActiveUri.split('/').pop() : null;

    for (const file of files) {
      const isEngineTemp = CACHE_FILE_PREFIXES.some(prefix => file.name.startsWith(prefix));
      if (isEngineTemp && file.name !== activeFileName) {
        await RNFS.unlink(file.path).catch(err => {
          console.warn(`[FileUtils] Failed to unlink cache file ${file.name}:`, err);
        });
      }
    }
  } catch (err) {
    console.warn('[FileUtils] Error cleaning old cache files:', err);
  }
}

/**
 * Formats seconds into MM:SS or HH:MM:SS format
 */
export function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '00:00';
  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Returns a clean human-readable resolution string (e.g., 4K, 1080p, 720p)
 */
export function getResolutionLabel(width: number, height: number): string {
  const maxDim = Math.max(width, height);
  const minDim = Math.min(width, height);

  if (maxDim >= 3840 || minDim >= 2160) return '4K';
  if (maxDim >= 2560 || minDim >= 1440) return '1440p';
  if (maxDim >= 1920 || minDim >= 1080) return '1080p';
  if (maxDim >= 1280 || minDim >= 720) return '720p';
  if (minDim >= 480) return '480p';
  return `${width}x${height}`;
}

/**
 * Formats bitrate in bps to Mbps or kbps
 */
export function formatBitrate(bitrateStr?: string | number): string {
  if (!bitrateStr) return 'N/A';
  const bps = Number(bitrateStr);
  if (isNaN(bps) || bps <= 0) return 'N/A';
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  }
  return `${Math.round(bps / 1_000)} kbps`;
}
