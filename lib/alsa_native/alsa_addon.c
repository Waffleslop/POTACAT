/*
 * alsa_native — N-API addon wrapping libasound for POTACAT.
 *
 * Why this exists:
 *   POTACAT (Electron) uses Chromium's navigator.mediaDevices.enumerateDevices()
 *   for every audio dropdown. On Linux that only surfaces devices published by
 *   the active sound server (PulseAudio / PipeWire) — never raw ALSA
 *   `hw:X,Y` / `plughw:X,Y` addresses. SDR users (sBitx with snd-aloop,
 *   audioinjectorpi setups, etc.) need to pick specific loopback subdevices
 *   that aren't visible through the browser API. This addon gives POTACAT
 *   direct ALSA access — list every device the kernel knows about, then
 *   capture from any of them as Float32 mono frames.
 *
 * Exports:
 *   available        boolean — always true on Linux, false on stub builds
 *   platform         string  — "linux"
 *   listDevices()    → [{ id, label, kind, card, device, isPlughw }]
 *                       kind is "audioinput" or "audiooutput".
 *   openCapture(name, opts) → numeric handle
 *                       opts: { rate=48000, channels=1, periodFrames=1024,
 *                               bufferFrames=8192 }
 *                       name: ALSA pcm name, e.g. "hw:1,1" / "plughw:1,1" /
 *                       "default". The opener requests S16_LE interleaved
 *                       and the read path mixes to Float32 mono.
 *   readCapture(handle, frames) → Float32Array
 *                       Non-blocking-ish: returns up to `frames` Float32
 *                       mono samples currently available; may return a
 *                       shorter array (including length 0). Negative
 *                       length signals an unrecoverable error (handle is
 *                       auto-closed before returning).
 *   closeCapture(handle) → void
 *
 * Design notes:
 *   - Synchronous pull model. No threading, no threadsafe-function dance.
 *     Renderer (or main process) drives reads on a setInterval at the
 *     cadence that suits its consumer (FT8 wants 100ms-ish chunks at
 *     12 kHz; ECHOCAT wants ~20ms at 48 kHz). PERIOD_FRAMES sized so the
 *     ALSA driver has headroom even when JS scheduling slips by a tick.
 *   - Read path mixes any-N-channel S16_LE to Float32 mono [-1, 1].
 *     We standardize on mono because every POTACAT consumer (FT8, SSTV,
 *     ECHOCAT mic, FreeDV) wants mono — and on Pi-class boxes the
 *     downmix is essentially free compared to round-tripping multi-channel
 *     audio through IPC.
 *   - snd_pcm_recover() handles XRUN transparently; only fatal errors
 *     bubble up as a -1 length return.
 *
 * What this is NOT yet:
 *   - Playback. The same pattern (writeCapture / openPlayback) is the
 *     obvious next step but FT8 RX, SSTV RX, and ECHOCAT mic — the actual
 *     pain points sBitx users hit — are all input-side, so we ship the
 *     read half first.
 */

#include <node_api.h>
#include <alsa/asoundlib.h>
#include <alloca.h>  /* explicit — some glibc builds only declare alloca here */
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_HANDLES 16
#define DEFAULT_RATE 48000
#define DEFAULT_CHANNELS 1
#define DEFAULT_PERIOD_FRAMES 1024
#define DEFAULT_BUFFER_FRAMES 8192
#define MAX_INTERLEAVED_CHANNELS 8

/* --- Open-capture handle table ----------------------------------------- */
typedef struct {
  snd_pcm_t *pcm;
  unsigned int rate;
  unsigned int channels;
  /* Scratch buffer for one period of interleaved S16 reads, reused
   * across calls to avoid per-read alloc churn on tight loops. */
  int16_t *scratch;
  snd_pcm_uframes_t scratch_frames;
  int in_use;
} capture_handle_t;

static capture_handle_t g_handles[MAX_HANDLES];
static pthread_mutex_t g_handles_lock = PTHREAD_MUTEX_INITIALIZER;

