/*
 * yaesu-scope — the Yaesu FT-710's band scope, read over the USB cable.
 *
 * The FT-710 puts its spectrum on an FTDI FT4222 USB→SPI bridge on the main
 * board, on the same USB cable that carries CAT and audio. This program opens
 * that bridge, keeps the SPI stream aligned to the radio's 4096-byte frames,
 * and writes each aligned frame to stdout behind an 8-byte header:
 *
 *     'Y' 'S'  version(1)  kind(0 live | 1 synth)  seq(u32 little-endian)
 *
 * It knows NOTHING about what the bytes mean — no de-inverting, no bins, no
 * metadata. All of that lives in lib/yaesu-scope.js, where it is unit-tested
 * and can be corrected without recompiling this. A capture for a bug report
 * is simply `yaesu-scope > capture.bin`.
 *
 * No FTDI SDK is needed to build this. The dozen entry points are declared
 * here and resolved at run time from the FTDI libraries the operator installs
 * (Windows: ftd2xx.dll + LibFT4222-64.dll; Linux/macOS: libft4222, which
 * carries the D2XX calls too). Nothing of FTDI's ships in the installer, and
 * "library missing" is a clean exit code instead of a loader failure.
 *
 * Exit codes (mirrored in lib/yaesu-scope.js HELPER_EXIT — keep in step):
 *   0  stopped normally (stdin closed, --once satisfied, or a signal)
 *   2  the FTDI libraries are not installed
 *   3  no device named "FT4222 A" could be opened
 *   4  the bridge opened but SPI master setup failed (something else holds it?)
 *   5  the bridge is open but the radio sends nothing (SCU-LAN10 off in its menu)
 *   6  a read failed mid-stream (cable, power)
 *   7  bytes flow but the frame sync pattern never appears (protocol drift)
 *
 * Options:
 *   --fps N       cap the frames written per second (1..60, default 20)
 *   --once        exit 0 after the first aligned frame is written
 *   --synth       write generated frames with no radio (drives the UI in dev)
 *   --list        list the FTDI devices the driver can see, then exit
 *   --timeout S   seconds of silence/no-sync tolerated at start (default 3)
 *
 * SPI parameters are the ones wfview has read this radio with for years:
 * single-line SPI, system clock 24 MHz ÷ 64, clock idle high, data on the
 * leading edge, slave select 1, 4096-byte reads.
 *
 * Apache-2.0, part of POTACAT. Technique acknowledged to wfview (GPL-3.0),
 * whose source was studied and not copied.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <signal.h>
#include <math.h>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#  include <io.h>
#  include <fcntl.h>
#  include <process.h>
#  define FTAPI __stdcall
typedef HMODULE lib_t;
#  define lib_open(name) LoadLibraryA(name)
#  define lib_sym(h, s)  ((void*)GetProcAddress((h), (s)))
#else
#  include <dlfcn.h>
#  include <pthread.h>
#  include <time.h>
#  include <unistd.h>
#  include <sys/stat.h>
#  define FTAPI
typedef void* lib_t;
#  define lib_open(name) dlopen((name), RTLD_NOW)
#  define lib_sym(h, s)  dlsym((h), (s))
#endif

/* ─── Exit codes ─────────────────────────────────────────────────────────── */
enum {
  EXIT_STOPPED    = 0,
  EXIT_NO_LIBRARY = 2,
  EXIT_NO_DEVICE  = 3,
  EXIT_SPI_INIT   = 4,
  EXIT_SILENT     = 5,
  EXIT_READ_ERROR = 6,
  EXIT_NO_SYNC    = 7,
};

/* ─── The FTDI ABI, as declared in ftd2xx.h / libft4222.h ────────────────── */
typedef void*        FT_HANDLE;
typedef unsigned int FT_STATUS;     /* ULONG — 32-bit on every FTDI platform */
typedef int          FT4222_STATUS; /* enum, FT4222_OK == 0 */

