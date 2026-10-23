/*
 * ALSA stand-in for building ardopcf's Linux platform sources on macOS.
 *
 * ardopcf has no macOS port only because src/linux/ALSASound.c is written
 * against ALSA. POTACAT runs ardopcf with the socket audio backend
 * (third_party/ardopcf/src/SocketAudio.c, device "tcp:<port>"), which takes
 * over BEFORE any snd_* call is reached — so on macOS the ALSA functions only
 * have to exist, never work. Every function here fails cleanly (-ENOSYS, or
 * "no cards") so a device name that is not "tcp:…" prints an error instead
 * of crashing. Types are opaque. Signatures follow alsa-lib 1.2 so the
 * existing calls compile without warnings.
 *
 * Used by scripts/build-winlink-helpers.sh (HOST=mac): -I helpers/alsa-stub,
 * no -lasound. Never installed, never shipped: build-time only.
 */
#ifndef POTACAT_ALSA_STUB_H
#define POTACAT_ALSA_STUB_H

/* The real asoundlib.h pulls these in, and ALSASound.c relies on it (usleep,
 * open/O_WRONLY/close came from here on Linux — the first Mac build failed
 * on exactly those). Same list as alsa-lib 1.2's header. */
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <assert.h>
#include <poll.h>
#include <errno.h>
#include <stddef.h>
#include <sys/types.h>
#include <alloca.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct _snd_pcm snd_pcm_t;
typedef struct _snd_pcm_hw_params snd_pcm_hw_params_t;
typedef struct _snd_pcm_status snd_pcm_status_t;
typedef struct _snd_pcm_info snd_pcm_info_t;
typedef struct _snd_pcm_format_mask snd_pcm_format_mask_t;
typedef struct _snd_ctl snd_ctl_t;
typedef struct _snd_ctl_card_info snd_ctl_card_info_t;
typedef unsigned long snd_pcm_uframes_t;
typedef long snd_pcm_sframes_t;

typedef enum _snd_pcm_stream { SND_PCM_STREAM_PLAYBACK = 0, SND_PCM_STREAM_CAPTURE = 1 } snd_pcm_stream_t;
typedef enum _snd_pcm_access { SND_PCM_ACCESS_RW_INTERLEAVED = 3 } snd_pcm_access_t;
typedef enum _snd_pcm_format { SND_PCM_FORMAT_S16_LE = 2 } snd_pcm_format_t;
typedef enum _snd_pcm_state { SND_PCM_STATE_OPEN = 0, SND_PCM_STATE_PREPARED = 2, SND_PCM_STATE_RUNNING = 3 } snd_pcm_state_t;

#define SND_PCM_NONBLOCK 0x00000001

/* alloca-style allocators: the macro form alsa-lib uses. */
#define snd_pcm_hw_params_alloca(ptr)   do { *(ptr) = (snd_pcm_hw_params_t *) alloca(64); memset(*(ptr), 0, 64); } while (0)
#define snd_pcm_status_alloca(ptr)      do { *(ptr) = (snd_pcm_status_t *) alloca(64); memset(*(ptr), 0, 64); } while (0)
#define snd_pcm_info_alloca(ptr)        do { *(ptr) = (snd_pcm_info_t *) alloca(64); memset(*(ptr), 0, 64); } while (0)
#define snd_pcm_format_mask_alloca(ptr) do { *(ptr) = (snd_pcm_format_mask_t *) alloca(64); memset(*(ptr), 0, 64); } while (0)
#define snd_ctl_card_info_alloca(ptr)   do { *(ptr) = (snd_ctl_card_info_t *) alloca(64); memset(*(ptr), 0, 64); } while (0)

static inline const char *snd_strerror(int errnum) { (void) errnum; return "ALSA is not available on macOS (POTACAT uses the socket audio device)"; }

/* Cards and devices: there are none. */
static inline int snd_card_next(int *card) { if (card) *card = -1; return 0; }
static inline int snd_ctl_open(snd_ctl_t **ctl, const char *name, int mode) { (void) name; (void) mode; if (ctl) *ctl = NULL; return -ENOSYS; }
static inline int snd_ctl_close(snd_ctl_t *ctl) { (void) ctl; return 0; }
static inline int snd_ctl_card_info(snd_ctl_t *ctl, snd_ctl_card_info_t *info) { (void) ctl; (void) info; return -ENOSYS; }
static inline const char *snd_ctl_card_info_get_id(const snd_ctl_card_info_t *info) { (void) info; return ""; }
static inline const char *snd_ctl_card_info_get_name(const snd_ctl_card_info_t *info) { (void) info; return ""; }
static inline int snd_ctl_pcm_next_device(snd_ctl_t *ctl, int *device) { (void) ctl; if (device) *device = -1; return 0; }
static inline int snd_ctl_pcm_info(snd_ctl_t *ctl, snd_pcm_info_t *info) { (void) ctl; (void) info; return -ENOSYS; }
static inline void snd_pcm_info_set_device(snd_pcm_info_t *obj, unsigned int val) { (void) obj; (void) val; }
static inline void snd_pcm_info_set_subdevice(snd_pcm_info_t *obj, unsigned int val) { (void) obj; (void) val; }
static inline void snd_pcm_info_set_stream(snd_pcm_info_t *obj, snd_pcm_stream_t val) { (void) obj; (void) val; }
static inline const char *snd_pcm_info_get_id(const snd_pcm_info_t *obj) { (void) obj; return ""; }
static inline const char *snd_pcm_info_get_name(const snd_pcm_info_t *obj) { (void) obj; return ""; }
static inline unsigned int snd_pcm_info_get_subdevices_count(const snd_pcm_info_t *obj) { (void) obj; return 0; }
static inline unsigned int snd_pcm_info_get_subdevices_avail(const snd_pcm_info_t *obj) { (void) obj; return 0; }

