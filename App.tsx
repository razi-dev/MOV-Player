import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { VideoPlayerScreen } from './src/screens/VideoPlayerScreen';

export default function App() {
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('Selected Video');

  const pickVideoFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['video/*', 'video/quicktime', 'video/mp4'],
        // Do NOT copy: copying a multi-GB MOV to cache before playback was the main
        // reason playback took 30–90 s to start. Both ExoPlayer and (patched) LibVLC
        // read the picked content:// URI directly.
        copyToCacheDirectory: false,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        setSelectedFileName(asset.name || 'ProRes / MOV Media');
        setSelectedUri(asset.uri);
      }
    } catch (err) {
      console.error('File pick error:', err);
    }
  };

  if (selectedUri) {
    return (
      <VideoPlayerScreen
        videoUri={selectedUri}
        title={selectedFileName}
        onBack={() => setSelectedUri(null)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#07090E" />
      <View style={styles.content}>
        {/* Tactical Header */}
        <View style={styles.headerBadge}>
          <View style={styles.dot} />
          <Text style={styles.badgeText}>SMART PROXY & FAST-REMUX ENGINE</Text>
        </View>

        <Text style={styles.title}>MOV & PRORES PLAYER</Text>
        <Text style={styles.subtitle}>
          Zero-stutter playback for Apple ProRes, 10-bit QuickTime, and unsupported video formats on Android.
        </Text>

        {/* Feature Cards */}
        <View style={styles.featuresContainer}>
          <View style={styles.featureCard}>
            <Text style={styles.featureAccent}>⚡ INSTANT DIRECT PLAY</Text>
            <Text style={styles.featureDesc}>
              H.264, HEVC, and standard MOV / MP4 files open instantly at 100% original quality. Zero loading wait.
            </Text>
          </View>

          <View style={styles.featureCard}>
            <Text style={styles.featureAccent}>🔄 STREAM COPY REMUX (1–3s)</Text>
            <Text style={styles.featureDesc}>
              ProRes 422/444 and exotic codecs are re-wrapped into MP4 with zero re-encoding — full original quality preserved in seconds, not minutes.
            </Text>
          </View>
        </View>

        {/* Action Button */}
        <TouchableOpacity style={styles.pickButton} onPress={pickVideoFile} activeOpacity={0.85}>
          <Text style={styles.pickButtonText}>SELECT VIDEO FILE</Text>
          <Text style={styles.pickButtonSub}>Supports .mov, .mp4, ProRes, DNxHD</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#07090E',
  },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 240, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0, 240, 255, 0.3)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 20,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00F0FF',
    marginRight: 8,
  },
  badgeText: {
    color: '#00F0FF',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 1.2,
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
    maxWidth: 340,
  },
  featuresContainer: {
    width: '100%',
    marginBottom: 36,
    gap: 12,
  },
  featureCard: {
    backgroundColor: '#121622',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 10,
    padding: 16,
  },
  featureAccent: {
    color: '#00F0FF',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  featureDesc: {
    color: '#94A3B8',
    fontSize: 12,
    lineHeight: 17,
  },
  pickButton: {
    width: '100%',
    backgroundColor: '#00F0FF',
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: 'center',
    elevation: 4,
  },
  pickButtonText: {
    color: '#07090E',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 1,
  },
  pickButtonSub: {
    color: 'rgba(7, 9, 14, 0.7)',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
});