enum { FT_OK = 0 };
enum { FT_OPEN_BY_DESCRIPTION = 2 };
enum { SYS_CLK_24 = 1 };            /* FT4222_ClockRate */
enum { SPI_IO_SINGLE = 1 };         /* FT4222_SPIMode   */
enum { CLK_DIV_64 = 6 };            /* FT4222_SPIClock  */
enum { CLK_IDLE_HIGH = 1 };         /* FT4222_SPICPOL   */
enum { CLK_LEADING = 0 };           /* FT4222_SPICPHA   */

typedef FT_STATUS (FTAPI *pFT_OpenEx)(void* arg, unsigned int flags, FT_HANDLE* h);
typedef FT_STATUS (FTAPI *pFT_Close)(FT_HANDLE h);
typedef FT_STATUS (FTAPI *pFT_SetTimeouts)(FT_HANDLE h, unsigned int rd, unsigned int wr);
typedef FT_STATUS (FTAPI *pFT_SetLatencyTimer)(FT_HANDLE h, unsigned char ms);
typedef FT_STATUS (FTAPI *pFT_CreateDeviceInfoList)(unsigned int* n);
typedef FT_STATUS (FTAPI *pFT_GetDeviceInfoDetail)(unsigned int i, unsigned int* flags, unsigned int* type,
                                                   unsigned int* id, unsigned int* locId, char* serial,
                                                   char* desc, FT_HANDLE* h);
typedef FT4222_STATUS (FTAPI *pFT4222_SetClock)(FT_HANDLE h, int clk);
typedef FT4222_STATUS (FTAPI *pFT4222_SPIMaster_Init)(FT_HANDLE h, int ioLine, int clock, int cpol, int cpha, unsigned char ssoMap);
typedef FT4222_STATUS (FTAPI *pFT4222_SPIMaster_SingleRead)(FT_HANDLE h, unsigned char* buf, unsigned short size,
                                                            unsigned short* sizeRead, int isEndTransaction);
typedef FT4222_STATUS (FTAPI *pFT4222_UnInitialize)(FT_HANDLE h);

static struct {
  pFT_OpenEx OpenEx;
  pFT_Close Close;
  pFT_SetTimeouts SetTimeouts;
  pFT_SetLatencyTimer SetLatencyTimer;
  pFT_CreateDeviceInfoList CreateDeviceInfoList;
  pFT_GetDeviceInfoDetail GetDeviceInfoDetail;
  pFT4222_SetClock SetClock;
  pFT4222_SPIMaster_Init SPIMaster_Init;
  pFT4222_SPIMaster_SingleRead SPIMaster_SingleRead;
  pFT4222_UnInitialize UnInitialize;
} ft;

/* ─── Constants of the stream ────────────────────────────────────────────── */
#define FRAME_BYTES 4096
static const unsigned char SYNC[4] = { 0xff, 0x01, 0xee, 0x01 };
#define HEADER_BYTES 8
#define RESYNC_MAX_BYTES 8192      /* wfview's bound: give up a resync after this many single bytes */

static volatile sig_atomic_t g_stop = 0;

/* ─── Small platform shims ───────────────────────────────────────────────── */
static uint64_t now_ms(void) {
#ifdef _WIN32
  return (uint64_t)GetTickCount64();
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);
#endif
}

static void sleep_ms(unsigned ms) {
#ifdef _WIN32
  Sleep(ms);
#else
  struct timespec ts = { (time_t)(ms / 1000), (long)(ms % 1000) * 1000000L };
  nanosleep(&ts, NULL);
#endif
}

static void on_signal(int sig) { (void)sig; g_stop = 1; }

/* The parent closes our stdin to stop us: a clean FT4222_UnInitialize/FT_Close
 * beats a TerminateProcess. A thread blocks on stdin and flips g_stop at EOF.
 * Only when stdin IS a pipe: run from a shell with no stdin (CI, `> capture`
 * from a script) the EOF is immediate and the helper would stop before its
 * first frame — the release smoke test lost exactly that race on Linux. */
