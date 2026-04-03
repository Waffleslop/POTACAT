/**
 * FreeDV N-API addon — wraps codec2 FreeDV API for Node.js
 *
 * Exports:
 *   open(mode)                → handle (uint32)
 *   close(handle)             → void
 *   tx(handle, Int16Array)    → Int16Array (modem samples)
 *   getNin(handle)            → int
 *   rx(handle, Int16Array)    → { speech: Int16Array, nout: int, sync: int, snr: float }
 *   getInfo(handle)           → { speechRate, modemRate, nSpeech, nNomModem, nMaxModem, nMaxSpeech }
 *
 * Modes: MODE_1600=0, MODE_700C=6, MODE_700D=7, MODE_700E=13
 */

#include <node_api.h>
#include <string.h>
#include <stdlib.h>
#include "codec2_src/freedv_api.h"

#define MAX_HANDLES 4

static struct freedv *handles[MAX_HANDLES] = {0};

static int find_free_slot(void) {
  for (int i = 0; i < MAX_HANDLES; i++) {
    if (!handles[i]) return i;
  }
  return -1;
}

/* open(mode: number) → handle: number */
static napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t mode;
  napi_get_value_int32(env, args[0], &mode);

  int slot = find_free_slot();
  if (slot < 0) {
    napi_throw_error(env, NULL, "No free FreeDV handle slots");
    return NULL;
  }

  struct freedv *fdv = freedv_open(mode);
  if (!fdv) {
    napi_throw_error(env, NULL, "freedv_open failed — unsupported mode?");
    return NULL;
  }

  /* Enable TX clipping and bandpass filter for cleaner signal */
  freedv_set_clip(fdv, 1);
  freedv_set_tx_bpf(fdv, 1);

  handles[slot] = fdv;

  napi_value result;
  napi_create_int32(env, slot, &result);
  return result;
}

/* close(handle: number) */
static napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot]) {
    napi_throw_error(env, NULL, "Invalid FreeDV handle");
    return NULL;
  }

  freedv_close(handles[slot]);
  handles[slot] = NULL;

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/* tx(handle: number, speechIn: Int16Array) → Int16Array */
static napi_value Tx(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot]) {
    napi_throw_error(env, NULL, "Invalid FreeDV handle");
    return NULL;
  }
  struct freedv *fdv = handles[slot];

  /* Get speech input */
  napi_typedarray_type type;
  size_t length;
  void *data;
  napi_value arraybuf;
  size_t offset;
  napi_get_typedarray_info(env, args[1], &type, &length, &data, &arraybuf, &offset);
  if (type != napi_int16_array) {
    napi_throw_error(env, NULL, "speech_in must be Int16Array");
    return NULL;
  }
  short *speech_in = (short *)data;

  int n_speech = freedv_get_n_speech_samples(fdv);
  int n_modem = freedv_get_n_tx_modem_samples(fdv);

  /* Allocate output */
  napi_value out_buf, out_arr;
  void *out_data;
  napi_create_arraybuffer(env, n_modem * sizeof(short), &out_data, &out_buf);
  napi_create_typedarray(env, napi_int16_array, n_modem, out_buf, 0, &out_arr);
  short *mod_out = (short *)out_data;

  /* Encode — process one frame */
  freedv_tx(fdv, mod_out, speech_in);

  return out_arr;
}

/* getNin(handle: number) → number */
static napi_value GetNin(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot]) {
    napi_throw_error(env, NULL, "Invalid FreeDV handle");
    return NULL;
  }

  int nin = freedv_nin(handles[slot]);
  napi_value result;
  napi_create_int32(env, nin, &result);
  return result;
}

