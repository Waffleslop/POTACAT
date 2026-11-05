'use strict';
/**
 * Radio audio to BOTH ears (hoogskev, FTX-1, macOS, 2026-11-05: the VFO
 * window's monitor played in the left channel only). The monitor asks for a
 * mono capture, but on macOS Chromium can hand a stereo device back as two
 * channels with only channel 0 filled, and a 2-channel stream goes to the
 * speakers as it is: left only.
 *
 * Take channel 0 (a ChannelSplitter) into a node forced to ONE channel
 * (channelCount 1, 'explicit'), which the destination up-mixes to both
 * sides. Unlike averaging the two channels into mono, this keeps the level: a
 * left-only stream is not halved. A truly mono capture passes unchanged.
 *
 * Dual-mode: require() in tests, window.MonoUpmix in the VFO window.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MonoUpmix = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /** Returns the node to connect onward (to a gain, then the destination). */
  function monoToBothSides(ctx, input) {
    const split = ctx.createChannelSplitter(2);
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    input.connect(split);
    split.connect(mono, 0);
    return mono;
  }
  return { monoToBothSides };
}));
