// POTACAT socket audio backend for ardopcf — see SocketAudio.h.
// MIT, same as ardopcf. Portable: winsock on Windows, BSD sockets elsewhere.

#ifdef WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET sa_sock_t;
#define SA_INVALID INVALID_SOCKET
#define sa_closesock closesocket
#define sa_errno WSAGetLastError()
#define SA_EWOULDBLOCK WSAEWOULDBLOCK
#else
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
typedef int sa_sock_t;
#define SA_INVALID (-1)
#define sa_closesock close
#define sa_errno errno
#define SA_EWOULDBLOCK EWOULDBLOCK
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#include "common/ardopcommon.h"
#include "common/SocketAudio.h"

#define SA_RATE 12000.0
#define SA_RXBUF (1 << 16)

static sa_sock_t sa_sock = SA_INVALID;
static int sa_up = 0;
static int sa_dead_logged = 0;
static unsigned char sa_rxbuf[SA_RXBUF];
static int sa_rxlen = 0;
static double sa_tx_end_ms = 0;

static double sa_now_ms(void)
{
#ifdef WIN32
	return (double)GetTickCount64();
#else
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
#endif
}

static int sa_parse_port(const char *spec)
{
	if (!spec || strlen(spec) < 5) return 0;
	if (tolower((unsigned char)spec[0]) != 't' || tolower((unsigned char)spec[1]) != 'c'
		|| tolower((unsigned char)spec[2]) != 'p' || spec[3] != ':') return 0;
	int port = atoi(spec + 4);
	return (port > 0 && port < 65536) ? port : 0;
}

int sa_active(void)
{
	return sa_parse_port(PlaybackDevice) != 0;
}

static void sa_sleep_ms(int ms)
{
#ifdef WIN32
	Sleep(ms);
#else
	usleep(ms * 1000);
#endif
}

static int sa_would_block(void)
{
	int e = sa_errno;
#ifdef WIN32
	return e == WSAEWOULDBLOCK;
#else
	return e == EWOULDBLOCK || e == EAGAIN;
#endif
}

int sa_init(const char *capture, const char *playback)
{
	int port = sa_parse_port(playback);
	int cport = sa_parse_port(capture);
	if (!port) {
		ZF_LOGE("socket audio: playback device must be tcp:<port> (got '%s')", playback ? playback : "");
		return 0;
	}
	if (cport && cport != port) {
		ZF_LOGE("socket audio: capture (%s) and playback (%s) must name the same port", capture, playback);
		return 0;
	}
	if (sa_up) return 1;
#ifdef WIN32
	WSADATA wsa;
	if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
		ZF_LOGE("socket audio: WSAStartup failed");
		return 0;
	}
#endif
	sa_sock = socket(AF_INET, SOCK_STREAM, 0);
	if (sa_sock == SA_INVALID) {
		ZF_LOGE("socket audio: socket() failed (%d)", (int)sa_errno);
		return 0;
	}
	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((unsigned short)port);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (connect(sa_sock, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
		ZF_LOGE("socket audio: cannot connect to POTACAT on 127.0.0.1:%d (%d) — is POTACAT's audio server running?", port, (int)sa_errno);
		sa_closesock(sa_sock);
		sa_sock = SA_INVALID;
		return 0;
	}
	int one = 1;
	setsockopt(sa_sock, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof(one));
#ifdef WIN32
	u_long nb = 1;
	ioctlsocket(sa_sock, FIONBIO, &nb);
#else
	fcntl(sa_sock, F_SETFL, fcntl(sa_sock, F_GETFL, 0) | O_NONBLOCK);
#endif
	sa_up = 1;
	sa_dead_logged = 0;
	sa_rxlen = 0;
	sa_tx_end_ms = 0;
	ZF_LOGI("socket audio: connected to POTACAT on 127.0.0.1:%d (12000 Hz s16 mono both ways)", port);
	return 1;
}

static void sa_mark_dead(const char *why)
{
	if (!sa_dead_logged) {
		ZF_LOGE("socket audio: %s — no audio until ardopcf is restarted", why);
		sa_dead_logged = 1;
	}
	sa_up = 0;
}

void sa_write(const short *buf, int n)
{
	if (n <= 0) return;
	double now = sa_now_ms();
	// The playback clock: audio "plays" at 12000 samples/s from when it was
	// sent, so the caller can pace itself exactly as it would on a sound card.
	if (sa_tx_end_ms < now) sa_tx_end_ms = now;
	sa_tx_end_ms += n * 1000.0 / SA_RATE;
	if (!sa_up) return;
	const char *p = (const char *)buf;
	int left = n * 2;
	int stalls = 0;
	while (left > 0) {
		int r = (int)send(sa_sock, p, left, 0);
		if (r > 0) { p += r; left -= r; stalls = 0; continue; }
		if (r < 0 && sa_would_block()) {
			if (++stalls > 500) { sa_mark_dead("POTACAT stopped reading transmit audio"); return; }
			sa_sleep_ms(1);
			continue;
		}
		sa_mark_dead("transmit audio socket closed");
		return;
	}
}

int sa_tx_backlog_ms(void)
{
	double d = sa_tx_end_ms - sa_now_ms();
	return d > 0 ? (int)d : 0;
}

int sa_read(short *out, int want)
{
	if (want <= 0) return 0;
	if (sa_up) {
		for (;;) {
			int room = SA_RXBUF - sa_rxlen;
			if (room <= 0) break;
			int r = (int)recv(sa_sock, (char *)sa_rxbuf + sa_rxlen, room, 0);
			if (r > 0) { sa_rxlen += r; continue; }
			if (r == 0) { sa_mark_dead("receive audio socket closed"); break; }
			if (!sa_would_block()) sa_mark_dead("receive audio socket error");
			break;
		}
	}
	int need = want * 2;
	if (sa_rxlen < need) return 0;
	memcpy(out, sa_rxbuf, need);
	sa_rxlen -= need;
	if (sa_rxlen > 0) memmove(sa_rxbuf, sa_rxbuf + need, sa_rxlen);
	return want;
}

void sa_close(void)
{
	if (sa_sock != SA_INVALID) {
		sa_closesock(sa_sock);
		sa_sock = SA_INVALID;
	}
	sa_up = 0;
#ifdef WIN32
	WSACleanup();
#endif
}
