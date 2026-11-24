'use strict';
// Size limits on what an ECHOCAT client may send the shack's WebSocket
// server (lib/remote-server.js). Pure: constants and small checks, tested in
// test/ws-limits-test.js. The wire contract is docs/echocat-protocol.md,
// "Frame size limits".
//
// Measured legitimate client-to-server frames (2026-11-23):
//   - sstv-photo: the largest picture is 640x496 (PD-120/160/180/240). A
//     lossless RGBA PNG of pure noise at that size, the desktop-to-desktop
//     sender's format, is 1.27 MB, 1.69 MB as a data URL. The phone's
//     320x256 JPEG (q 0.9) is 40-90 kB as a data URL; ECHOCAT Web's the same.
//   - voice-macro-play-audio / voice-macro-sync: a 30 s phone recording at
//     128 kbit/s AAC is 0.64 MB of base64; play-audio is capped at
//     VOICE_PLAY_AUDIO_MAX (4 MiB) of base64.
//   - save-settings with sstvTemplates: at the template sync limits (24
//     templates, 150 KiB background, 32 KiB thumbnail) about 4.3 MiB.
//   - winlink-compose: attachments are refused over 2 MiB in total, 2.7 MiB
//     as base64.
//   - Everything else (log-qso, APRS, JS8, settings without pictures) is
//     a few kB. hello and auth, the only frames read before sign-in, are
//     under 1 kB.

const KiB = 1024;
const MiB = 1024 * 1024;

// ws closes a socket whose frame is larger than this (close 1009, before the
// frame is buffered). 16 MiB is about 4x the largest legitimate frame.
const WS_MAX_PAYLOAD = 16 * MiB;

// Until a socket has signed in, a frame larger than this closes it before it
// is parsed. hello and auth are under 1 kB.
const PRE_AUTH_MAX_FRAME = 64 * KiB;

// sstv-photo `image` (the data URL or bare base64 string, in characters).
// About 2.4x the largest real picture.
const SSTV_IMAGE_MAX = 4 * MiB;

// voice-macro-play-audio `audio` (base64 characters): about two minutes.
const VOICE_PLAY_AUDIO_MAX = 4 * MiB;

// RFC 6455 1009 "Message Too Big", for both the ws limit and ours.
const CLOSE_TOO_BIG = 1009;
const PRE_AUTH_CLOSE_REASON = 'Frame too large before sign-in';

const SSTV_TOO_LARGE_ERROR = 'Picture not sent: the picture is too large to send (4 MB at most).';
const SSTV_UNREADABLE_ERROR = 'Picture not sent: the picture could not be read.';

/** Size in bytes of a ws 'message' payload (Buffer, ArrayBuffer, Buffer[] or string). */
function frameBytes(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'string') return Buffer.byteLength(raw);
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + frameBytes(b), 0);
  if (typeof raw.byteLength === 'number') return raw.byteLength;
  if (typeof raw.length === 'number') return raw.length;
  return 0;
}

/** True when this frame must close a socket that has not signed in yet. */
function preAuthFrameTooBig(raw, authenticated) {
  return !authenticated && frameBytes(raw) > PRE_AUTH_MAX_FRAME;
}

/**
 * Whether an sstv-photo image may go on to the encoder.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkSstvImage(image) {
  if (typeof image !== 'string' || image.length === 0) return { ok: false, error: SSTV_UNREADABLE_ERROR };
  if (image.length > SSTV_IMAGE_MAX) return { ok: false, error: SSTV_TOO_LARGE_ERROR };
  return { ok: true };
}

module.exports = {
  WS_MAX_PAYLOAD,
  PRE_AUTH_MAX_FRAME,
  SSTV_IMAGE_MAX,
  VOICE_PLAY_AUDIO_MAX,
  CLOSE_TOO_BIG,
  PRE_AUTH_CLOSE_REASON,
  SSTV_TOO_LARGE_ERROR,
  SSTV_UNREADABLE_ERROR,
  frameBytes,
  preAuthFrameTooBig,
  checkSstvImage,
};
