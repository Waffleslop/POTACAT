/**
 * ft8_native — Node.js N-API addon for native FT8/FT4 decoding.
 * Uses ft8_lib by Karlis Goba (YL3JG) for decode at native C speed.
 *
 * Exports:
 *   decode(Float32Array samples, string protocol) → [{db, dt, df, text}]
 *     protocol: "FT8" or "FT4"
 *     samples: 12000 Hz mono audio (15s for FT8, 7.5s for FT4)
 */

#include <node_api.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>

#include <ft8/decode.h>
#include <ft8/encode.h>
#include <ft8/message.h>
#include <ft8/constants.h>
#include <common/monitor.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define MAX_CANDIDATES 140
#define MAX_DECODED 50
#define MIN_SCORE 10
#define LDPC_ITERATIONS 25
#define SAMPLE_RATE 12000

/* Callsign hash table for message unpacking */
#define HASH_SIZE 256

static struct {
    char callsign[12];
    uint32_t hash;
} hash_table[HASH_SIZE];
static int hash_table_size = 0;

static void ht_init(void) {
    hash_table_size = 0;
    memset(hash_table, 0, sizeof(hash_table));
}

static void ht_add(const char* callsign, uint32_t hash) {
    uint16_t h10 = (hash >> 12) & 0x3FFu;
    int idx = (h10 * 23) % HASH_SIZE;
    while (hash_table[idx].callsign[0] != '\0') {
        if (((hash_table[idx].hash & 0x3FFFFFu) == hash) &&
            strcmp(hash_table[idx].callsign, callsign) == 0) {
            hash_table[idx].hash &= 0x3FFFFFu;
            return;
        }
        idx = (idx + 1) % HASH_SIZE;
    }
    hash_table_size++;
    strncpy(hash_table[idx].callsign, callsign, 11);
    hash_table[idx].callsign[11] = '\0';
    hash_table[idx].hash = hash;
}

static bool ht_lookup(ftx_callsign_hash_type_t type, uint32_t hash, char* callsign) {
    uint8_t shift = (type == FTX_CALLSIGN_HASH_10_BITS) ? 12 :
                    (type == FTX_CALLSIGN_HASH_12_BITS) ? 10 : 0;
    uint16_t h10 = (hash >> (12 - shift)) & 0x3FFu;
    int idx = (h10 * 23) % HASH_SIZE;
    while (hash_table[idx].callsign[0] != '\0') {
        if (((hash_table[idx].hash & 0x3FFFFFu) >> shift) == hash) {
            strcpy(callsign, hash_table[idx].callsign);
            return true;
        }
        idx = (idx + 1) % HASH_SIZE;
    }
    callsign[0] = '\0';
    return false;
}

static ftx_callsign_hash_interface_t hash_if = {
    .lookup_hash = ht_lookup,
    .save_hash = ht_add
};

/* ---- A priori (AP) decoding -------------------------------------------------
 * To recover marginal / late-started replies addressed to us, hypothesize the
 * known bits of an incoming STANDARD message and hand them to the LDPC decoder
 * (decode.c clamps those likelihoods before belief propagation). Two passes,
 * tried only after the plain no-AP decode fails for a candidate:
 *   AP1 "mycall": call1 = our call, i3 = 1  — any reply to our CQ
 *   AP2 "both":   call1 = our call, call2 = the station we're working, i3 = 1
 *                 — mid-QSO, far more bits known (up to ~10 dB on bad channels,
 *                 Franke/Somerville/Taylor QEX 2020)
 * Masks are derived once (cached) by encoding a probe std message and lifting
 * the known field bits, so the 77-bit field layout is never hand-rolled. A
 * throwaway hash interface keeps the probe's dummy call out of the live table.
 *
 * Standard-message payload bit ranges (MSB-first, indices into plain174):
 *   call1+ipa = 0..28, call2+ipb = 29..57, ir = 58, grid15 = 59..73, i3 = 74..76 */
#define AP_CALL1_LO 0
#define AP_CALL1_HI 28
#define AP_CALL2_LO 29
#define AP_CALL2_HI 57
#define AP_I3_LO    74
#define AP_I3_HI    76