static int alloc_handle(void) {
  pthread_mutex_lock(&g_handles_lock);
  for (int i = 0; i < MAX_HANDLES; i++) {
    if (!g_handles[i].in_use) {
      memset(&g_handles[i], 0, sizeof(g_handles[i]));
      g_handles[i].in_use = 1;
      pthread_mutex_unlock(&g_handles_lock);
      return i;
    }
  }
  pthread_mutex_unlock(&g_handles_lock);
  return -1;
}

static capture_handle_t *get_handle(int idx) {
  if (idx < 0 || idx >= MAX_HANDLES) return NULL;
  if (!g_handles[idx].in_use) return NULL;
  return &g_handles[idx];
}

static void free_handle(int idx) {
  pthread_mutex_lock(&g_handles_lock);
  if (idx >= 0 && idx < MAX_HANDLES && g_handles[idx].in_use) {
    if (g_handles[idx].pcm)     snd_pcm_close(g_handles[idx].pcm);
    if (g_handles[idx].scratch) free(g_handles[idx].scratch);
    memset(&g_handles[idx], 0, sizeof(g_handles[idx]));
  }
  pthread_mutex_unlock(&g_handles_lock);
}

/* --- Helpers ----------------------------------------------------------- */

/* napi shorthand to bail with a JS Error containing `msg`. Returns
 * undefined so call-sites can `return throw_error(env, ...);`. */
