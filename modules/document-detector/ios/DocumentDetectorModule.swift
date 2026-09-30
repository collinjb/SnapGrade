//
//  DocumentDetectorModule.swift
//
//  Expo modules autolinking needs a module class to pick this package up and
//  compile the plugin into the app. The plugin itself registers through
//  VisionCamera, so there is nothing to expose to JS here.
//

import ExpoModulesCore

public class DocumentDetectorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DocumentDetector")

    Function("isAvailable") { () -> Bool in
      true
    }
  }
}