/* PCM: opening always fails; everything else is a no-op on a NULL handle. */
static inline int snd_pcm_open(snd_pcm_t **pcm, const char *name, snd_pcm_stream_t stream, int mode) { (void) name; (void) stream; (void) mode; if (pcm) *pcm = NULL; return -ENOSYS; }
static inline int snd_pcm_close(snd_pcm_t *pcm) { (void) pcm; return 0; }
static inline int snd_pcm_prepare(snd_pcm_t *pcm) { (void) pcm; return -ENOSYS; }
static inline int snd_pcm_start(snd_pcm_t *pcm) { (void) pcm; return -ENOSYS; }
static inline int snd_pcm_recover(snd_pcm_t *pcm, int err, int silent) { (void) pcm; (void) silent; return err; }
static inline snd_pcm_sframes_t snd_pcm_avail_update(snd_pcm_t *pcm) { (void) pcm; return -ENOSYS; }
static inline snd_pcm_sframes_t snd_pcm_writei(snd_pcm_t *pcm, const void *buffer, snd_pcm_uframes_t size) { (void) pcm; (void) buffer; (void) size; return -ENOSYS; }
static inline snd_pcm_sframes_t snd_pcm_readi(snd_pcm_t *pcm, void *buffer, snd_pcm_uframes_t size) { (void) pcm; (void) buffer; (void) size; return -ENOSYS; }
static inline int snd_pcm_status(snd_pcm_t *pcm, snd_pcm_status_t *status) { (void) pcm; (void) status; return -ENOSYS; }
static inline snd_pcm_state_t snd_pcm_status_get_state(const snd_pcm_status_t *obj) { (void) obj; return SND_PCM_STATE_OPEN; }

/* Hardware parameters: nothing is settable, nothing is known. */
static inline int snd_pcm_hw_params_malloc(snd_pcm_hw_params_t **ptr) { if (ptr) *ptr = (snd_pcm_hw_params_t *) calloc(1, 64); return ptr && *ptr ? 0 : -ENOMEM; }
static inline void snd_pcm_hw_params_free(snd_pcm_hw_params_t *obj) { free(obj); }
static inline int snd_pcm_hw_params_any(snd_pcm_t *pcm, snd_pcm_hw_params_t *params) { (void) pcm; (void) params; return -ENOSYS; }
static inline int snd_pcm_hw_params(snd_pcm_t *pcm, snd_pcm_hw_params_t *params) { (void) pcm; (void) params; return -ENOSYS; }
static inline int snd_pcm_hw_params_set_access(snd_pcm_t *pcm, snd_pcm_hw_params_t *params, snd_pcm_access_t access) { (void) pcm; (void) params; (void) access; return -ENOSYS; }
static inline int snd_pcm_hw_params_set_format(snd_pcm_t *pcm, snd_pcm_hw_params_t *params, snd_pcm_format_t val) { (void) pcm; (void) params; (void) val; return -ENOSYS; }
static inline int snd_pcm_hw_params_set_channels(snd_pcm_t *pcm, snd_pcm_hw_params_t *params, unsigned int val) { (void) pcm; (void) params; (void) val; return -ENOSYS; }
static inline int snd_pcm_hw_params_set_rate(snd_pcm_t *pcm, snd_pcm_hw_params_t *params, unsigned int val, int dir) { (void) pcm; (void) params; (void) val; (void) dir; return -ENOSYS; }
static inline int snd_pcm_hw_params_set_period_size(snd_pcm_t *pcm, snd_pcm_hw_params_t *params, snd_pcm_uframes_t val, int dir) { (void) pcm; (void) params; (void) val; (void) dir; return -ENOSYS; }
static inline int snd_pcm_hw_params_set_period_size_near(snd_pcm_t *pcm, snd_pcm_hw_params_t *params, snd_pcm_uframes_t *val, int *dir) { (void) pcm; (void) params; (void) val; (void) dir; return -ENOSYS; }
static inline int snd_pcm_hw_params_get_rate(const snd_pcm_hw_params_t *params, unsigned int *val, int *dir) { (void) params; if (val) *val = 0; if (dir) *dir = 0; return -ENOSYS; }
static inline int snd_pcm_hw_params_get_rate_min(const snd_pcm_hw_params_t *params, unsigned int *val, int *dir) { (void) params; if (val) *val = 0; if (dir) *dir = 0; return -ENOSYS; }
static inline int snd_pcm_hw_params_get_rate_max(const snd_pcm_hw_params_t *params, unsigned int *val, int *dir) { (void) params; if (val) *val = 0; if (dir) *dir = 0; return -ENOSYS; }
static inline int snd_pcm_hw_params_get_channels_min(const snd_pcm_hw_params_t *params, unsigned int *val) { (void) params; if (val) *val = 0; return -ENOSYS; }
static inline int snd_pcm_hw_params_get_channels_max(const snd_pcm_hw_params_t *params, unsigned int *val) { (void) params; if (val) *val = 0; return -ENOSYS; }
static inline int snd_pcm_hw_params_get_period_size(const snd_pcm_hw_params_t *params, snd_pcm_uframes_t *val, int *dir) { (void) params; if (val) *val = 0; if (dir) *dir = 0; return -ENOSYS; }
static inline int snd_pcm_hw_params_get_period_time(const snd_pcm_hw_params_t *params, unsigned int *val, int *dir) { (void) params; if (val) *val = 0; if (dir) *dir = 0; return -ENOSYS; }

#ifdef __cplusplus
}
#endif
#endif /* POTACAT_ALSA_STUB_H */
