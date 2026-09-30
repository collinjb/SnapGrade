module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          // zustand's middleware barrel pulls in its devtools helper, which
          // reads `import.meta.env`. Metro emits classic scripts, so that
          // throws at load unless the preset shims it.
          unstable_transformImportMeta: true,
        },
      ],
    ],
    // `@/*` path aliases resolve through tsconfig.json paths, which Expo's
    // Metro config reads natively (expo.experiments.tsconfigPaths, on by default).
    //
    // VisionCamera 4 frame processors run on react-native-worklets-core, so its
    // Babel plugin has to see every `'worklet'` function. It must stay last.
    // Reanimated is deliberately NOT installed: Reanimated 4 ships its own,
    // incompatible worklets runtime (react-native-worklets), and having both
    // Babel plugins fight over the same directive breaks frame processors. The
    // UI animations here use React Native's own Animated API instead.
    plugins: ['react-native-worklets-core/plugin'],
  };
};
