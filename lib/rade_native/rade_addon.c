/**
 * RADE V1 N-API addon — wraps radae_nopy + Opus FARGAN for FreeDV RADE.
 *
 * Full pipeline:
 *   TX: PCM 16kHz Int16 → LPCNet features → rade_tx() → OFDM complex → real 8kHz Int16
 *   RX: real 8kHz Int16 → complex → rade_rx() → features → FARGAN → PCM 16kHz Int16
 *
 * Exports:
 *   open()               → handle
 *   close(handle)
 *   tx(handle, Int16Array speech_in)  → Int16Array modem_out (8kHz mono)
 *   rx(handle, Int16Array modem_in)   → { speech: Int16Array, sync: int, snr: int }
 *   getNin(handle)       → int
 *   getInfo(handle)      → { speechRate, modemRate, nSpeech, nModem }
 */

#include <node_api.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>

/* RADE API */
#include "rade_src/rade_api.h"

/* Opus/LPCNet for feature extraction and FARGAN synthesis */
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#include "lpcnet.h"
#include "fargan.h"
#include "freq.h"
#include "cpu_support.h"

#define MAX_HANDLES 2

struct rade_handle {
  struct rade *r;
  LPCNetEncState *encoder;    /* speech → features */
  FARGANState *fargan;        /* features → speech */
  int arch;
  int n_features;
  int nin_max;
  int n_tx_out;
  int fargan_initialized;     /* 1 after first fargan_cont call */
};

static struct rade_handle handles[MAX_HANDLES] = {0};
static int rade_initialized = 0;

static int find_free_slot(void) {
  for (int i = 0; i < MAX_HANDLES; i++) {
    if (!handles[i].r) return i;
  }
  return -1;
}

/* open() → handle */
static napi_value Open(napi_env env, napi_callback_info info) {
  if (!rade_initialized) {
    rade_initialize();
    rade_initialized = 1;
  }

  int slot = find_free_slot();
  if (slot < 0) {
    napi_throw_error(env, NULL, "No free RADE handle slots");
    return NULL;
  }

  int flags = RADE_USE_C_ENCODER | RADE_USE_C_DECODER | RADE_VERBOSE_0;
  struct rade *r = rade_open(NULL, flags);
  if (!r) {
    napi_throw_error(env, NULL, "rade_open failed");
    return NULL;
  }

  int arch = opus_select_arch();
  LPCNetEncState *enc = lpcnet_encoder_create();
  FARGANState *fargan = (FARGANState *)calloc(1, sizeof(FARGANState));
  fargan_init(fargan);

  handles[slot].r = r;
  handles[slot].encoder = enc;
  handles[slot].fargan = fargan;
  handles[slot].arch = arch;
  handles[slot].n_features = rade_n_features_in_out(r);
  handles[slot].nin_max = rade_nin_max(r);
  handles[slot].n_tx_out = rade_n_tx_out(r);

  napi_value result;
  napi_create_int32(env, slot, &result);
  return result;
}

/* close(handle) */
static napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot].r) {
    napi_throw_error(env, NULL, "Invalid RADE handle");
    return NULL;
  }

  rade_close(handles[slot].r);
  if (handles[slot].encoder) lpcnet_encoder_destroy(handles[slot].encoder);
  if (handles[slot].fargan) free(handles[slot].fargan);
  memset(&handles[slot], 0, sizeof(struct rade_handle));

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/* getNin(handle) → int */
static napi_value GetNin(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot].r) {
    napi_throw_error(env, NULL, "Invalid RADE handle");
    return NULL;
  }

  /* RADE nin is in complex samples. For real 8kHz audio, we need 2x
     (real + imaginary interleaved, or just real part from real audio). */
  int nin = rade_nin(handles[slot].r);

  napi_value result;
  napi_create_int32(env, nin, &result);
  return result;
}

/* tx(handle, Int16Array speech_16k) → Int16Array modem_8k */
static napi_value Tx(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot].r) {
    napi_throw_error(env, NULL, "Invalid RADE handle");
    return NULL;
  }
  struct rade_handle *h = &handles[slot];

  /* Get speech input (16kHz Int16) */
  napi_typedarray_type type;
  size_t length;
  void *data;
  napi_value arraybuf;
  size_t offset;
  napi_get_typedarray_info(env, args[1], &type, &length, &data, &arraybuf, &offset);
  if (type != napi_int16_array) {
    napi_throw_error(env, NULL, "speech must be Int16Array");
    return NULL;
  }
  short *pcm = (short *)data;

  /* Extract features from speech using LPCNet encoder */
  float features[NB_TOTAL_FEATURES];
  lpcnet_compute_single_frame_features(h->encoder, pcm, features, h->arch);

  /* Encode features to OFDM modem signal */
  int n_tx = h->n_tx_out;
  RADE_COMP *tx_out = (RADE_COMP *)calloc(n_tx, sizeof(RADE_COMP));
  int n_written = rade_tx(h->r, tx_out, features);

  /* Convert complex OFDM to real 8kHz audio (take real part, scale to Int16) */
  napi_value out_buf, out_arr;
  void *out_data;
  napi_create_arraybuffer(env, n_written * sizeof(short), &out_data, &out_buf);
  napi_create_typedarray(env, napi_int16_array, n_written, out_buf, 0, &out_arr);
  short *modem_out = (short *)out_data;

  for (int i = 0; i < n_written; i++) {
    float val = tx_out[i].real * 16384.0f;
    if (val > 32767.0f) val = 32767.0f;
    if (val < -32767.0f) val = -32767.0f;
    modem_out[i] = (short)val;
  }

  free(tx_out);
  return out_arr;
}