static int stdin_is_pipe(void) {
#ifdef _WIN32
  return GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE;
#else
  struct stat st;
  if (fstat(0, &st) != 0) return 0;
  return S_ISFIFO(st.st_mode) || S_ISSOCK(st.st_mode);
#endif
}
#ifdef _WIN32
static unsigned __stdcall stdin_watch(void* arg) {
  (void)arg;
  char c;
  while (fread(&c, 1, 1, stdin) == 1) { /* ignore input */ }
  g_stop = 1;
  return 0;
}
static void start_stdin_watch(void) { _beginthreadex(NULL, 0, stdin_watch, NULL, 0, NULL); }
#else
static void* stdin_watch(void* arg) {
  (void)arg;
  char c;
  while (read(0, &c, 1) == 1) { /* ignore input */ }
  g_stop = 1;
  return NULL;
}
static void start_stdin_watch(void) {
  pthread_t t;
  if (pthread_create(&t, NULL, stdin_watch, NULL) == 0) pthread_detach(t);
}
#endif

/* ─── Loading the FTDI libraries at run time ─────────────────────────────── */
static int load_ftdi(void) {
#ifdef _WIN32
  lib_t d2xx = lib_open("ftd2xx.dll");
  if (!d2xx) { fprintf(stderr, "yaesu-scope: ftd2xx.dll not found (install the FT-710 USB driver / FTDI D2XX)\n"); return 0; }
  lib_t l4222 = lib_open("LibFT4222-64.dll");
  if (!l4222) l4222 = lib_open("LibFT4222.dll");
  if (!l4222) { fprintf(stderr, "yaesu-scope: LibFT4222-64.dll not found (install FTDI's LibFT4222)\n"); return 0; }
  ft.OpenEx = (pFT_OpenEx)lib_sym(d2xx, "FT_OpenEx");
  ft.Close = (pFT_Close)lib_sym(d2xx, "FT_Close");
  ft.SetTimeouts = (pFT_SetTimeouts)lib_sym(d2xx, "FT_SetTimeouts");
  ft.SetLatencyTimer = (pFT_SetLatencyTimer)lib_sym(d2xx, "FT_SetLatencyTimer");
  ft.CreateDeviceInfoList = (pFT_CreateDeviceInfoList)lib_sym(d2xx, "FT_CreateDeviceInfoList");
  ft.GetDeviceInfoDetail = (pFT_GetDeviceInfoDetail)lib_sym(d2xx, "FT_GetDeviceInfoDetail");
  lib_t l = l4222;
#else
  static const char* names[] = {
    "libft4222.so", "libft4222.so.1.4.7", "libft4222.so.1.4.6", "libft4222.so.1.4.4.44",
    "/usr/local/lib/libft4222.so", "/usr/lib/libft4222.so",
    "libft4222.dylib", "/usr/local/lib/libft4222.dylib", "/opt/homebrew/lib/libft4222.dylib",
    NULL,
  };
  lib_t l = NULL;
  for (int i = 0; names[i] && !l; i++) l = lib_open(names[i]);
  if (!l) { fprintf(stderr, "yaesu-scope: libft4222 not found (install FTDI's LibFT4222; on Linux run ldconfig after)\n"); return 0; }
  ft.OpenEx = (pFT_OpenEx)lib_sym(l, "FT_OpenEx");
  ft.Close = (pFT_Close)lib_sym(l, "FT_Close");
  ft.SetTimeouts = (pFT_SetTimeouts)lib_sym(l, "FT_SetTimeouts");
  ft.SetLatencyTimer = (pFT_SetLatencyTimer)lib_sym(l, "FT_SetLatencyTimer");
  ft.CreateDeviceInfoList = (pFT_CreateDeviceInfoList)lib_sym(l, "FT_CreateDeviceInfoList");
  ft.GetDeviceInfoDetail = (pFT_GetDeviceInfoDetail)lib_sym(l, "FT_GetDeviceInfoDetail");
#endif
  ft.SetClock = (pFT4222_SetClock)lib_sym(l, "FT4222_SetClock");
  ft.SPIMaster_Init = (pFT4222_SPIMaster_Init)lib_sym(l, "FT4222_SPIMaster_Init");
  ft.SPIMaster_SingleRead = (pFT4222_SPIMaster_SingleRead)lib_sym(l, "FT4222_SPIMaster_SingleRead");
  ft.UnInitialize = (pFT4222_UnInitialize)lib_sym(l, "FT4222_UnInitialize");
  if (!ft.OpenEx || !ft.Close || !ft.SetTimeouts || !ft.SetLatencyTimer ||
      !ft.SetClock || !ft.SPIMaster_Init || !ft.SPIMaster_SingleRead || !ft.UnInitialize) {
    fprintf(stderr, "yaesu-scope: the FTDI libraries loaded but are missing entry points (wrong version?)\n");
    return 0;
  }
  return 1;
}

