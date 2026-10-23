// Temporary: remove this loader and its rule in next.config.ts once @sentdm/voice-client 0.2.1 is
// installed, which strips these branches at build.
// @sentdm/voice-client 0.2.0 bundles crypto-js with its UMD wrappers, whose AMD branch names files
// the package does not ship, such as "./core". Turbopack resolves those names and fails the build.
// The branch never runs, since the CommonJS one comes first, so this loader turns it off.
module.exports = function stripAmd(source) {
  return source.replaceAll('typeof define=="function"&&define.amd', "false");
};
