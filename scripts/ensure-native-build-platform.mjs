#!/usr/bin/env node

const [, , requestedTarget] = process.argv;

const platformLabels = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux"
};

const targetToPlatform = {
  mac: "darwin",
  win: "win32",
  linux: "linux"
};

if (!requestedTarget || !(requestedTarget in targetToPlatform)) {
  const supportedTargets = Object.keys(targetToPlatform).join(", ");
  console.error(`Expected one of these build targets: ${supportedTargets}.`);
  process.exit(1);
}

const expectedPlatform = targetToPlatform[requestedTarget];
const currentPlatform = process.platform;

if (currentPlatform !== expectedPlatform) {
  const currentLabel = platformLabels[currentPlatform] ?? currentPlatform;
  const expectedLabel = platformLabels[expectedPlatform] ?? expectedPlatform;
  console.warn(
    [
      `Warning: building the ${requestedTarget} desktop package on ${currentLabel}.`,
      `This app ships native torrent dependencies, so cross-platform builds can package an incompatible .node binary.`,
      `For the most reliable result, create the ${requestedTarget} build on ${expectedLabel}.`
    ].join(" ")
  );
}