static int list_devices(void) {
  if (!ft.CreateDeviceInfoList || !ft.GetDeviceInfoDetail) {
    fprintf(stderr, "yaesu-scope: this FTDI library cannot enumerate devices\n");
    return EXIT_NO_LIBRARY;
  }
  unsigned int n = 0;
  if (ft.CreateDeviceInfoList(&n) != FT_OK) { fprintf(stderr, "yaesu-scope: FT_CreateDeviceInfoList failed\n"); return EXIT_NO_DEVICE; }
  fprintf(stderr, "yaesu-scope: %u FTDI device(s)\n", n);
  for (unsigned int i = 0; i < n; i++) {
    unsigned int flags = 0, type = 0, id = 0, loc = 0;
    char serial[16] = { 0 }, desc[64] = { 0 };
    FT_HANDLE h = NULL;
    if (ft.GetDeviceInfoDetail(i, &flags, &type, &id, &loc, serial, desc, &h) == FT_OK) {
      fprintf(stderr, "  [%u] \"%s\" serial=%s type=%u id=%08x flags=%u%s\n", i, desc, serial, type, id, flags,
              (flags & 1) ? " (OPEN by another program)" : "");
    }
  }
  return EXIT_STOPPED;
}

/* ─── The bridge ─────────────────────────────────────────────────────────── */
static FT_HANDLE g_dev = NULL;

static void close_bridge(void) {
  if (!g_dev) return;
  ft.UnInitialize(g_dev);
  ft.Close(g_dev);
  g_dev = NULL;
}

static int open_bridge(void) {
  close_bridge();
  FT_STATUS st = ft.OpenEx((void*)"FT4222 A", FT_OPEN_BY_DESCRIPTION, &g_dev);
  if (st != FT_OK) {
    fprintf(stderr, "yaesu-scope: could not open \"FT4222 A\" (FT_STATUS %u) — radio off, not on this USB port, driver missing, or another program has it\n", st);
    g_dev = NULL;
    return EXIT_NO_DEVICE;
  }
  if (ft.SetTimeouts(g_dev, 100, 100) != FT_OK) { fprintf(stderr, "yaesu-scope: FT_SetTimeouts failed\n"); goto spi_fail; }
  if (ft.SetLatencyTimer(g_dev, 2) != FT_OK)   { fprintf(stderr, "yaesu-scope: FT_SetLatencyTimer failed\n"); goto spi_fail; }
  if (ft.SPIMaster_Init(g_dev, SPI_IO_SINGLE, CLK_DIV_64, CLK_IDLE_HIGH, CLK_LEADING, 0x01) != 0) {
    fprintf(stderr, "yaesu-scope: FT4222_SPIMaster_Init failed — is wfview or 710 Console holding the bridge?\n");
    goto spi_fail;
  }
  if (ft.SetClock(g_dev, SYS_CLK_24) != 0) { fprintf(stderr, "yaesu-scope: FT4222_SetClock failed\n"); goto spi_fail; }
  fprintf(stderr, "yaesu-scope: opened \"FT4222 A\" — SPI single, 24 MHz/64, idle high, leading edge, SS1\n");
  return EXIT_STOPPED;
spi_fail:
  ft.Close(g_dev);
  g_dev = NULL;
  return EXIT_SPI_INIT;
}

static int frame_aligned(const unsigned char* buf) {
  return memcmp(buf + FRAME_BYTES - 4, SYNC, 4) == 0;
}

/* Read one byte at a time until sixteen bytes of the repeated sync pattern
 * have gone by, which puts the next 4096-byte read on a frame boundary.
 * Returns 1 when aligned; 0 when RESYNC_MAX_BYTES passed without it; -1 on a
 * read failure. `varied` reports whether the bytes were anything other than
 * a constant — the difference between "not aligned" and "nothing there". */