static napi_value throw_error(napi_env env, const char *msg) {
  napi_throw_error(env, NULL, msg);
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/* Read an optional integer property off a JS options object. Returns
 * `dflt` if missing or wrong type — opts are best-effort hints, not
 * validated contracts. */
static int get_int_prop(napi_env env, napi_value obj, const char *key, int dflt) {
  bool has = false;
  if (napi_has_named_property(env, obj, key, &has) != napi_ok || !has) return dflt;
  napi_value val;
  if (napi_get_named_property(env, obj, key, &val) != napi_ok) return dflt;
  napi_valuetype t;
  if (napi_typeof(env, val, &t) != napi_ok || t != napi_number) return dflt;
  int32_t out = dflt;
  if (napi_get_value_int32(env, val, &out) != napi_ok) return dflt;
  return out;
}

/* --- listDevices() ----------------------------------------------------- */
/*
 * Enumerates every ALSA PCM exposed by the kernel — every card, every
 * subdevice, both directions, plus the "plughw" plug-layer aliases that
 * auto-convert sample rate / format / channels. The plughw flavor is
 * usually what users actually want (works at any rate); pure hw entries
 * are kept for the rare case where a specific FS-rate matters.
 *
 * We emit one object per audio "stream" we discover:
 *   { id: "hw:1,1",  label: "Loopback PCM #1,1 (capture)",
 *     kind: "audioinput", card: 1, device: 1, isPlughw: false }
 * Caller merges these into the JS dropdown alongside Chromium's list.
 */
static napi_value ListDevices(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_array(env, &result);
  uint32_t out_idx = 0;

  void **hints = NULL;
  if (snd_device_name_hint(-1, "pcm", &hints) < 0 || !hints) {
    /* snd_device_name_hint failure means no devices visible — return
     * an empty array rather than throwing. Callers may legitimately
     * be running headless without /dev/snd present at all. */
    return result;
  }

  for (void **h = hints; *h != NULL; h++) {
    char *name = snd_device_name_get_hint(*h, "NAME");
    char *desc = snd_device_name_get_hint(*h, "DESC");
    char *ioid = snd_device_name_get_hint(*h, "IOID"); /* NULL/Input/Output */
    if (!name) {
      if (desc) free(desc);
      if (ioid) free(ioid);
      continue;
    }

    /* The hint table contains a ton of cruft we don't want surfaced to
     * the user: "null", "sysdefault:CARD=...", "front:CARD=...", "iec958",
     * "hdmi", "modem", "phoneline" etc. Keep only the entries the user
     * is likely to actually pick. "hw:" and "plughw:" are the ones SDR
     * docs (sBitx, etc.) name explicitly; "default" stays as a safety
     * net for users with a simple single-card setup. */
    int keep = 0;
    if (strncmp(name, "hw:",     3) == 0) keep = 1;
    if (strncmp(name, "plughw:", 7) == 0) keep = 1;
    if (strcmp (name, "default")     == 0) keep = 1;

    if (!keep) {
      free(name);
      if (desc) free(desc);
      if (ioid) free(ioid);
      continue;
    }

    /* IOID == NULL means duplex (both input + output). Emit one entry
     * per supported direction so renderer dropdowns can filter cleanly
     * by `kind`. */
    int emit_input  = (!ioid || strcmp(ioid, "Input")  == 0);
    int emit_output = (!ioid || strcmp(ioid, "Output") == 0);

    /* Pull card/device numbers out of names like "hw:1,1" so the JS
     * side can sort / dedupe / display them grouped by card. The plug
     * variant carries the same numbers, just routed through the plug
     * conversion layer. */
    int card_no = -1, dev_no = -1;
    const char *p = strchr(name, ':');
    if (p) sscanf(p + 1, "%d,%d", &card_no, &dev_no);
    int is_plughw = (strncmp(name, "plughw:", 7) == 0);

    for (int dir = 0; dir < 2; dir++) {
      if (dir == 0 && !emit_input)  continue;
      if (dir == 1 && !emit_output) continue;
      const char *kind = (dir == 0) ? "audioinput" : "audiooutput";

      napi_value entry;
      napi_create_object(env, &entry);

      napi_value v;
      napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &v);
      napi_set_named_property(env, entry, "id", v);

      /* Label — first line of DESC if present, else just the name.
       * Many DESCs have a multi-line "card / subdevice" format; the
       * first line carries the human-readable card name. We append
       * the address + direction so users can disambiguate identical-
       * named subdevices (e.g. "Loopback PCM" repeated 16 times). */
      char label[512];
      const char *card_label = desc ? desc : name;
      char first_line[256] = {0};
      const char *nl = card_label ? strchr(card_label, '\n') : NULL;
      if (nl) {
        size_t n = (size_t)(nl - card_label);
        if (n >= sizeof(first_line)) n = sizeof(first_line) - 1;
        memcpy(first_line, card_label, n);
        first_line[n] = '\0';
      } else if (card_label) {
        strncpy(first_line, card_label, sizeof(first_line) - 1);
      }
      snprintf(label, sizeof(label), "%s [%s] (%s)",
               first_line[0] ? first_line : name,
               name,
               (dir == 0) ? "in" : "out");
      napi_create_string_utf8(env, label, NAPI_AUTO_LENGTH, &v);
      napi_set_named_property(env, entry, "label", v);

      napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &v);
      napi_set_named_property(env, entry, "kind", v);

      napi_create_int32(env, card_no, &v);
      napi_set_named_property(env, entry, "card", v);
      napi_create_int32(env, dev_no, &v);
      napi_set_named_property(env, entry, "device", v);
      napi_get_boolean(env, is_plughw, &v);
      napi_set_named_property(env, entry, "isPlughw", v);

      napi_set_element(env, result, out_idx++, entry);
    }

    free(name);
    if (desc) free(desc);
    if (ioid) free(ioid);
  }
  snd_device_name_free_hint(hints);
  return result;
}