/* rx(handle, Int16Array modem_8k) → { speech: Int16Array, sync: int, snr: int } */
static napi_value Rx(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot].r) {
    napi_throw_error(env, NULL, "Invalid RADE handle");
    return NULL;
  }
  struct rade_handle *h = &handles[slot];

  /* Get modem input (8kHz Int16) */
  napi_typedarray_type type;
  size_t length;
  void *data;
  napi_value arraybuf;
  size_t offset;
  napi_get_typedarray_info(env, args[1], &type, &length, &data, &arraybuf, &offset);
  if (type != napi_int16_array) {
    napi_throw_error(env, NULL, "modem_in must be Int16Array");
    return NULL;
  }
  short *modem_in = (short *)data;

  /* Convert real 8kHz audio to complex (imaginary = 0) */
  RADE_COMP *rx_in = (RADE_COMP *)calloc(length, sizeof(RADE_COMP));
  for (size_t i = 0; i < length; i++) {
    rx_in[i].real = (float)modem_in[i] / 16384.0f;
    rx_in[i].imag = 0.0f;
  }

  /* Decode modem signal to features */
  int n_features = h->n_features;
  float *features_out = (float *)calloc(n_features, sizeof(float));
  int has_eoo = 0;
  float eoo_bits[8] = {0};
  int n_out = rade_rx(h->r, features_out, &has_eoo, eoo_bits, rx_in);

  /* Get sync and SNR */
  int sync_state = rade_sync(h->r);
  int snr_dB = rade_snrdB_3k_est(h->r);

  /* Synthesize speech from features using FARGAN (if we got valid output) */
  napi_value speech_arr;
  if (n_out > 0 && sync_state) {
    /* FARGAN synthesizes one frame of 16kHz audio from features */
    short pcm_out[LPCNET_FRAME_SIZE];
    if (!h->fargan_initialized) {
      /* First frame: initialize FARGAN continuation state with silence + features */
      float silence[LPCNET_FRAME_SIZE];
      memset(silence, 0, sizeof(silence));
      fargan_cont(h->fargan, silence, features_out);
      h->fargan_initialized = 1;
    }
    fargan_synthesize_int(h->fargan, pcm_out, features_out);

    napi_value speech_buf;
    void *speech_data;
    napi_create_arraybuffer(env, LPCNET_FRAME_SIZE * sizeof(short), &speech_data, &speech_buf);
    napi_create_typedarray(env, napi_int16_array, LPCNET_FRAME_SIZE, speech_buf, 0, &speech_arr);
    memcpy(speech_data, pcm_out, LPCNET_FRAME_SIZE * sizeof(short));
  } else {
    napi_value speech_buf;
    void *speech_data;
    napi_create_arraybuffer(env, 0, &speech_data, &speech_buf);
    napi_create_typedarray(env, napi_int16_array, 0, speech_buf, 0, &speech_arr);
  }

  free(rx_in);
  free(features_out);

  /* Build result object */
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "speech", speech_arr);

  napi_value v_sync, v_snr;
  napi_create_int32(env, sync_state, &v_sync);
  napi_create_int32(env, snr_dB, &v_snr);
  napi_set_named_property(env, result, "sync", v_sync);
  napi_set_named_property(env, result, "snr", v_snr);

  return result;
}

/* getInfo(handle) → { speechRate, modemRate, nSpeech, nModem, nFeatures } */
static napi_value GetInfo(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot].r) {
    napi_throw_error(env, NULL, "Invalid RADE handle");
    return NULL;
  }
  struct rade_handle *h = &handles[slot];

  napi_value result;
  napi_create_object(env, &result);

  napi_value v;
  napi_create_int32(env, RADE_SPEECH_SAMPLE_RATE, &v);
  napi_set_named_property(env, result, "speechRate", v);
  napi_create_int32(env, RADE_MODEM_SAMPLE_RATE, &v);
  napi_set_named_property(env, result, "modemRate", v);
  napi_create_int32(env, LPCNET_FRAME_SIZE, &v);
  napi_set_named_property(env, result, "nSpeech", v);
  napi_create_int32(env, h->n_tx_out, &v);
  napi_set_named_property(env, result, "nModem", v);
  napi_create_int32(env, h->n_features, &v);
  napi_set_named_property(env, result, "nFeatures", v);
  napi_create_int32(env, h->nin_max, &v);
  napi_set_named_property(env, result, "ninMax", v);

  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;

  napi_create_function(env, "open", NAPI_AUTO_LENGTH, Open, NULL, &fn);
  napi_set_named_property(env, exports, "open", fn);

  napi_create_function(env, "close", NAPI_AUTO_LENGTH, Close, NULL, &fn);
  napi_set_named_property(env, exports, "close", fn);

  napi_create_function(env, "tx", NAPI_AUTO_LENGTH, Tx, NULL, &fn);
  napi_set_named_property(env, exports, "tx", fn);

  napi_create_function(env, "rx", NAPI_AUTO_LENGTH, Rx, NULL, &fn);
  napi_set_named_property(env, exports, "rx", fn);

  napi_create_function(env, "getNin", NAPI_AUTO_LENGTH, GetNin, NULL, &fn);
  napi_set_named_property(env, exports, "getNin", fn);

  napi_create_function(env, "getInfo", NAPI_AUTO_LENGTH, GetInfo, NULL, &fn);
  napi_set_named_property(env, exports, "getInfo", fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