static bool ap_probe_lookup(ftx_callsign_hash_type_t t, uint32_t h, char* c) { (void)t; (void)h; c[0] = '\0'; return false; }
static void ap_probe_save(const char* c, uint32_t h) { (void)c; (void)h; }
static ftx_callsign_hash_interface_t ap_probe_hash_if = { .lookup_hash = ap_probe_lookup, .save_hash = ap_probe_save };

static char ap_cached_mycall[16] = {0};
static char ap_cached_dxcall[16] = {0};
static uint8_t ap1_mask[FTX_LDPC_N], ap1_bits[FTX_LDPC_N];
static uint8_t ap2_mask[FTX_LDPC_N], ap2_bits[FTX_LDPC_N];
static bool ap1_valid = false;
static bool ap2_valid = false;

static inline uint8_t payload_bit(const uint8_t* payload, int j) {
    return (payload[j >> 3] >> (7 - (j & 7))) & 1u;
}

/* Build an AP mask/bits pair from a probe std message. When mask_call2 is set,
 * the call2 field is fixed too. Returns false (AP unavailable) if the calls
 * don't pack as a standard i3=1 message. */
static bool ap_build(const char* call_to, const char* call_de, bool mask_call2,
                     uint8_t* mask, uint8_t* bits) {
    memset(mask, 0, FTX_LDPC_N);
    memset(bits, 0, FTX_LDPC_N);
    ftx_message_t probe;
    ftx_message_init(&probe);
    if (ftx_message_encode_std(&probe, &ap_probe_hash_if, call_to, call_de, "AA00") != FTX_MESSAGE_RC_OK)
        return false;
    if (ftx_message_get_i3(&probe) != 1)
        return false; // not a plain standard message — don't risk a wrong hypothesis
    for (int j = AP_CALL1_LO; j <= AP_CALL1_HI; ++j) { mask[j] = 1; bits[j] = payload_bit(probe.payload, j); }
    for (int j = AP_I3_LO;    j <= AP_I3_HI;    ++j) { mask[j] = 1; bits[j] = payload_bit(probe.payload, j); }
    if (mask_call2) {
        for (int j = AP_CALL2_LO; j <= AP_CALL2_HI; ++j) { mask[j] = 1; bits[j] = payload_bit(probe.payload, j); }
    }
    return true;
}

/* Refresh cached AP masks when the operator's call or QSO partner changes. */
static void ap_refresh(const char* mycall, const char* dxcall) {
    if (mycall == NULL) mycall = "";
    if (dxcall == NULL) dxcall = "";
    if (strcmp(mycall, ap_cached_mycall) == 0 && strcmp(dxcall, ap_cached_dxcall) == 0)
        return; // unchanged
    strncpy(ap_cached_mycall, mycall, sizeof(ap_cached_mycall) - 1);
    ap_cached_mycall[sizeof(ap_cached_mycall) - 1] = '\0';
    strncpy(ap_cached_dxcall, dxcall, sizeof(ap_cached_dxcall) - 1);
    ap_cached_dxcall[sizeof(ap_cached_dxcall) - 1] = '\0';
    ap1_valid = ap2_valid = false;
    if (ap_cached_mycall[0]) {
        // AP1: our call as call1, a throwaway standard call2.
        ap1_valid = ap_build(ap_cached_mycall, "K1AB", false, ap1_mask, ap1_bits);
        if (ap_cached_dxcall[0])
            ap2_valid = ap_build(ap_cached_mycall, ap_cached_dxcall, true, ap2_mask, ap2_bits);
    }
}

/* ---- TX waveform synthesis -------------------------------------------------
 * GFSK phase shaping, ported from ft8_lib's gen_ft8 demo but with a heap
 * `dphi` buffer (the demo uses a C99 VLA, which MSVC — the Windows addon
 * compiler — rejects). Produces the modulated envelope starting at sample 0,
 * matching ft8js's encode() so the engine's TX timing/late-start slicing is
 * unchanged when it swaps in native encode. */
#define GFSK_CONST_K 5.336446f /* == pi * sqrt(2 / log(2)) */

