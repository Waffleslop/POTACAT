/*
 * Stand-ins for FTDI's libftd2xx and libft4222, for the loader test only
 * (scripts/test-ft4222-loader.sh, GitHub #360). They carry the entry points
 * yaesu-scope resolves and nothing else: no device is ever found. Built as:
 *   -DSTUB_D2XX   libftd2xx.dylib (macOS: install name "libftd2xx.dylib", as FTDI's)
 *   -DSTUB_4222   libft4222.<version>.dylib, linked to libftd2xx by bare name, as FTDI's
 *   both          libft4222.so.<version> (Linux: one file, as FTDI's)
 * Apache-2.0, part of POTACAT. Written from the helper's own declarations.
 */
#ifdef STUB_D2XX
unsigned int FT_OpenEx(void* arg, unsigned int flags, void** h) { (void)arg; (void)flags; *h = 0; return 2; /* FT_DEVICE_NOT_FOUND */ }
unsigned int FT_Close(void* h) { (void)h; return 0; }
unsigned int FT_SetTimeouts(void* h, unsigned int rd, unsigned int wr) { (void)h; (void)rd; (void)wr; return 0; }
unsigned int FT_SetLatencyTimer(void* h, unsigned char ms) { (void)h; (void)ms; return 0; }
unsigned int FT_CreateDeviceInfoList(unsigned int* n) { *n = 0; return 0; }
unsigned int FT_GetDeviceInfoDetail(unsigned int i, unsigned int* f, unsigned int* t, unsigned int* id, unsigned int* loc,
                                    char* serial, char* desc, void** h) {
  (void)i; (void)f; (void)t; (void)id; (void)loc; (void)serial; (void)desc; (void)h; return 1;
}
#endif

#ifdef STUB_4222
unsigned int FT_Close(void* h);   /* from libftd2xx: makes the dependency real */
int FT4222_SetClock(void* h, int clk) { (void)h; (void)clk; return 0; }
int FT4222_SPIMaster_Init(void* h, int io, int clk, int cpol, int cpha, unsigned char sso) {
  (void)h; (void)io; (void)clk; (void)cpol; (void)cpha; (void)sso; return 0;
}
int FT4222_SPIMaster_SingleRead(void* h, unsigned char* b, unsigned short n, unsigned short* got, int end) {
  (void)h; (void)b; (void)n; (void)end; *got = 0; return 1;
}
int FT4222_UnInitialize(void* h) { return (int)FT_Close(h); }
#endif
