package expo.modules.documentdetector

import com.mrousavy.camera.frameprocessors.FrameProcessorPluginRegistry
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Registers the `detectDocument` frame processor with VisionCamera.
 *
 * Expo autolinking instantiates this module at startup, which is early enough
 * for the registry: VisionCamera resolves plugin names lazily, the first time
 * JS calls `initFrameProcessorPlugin`.
 */
class DocumentDetectorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DocumentDetector")

    OnCreate {
      FrameProcessorPluginRegistry.addFrameProcessorPlugin("detectDocument") { proxy, options ->
        DocumentDetectorPlugin(proxy, options)
      }
    }

    Function("isAvailable") { true }
  }
}