static void gfsk_pulse(int n_spsym, float symbol_bt, float* pulse) {
    for (int i = 0; i < 3 * n_spsym; ++i) {
        float t = i / (float)n_spsym - 1.5f;
        float arg1 = GFSK_CONST_K * symbol_bt * (t + 0.5f);
        float arg2 = GFSK_CONST_K * symbol_bt * (t - 0.5f);
        pulse[i] = (erff(arg1) - erff(arg2)) / 2;
    }
}

/* Returns 0 on success, -1 on allocation failure. signal must hold n_sym*n_spsym floats. */
static int synth_gfsk(const uint8_t* symbols, int n_sym, float f0, float symbol_bt,
                      float symbol_period, int signal_rate, float* signal) {
    int n_spsym = (int)(0.5f + signal_rate * symbol_period);
    int n_wave = n_sym * n_spsym;
    float hmod = 1.0f;
    float dphi_peak = 2 * (float)M_PI * hmod / n_spsym;

    float* dphi = (float*)malloc((size_t)(n_wave + 2 * n_spsym) * sizeof(float));
    float* pulse = (float*)malloc((size_t)(3 * n_spsym) * sizeof(float));
    if (!dphi || !pulse) { free(dphi); free(pulse); return -1; }

    for (int i = 0; i < n_wave + 2 * n_spsym; ++i)
        dphi[i] = 2 * (float)M_PI * f0 / signal_rate;

    gfsk_pulse(n_spsym, symbol_bt, pulse);

    for (int i = 0; i < n_sym; ++i) {
        int ib = i * n_spsym;
        for (int j = 0; j < 3 * n_spsym; ++j)
            dphi[j + ib] += dphi_peak * symbols[i] * pulse[j];
    }
    for (int j = 0; j < 2 * n_spsym; ++j) {
        dphi[j] += dphi_peak * pulse[j + n_spsym] * symbols[0];
        dphi[j + n_sym * n_spsym] += dphi_peak * pulse[j] * symbols[n_sym - 1];
    }

    float phi = 0;
    for (int k = 0; k < n_wave; ++k) {
        signal[k] = sinf(phi);
        phi = fmodf(phi + dphi[k + n_spsym], 2 * (float)M_PI);
    }

    int n_ramp = n_spsym / 8;
    for (int i = 0; i < n_ramp; ++i) {
        float env = (1 - cosf(2 * (float)M_PI * i / (2 * n_ramp))) / 2;
        signal[i] *= env;
        signal[n_wave - 1 - i] *= env;
    }

    free(dphi);
    free(pulse);
    return 0;
}

/* N-API encode function: (text, frequency?, protocol?) -> Float32Array | null
 * Packs text (FD-aware via ftx_message_encode), generates tones, and synthesizes
 * the GFSK envelope. The returned buffer starts at sample 0 with no leading
 * silence — same contract as ft8js.encode(); the caller owns slot timing. */
static napi_value Encode(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    if (argc < 1) {
        napi_throw_error(env, NULL, "Expected (text, frequency?, protocol?)");
        return NULL;
    }

    char text[64] = {0};
    size_t text_len = 0;
    napi_get_value_string_utf8(env, args[0], text, sizeof(text), &text_len);

    double frequency = 1000.0;
    if (argc >= 2) {
        napi_valuetype vt;
        napi_typeof(env, args[1], &vt);
        if (vt == napi_number) napi_get_value_double(env, args[1], &frequency);
    }

    bool is_ft4 = false;
    if (argc >= 3) {
        char proto_str[8] = {0};
        size_t n;
        napi_get_value_string_utf8(env, args[2], proto_str, sizeof(proto_str), &n);
        if (strcmp(proto_str, "FT4") == 0) is_ft4 = true;
    }

    /* Pack the text into a 77-bit message (NULL hash_if, matching ft8js). */
    ftx_message_t msg;
    ftx_message_init(&msg);
    if (ftx_message_encode(&msg, NULL, text) != FTX_MESSAGE_RC_OK) {
        napi_value null_val;
        napi_get_null(env, &null_val);
        return null_val;
    }

    int num_tones = is_ft4 ? FT4_NN : FT8_NN;
    float symbol_period = is_ft4 ? FT4_SYMBOL_PERIOD : FT8_SYMBOL_PERIOD;
    float symbol_bt = is_ft4 ? 1.0f : 2.0f;

    uint8_t tones[FT4_NN > FT8_NN ? FT4_NN : FT8_NN];
    if (is_ft4) ft4_encode(msg.payload, tones);
    else        ft8_encode(msg.payload, tones);

    int sample_rate = 12000;
    int n_spsym = (int)(0.5f + sample_rate * symbol_period);
    int n_wave = num_tones * n_spsym;

    napi_value arraybuffer;
    void* ab_data;
    napi_create_arraybuffer(env, (size_t)n_wave * sizeof(float), &ab_data, &arraybuffer);

    if (synth_gfsk(tones, num_tones, (float)frequency, symbol_bt, symbol_period, sample_rate, (float*)ab_data) != 0) {
        napi_value null_val;
        napi_get_null(env, &null_val);
        return null_val;
    }

    napi_value typedarray;
    napi_create_typedarray(env, napi_float32_array, (size_t)n_wave, arraybuffer, 0, &typedarray);
    return typedarray;
}

