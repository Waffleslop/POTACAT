/*
 * POTACAT socket audio backend for Dire Wolf — see audio_tcp.h.
 * GPL-2.0, as Dire Wolf. Portable: winsock on Windows, BSD sockets elsewhere.
 */
#include "direwolf.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#if __WIN32__
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET tcpaudio_sock_t;
#define TCPAUDIO_INVALID INVALID_SOCKET
#define tcpaudio_closesock closesocket
#else
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
typedef int tcpaudio_sock_t;
#define TCPAUDIO_INVALID (-1)
#define tcpaudio_closesock close
#endif

#include "textcolor.h"
#include "audio_tcp.h"

#define TCPAUDIO_OUTBUF 2048	/* bytes queued before a send: ~21 ms at 48 k mono */
#define TCPAUDIO_LEAD_MS 200	/* how far ahead of real time we may write (POTACAT drops past ~300 ms) */

static tcpaudio_sock_t s_sock = TCPAUDIO_INVALID;
static int s_active = 0;
static int s_bytes_per_sec = 96000;
static unsigned char s_out[TCPAUDIO_OUTBUF];
static int s_out_len = 0;
static double s_tx_end_ms = 0;	/* playback clock: when the audio sent so far has played */

static double now_ms (void)
{
#if __WIN32__
	static LARGE_INTEGER f;
	LARGE_INTEGER c;
	if (f.QuadPart == 0) QueryPerformanceFrequency(&f);
	QueryPerformanceCounter(&c);
	return (double) c.QuadPart * 1000.0 / (double) f.QuadPart;
#else
	struct timespec ts;
	clock_gettime (CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
#endif
}

static void sleep_ms (int ms)
{
	if (ms <= 0) return;
#if __WIN32__
	Sleep (ms);
#else
	usleep (ms * 1000);
#endif
}

int tcpaudio_is_spec (const char *spec)
{
	return spec != NULL && strlen(spec) > 4 &&
	       tolower((unsigned char)spec[0]) == 't' && tolower((unsigned char)spec[1]) == 'c' &&
	       tolower((unsigned char)spec[2]) == 'p' && spec[3] == ':';
}

int tcpaudio_open (const char *spec, int samples_per_sec, int num_channels, int bits_per_sample)
{
	int port;
	struct sockaddr_in sa;
	int one = 1;

	if (!tcpaudio_is_spec(spec)) return (-1);
	port = atoi(spec + 4);
	if (port <= 0 || port > 65535) {
	  text_color_set(DW_COLOR_ERROR);
	  dw_printf ("Audio device %s: port must be 1-65535.\n", spec);
	  return (-1);
	}
	if (num_channels != 1 || bits_per_sample != 16) {
	  text_color_set(DW_COLOR_ERROR);
	  dw_printf ("Audio device %s carries 16-bit mono only (configured %d channels, %d bits).\n", spec, num_channels, bits_per_sample);
	  return (-1);
	}
#if __WIN32__
	{
	  WSADATA wsadata;
	  if (WSAStartup(MAKEWORD(2,2), &wsadata) != 0) {
	    text_color_set(DW_COLOR_ERROR);
	    dw_printf ("Audio device %s: WSAStartup failed.\n", spec);
	    return (-1);
	  }
	}
#endif
	s_sock = socket(AF_INET, SOCK_STREAM, 0);
	if (s_sock == TCPAUDIO_INVALID) {
	  text_color_set(DW_COLOR_ERROR);
	  dw_printf ("Audio device %s: socket() failed.\n", spec);
	  return (-1);
	}
	memset (&sa, 0, sizeof(sa));
	sa.sin_family = AF_INET;
	sa.sin_port = htons((unsigned short)port);
	sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (connect(s_sock, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
	  text_color_set(DW_COLOR_ERROR);
	  dw_printf ("Audio device %s: nothing is serving modem audio on 127.0.0.1:%d.\n", spec, port);
	  tcpaudio_closesock (s_sock);
	  s_sock = TCPAUDIO_INVALID;
	  return (-1);
	}
	setsockopt (s_sock, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof(one));
	s_bytes_per_sec = samples_per_sec * 2;
	s_out_len = 0;
	s_tx_end_ms = 0;
	s_active = 1;
	text_color_set(DW_COLOR_INFO);
	dw_printf ("Audio via POTACAT on 127.0.0.1:%d, %d samples/s 16-bit mono (no sound device).\n", port, samples_per_sec);
	return (0);
}

int tcpaudio_active (void)
{
	return s_active;
}

int tcpaudio_read (unsigned char *buf, int max)
{
	int n;
	if (!s_active || max <= 0) return (-1);
	n = (int) recv(s_sock, (char *)buf, max, 0);
	return (n);
}

int tcpaudio_put (int c)
{
	if (!s_active) return (-1);
	s_out[s_out_len++] = (unsigned char) c;
	if (s_out_len >= TCPAUDIO_OUTBUF) return (tcpaudio_flush());
	return (0);
}

int tcpaudio_flush (void)
{
	int off = 0;
	double now;
	if (!s_active) return (-1);
	if (s_out_len == 0) return (0);

	/* Pace like a sound card with a small buffer: never run far ahead of real time. */
	now = now_ms ();
	if (s_tx_end_ms < now) s_tx_end_ms = now;
	while (s_tx_end_ms - now_ms () > TCPAUDIO_LEAD_MS) sleep_ms (5);

	while (off < s_out_len) {
	  int n = (int) send(s_sock, (const char *)s_out + off, s_out_len - off, 0);
	  if (n <= 0) {
	    text_color_set(DW_COLOR_ERROR);
	    dw_printf ("Audio via POTACAT: the audio connection closed while transmitting.\n");
	    s_out_len = 0;
	    return (-1);
	  }
	  off += n;
	}
	s_tx_end_ms += s_out_len * 1000.0 / s_bytes_per_sec;
	s_out_len = 0;
	return (0);
}

void tcpaudio_wait (void)
{
	if (!s_active) return;
	tcpaudio_flush ();
	for (;;) {
	  double left = s_tx_end_ms - now_ms ();
	  if (left <= 0) break;
	  sleep_ms (left > 20 ? 20 : (int) left + 1);
	}
}

void tcpaudio_close (void)
{
	if (!s_active) return;
	tcpaudio_flush ();
	tcpaudio_closesock (s_sock);
	s_sock = TCPAUDIO_INVALID;
	s_active = 0;
}
