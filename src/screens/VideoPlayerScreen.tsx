import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  ActivityIndicator,
  Animated,
  StatusBar,
  SafeAreaView,
  Platform,
} from 'react-native';
import Video, { VideoRef, OnProgressData, OnLoadData } from 'react-native-video';
import { VLCPlayer, VLCPlayerSource } from 'react-native-vlc-media-player';
import Slider from '@react-native-community/slider';
import { useSmartVideoEngine } from '../hooks/useSmartVideoEngine';
import { formatDuration } from '../utils/fileUtils';
import { ActivePlayerEngine } from '../types/video';

/**
 * LibVLC source config tuned for low-end phones.
 *
 * - initType: 2 is REQUIRED — with the wrapper's default (1) every initOption is ignored.
 * - Two modes:
 *   hw=true  → try the phone's MediaCodec decoder first, fall back to software if it refuses.
 *              Used when ExoPlayer failed for a NON-video reason (container, audio track…).
 *   hw=false → pure software (libavcodec). Used when ExoPlayer already proved the hardware
 *              video decoder can't handle this file (e.g. iPhone 10-bit Dolby Vision / HLG
 *              HEVC on a 1080p-only Snapdragon). Retrying MediaCodec there makes VLC fail
 *              mid-stream and switch decoders, which shows up as sudden glitches.
 * - skiploopfilter=1 skips deblocking ONLY on non-reference frames: a real CPU saving with
 *   no visible damage. (Skipping it on all frames — value 4 — corrupts the reference frames
 *   and the error accumulates until the next keyframe = blocky glitches.)
 * - Display chroma: we do NOT set --android-display-chroma. When left unset, LibVLC 3.6
 *   defaults to RGBA on Android's TextureView, which works for all bit depths including
 *   10-bit (P010). YV12 is 8-bit only and causes VLC to freeze after frame 1 on 10-bit
 *   Dolby Vision / HLG content (the P010→YV12 blit path stalls on Snapdragon 695).
 * - hurry-up / drop-late-frames / skip-frames: if the CPU still can't keep up, drop frames
 *   gracefully and keep audio in sync instead of freezing.
 */
const VLC_COMMON_OPTIONS = [
  '--avcodec-skiploopfilter=1', // skip deblocking on NON-reference frames only (no drift)
  '--no-avcodec-hurry-up',      // hurry-up skips decode work mid-frame -> gray HEVC patches
  '--avcodec-threads=0',        // use every CPU core
  '--drop-late-frames',         // drop whole late frames at display: never corrupts picture
  '--no-skip-frames',           // same corruption risk as hurry-up
  '--file-caching=300',         // local file: small cache = fast start
  '--no-sub-autodetect-file',
  '--no-stats',
];

// hwDecoder* are read by the native Android view but missing from the library's typings.
type VlcSourceWithHw = VLCPlayerSource & { hwDecoderEnabled: 0 | 1; hwDecoderForced: 0 | 1 };

/**
 * Always request hardware decode but never force it (hwDecoderForced=0).
 *
 * With hwDecoderEnabled=1, hwDecoderForced=0: VLC asks MediaCodec to decode.
 * If MediaCodec accepts (e.g. the chip quietly supports 10-bit even though ExoPlayer's
 * strict capability check says NO_EXCEEDS_CAPABILITIES), we get hardware-smooth playback.
 * If MediaCodec refuses, LibVLC falls back to libavcodec software decode automatically
 * and seamlessly — no glitch, no extra code needed on our side.
 *
 * We never set hwDecoderForced=1: that would suppress the software fallback and cause
 * VLC to crash instead of degrade gracefully.
 */
/**
 * High-frame-rate files (iPhone 60 fps) decoded in software: skip non-reference frames
 * up front. Nothing depends on them, so the picture stays clean and playback is a steady
 * ~30 fps instead of random drops. If a file has no non-reference frames this skips
 * nothing, so it is safe either way.
 */
const HIGH_FPS_OPTIONS = ['--avcodec-skip-frame=1'];

const buildVlcSource = (uri: string, highFps: boolean): VlcSourceWithHw => ({
  uri,
  initType: 2,
  hwDecoderEnabled: 1,
  hwDecoderForced: 0,
  initOptions: highFps ? [...VLC_COMMON_OPTIONS, ...HIGH_FPS_OPTIONS] : [...VLC_COMMON_OPTIONS],
});