/* N-API decode function */
static napi_value Decode(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    if (argc < 1) {
        napi_throw_error(env, NULL, "Expected (samples, protocol?, myCall?, dxCall?)");
        return NULL;
    }

    /* Get Float32Array samples */
    float* samples;
    size_t byte_length;
    napi_typedarray_type type;
    size_t length;
    napi_value arraybuffer;
    size_t offset;
    napi_get_typedarray_info(env, args[0], &type, &length, (void**)&samples, &arraybuffer, &offset);

    if (type != napi_float32_array || length == 0) {
        napi_throw_error(env, NULL, "First argument must be a Float32Array");
        return NULL;
    }

    /* Get protocol string (default FT8) */
    ftx_protocol_t protocol = FTX_PROTOCOL_FT8;
    if (argc >= 2) {
        char proto_str[8] = {0};
        size_t proto_len;
        napi_get_value_string_utf8(env, args[1], proto_str, sizeof(proto_str), &proto_len);
        if (strcmp(proto_str, "FT4") == 0) {
            protocol = FTX_PROTOCOL_FT4;
        }
    }

    /* AP context: our callsign (args[2]) + current QSO partner (args[3]).
     * Both optional; absent/blank disables the corresponding AP pass. Reading
     * a non-string arg leaves the buffer zeroed (rc ignored on purpose). */
    char ap_mycall[16] = {0};
    char ap_dxcall[16] = {0};
    if (argc >= 3) { size_t n; napi_get_value_string_utf8(env, args[2], ap_mycall, sizeof(ap_mycall), &n); }
    if (argc >= 4) { size_t n; napi_get_value_string_utf8(env, args[3], ap_dxcall, sizeof(ap_dxcall), &n); }
    ap_refresh(ap_mycall, ap_dxcall);

    /* Set up monitor */
    monitor_config_t cfg = {
        .f_min = 200,
        .f_max = 3000,
        .sample_rate = SAMPLE_RATE,
        .time_osr = 2,
        .freq_osr = 2,
        .protocol = protocol
    };

    monitor_t mon;
    monitor_init(&mon, &cfg);

    /* Feed audio into monitor */
    int num_samples = (int)length;
    for (int pos = 0; pos + mon.block_size <= num_samples; pos += mon.block_size) {
        monitor_process(&mon, samples + pos);
    }

    /* Find candidates */
    ftx_candidate_t candidates[MAX_CANDIDATES];
    int num_candidates = ftx_find_candidates(&mon.wf, MAX_CANDIDATES, candidates, MIN_SCORE);

    /* Decode candidates */
    napi_value result_array;
    napi_create_array(env, &result_array);
    int result_count = 0;

    /* Dedup hash table for this cycle */
    ftx_message_t decoded[MAX_DECODED];
    ftx_message_t* decoded_ht[MAX_DECODED];
    memset(decoded_ht, 0, sizeof(decoded_ht));

    for (int i = 0; i < num_candidates && result_count < MAX_DECODED; i++) {
        const ftx_candidate_t* cand = &candidates[i];

        ftx_message_t message;
        ftx_decode_status_t status;
        bool is_ap = false;
        if (!ftx_decode_candidate(&mon.wf, cand, LDPC_ITERATIONS, &message, &status)) {
            /* Plain decode failed — try AP hypotheses, strongest (most bits
             * known) first. Each forces our call onto the candidate and still
             * requires the CRC to pass, so a signal NOT addressed to us simply
             * won't converge. */
            if (ap2_valid && ftx_decode_candidate_ap(&mon.wf, cand, LDPC_ITERATIONS, ap2_mask, ap2_bits, &message, &status)) {
                is_ap = true;
            } else if (ap1_valid && ftx_decode_candidate_ap(&mon.wf, cand, LDPC_ITERATIONS, ap1_mask, ap1_bits, &message, &status)) {
                is_ap = true;
            } else {
                continue;
            }
        }

        /* Check for duplicates */
        int idx_hash = message.hash % MAX_DECODED;
        bool dup = false;
        bool found_slot = false;
        do {
            if (decoded_ht[idx_hash] == NULL) {
                found_slot = true;
            } else if (decoded_ht[idx_hash]->hash == message.hash &&
                       memcmp(decoded_ht[idx_hash]->payload, message.payload, sizeof(message.payload)) == 0) {
                dup = true;
            } else {
                idx_hash = (idx_hash + 1) % MAX_DECODED;
            }
        } while (!found_slot && !dup);

        if (dup) continue;

        memcpy(&decoded[idx_hash], &message, sizeof(message));
        decoded_ht[idx_hash] = &decoded[idx_hash];

        /* Unpack message text */
        char text[FTX_MAX_MESSAGE_LENGTH];
        ftx_message_offsets_t offsets;
        ftx_message_rc_t rc = ftx_message_decode(&message, &hash_if, text, &offsets);
        if (rc != FTX_MESSAGE_RC_OK) {
            continue;
        }

        /* AP false-accept guard: an AP decode forced our call onto the bits, so
         * a genuine decode unpacks to text containing our call. If it doesn't
         * (rare AP+CRC coincidence), drop it rather than surface a bogus spot. */
        if (is_ap && ap_cached_mycall[0] && strstr(text, ap_cached_mycall) == NULL) {
            continue;
        }

        float freq_hz = (mon.min_bin + cand->freq_offset +
                        (float)cand->freq_sub / mon.wf.freq_osr) / mon.symbol_period;
        float time_sec = (cand->time_offset +
                         (float)cand->time_sub / mon.wf.time_osr) * mon.symbol_period;
        float snr = cand->score * 0.5f;

        /* Create result object {db, dt, df, text} */
        napi_value obj;
        napi_create_object(env, &obj);

        napi_value v_db, v_dt, v_df, v_text;
        napi_create_double(env, (double)snr, &v_db);
        napi_create_double(env, (double)time_sec, &v_dt);
        napi_create_double(env, (double)freq_hz, &v_df);
        napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &v_text);

        napi_value v_ap;
        napi_get_boolean(env, is_ap, &v_ap);

        /* Message type (i3/n3) lets the QSO state machine recognize contest
         * exchanges (ARRL Field Day = i3:0 n3:3/4) without re-parsing the text. */
        napi_value v_i3, v_n3;
        napi_create_int32(env, (int32_t)ftx_message_get_i3(&message), &v_i3);
        napi_create_int32(env, (int32_t)ftx_message_get_n3(&message), &v_n3);

        napi_set_named_property(env, obj, "db", v_db);
        napi_set_named_property(env, obj, "dt", v_dt);
        napi_set_named_property(env, obj, "df", v_df);
        napi_set_named_property(env, obj, "text", v_text);
        napi_set_named_property(env, obj, "ap", v_ap);
        napi_set_named_property(env, obj, "i3", v_i3);
        napi_set_named_property(env, obj, "n3", v_n3);

        napi_set_element(env, result_array, result_count, obj);
        result_count++;
    }

    monitor_free(&mon);

    return result_array;
}

/* Module initialization */
static napi_value Init(napi_env env, napi_value exports) {
    ht_init();

    napi_value fn;
    napi_create_function(env, "decode", NAPI_AUTO_LENGTH, Decode, NULL, &fn);
    napi_set_named_property(env, exports, "decode", fn);

    napi_value fn_encode;
    napi_create_function(env, "encode", NAPI_AUTO_LENGTH, Encode, NULL, &fn_encode);
    napi_set_named_property(env, exports, "encode", fn_encode);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
