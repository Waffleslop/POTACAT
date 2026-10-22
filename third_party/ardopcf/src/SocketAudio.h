// POTACAT socket audio backend for ardopcf (MIT, same as ardopcf).
//
// Instead of a sound card, ardopcf connects to a loopback TCP port that
// POTACAT serves: POTACAT writes the radio's receive audio to it and reads
// ardopcf's transmit audio from it — 16-bit signed little-endian mono PCM at
// 12000 samples/s, both directions, no framing. POTACAT carries both over
// its own radio link (Flex Direct VITA-49, Icom Network, or a sound device it
// already owns), so no DAX program, virtual cable or second sound card is
// needed, and the backend has no platform audio code at all.
//
// Selected by giving BOTH device names as "tcp:<port>" (case-insensitive).
#ifndef POTACAT_SOCKET_AUDIO_H
#define POTACAT_SOCKET_AUDIO_H

// True when the configured playback device is "tcp:<port>".
int sa_active(void);

// Connect to 127.0.0.1:<port>. Returns 1 on success, 0 (logged) on failure.
int sa_init(const char *capture, const char *playback);

// Send n samples of transmit audio. Never blocks for long; pacing is the
// caller's job via sa_tx_backlog_ms().
void sa_write(const short *buf, int n);

// Milliseconds of sent audio not yet "played" at 12000 samples/s (0 = idle).
int sa_tx_backlog_ms(void);

// Copy exactly `want` received samples into out when that many are buffered;
// otherwise 0 (the remainder stays buffered). Non-blocking.
int sa_read(short *out, int want);

void sa_close(void);

#endif