/* --- openCapture(name, opts) → handle ---------------------------------- */
static napi_value OpenCapture(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throw_error(env, "openCapture(name[, opts]) — name required");

  /* Name: any libasound PCM string. Treat plenty-long path strings as
   * the upper bound; ALSA names are usually < 32 chars. */
  char name[256];
  size_t name_len = 0;
  if (napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &name_len) != napi_ok || name_len == 0) {
    return throw_error(env, "openCapture: name must be a non-empty string");
  }

  unsigned int rate     = DEFAULT_RATE;
  unsigned int channels = DEFAULT_CHANNELS;
  snd_pcm_uframes_t period_frames = DEFAULT_PERIOD_FRAMES;
  snd_pcm_uframes_t buffer_frames = DEFAULT_BUFFER_FRAMES;

  if (argc >= 2) {
    napi_valuetype t;
    napi_typeof(env, argv[1], &t);
    if (t == napi_object) {
      int v;
      v = get_int_prop(env, argv[1], "rate",         (int)rate);
      if (v > 0)  rate = (unsigned int)v;
      v = get_int_prop(env, argv[1], "channels",     (int)channels);
      if (v >= 1 && v <= MAX_INTERLEAVED_CHANNELS) channels = (unsigned int)v;
      v = get_int_prop(env, argv[1], "periodFrames", (int)period_frames);
      if (v > 0)  period_frames = (snd_pcm_uframes_t)v;
      v = get_int_prop(env, argv[1], "bufferFrames", (int)buffer_frames);
      if (v > 0)  buffer_frames = (snd_pcm_uframes_t)v;
    }
  }

  int idx = alloc_handle();
  if (idx < 0) return throw_error(env, "openCapture: out of handle slots (16 max)");

  snd_pcm_t *pcm = NULL;
  int err = snd_pcm_open(&pcm, name, SND_PCM_STREAM_CAPTURE, 0);
  if (err < 0) {
    free_handle(idx);
    char msg[384];
    snprintf(msg, sizeof(msg), "snd_pcm_open(%s) failed: %s", name, snd_strerror(err));
    return throw_error(env, msg);
  }

  /* Hardware params — interleaved S16_LE, target rate, target channel
   * count. snd_pcm_hw_params_set_rate_near and ..._set_channels_near
   * negotiate down if the device can't exactly satisfy us; that's
   * what `plughw:` is for in the user-facing setup, but the bare hw:
   * path still benefits from the near-match fallback.
   *
   * Heap-allocate hw via snd_pcm_hw_params_malloc rather than the
   * stack-allocating snd_pcm_hw_params_alloca macro: the macro
   * expands to alloca(), and HA3HZ on a Raspberry Pi hit "undefined
   * symbol: alloca" at .node dlopen time — some libc builds don't
   * export alloca as a real symbol. Heap alloc removes that fragile
   * dependency entirely. Paired with snd_pcm_hw_params_free below
   * on every exit path. K3SBP 2026-05-16. */
  snd_pcm_hw_params_t *hw = NULL;
  if ((err = snd_pcm_hw_params_malloc(&hw)) < 0) {
    snd_pcm_close(pcm); free_handle(idx);
    char msg[384];
    snprintf(msg, sizeof(msg), "snd_pcm_hw_params_malloc failed: %s", snd_strerror(err));
    return throw_error(env, msg);
  }
  snd_pcm_hw_params_any(pcm, hw);

  if ((err = snd_pcm_hw_params_set_access(pcm, hw, SND_PCM_ACCESS_RW_INTERLEAVED)) < 0 ||
      (err = snd_pcm_hw_params_set_format(pcm, hw, SND_PCM_FORMAT_S16_LE)) < 0) {
    snd_pcm_hw_params_free(hw); snd_pcm_close(pcm); free_handle(idx);
    char msg[384];
    snprintf(msg, sizeof(msg), "snd_pcm hw_params (access/format) failed for %s: %s — try plughw:X,Y instead of hw:X,Y", name, snd_strerror(err));
    return throw_error(env, msg);
  }
  unsigned int actual_rate = rate;
  if ((err = snd_pcm_hw_params_set_rate_near(pcm, hw, &actual_rate, 0)) < 0) {
    snd_pcm_hw_params_free(hw); snd_pcm_close(pcm); free_handle(idx);
    char msg[384];
    snprintf(msg, sizeof(msg), "snd_pcm_hw_params_set_rate_near(%u) failed: %s", rate, snd_strerror(err));
    return throw_error(env, msg);
  }
  unsigned int actual_channels = channels;
  if ((err = snd_pcm_hw_params_set_channels_near(pcm, hw, &actual_channels)) < 0) {
    snd_pcm_hw_params_free(hw); snd_pcm_close(pcm); free_handle(idx);
    char msg[384];
    snprintf(msg, sizeof(msg), "snd_pcm_hw_params_set_channels_near(%u) failed: %s", channels, snd_strerror(err));
    return throw_error(env, msg);
  }
  if (actual_channels > MAX_INTERLEAVED_CHANNELS) {
    snd_pcm_hw_params_free(hw); snd_pcm_close(pcm); free_handle(idx);
    return throw_error(env, "openCapture: device requires more channels than addon supports (8 max)");
  }
  snd_pcm_uframes_t actual_period = period_frames;
  snd_pcm_hw_params_set_period_size_near(pcm, hw, &actual_period, 0);
  snd_pcm_uframes_t actual_buffer = buffer_frames;
  snd_pcm_hw_params_set_buffer_size_near(pcm, hw, &actual_buffer);

  if ((err = snd_pcm_hw_params(pcm, hw)) < 0) {
    snd_pcm_hw_params_free(hw); snd_pcm_close(pcm); free_handle(idx);
    char msg[384];
    snprintf(msg, sizeof(msg), "snd_pcm_hw_params commit failed for %s: %s", name, snd_strerror(err));
    return throw_error(env, msg);
  }
  /* hw_params is committed — the params object is no longer needed.
   * Free here so subsequent exit paths don't have to remember to. */
  snd_pcm_hw_params_free(hw);
  hw = NULL;

  if ((err = snd_pcm_prepare(pcm)) < 0) {
    snd_pcm_close(pcm); free_handle(idx);
    char msg[384];
    snprintf(msg, sizeof(msg), "snd_pcm_prepare failed for %s: %s", name, snd_strerror(err));
    return throw_error(env, msg);
  }

  capture_handle_t *h = get_handle(idx);
  h->pcm = pcm;
  h->rate = actual_rate;
  h->channels = actual_channels;
  /* Scratch sized to one period × channels; grown on demand if a later
   * read asks for more frames than fit. */
  h->scratch_frames = actual_period;
  h->scratch = (int16_t *)calloc(actual_period * actual_channels, sizeof(int16_t));
  if (!h->scratch) {
    snd_pcm_close(pcm); free_handle(idx);
    return throw_error(env, "openCapture: scratch buffer alloc failed");
  }

  /* Return { handle, rate, channels } so the JS side can tell the
   * caller what it actually got vs what it asked for. */
  napi_value result;
  napi_create_object(env, &result);
  napi_value v;
  napi_create_int32(env, idx, &v);            napi_set_named_property(env, result, "handle",   v);
  napi_create_int32(env, (int)actual_rate, &v);     napi_set_named_property(env, result, "rate",     v);
  napi_create_int32(env, (int)actual_channels, &v); napi_set_named_property(env, result, "channels", v);
  return result;
}

