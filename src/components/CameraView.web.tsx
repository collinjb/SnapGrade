/** The camera preview and shutter, web implementation.
 *
 *  getUserMedia into a <video>, with two hidden canvases: a tiny one that is
 *  sampled at 8fps to find the page (the same Otsu algorithm the Android
 *  plugin uses, via `pageDetect.ts`), and a full-size one used as the
 *  shutter.
 *
 *  Same interface as `CameraView.tsx`, so `CameraScreen` is identical on
 *  both platforms. */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { GRID_H, GRID_W, detectPageInLuma, rgbaToLuma } from '@/lib/pageDetect';
import { saveBlob } from '@/lib/media';
import type { Corners } from '@/types';

export type CameraStatus = 'loading' | 'granted' | 'denied' | 'no-device';

export interface CapturedPhoto {
  uri: string;
  width: number;
  height: number;
}

export interface CameraViewHandle {
  takePhoto(): Promise<CapturedPhoto | null>;
  requestPermission(): Promise<boolean>;
}

export interface CameraViewProps {
  isActive: boolean;
  detectionEnabled: boolean;
  onDetection: (corners: Corners | null, confidence: number) => void;
  onStatusChange: (status: CameraStatus) => void;
}

/** The canvas detector works everywhere a camera does. */
export const supportsEdgeDetection = true;

/** Shown in Settings → Diagnostics. */
export const detectorLabel = 'in-page canvas';

/** Detection cadence, matched to the native frame processor. */
const DETECT_INTERVAL_MS = 125;

/** Ask for a high-ish resolution; the browser gives what it can. */
const CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1440 },
  },
};

export const CameraView = forwardRef<CameraViewHandle, CameraViewProps>(function CameraView(
  { isActive, detectionEnabled, onDetection, onStatusChange },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sampleCanvas = useRef<HTMLCanvasElement | null>(null);
  const shotCanvas = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const detectionEnabledRef = useRef(detectionEnabled);
  detectionEnabledRef.current = detectionEnabled;
  const onDetectionRef = useRef(onDetection);
  onDetectionRef.current = onDetection;

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      onStatusChange('no-device');
      return false;
    }
    if (streamRef.current) return true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        // iOS will not play an inline video without both of these.
        video.setAttribute('playsinline', 'true');
        video.muted = true;
        await video.play().catch(() => {});
      }
      onStatusChange('granted');
      return true;
    } catch (e) {
      // NotAllowedError is a refusal; anything else means no usable camera.
      const denied = e instanceof DOMException && e.name === 'NotAllowedError';
      onStatusChange(denied ? 'denied' : 'no-device');
      return false;
    }
  }, [onStatusChange]);

  // --- Lifecycle ----------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (isActive) void start();
    else stop();
  }, [isActive, start, stop]);

  // --- Detection loop -----------------------------------------------------
  useEffect(() => {
    if (!isActive || !detectionEnabled) return;

    const canvas =
      sampleCanvas.current ?? (sampleCanvas.current = document.createElement('canvas'));
    canvas.width = GRID_W;
    canvas.height = GRID_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const tick = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !detectionEnabledRef.current) return;

      try {
        // Squashing the frame to a 96x96 square is fine: the detector works
        // in normalized coordinates, so the aspect distortion cancels out.
        ctx.drawImage(video, 0, 0, GRID_W, GRID_H);
        const { data } = ctx.getImageData(0, 0, GRID_W, GRID_H);
        const detection = detectPageInLuma(rgbaToLuma(data, GRID_W * GRID_H), GRID_W, GRID_H);
        onDetectionRef.current(detection?.corners ?? null, detection?.confidence ?? 0);
      } catch {
        // A tainted or not-yet-ready frame: skip it and try the next one.
      }
    };

    timerRef.current = setInterval(tick, DETECT_INTERVAL_MS);
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [detectionEnabled, isActive]);

  // --- Shutter ------------------------------------------------------------
  useImperativeHandle(
    ref,
    () => ({
      async takePhoto() {
        const video = videoRef.current;
        if (!video || video.readyState < 2) return null;

        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width === 0 || height === 0) return null;

        const canvas = shotCanvas.current ?? (shotCanvas.current = document.createElement('canvas'));
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, width, height);

        const blob = await new Promise<Blob | null>((resolve) =>
          // A near-lossless grab: the processing pass does the real
          // compression, and encoding twice at 0.8 would show.
          canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.95),
        );
        if (!blob) return null;

        return { uri: await saveBlob(blob, 'shot'), width, height };
      },
      requestPermission: start,
    }),
    [start],
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* A raw <video> is intentional: react-native-web renders DOM nodes
          inside a View, and RN has no camera-preview primitive. */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'cover', backgroundColor: '#000' }}
      />
    </View>
  );
});
