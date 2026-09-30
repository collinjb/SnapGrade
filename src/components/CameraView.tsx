/** The camera preview and shutter, native implementation.
 *
 *  Wraps react-native-vision-camera and the `detectDocument` frame processor
 *  behind a small interface so `CameraScreen` carries none of it — the web
 *  build swaps in `CameraView.web.tsx`, which does the same job with
 *  getUserMedia and a canvas. */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import {
  Camera,
  runAtTargetFps,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  type PhotoFile,
} from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import { detectDocument, detectorMode } from '@/lib/documentDetector';
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
  /** Keep the preview running. False while another screen is on top. */
  isActive: boolean;
  /** Run page detection and report it. */
  detectionEnabled: boolean;
  onDetection: (corners: Corners | null, confidence: number) => void;
  onStatusChange: (status: CameraStatus) => void;
}

/** Whether this platform can detect page edges at all. False means
 *  auto-capture has to fall back to a hold-still timer. */
export const supportsEdgeDetection = detectorMode === 'edges';

/** Shown in Settings → Diagnostics. */
export const detectorLabel = detectorMode === 'edges' ? 'native plugin' : 'hold-still fallback';

export const CameraView = forwardRef<CameraViewHandle, CameraViewProps>(function CameraView(
  { isActive, detectionEnabled, onDetection, onStatusChange },
  ref,
) {
  const camera = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();

  useEffect(() => {
    if (!hasPermission) {
      void requestPermission();
      onStatusChange('loading');
    } else if (!device) {
      onStatusChange('no-device');
    } else {
      onStatusChange('granted');
    }
  }, [device, hasPermission, onStatusChange, requestPermission]);

  useImperativeHandle(
    ref,
    () => ({
      async takePhoto() {
        const cam = camera.current;
        if (!cam) return null;
        const photo: PhotoFile = await cam.takePhoto({ flash: 'off' });
        return {
          uri: photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`,
          width: photo.width,
          height: photo.height,
        };
      },
      requestPermission,
    }),
    [requestPermission],
  );

  // worklets-core needs the JS callback wrapped before a worklet can call it.
  const report = useCallback(
    (flat: number[] | null) => {
      if (!flat) {
        onDetection(null, 0);
        return;
      }
      onDetection(
        [
          { x: flat[0]!, y: flat[1]! },
          { x: flat[2]!, y: flat[3]! },
          { x: flat[4]!, y: flat[5]! },
          { x: flat[6]!, y: flat[7]! },
        ],
        flat[8]!,
      );
    },
    [onDetection],
  );

  const reportDetection = useMemo(() => Worklets.createRunOnJS(report), [report]);

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      // 8fps is plenty for a 700ms steady window and leaves the GPU free for
      // a smooth preview.
      runAtTargetFps(8, () => {
        'worklet';
        const detection = detectDocument(frame);
        if (detection == null) {
          reportDetection(null);
          return;
        }
        const c = detection.corners;
        reportDetection([
          c[0].x, c[0].y,
          c[1].x, c[1].y,
          c[2].x, c[2].y,
          c[3].x, c[3].y,
          detection.confidence,
        ]);
      });
    },
    [reportDetection],
  );

  if (!hasPermission || !device) return null;

  return (
    <Camera
      ref={camera}
      style={StyleSheet.absoluteFill}
      device={device}
      isActive={isActive}
      photo
      frameProcessor={
        detectionEnabled && supportsEdgeDetection ? frameProcessor : undefined
      }
      photoQualityBalance="speed"
    />
  );
});