/**
 * True when ExoPlayer's failing format is Dolby Vision (iPhone HDR: "dvhe.08.xx",
 * mimeType video/dolby-vision). Its base layer is plain HEVC Main10 HLG; only the
 * embedded Dolby Vision RPU units (NAL type 62) need to go.
 */
const isDolbyVisionFormat = (error: any): boolean =>
  /video\/dolby-vision|dvhe\.|dvh1\./i.test(JSON.stringify(error ?? ''));

interface VideoPlayerScreenProps {
  videoUri: string;
  title?: string;
  onBack?: () => void;
}

export const VideoPlayerScreen: React.FC<VideoPlayerScreenProps> = ({
  videoUri,
  title = 'Field Footage',
  onBack,
}) => {
  const {
    status,
    progress: optimizationProgress,
    formatDetails,
    playableUri,
    errorMessage,
    retry,
    forceRemux,
  } = useSmartVideoEngine(videoUri);

  // Hybrid Player Engine state ('exoplayer' for battery-efficient HW decode, 'vlc' for direct decode)
  const [playerEngine, setPlayerEngine] = useState<ActivePlayerEngine>('exoplayer');
  // 60 fps files get VLC's non-reference-frame skipping. The probe that runs before any
  // strip/remux guarantees fps is known by the time VLC mounts on the cleaned file.
  const vlcHighFps = (formatDetails?.fps ?? 0) > 40;
  // While the Dolby Vision strip runs, render nothing instead of letting VLC start on the
  // original file (which would play glitchy for a second, then restart).
  const [awaitingStrip, setAwaitingStrip] = useState<boolean>(false);
  // ExoPlayer stall watchdog: set once ExoPlayer's position actually moves.
  const exoStartedRef = useRef<boolean>(false);

  // Playback state
  const videoRef = useRef<VideoRef>(null);
  const vlcRef = useRef<any>(null);
  const [paused, setPaused] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isScrubbing, setIsScrubbing] = useState<number | false>(false);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  // For VLC software decode, suppress the buffering spinner after the first frame arrives
  // so it doesn't flicker every time VLC works hard on a complex frame.
  const vlcFirstFrameRef = useRef<boolean>(false);
  // Position (seconds) to restore after the engine is swapped, so switching doesn't restart at 0:00
  const resumeAtRef = useRef<number>(0);
  // ExoPlayer fires onError more than once per failure; only strip Dolby Vision once per file
  const dvStripTriedRef = useRef<boolean>(false);
  // True from the moment we start stripping until the stripped file is handed to the
  // player; errors arriving in between belong to the OLD file and must be ignored.
  const dvStripPendingRef = useRef<boolean>(false);
  useEffect(() => {
    dvStripPendingRef.current = false;
    exoStartedRef.current = false;
    setAwaitingStrip(false);
  }, [playableUri]);

  // Controls Visibility & Animation
  const [showControls, setShowControls] = useState<boolean>(true);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Play/Pause Center Indicator Flash Animation
  const centerIconAnim = useRef(new Animated.Value(0)).current;

  // Refs mirror state so timers and animation callbacks never read stale values.
  const controlsVisibleRef = useRef<boolean>(true);
  const pausedRef = useRef<boolean>(paused);
  pausedRef.current = paused;

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hideControls = useCallback(() => {
    clearHideTimer();
    controlsVisibleRef.current = false;
    Animated.timing(controlsOpacity, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true,
    }).start(({ finished }) => {
      // Animated calls this even when the fade is INTERRUPTED (e.g. the user tapped to
      // show the controls mid-fade). Unmounting then made the controls vanish right after
      // they were shown. Only unmount if the fade completed and nobody re-showed them.
      if (finished && !controlsVisibleRef.current) setShowControls(false);
    });
  }, [controlsOpacity, clearHideTimer]);

  // Auto-hide after 3.5 s of inactivity — only while actually playing.
  const resetHideTimer = useCallback(() => {
    clearHideTimer();
    if (pausedRef.current) return;
    hideTimerRef.current = setTimeout(hideControls, 3500);
  }, [clearHideTimer, hideControls]);

  const showControlsAnimated = useCallback(() => {
    controlsVisibleRef.current = true;
    setShowControls(true);
    controlsOpacity.stopAnimation();
    Animated.timing(controlsOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
    resetHideTimer();
  }, [controlsOpacity, resetHideTimer]);

  const toggleControls = useCallback(() => {
    if (controlsVisibleRef.current) {
      hideControls();
    } else {
      showControlsAnimated();
    }
  }, [hideControls, showControlsAnimated]);

  // Paused → controls stay visible. Playing → start the auto-hide countdown.
  useEffect(() => {
    if (paused) {
      showControlsAnimated();
    } else {
      resetHideTimer();
    }
    return clearHideTimer;
  }, [paused, showControlsAnimated, resetHideTimer, clearHideTimer]);

  // Whenever the video source or engine changes (engine fallback, DV strip, transcode
  // finishing), bring the controls back so the new playback never starts without UI.
  useEffect(() => {
    showControlsAnimated();
  }, [playerEngine, playableUri, showControlsAnimated]);

  const flashCenterIndicator = () => {
    centerIconAnim.setValue(1);
    Animated.sequence([
      Animated.timing(centerIconAnim, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(centerIconAnim, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const togglePlayPause = () => {
    setPaused(prev => !prev);
    flashCenterIndicator();
    // The [paused] effect handles the controls (stay up when paused, countdown when playing)
  };

  // ExoPlayer callbacks
  const handleProgress = (data: OnProgressData) => {
    if (data.currentTime > 0.1) exoStartedRef.current = true;
    if (isScrubbing === false) {
      setCurrentTime(data.currentTime);
    }
  };

  /**
   * Leave ExoPlayer. Called on an ExoPlayer error OR when the stall watchdog fires
   * (ExoPlayer can silently fall back to Google's software decoder c2.android.hevc.decoder,
   * which can't keep up with 10-bit 1080p60 and buffers forever without an error).
   *
   * - Dolby Vision / HEVC: strip the DV RPU units (fast stream copy, no re-encode), then play
   *   the clean copy in VLC. On a Snapdragon 695 the hardware decoder never played these
   *   files even after stripping, while VLC on the stripped copy played smoothly.
   * - Anything else: VLC directly.
   */
  const fallbackFromExoPlayer = (reason: 'dolby-vision' | 'error' | 'stall', detail?: string) => {
    if (playerEngine !== 'exoplayer' || dvStripPendingRef.current) return;
    const isHevc = (formatDetails?.codec ?? '').toUpperCase() === 'HEVC';
    const shouldStrip = !dvStripTriedRef.current && (reason === 'dolby-vision' || (reason === 'stall' && isHevc));
    // console.log, not warn: expected path for 10-bit / HDR files; warn draws a LogBox banner.
    console.log(`[VideoPlayerScreen] Leaving ExoPlayer (${reason})${shouldStrip ? ' — stripping Dolby Vision first' : ''}:`, detail ?? '');
    resumeAtRef.current = currentTime;
    vlcFirstFrameRef.current = false;
    if (shouldStrip) {
      dvStripTriedRef.current = true;
      dvStripPendingRef.current = true;
      setAwaitingStrip(true);
      forceRemux({ stripDolbyVision: true });
    }
    setPlayerEngine('vlc');
    setIsBuffering(false);
  };

  const handlePlaybackError = (error: any) => {
    if (playerEngine === 'exoplayer') {
      fallbackFromExoPlayer(isDolbyVisionFormat(error) ? 'dolby-vision' : 'error', error?.errorString);
    } else {
      // VLC also failed (truly unplayable container / corrupt file) → remux/transcode
      forceRemux();
    }
  };

  // Stall watchdog: if ExoPlayer hasn't moved within 3.5 s of playing, give up on it.
  const fallbackRef = useRef(fallbackFromExoPlayer);
  fallbackRef.current = fallbackFromExoPlayer;
  useEffect(() => {
    if (playerEngine !== 'exoplayer' || !playableUri || paused || exoStartedRef.current) return;
    const t = setTimeout(() => {
      if (!exoStartedRef.current) fallbackRef.current('stall', 'no playback progress after 3.5 s');
    }, 3500);
    return () => clearTimeout(t);
  }, [playerEngine, playableUri, paused]);

  const handleLoad = (data: OnLoadData) => {
    setDuration(data.duration);
    setIsBuffering(false);
    if (resumeAtRef.current > 0) {
      videoRef.current?.seek(resumeAtRef.current);
      resumeAtRef.current = 0;
    }
  };

  // VLC callbacks (VLC reports time in milliseconds)
  const handleVlcProgress = (data: any) => {
    if (isScrubbing === false) {
      const secs = (data.currentTime || 0) / 1000;
      setCurrentTime(secs);
    }
    // Once we get a progress event, the first frame has been rendered — stop any spinner
    if (!vlcFirstFrameRef.current) {
      vlcFirstFrameRef.current = true;
      setIsBuffering(false);
    }
  };

  const handleVlcLoad = (data: any) => {
    const durSecs = (data.duration || 0) / 1000;
    if (durSecs > 0) {
      setDuration(durSecs);
      if (resumeAtRef.current > 0) {
        vlcRef.current?.seek(Math.min(1, resumeAtRef.current / durSecs));
        resumeAtRef.current = 0;
      }
    }
    setIsBuffering(false);
  };

  const handleVlcError = (error: any) => {
    console.warn('[VideoPlayerScreen] VLC playback error — triggering remux/transcode:', error);
    forceRemux();
  };

  // Reset first-frame flag whenever we (re)mount VLC for a new file
  const handleVlcMounted = () => {
    vlcFirstFrameRef.current = false;
  };

  const toggleEngine = () => {
    resumeAtRef.current = currentTime;
    vlcFirstFrameRef.current = false;
    setPlayerEngine(prev => (prev === 'exoplayer' ? 'vlc' : 'exoplayer'));
    setIsBuffering(false);
  };

  const handleSlidingStart = (value: number) => {
    setIsScrubbing(value);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  };

  const handleValueChange = (value: number) => {
    setIsScrubbing(value);
  };

  const handleSlidingComplete = (value: number) => {
    setIsScrubbing(false);
    setCurrentTime(value);
    if (playerEngine === 'exoplayer') {
      videoRef.current?.seek(value);
    } else if (vlcRef.current && duration > 0) {
      // VLC seek takes a fraction between 0.0 and 1.0
      const fraction = Math.max(0, Math.min(1, value / duration));
      vlcRef.current.seek(fraction);
    }
    resetHideTimer();
  };


  // Pill badge text e.g. [⚡ EXO • 1080p H264] or [🛡️ VLC • 4K PRORES DIRECT]
  const getBadgeText = () => {
    const engineTag = playerEngine === 'exoplayer' ? '⚡ EXO' : '🛡️ VLC';
    if (!formatDetails) return `${engineTag} • INSPECTING...`;
    const res = formatDetails.resolution;
    const codec = formatDetails.codec;
    const opt =
      playerEngine === 'vlc'
        ? 'DIRECT'
        : formatDetails.optimizationType === 'remux'
        ? 'REMUXED'
        : formatDetails.optimizationType === 'transcode'
        ? 'PROXY'
        : 'HW';
    return `${engineTag} • ${res} ${codec} ${opt}`;
  };

  const isOptimizing = status === 'remuxing' || status === 'transcoding';
  const showFallbackSpinner = isOptimizing || awaitingStrip;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#07090E" />

      {/* Touch surface for toggling controls & play/pause */}
      <TouchableWithoutFeedback onPress={toggleControls}>
        <View style={styles.videoSurfaceContainer}>
          {/* Hybrid Video View: Render ExoPlayer or VLCPlayer depending on current engine */}
          {playableUri && !awaitingStrip ? (
            playerEngine === 'exoplayer' ? (
              <Video
                ref={videoRef}
                source={{ uri: playableUri }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
                paused={paused}
                controls={false}
                repeat={true}
                onProgress={handleProgress}
                onLoad={handleLoad}
                onError={handlePlaybackError}
                onBuffer={meta => setIsBuffering(meta.isBuffering)}
                bufferConfig={{
                  minBufferMs: 1500,
                  maxBufferMs: 5000,
                  bufferForPlaybackMs: 500,
                  bufferForPlaybackAfterRebufferMs: 1000,
                }}
              />
            ) : (
              <VLCPlayer
                ref={(r) => { (vlcRef as any).current = r; if (r) handleVlcMounted(); }}
                // Remount (with resume) if the 60 fps decision changes
                key={`vlc-${vlcHighFps ? 'hfr' : 'std'}`}
                source={buildVlcSource(playableUri, vlcHighFps)}
                style={StyleSheet.absoluteFill}
                paused={paused}
                autoplay={!paused}
                // NOT autoAspectRatio: in this wrapper it forces the video to the VIEW's
                // shape (stretching it). Leaving it off lets VLC best-fit the real ratio.
                autoAspectRatio={false}
                resizeMode="contain"
                onProgress={handleVlcProgress}
                onLoad={handleVlcLoad}
                onError={handleVlcError}
                // Only show buffering spinner if no frame has been rendered yet.
                // VLC in SW-decode mode fires onBuffering frequently between frames on slow
                // CPUs; suppressing it after frame-1 prevents the spinner from flickering.
                onBuffering={() => { if (!vlcFirstFrameRef.current) setIsBuffering(true); }}
                onPlaying={() => setIsBuffering(false)}
              />
            )
          ) : (
            <View style={styles.placeholderBackground} />
          )}

          {/* Center Play/Pause Micro-Animation Indicator */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.centerFlashPill,
              {
                opacity: centerIconAnim,
                transform: [
                  {
                    scale: centerIconAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.7, 1.1],
                    }),
                  },
                ],
              },
            ]}
          >
            <Text style={styles.centerFlashText}>{paused ? '❚❚' : '▶'}</Text>
          </Animated.View>

          {/* Fallback spinner — only shown when remuxing or transcoding after both engines fail */}
          {(showFallbackSpinner || isBuffering) && (
            <View style={styles.centerSpinnerOverlay} pointerEvents="none">
              <View style={styles.tacticalSpinnerCard}>
                <ActivityIndicator size="large" color="#00F0FF" />
                <Text style={styles.spinnerText}>
                  {(status === 'remuxing' || (awaitingStrip && !isOptimizing)) && 'PREPARING VIDEO...'}
                  {status === 'transcoding' && `CONVERTING TO 1080p (${optimizationProgress}%)`}
                  {!isOptimizing && !awaitingStrip && isBuffering && 'BUFFERING...'}
                </Text>
              </View>
            </View>
          )}

          {/* Error State Overlay */}
          {status === 'error' && (
            <View style={styles.errorOverlay}>
              <View style={styles.errorCard}>
                <Text style={styles.errorIcon}>⚠️</Text>
                <Text style={styles.errorTitle}>PLAYBACK PIPELINE FAILURE</Text>
                <Text style={styles.errorMessage}>{errorMessage || 'Codec unsupported or file atom corrupt.'}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={retry} activeOpacity={0.8}>
                  <Text style={styles.retryButtonText}>RETRY PROCESSING</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Tactical Overlay Controls */}
          {showControls && (
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: controlsOpacity }]} pointerEvents="box-none">
              {/* TOP BAR OVERLAY */}
              <View style={styles.topBar}>
                <TouchableOpacity style={styles.backButton} onPress={onBack} activeOpacity={0.7}>
                  <Text style={styles.backButtonText}>←</Text>
                </TouchableOpacity>

                <View style={styles.titleContainer}>
                  <Text style={styles.videoTitle} numberOfLines={1}>
                    {title}
                  </Text>
                </View>

                {/* Codec, Engine & Resolution Pill Badge (Clickable to switch engine manually) */}
                <TouchableOpacity style={styles.badgePill} onPress={toggleEngine} activeOpacity={0.7}>
                  <View style={[styles.badgePulseDot, playerEngine === 'vlc' && styles.vlcPulseDot]} />
                  <Text style={styles.badgeText}>{getBadgeText()}</Text>
                </TouchableOpacity>
              </View>

              {/* Active Optimization Progress Pill Banner */}
              {(status === 'remuxing' || status === 'transcoding') && (
                <View style={styles.optimizationBannerContainer}>
                  <View style={styles.optimizationBanner}>
                    <View style={styles.amberWarningIcon} />
                    <Text style={styles.optimizationBannerText}>
                      {status === 'remuxing'
                        ? 'ENABLING HARDWARE DECODE...'
                        : `CONVERTING TO 1080p (${optimizationProgress}%)`}
                    </Text>
                  </View>
                </View>
              )}

              {/* BOTTOM CONTROL BAR */}
              <View style={styles.bottomBar}>
                {/* Scrubbing Slider & Timestamps */}
                <View style={styles.timelineRow}>
                  <Text style={styles.timeLabel}>
                    {formatDuration(isScrubbing !== false ? isScrubbing : currentTime)}
                  </Text>

                  <View style={styles.sliderWrapper}>
                    <Slider
                      style={styles.slider}
                      minimumValue={0}
                      maximumValue={duration > 0 ? duration : 1}
                      value={isScrubbing !== false ? isScrubbing : currentTime}
                      onSlidingStart={handleSlidingStart}
                      onValueChange={handleValueChange}
                      onSlidingComplete={handleSlidingComplete}
                      minimumTrackTintColor="#00F0FF"
                      maximumTrackTintColor="rgba(255, 255, 255, 0.2)"
                      thumbTintColor="#00F0FF"
                    />
                  </View>

                  <Text style={styles.timeLabel}>{formatDuration(duration)}</Text>
                </View>

                {/* Bottom Actions Row */}
                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    style={styles.playPauseButton}
                    onPress={togglePlayPause}
                    activeOpacity={0.7}
                    disabled={status !== 'ready'}
                  >
                    <Text style={styles.playPauseButtonText}>{paused ? '▶' : '❚❚'}</Text>
                  </TouchableOpacity>

                  {/* Engine Switcher Quick Button */}
                  <TouchableOpacity
                    style={[styles.engineSwitchButton, playerEngine === 'vlc' && styles.engineSwitchButtonActive]}
                    onPress={toggleEngine}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.engineSwitchText}>
                      {playerEngine === 'exoplayer' ? 'SWITCH TO VLC' : 'SWITCH TO EXO'}
                    </Text>
                  </TouchableOpacity>

                  {formatDetails && (
                    <View style={styles.metaDataRow}>
                      <Text style={styles.metaText}>
                        BITRATE: <Text style={styles.metaValue}>{formatDetails.bitrate}</Text>
                      </Text>
                      {formatDetails.width && formatDetails.height ? (
                        <Text style={[styles.metaText, { marginLeft: 16 }]}>
                          DIMENSIONS:{' '}
                          <Text style={styles.metaValue}>
                            {formatDetails.width}x{formatDetails.height}
                          </Text>
                        </Text>
                      ) : null}
                    </View>
                  )}
                </View>
              </View>
            </Animated.View>
          )}
        </View>
      </TouchableWithoutFeedback>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#07090E',
  },
  videoSurfaceContainer: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderBackground: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#07090E',
  },
  // Top Bar
  topBar: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 12 : 20,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 20,
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(18, 24, 38, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(0, 240, 255, 0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButtonText: {
    color: '#00F0FF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: -2,
  },
  titleContainer: {
    flex: 1,
    marginHorizontal: 12,
  },
  videoTitle: {
    color: '#E0E7FF',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  badgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(10, 15, 26, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(0, 240, 255, 0.4)',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  badgePulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00F0FF',
    marginRight: 6,
  },
  vlcPulseDot: {
    backgroundColor: '#FF9500',
  },
  badgeText: {
    color: '#00F0FF',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  // Active Optimization Banner
  optimizationBannerContainer: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 68 : 76,
    alignSelf: 'center',
    zIndex: 19,
  },
  optimizationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 184, 0, 0.15)',
    borderWidth: 1,
    borderColor: '#FFB800',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  amberWarningIcon: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FFB800',
    marginRight: 8,
  },
  optimizationBannerText: {
    color: '#FFB800',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  // Center Overlay Spinner & Flash Pill
  centerSpinnerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 15,
  },
  tacticalSpinnerCard: {
    backgroundColor: 'rgba(10, 15, 26, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(0, 240, 255, 0.3)',
    borderRadius: 12,
    paddingVertical: 18,
    paddingHorizontal: 24,
    alignItems: 'center',
    elevation: 8,
  },
  spinnerText: {
    color: '#E0E7FF',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 12,
    letterSpacing: 0.8,
  },
  centerFlashPill: {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    borderWidth: 1.5,
    borderColor: '#00F0FF',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 14,
  },
  centerFlashText: {
    color: '#00F0FF',
    fontSize: 26,
    fontWeight: '900',
  },
  // Error Card
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(7, 9, 14, 0.95)',
    padding: 24,
    zIndex: 25,
  },
  errorCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#121622',
    borderWidth: 1,
    borderColor: '#FF4444',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
  },
  errorIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  errorTitle: {
    color: '#FF4444',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 8,
  },
  errorMessage: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 18,
  },
  retryButton: {
    backgroundColor: '#FF4444',
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 6,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  // Bottom Bar
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(7, 9, 14, 0.92)',
    borderTopWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'android' ? 16 : 28,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sliderWrapper: {
    flex: 1,
    marginHorizontal: 8,
  },
  slider: {
    height: 40,
  },
  timeLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  playPauseButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 240, 255, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0, 240, 255, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playPauseButtonText: {
    color: '#00F0FF',
    fontSize: 18,
    fontWeight: '800',
  },
  engineSwitchButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    marginLeft: 12,
  },
  engineSwitchButtonActive: {
    backgroundColor: 'rgba(255, 149, 0, 0.15)',
    borderColor: '#FF9500',
  },
  engineSwitchText: {
    color: '#CBD5E1',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  metaDataRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaText: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  metaValue: {
    color: '#CBD5E1',
    fontWeight: '700',
  },
});

export default VideoPlayerScreen;