static int resync(int* varied) {
  unsigned char b, first = 0;
  unsigned short n = 0;
  int run = 0;         /* consecutive sync bytes matched */
  int seen = 0;
  *varied = 0;
  for (int k = 0; k < RESYNC_MAX_BYTES && !g_stop; k++) {
    if (ft.SPIMaster_SingleRead(g_dev, &b, 1, &n, 0) != 0 || n != 1) return -1;
    if (!seen) { first = b; seen = 1; }
    else if (b != first) *varied = 1;
    if (b == SYNC[run & 3]) {
      run++;
      if (run == 16) return 1;
    } else {
      run = (b == SYNC[0]) ? 1 : 0;
    }
  }
  return 0;
}

static void hexdump_prefix(const unsigned char* buf, int n) {
  fprintf(stderr, "yaesu-scope: first %d bytes seen:", n);
  for (int i = 0; i < n; i++) fprintf(stderr, " %02x", buf[i]);
  fprintf(stderr, "\n");
}

static int write_frame(const unsigned char* payload, unsigned char kind, uint32_t seq) {
  unsigned char h[HEADER_BYTES] = { 'Y', 'S', 1, kind,
    (unsigned char)(seq & 0xff), (unsigned char)((seq >> 8) & 0xff),
    (unsigned char)((seq >> 16) & 0xff), (unsigned char)((seq >> 24) & 0xff) };
  if (fwrite(h, 1, HEADER_BYTES, stdout) != HEADER_BYTES) return 0;
  if (fwrite(payload, 1, FRAME_BYTES, stdout) != FRAME_BYTES) return 0;
  fflush(stdout);
  return 1;
}

/* ─── Live loop ──────────────────────────────────────────────────────────── */
static int run_live(int fps, int once, int timeout_s) {
  int rc = open_bridge();
  if (rc != EXIT_STOPPED) return rc;

  unsigned char buf[FRAME_BYTES];
  unsigned short n = 0;
  uint32_t seq = 0;
  uint64_t started = now_ms();
  uint64_t last_write = 0;
  uint64_t min_gap = fps > 0 ? (1000u / (unsigned)fps) : 0;
  int read_errors = 0;
  int sync_failures = 0;
  int any_frame = 0;
  int reported_first = 0;

  while (!g_stop) {
    FT4222_STATUS st = ft.SPIMaster_SingleRead(g_dev, buf, FRAME_BYTES, &n, 0);
    if (st != 0 || n != FRAME_BYTES) {
      if (++read_errors >= 20) {
        fprintf(stderr, "yaesu-scope: %d consecutive read failures (status %d, got %u bytes)\n", read_errors, st, n);
        close_bridge();
        return EXIT_READ_ERROR;
      }
      sleep_ms(20);
      continue;
    }
    read_errors = 0;

    if (!frame_aligned(buf)) {
      if (!reported_first) { hexdump_prefix(buf, 32); reported_first = 1; }
      int varied = 0;
      int r = resync(&varied);
      if (r == 1) { sync_failures = 0; continue; }
      if (r < 0) { if (++read_errors >= 20) { close_bridge(); return EXIT_READ_ERROR; } continue; }
      sync_failures++;
      /* Not aligned after 8192 bytes. Before the first frame ever, decide
       * between "the radio is not sending" and "it is sending something we
       * do not understand" — they need opposite advice. */
      if (!any_frame && (now_ms() - started) > (uint64_t)timeout_s * 1000u) {
        close_bridge();
        if (!varied) {
          fprintf(stderr, "yaesu-scope: the bridge answers but every byte is the same — the radio is not streaming (SCU-LAN10 off?)\n");
          return EXIT_SILENT;
        }
        fprintf(stderr, "yaesu-scope: bytes vary but the sync pattern FF 01 EE 01 never appeared\n");
        return EXIT_NO_SYNC;
      }
      if (sync_failures >= 3) {
        /* Mid-stream loss of sync: reopen the bridge like wfview does. */
        sync_failures = 0;
        rc = open_bridge();
        if (rc != EXIT_STOPPED) return rc;
      }
      continue;
    }

    any_frame = 1;
    uint64_t t = now_ms();
    if (min_gap && last_write && (t - last_write) < min_gap) continue;  /* rate cap: drop, never queue */
    last_write = t;
    if (!write_frame(buf, 0, ++seq)) { close_bridge(); return EXIT_STOPPED; }  /* stdout gone: parent left */
    if (once) { close_bridge(); return EXIT_STOPPED; }
  }
  close_bridge();
  return EXIT_STOPPED;
}

