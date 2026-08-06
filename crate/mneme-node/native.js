'use strict';
// Resolve the native addon for the current platform: a local build first (dev / single-platform
// install), then the per-platform npm package published by CI (singulance-amr-<triple>).

const { existsSync } = require('fs');
const { join } = require('path');

function triple() {
  const { platform, arch } = process;
  if (platform === 'linux') return `linux-${arch}-gnu`;
  if (platform === 'win32') return `win32-${arch}-msvc`;
  return `${platform}-${arch}`; // darwin-arm64, darwin-x64
}

function localCandidates() {
  return [
    join(__dirname, `singulance-amr.${triple()}.node`),
    join(__dirname, 'singulance-amr.node'),
  ];
}

function platformPackages() {
  const { platform, arch } = process;
  if (platform === 'darwin') return [`singulance-amr-darwin-${arch}`];
  if (platform === 'linux') return [`singulance-amr-linux-${arch}-gnu`, `singulance-amr-linux-${arch}-musl`];
  if (platform === 'win32') return [`singulance-amr-win32-${arch}-msvc`];
  return [];
}

let native;
for (const p of localCandidates()) {
  if (existsSync(p)) {
    native = require(p);
    break;
  }
}
if (!native) {
  for (const pkg of platformPackages()) {
    try {
      native = require(pkg);
      break;
    } catch (_) {
      /* try next */
    }
  }
}
if (!native) {
  throw new Error(
    `singulance-amr: no prebuilt binary for ${process.platform}-${process.arch}. ` +
      `Build from source: https://github.com/amar3012005/ICARUS`
  );
}

module.exports = native;
