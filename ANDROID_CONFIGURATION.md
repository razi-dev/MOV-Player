# Android System & Native Configuration Guide

To guarantee zero-stutter playback for high-bitrate `.mov`, Apple ProRes, and QuickTime media on Android via React Native, apply the following native configurations.

---

## 1. Android Manifest Configuration (`android/app/src/main/AndroidManifest.xml`)

Ensure your `<application>` tag enables hardware acceleration and a large heap, along with the scoped storage permissions for Android 13+ (API 33+):

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- Scoped Media Permissions for Android 13+ (API 33+) -->
    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />

    <!-- Legacy Storage Permissions for Android 12 and below (API <= 32) -->
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="32" />

    <application
      android:name=".MainApplication"
      android:label="@string/app_name"
      android:icon="@mipmap/ic_launcher"
      android:roundIcon="@mipmap/ic_launcher_round"
      android:allowBackup="false"
      android:theme="@style/AppTheme"
      <!-- CRITICAL: Enable hardware acceleration for ExoPlayer / Media3 surface rendering -->
      android:hardwareAccelerated="true"
      <!-- CRITICAL: Prevent OutOfMemoryError when handling 4K/high-bitrate container atoms -->
      android:largeHeap="true"
      android:requestLegacyExternalStorage="true">
      
      <activity
        android:name=".MainActivity"
        android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize|uiMode"
        android:launchMode="singleTask"
        android:windowSoftInputMode="adjustResize"
        android:exported="true">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
      </activity>
    </application>
</manifest>
```

---

## 2. Gradle & FFmpegKit Setup (`android/app/build.gradle`)

### A. FFmpegKit Package Selection
Apple ProRes (`prores`, `apch`, `apcn`) decoding and baseline H.264 (`libx264`) software encoding require the **GPL** package of FFmpegKit (e.g., `full-gpl` or `video-gpl`).

In your root `android/build.gradle` or `android/app/build.gradle`:

```groovy
// In android/build.gradle (Project level ext block)
buildscript {
    ext {
        buildToolsVersion = "34.0.0"
        minSdkVersion = 24
        compileSdkVersion = 34
        targetSdkVersion = 34
        // Select full-gpl or video-gpl for ProRes decoding + libx264 encoding support:
        ffmpegKitPackage = "full-gpl"
    }
}
```

### B. ABI Packaging & Shared Object `.so` Rules (`android/app/build.gradle` & `android/gradle.properties`)

Prevent duplicate symbol errors between `ffmpeg-kit-react-native`, `react-native-video`, and `react-native-vlc-media-player`:

In `android/gradle.properties`:
```properties
android.packagingOptions.pickFirsts=**/libc++_shared.so,**/libffmpegkit.so,**/libffmpegkit_abidetect.so,**/libvlc.so,**/libvlcjni.so
android.minSdkVersion=26
```

In `android/app/build.gradle`:
```groovy
android {
    ...
    defaultConfig {
        ...
        minSdkVersion rootProject.ext.minSdkVersion // 26
        ndk {
            abiFilters "arm64-v8a", "armeabi-v7a", "x86_64"
        }
    }

    packagingOptions {
        pickFirst 'lib/arm64-v8a/libc++_shared.so'
        pickFirst 'lib/armeabi-v7a/libc++_shared.so'
        pickFirst 'lib/x86_64/libc++_shared.so'
        pickFirst 'lib/x86/libc++_shared.so'
        pickFirst 'lib/*/libffmpegkit.so'
        pickFirst 'lib/*/libffmpegkit_abidetect.so'
        pickFirst 'lib/*/libvlc.so'
        pickFirst 'lib/*/libvlcjni.so'
    }
}
```

---

## 3. Hybrid Player Architecture (ExoPlayer + LibVLC Dual Engine)

The player implements a zero-delay dual engine architecture:
1. **Primary (`ExoPlayer` via `react-native-video`)**:
   - Used for standard AVC/HEVC/MP4 video streams.
   - Utilizes Android's battery-efficient hardware `MediaCodec` decoder ASIC.
2. **Instant Fallback (`LibVLC` via `react-native-vlc-media-player`)**:
   - When ExoPlayer fires `onError` (or when `NO_EXCEEDS_CAPABILITIES` occurs for ProRes / 10-bit / non-standard QuickTime files), the player automatically and instantly swaps to the VLC software engine in < 100ms.
   - Decodes frame-by-frame in RAM via `libavcodec` and passes textures directly to the GPU SurfaceView with zero disk transcoding wait.
3. **Manual Engine Switch**:
   - The user can tap the badge in the top bar (`[⚡ EXO]` / `[🛡️ VLC]`) or the "SWITCH TO VLC / EXO" button at any time to compare engines.

---

## 3. Scoped Storage & Android 13+ `content://` Handling

Android 13+ restricts native C/C++ libraries from accessing filesystem paths directly from `content://` URIs obtained via document pickers.

The included `useSmartVideoEngine.ts` and `fileUtils.ts` automatically solve this:
1. First, it queries `FFmpegKitConfig.getSafParameterForRead(uri)` to get a native SAF file descriptor.
2. If the platform blocks SAF parameter direct streaming, it falls back to copying the media file to `RNFS.CachesDirectoryPath/staged_input_<timestamp>.<ext>`.
3. Native `FFprobe` and `FFmpeg` execute directly on the cached path without permission errors.

---

## 4. Cache Purging Policy

Video proxy files and remuxed streams can quickly consume storage space:
- When a video unmounts or a new video is loaded, `cleanOldEngineCacheFiles()` executes.
- It scans `RNFS.CachesDirectoryPath` for `remux_*`, `proxy_*`, and `staged_input_*` files and deletes unreferenced files while keeping the active playback target intact.