/* rx(handle: number, demodIn: Int16Array) → { speech, nout, sync, snr } */
static napi_value Rx(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot]) {
    napi_throw_error(env, NULL, "Invalid FreeDV handle");
    return NULL;
  }
  struct freedv *fdv = handles[slot];

  /* Get demod input */
  napi_typedarray_type type;
  size_t length;
  void *data;
  napi_value arraybuf;
  size_t offset;
  napi_get_typedarray_info(env, args[1], &type, &length, &data, &arraybuf, &offset);
  if (type != napi_int16_array) {
    napi_throw_error(env, NULL, "demod_in must be Int16Array");
    return NULL;
  }
  short *demod_in = (short *)data;

  int n_max_speech = freedv_get_n_max_speech_samples(fdv);

  /* Allocate speech output */
  napi_value speech_buf, speech_arr;
  void *speech_data;
  napi_create_arraybuffer(env, n_max_speech * sizeof(short), &speech_data, &speech_buf);
  napi_create_typedarray(env, napi_int16_array, n_max_speech, speech_buf, 0, &speech_arr);
  short *speech_out = (short *)speech_data;

  /* Decode */
  int nout = freedv_rx(fdv, speech_out, demod_in);

  /* Get modem stats */
  int sync = 0;
  float snr_est = 0.0f;
  freedv_get_modem_stats(fdv, &sync, &snr_est);

  /* Build result object */
  napi_value result;
  napi_create_object(env, &result);

  /* Trim speech array to actual output size */
  napi_value trimmed_arr;
  napi_create_typedarray(env, napi_int16_array, nout, speech_buf, 0, &trimmed_arr);
  napi_set_named_property(env, result, "speech", trimmed_arr);

  napi_value v_nout, v_sync, v_snr;
  napi_create_int32(env, nout, &v_nout);
  napi_create_int32(env, sync, &v_sync);
  napi_create_double(env, (double)snr_est, &v_snr);
  napi_set_named_property(env, result, "nout", v_nout);
  napi_set_named_property(env, result, "sync", v_sync);
  napi_set_named_property(env, result, "snr", v_snr);

  return result;
}

/* getInfo(handle: number) → { speechRate, modemRate, nSpeech, nNomModem, nMaxModem, nMaxSpeech } */
static napi_value GetInfo(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  int32_t slot;
  napi_get_value_int32(env, args[0], &slot);
  if (slot < 0 || slot >= MAX_HANDLES || !handles[slot]) {
    napi_throw_error(env, NULL, "Invalid FreeDV handle");
    return NULL;
  }
  struct freedv *fdv = handles[slot];

  napi_value result;
  napi_create_object(env, &result);

  napi_value v;
  napi_create_int32(env, freedv_get_speech_sample_rate(fdv), &v);
  napi_set_named_property(env, result, "speechRate", v);
  napi_create_int32(env, freedv_get_modem_sample_rate(fdv), &v);
  napi_set_named_property(env, result, "modemRate", v);
  napi_create_int32(env, freedv_get_n_speech_samples(fdv), &v);
  napi_set_named_property(env, result, "nSpeech", v);
  napi_create_int32(env, freedv_get_n_nom_modem_samples(fdv), &v);
  napi_set_named_property(env, result, "nNomModem", v);
  napi_create_int32(env, freedv_get_n_max_modem_samples(fdv), &v);
  napi_set_named_property(env, result, "nMaxModem", v);
  napi_create_int32(env, freedv_get_n_max_speech_samples(fdv), &v);
  napi_set_named_property(env, result, "nMaxSpeech", v);
  napi_create_int32(env, freedv_get_n_tx_modem_samples(fdv), &v);
  napi_set_named_property(env, result, "nTxModem", v);

  return result;
}

/* Mode constants */
static napi_value InitConstants(napi_env env, napi_value exports) {
  napi_value v;
  napi_create_int32(env, FREEDV_MODE_1600, &v);
  napi_set_named_property(env, exports, "MODE_1600", v);
  napi_create_int32(env, FREEDV_MODE_700C, &v);
  napi_set_named_property(env, exports, "MODE_700C", v);
  napi_create_int32(env, FREEDV_MODE_700D, &v);
  napi_set_named_property(env, exports, "MODE_700D", v);
  napi_create_int32(env, FREEDV_MODE_700E, &v);
  napi_set_named_property(env, exports, "MODE_700E", v);
  return exports;
}

static napi_value Init(napi_env env, napi_value exports) {
  InitConstants(env, exports);

  napi_value fn;
  napi_create_function(env, "open", NAPI_AUTO_LENGTH, Open, NULL, &fn);
  napi_set_named_property(env, exports, "open", fn);

  napi_create_function(env, "close", NAPI_AUTO_LENGTH, Close, NULL, &fn);
  napi_set_named_property(env, exports, "close", fn);

  napi_create_function(env, "tx", NAPI_AUTO_LENGTH, Tx, NULL, &fn);
  napi_set_named_property(env, exports, "tx", fn);

  napi_create_function(env, "getNin", NAPI_AUTO_LENGTH, GetNin, NULL, &fn);
  napi_set_named_property(env, exports, "getNin", fn);

  napi_create_function(env, "rx", NAPI_AUTO_LENGTH, Rx, NULL, &fn);
  napi_set_named_property(env, exports, "rx", fn);

  napi_create_function(env, "getInfo", NAPI_AUTO_LENGTH, GetInfo, NULL, &fn);
  napi_set_named_property(env, exports, "getInfo", fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
