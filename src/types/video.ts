export type VideoEngineStatus =
  | 'idle'
  | 'probing'
  | 'remuxing'
  | 'transcoding'
  | 'ready'
  | 'error';

export type ActivePlayerEngine = 'exoplayer' | 'vlc';

export interface FormatDetails {
  codec: string;
  resolution: string;
  bitrate: string;
  duration: number; // in seconds
  width?: number;
  height?: number;
  fps?: number; // average frame rate, 0 if unknown
  isOptimized?: boolean;
  optimizationType?: 'remux' | 'transcode' | 'original' | 'vlc-fallback';
}

export interface SmartVideoEngineState {
  status: VideoEngineStatus;
  progress: number; // 0 to 100
  formatDetails: FormatDetails | null;
  playableUri: string | null;
  errorMessage: string | null;
}

export interface UseSmartVideoEngineReturn extends SmartVideoEngineState {
  retry: () => void;
  cancel: () => void;
  cleanupCache: () => Promise<void>;
  forceRemux: (opts?: { stripDolbyVision?: boolean }) => void;
}
