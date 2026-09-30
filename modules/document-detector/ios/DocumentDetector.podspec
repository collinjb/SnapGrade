Pod::Spec.new do |s|
  s.name           = 'DocumentDetector'
  s.version        = '1.0.0'
  s.summary        = 'Page edge detection as a VisionCamera frame processor plugin.'
  s.description    = 'Finds the four corners of a sheet of paper in a camera frame using Vision.'
  s.author         = 'SnapGrade'
  s.homepage       = 'https://example.com/snapgrade'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'VisionCamera'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