/* --- readCapture(handle, frames) → Float32Array ------------------------ */
static napi_value ReadCapture(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) return throw_error(env, "readCapture(handle, frames)");

  int32_t handle_idx = -1;
  napi_get_value_int32(env, argv[0], &handle_idx);
  capture_handle_t *h = get_handle(handle_idx);
  if (!h) return throw_error(env, "readCapture: invalid handle");

  int32_t want_frames = 0;
  napi_get_value_int32(env, argv[1], &want_frames);
  if (want_frames <= 0) {
    /* Empty Float32Array — same shape as a zero-frame read. Lets the
     * caller's hot loop keep a single code path. */
    napi_value buf, arr;
    napi_create_arraybuffer(env, 0, NULL, &buf);
    napi_create_typedarray(env, napi_float32_array, 0, buf, 0, &arr);
    return arr;
  }

  /* Grow scratch if the consumer asked for more than one period at once.
   * Stays around for subsequent reads — saves the realloc churn on
   * steady-state pulls (FT8 grabs 1200 frames per call at 12 kHz). */
  if ((snd_pcm_uframes_t)want_frames > h->scratch_frames) {
    int16_t *next = (int16_t *)realloc(h->scratch, want_frames * h->channels * sizeof(int16_t));
    if (!next) return throw_error(env, "readCapture: scratch realloc failed");
    h->scratch = next;
    h->scratch_frames = want_frames;
  }

  /* Single-shot read. Don't loop here — the consumer's setInterval
   * will drive the cadence. Looping inside a synchronous N-API call
   * would block the libuv thread. */
  snd_pcm_sframes_t got = snd_pcm_readi(h->pcm, h->scratch, want_frames);
  if (got == -EAGAIN) {
    /* Non-blocking would-block — treat as zero-frame read. */
    napi_value buf, arr;
    napi_create_arraybuffer(env, 0, NULL, &buf);
    napi_create_typedarray(env, napi_float32_array, 0, buf, 0, &arr);
    return arr;
  }
  if (got < 0) {
    /* Try snd_pcm_recover for XRUN / suspended states — drops samples
     * but keeps the stream alive. -EPIPE in particular is xrun ("buffer
     * overrun in capture path") and is recoverable; the consumer just
     * misses a chunk. */
    int rec = snd_pcm_recover(h->pcm, (int)got, 1);
    if (rec < 0) {
      /* Fatal — auto-close the handle so the JS side doesn't have to
       * special-case the cleanup path on errors. Returned -1-length
       * sentinel array signals "stream's gone". */
      free_handle(handle_idx);
      napi_value buf, arr;
      napi_create_arraybuffer(env, 0, NULL, &buf);
      napi_create_typedarray(env, napi_float32_array, 0, buf, 0, &arr);
      /* Attach a `closed: true` marker on a property so JS can tell
       * a transient zero-read from a fatal close. */
      napi_value t;
      napi_get_boolean(env, true, &t);
      napi_set_named_property(env, arr, "closed", t);
      return arr;
    }
    /* Recovered — return zero frames this tick; next tick will read fresh. */
    napi_value buf, arr;
    napi_create_arraybuffer(env, 0, NULL, &buf);
    napi_create_typedarray(env, napi_float32_array, 0, buf, 0, &arr);
    return arr;
  }

  /* Down-mix to Float32 mono. Average across channels when stereo+ —
   * cheap and good enough for FT8/SSTV/ECHOCAT, all of which discard
   * stereo information anyway. */
  size_t out_frames = (size_t)got;
  float *out = NULL;
  napi_value out_buf, out_arr;
  napi_create_arraybuffer(env, out_frames * sizeof(float), (void **)&out, &out_buf);
  napi_create_typedarray(env, napi_float32_array, out_frames, out_buf, 0, &out_arr);

  const unsigned int ch = h->channels;
  if (ch == 1) {
    /* Fast path: direct S16 → Float32, no per-frame averaging. */
    for (size_t i = 0; i < out_frames; i++) {
      out[i] = (float)h->scratch[i] / 32768.0f;
    }
  } else {
    for (size_t i = 0; i < out_frames; i++) {
      int32_t acc = 0;
      for (unsigned int c = 0; c < ch; c++) {
        acc += h->scratch[i * ch + c];
      }
      out[i] = (float)acc / (32768.0f * (float)ch);
    }
  }

  return out_arr;
}

/* --- closeCapture(handle) ---------------------------------------------- */
static napi_value CloseCapture(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) return throw_error(env, "closeCapture(handle)");
  int32_t idx = -1;
  napi_get_value_int32(env, argv[0], &idx);
  free_handle(idx);
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/* --- Module init ------------------------------------------------------- */
#define EXPORT_FN(name, fn) do { \
  napi_value _f; \
  napi_create_function(env, NULL, 0, fn, NULL, &_f); \
  napi_set_named_property(env, exports, name, _f); \
} while (0)

static napi_value Init(napi_env env, napi_value exports) {
  napi_value v;

  napi_get_boolean(env, true, &v);
  napi_set_named_property(env, exports, "available", v);
  napi_create_string_utf8(env, "linux", NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, exports, "platform", v);
  napi_create_string_utf8(env, snd_asoundlib_version(), NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, exports, "alsaVersion", v);

  EXPORT_FN("listDevices",  ListDevices);
  EXPORT_FN("openCapture",  OpenCapture);
  EXPORT_FN("readCapture",  ReadCapture);
  EXPORT_FN("closeCapture", CloseCapture);

  return exports;
}

NAPI_MODULE(alsa_native, Init)