/* ─── Synthetic frames (no radio) ────────────────────────────────────────── */
static unsigned rng_state = 0x2545F491u;
static unsigned rng(void) { rng_state ^= rng_state << 13; rng_state ^= rng_state >> 17; rng_state ^= rng_state << 5; return rng_state; }

static void synth_frame(unsigned char* buf, uint32_t seq) {
  /* Levels first (0..255, higher = stronger), then invert like the radio. */
  unsigned char lv[850];
  double drift = 200.0 + 300.0 * (0.5 + 0.5 * sin((double)seq / 90.0));   /* a carrier wandering across the band */
  for (int i = 0; i < 850; i++) {
    double v = 38.0 + (double)(rng() % 22);                                  /* noise floor */
    double d1 = (i - drift), d2 = (i - 610.0), d3 = (i - 120.0);
    v += 170.0 * exp(-(d1 * d1) / 8.0);                                      /* the wanderer */
    v += 110.0 * exp(-(d2 * d2) / 30.0) * (0.6 + 0.4 * sin((double)seq / 7.0)); /* an SSB-wide signal, breathing */
    v += ((seq / 45) % 3 == 0) ? 140.0 * exp(-(d3 * d3) / 3.0) : 0.0;        /* a CW station keying */
    if (v > 255.0) v = 255.0;
    lv[i] = (unsigned char)v;
  }
  memset(buf, 0xff, FRAME_BYTES);                          /* inverted zeros everywhere */
  for (int i = 0; i < 850; i++) buf[i] = (unsigned char)(~lv[i]);
  for (int i = 0; i < 150; i++) buf[2900 + i] = (unsigned char)i;           /* a recognisable metadata block */
  for (int i = 3050; i < FRAME_BYTES; i++) buf[i] = SYNC[i & 3];   /* phased so the frame ENDS on FF 01 EE 01 */
}

static int run_synth(int fps, int once) {
  unsigned char buf[FRAME_BYTES];
  uint32_t seq = 0;
  unsigned gap = fps > 0 ? (1000u / (unsigned)fps) : 33;
  fprintf(stderr, "yaesu-scope: --synth — generated frames, no radio (kind=1)\n");
  do {   /* the first frame is written before the stop flag is consulted: --once always yields one */
    synth_frame(buf, ++seq);
    if (!write_frame(buf, 1, seq)) return EXIT_STOPPED;
    if (once) return EXIT_STOPPED;
    sleep_ms(gap);
  } while (!g_stop);
  return EXIT_STOPPED;
}

/* ─── main ───────────────────────────────────────────────────────────────── */
int main(int argc, char** argv) {
  int fps = 20, once = 0, synth = 0, list = 0, timeout_s = 3;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--fps") && i + 1 < argc) { fps = atoi(argv[++i]); }
    else if (!strcmp(argv[i], "--once")) once = 1;
    else if (!strcmp(argv[i], "--synth")) synth = 1;
    else if (!strcmp(argv[i], "--list")) list = 1;
    else if (!strcmp(argv[i], "--timeout") && i + 1 < argc) { timeout_s = atoi(argv[++i]); }
    else if (!strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) {
      fprintf(stderr, "usage: yaesu-scope [--fps N] [--once] [--synth] [--list] [--timeout S]\n");
      return EXIT_STOPPED;
    }
  }
  if (fps < 1) fps = 1;
  if (fps > 60) fps = 60;
  if (timeout_s < 1) timeout_s = 1;

#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  signal(SIGINT, on_signal);
  signal(SIGTERM, on_signal);
  if (stdin_is_pipe()) start_stdin_watch();

  if (synth) return run_synth(fps, once);
  if (!load_ftdi()) return EXIT_NO_LIBRARY;
  if (list) return list_devices();
  return run_live(fps, once, timeout_s);
}
