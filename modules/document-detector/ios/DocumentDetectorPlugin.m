//
//  DocumentDetectorPlugin.m
//
//  Registers the Swift plugin with VisionCamera under the name the JS side
//  looks up (`detectDocument`). The macro emits a +load hook, so registration
//  happens before any frame processor runs and needs no AppDelegate wiring.
//

#import <VisionCamera/FrameProcessorPluginRegistry.h>

// The Swift class lives in this pod, whose module name comes from the
// podspec. DEFINES_MODULE is set there so the generated interface is
// importable as a module regardless of the app target's name.
@import DocumentDetector;

VISION_EXPORT_SWIFT_FRAME_PROCESSOR(DocumentDetectorPlugin, detectDocument)
