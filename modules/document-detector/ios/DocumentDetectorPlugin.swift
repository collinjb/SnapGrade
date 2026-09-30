//
//  DocumentDetectorPlugin.swift
//  SnapGrade
//
//  A VisionCamera frame-processor plugin that finds the page in the frame.
//
//  Vision's VNDetectRectanglesRequest gives us four real corners — not a
//  bounding box — which is what makes true perspective correction possible on
//  the JS side. It runs comfortably at the 8fps the app asks for.
//
//  Returns a flat array so the JSI hop stays cheap:
//    [x0, y0, x1, y1, x2, y2, x3, y3, confidence]
//  with corners clockwise from top-left, normalized 0–1 in *display* space
//  (origin top-left), or nil when no page is visible.
//

import Foundation
import Vision
import VisionCamera

@objc(DocumentDetectorPlugin)
public class DocumentDetectorPlugin: FrameProcessorPlugin {

  /// A worksheet is big in frame; ignoring small rectangles keeps us from
  /// locking onto a calculator, a phone, or a single printed box.
  private static let minimumSize: Float = 0.30

  /// Paper is rectangular; allow real perspective tilt but not a random quad.
  private static let quadratureTolerance: Float = 35.0

  /// Letter, A4 and legal all fall inside this range in either orientation.
  private static let minAspect: Float = 0.45
  private static let maxAspect: Float = 2.2

  public override init(proxy: VisionCameraProxyHolder, options: [AnyHashable: Any]! = [:]) {
    super.init(proxy: proxy, options: options)
  }

  public override func callback(_ frame: Frame, withArguments _: [AnyHashable: Any]?) -> Any? {
    let buffer = frame.buffer
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(buffer) else { return nil }

    let request = VNDetectRectanglesRequest()
    request.minimumSize = Self.minimumSize
    request.quadratureTolerance = Self.quadratureTolerance
    request.minimumAspectRatio = Self.minAspect
    request.maximumAspectRatio = Self.maxAspect
    // One page at a time: the app grades a single sheet per capture.
    request.maximumObservations = 1
    request.minimumConfidence = 0.4

    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])

    do {
      try handler.perform([request])
    } catch {
      return nil
    }

    guard let rect = request.results?.first else { return nil }

    // Vision reports normalized points with the origin at the bottom-left of
    // the *buffer*. The preview is rotated relative to the buffer, so map
    // through the frame's orientation before flipping to a top-left origin.
    let orientation = frame.orientation
    let corners = [rect.topLeft, rect.topRight, rect.bottomRight, rect.bottomLeft]
      .map { Self.toDisplaySpace($0, orientation: orientation) }

    // Re-sort after rotation: what Vision called "top left" is only top-left
    // in buffer space, and a 90-degree frame turns that into a different
    // corner of the page as the user sees it.
    let ordered = Self.orderClockwiseFromTopLeft(corners)

    var out: [Float] = []
    out.reserveCapacity(9)
    for point in ordered {
      out.append(Float(point.x))
      out.append(Float(point.y))
    }
    out.append(rect.confidence)
    return out
  }

  /// Rotate a normalized buffer-space point into display space and flip the
  /// y axis so the origin ends up top-left, matching the RN overlay.
  private static func toDisplaySpace(_ p: CGPoint, orientation: UIImage.Orientation) -> CGPoint {
    // Flip first: Vision's origin is bottom-left, ours is top-left.
    let flipped = CGPoint(x: p.x, y: 1.0 - p.y)

    switch orientation {
    case .up:
      return flipped
    case .right:
      // Buffer is rotated 90 degrees clockwise relative to the display.
      return CGPoint(x: 1.0 - flipped.y, y: flipped.x)
    case .down:
      return CGPoint(x: 1.0 - flipped.x, y: 1.0 - flipped.y)
    case .left:
      return CGPoint(x: flipped.y, y: 1.0 - flipped.x)
    case .upMirrored:
      return CGPoint(x: 1.0 - flipped.x, y: flipped.y)
    case .rightMirrored:
      return CGPoint(x: flipped.y, y: flipped.x)
    case .downMirrored:
      return CGPoint(x: flipped.x, y: 1.0 - flipped.y)
    case .leftMirrored:
      return CGPoint(x: 1.0 - flipped.y, y: 1.0 - flipped.x)
    @unknown default:
      return flipped
    }
  }

  /// Put four arbitrary corners into clockwise order starting at the one
  /// nearest the top-left, which is the order the JS side expects.
  private static func orderClockwiseFromTopLeft(_ points: [CGPoint]) -> [CGPoint] {
    guard points.count == 4 else { return points }

    let cx = points.reduce(0) { $0 + $1.x } / 4
    let cy = points.reduce(0) { $0 + $1.y } / 4

    // Sort by angle about the centroid. With y pointing down, increasing
    // atan2 traces clockwise on screen.
    let sorted = points.sorted {
      atan2($0.y - cy, $0.x - cx) < atan2($1.y - cy, $1.x - cx)
    }

    // Rotate the cycle so it begins at the corner closest to the origin.
    var startIndex = 0
    var best = CGFloat.greatestFiniteMagnitude
    for (i, p) in sorted.enumerated() {
      let d = p.x * p.x + p.y * p.y
      if d < best {
        best = d
        startIndex = i
      }
    }

    return (0..<4).map { sorted[(startIndex + $0) % 4] }
  }
}
