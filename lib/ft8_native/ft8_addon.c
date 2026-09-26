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

/* Decoder limits. Measured with scripts/ft8-benchmark.js on ft8_lib's
 * WSJT-X-referenced test set (60 slots): beyond these, more candidates, a
 * lower sync threshold, more LDPC iterations or a 4th pass bought no decodes,
 * only time. Before issue #87 these were 140 / 50 / 10 / 25, one pass. */
#define MAX_CANDIDATES 150      /* waterfall sync candidates per pass */
#define MAX_DECODED 200         /* results per slot (was 50: a busy 20 m slot has more) */
#define MIN_SCORE 10            /* waterfall sync score floor */
#define LDPC_ITERATIONS 25      /* BP iterations, waterfall metric */
#define NUM_PASSES 3            /* FT8 decode/subtract passes */
#define FT8_TIME_OSR 4          /* waterfall time oversampling (FT4 keeps 2) */
#define FREQ_OSR 2              /* waterfall frequency oversampling */
#define REF_T_RANGE 10          /* refined sync: +/- 200 Hz samples (50 ms) */
#define REF_MIN_NSYNC 6         /* reject when <= this many of 21 Costas symbols match (WSJT-X) */
#define REF_LDPC 30             /* BP iterations, refined metrics */
#define REF_SCALE 5.5f          /* LLR scale for the refined metrics (ft8_lib's BP) */
#define SUB_T_RANGE 10          /* subtraction sync: +/- 200 Hz samples */
#define SUB_SMOOTH 1            /* amplitude smoothing, +/- half-symbol blocks */
#define COVER_HZ 3.0f           /* a candidate this close to a decode ... */
#define COVER_SAMPLES 1200.0f   /* ... and within 100 ms is the same signal */
#define SAMPLE_RATE 12000

/* Callsign hash table for message unpacking.
 *
 * ft8_lib saves EVERY callsign it unpacks (save_callsign), so the table only
 * ever grows. It used to be a fixed 256-slot open-addressing table with no
 * eviction: once 256 distinct calls had been heard (~15 min on a busy 20 m
 * band) ht_add's probe loop never found an empty slot and spun forever. The
 * decode never returned, the engine's watchdog "respawned" the worker — but
 * worker.terminate() cannot interrupt native code, so the old thread kept
 * spinning on a core while the new one shared (and re-initialised) the same
 * static table. That is the "FT8 silently stops decoding" report and part of
 * issue #87. Now: 1024 slots, every entry stamped with the decode cycle that
 * last touched it, and the least-recently-used half is dropped whenever the
 * load reaches 3/4 — so a probe always reaches an empty slot. */
#define HASH_SIZE 1024
#define HASH_PRUNE_AT (HASH_SIZE * 3 / 4)

typedef struct {
    char callsign[12];
    uint32_t hash;
    uint32_t age;   /* ht_epoch when last saved or looked up */
} ht_entry_t;

static ht_entry_t hash_table[HASH_SIZE];
static int hash_table_size = 0;
static uint32_t ht_epoch = 0;   /* bumped once per Decode() call */

static void ht_init(void) {
    hash_table_size = 0;
    memset(hash_table, 0, sizeof(hash_table));
}

static int ht_home(uint32_t hash22) {
    uint16_t h10 = (hash22 >> 12) & 0x3FFu;
    return (h10 * 23) % HASH_SIZE;
}

static void ht_insert_raw(const ht_entry_t* e) {
    int idx = ht_home(e->hash);
    while (hash_table[idx].callsign[0] != '\0')
        idx = (idx + 1) % HASH_SIZE;
    hash_table[idx] = *e;
    hash_table_size++;
}

static int ht_cmp_age_desc(const void* a, const void* b) {
    uint32_t x = ((const ht_entry_t*)a)->age, y = ((const ht_entry_t*)b)->age;
    return (x < y) ? 1 : ((x > y) ? -1 : 0);
}

/* Keep the most recently used half; rebuild so probe chains stay valid. */
static void ht_prune(void) {
    static ht_entry_t keep[HASH_SIZE];
    int n = 0;
    for (int i = 0; i < HASH_SIZE; ++i)
        if (hash_table[i].callsign[0] != '\0') keep[n++] = hash_table[i];
    qsort(keep, (size_t)n, sizeof(keep[0]), ht_cmp_age_desc);
    if (n > HASH_SIZE / 2) n = HASH_SIZE / 2;
    ht_init();
    for (int i = 0; i < n; ++i) ht_insert_raw(&keep[i]);
}

static void ht_add(const char* callsign, uint32_t hash) {
    int idx = ht_home(hash);
    while (hash_table[idx].callsign[0] != '\0') {
        if (((hash_table[idx].hash & 0x3FFFFFu) == hash) &&
            strcmp(hash_table[idx].callsign, callsign) == 0) {
            hash_table[idx].hash &= 0x3FFFFFu;
            hash_table[idx].age = ht_epoch;
            return;
        }
        idx = (idx + 1) % HASH_SIZE;
    }
    if (hash_table_size >= HASH_PRUNE_AT) {
        ht_prune();
    }
    ht_entry_t e;
    memset(&e, 0, sizeof(e));
    strncpy(e.callsign, callsign, 11);
    e.callsign[11] = '\0';
    e.hash = hash;
    e.age = ht_epoch;
    ht_insert_raw(&e);
}

static bool ht_lookup(ftx_callsign_hash_type_t type, uint32_t hash, char* callsign) {
    uint8_t shift = (type == FTX_CALLSIGN_HASH_10_BITS) ? 12 :
                    (type == FTX_CALLSIGN_HASH_12_BITS) ? 10 : 0;
    uint16_t h10 = (hash >> (12 - shift)) & 0x3FFu;
    int idx = (h10 * 23) % HASH_SIZE;
    while (hash_table[idx].callsign[0] != '\0') {
        if (((hash_table[idx].hash & 0x3FFFFFu) >> shift) == hash) {
            strcpy(callsign, hash_table[idx].callsign);
            hash_table[idx].age = ht_epoch;
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

    /* Pack the text into a 77-bit message. Uses the live hash interface so
     * (a) nonstandard/bracketed calls can encode (type 4 + <hash> forms) and
     * (b) our own TX seeds the hash table, mirroring WSJT-X seeding from the
     * DX-call box. (Was NULL "matching ft8js" — which made every message
     * containing a bracketed call fail encode and silently skip TX.) */
    ftx_message_t msg;
    ftx_message_init(&msg);
    if (ftx_message_encode(&msg, &hash_if, text) != FTX_MESSAGE_RC_OK) {
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

/* ---- Multi-pass FT8 decode: refined demodulation + signal subtraction ------
 * (issue #87: far fewer decodes than WSJT-X on the same band)
 *
 * ft8_lib alone is one pass over a log-magnitude waterfall with a 3.125 Hz x
 * 40 ms grid and a hard max-log bit metric. Two things WSJT-X does that it
 * does not, both ported here from WSJT-X's ft8b / ft8_downsample /
 * subtractft8 (same algorithms, re-implemented in C on ft8_lib's LDPC):
 *
 * 1. REFINED DEMODULATION of candidates the waterfall decode could not crack.
 *    One 192000-point FFT of the slot per pass; for each candidate the band
 *    around it is cut out and inverse-transformed to a 200 Hz complex baseband
 *    with tone 0 at DC. Time and frequency are then searched on the Costas
 *    arrays (to 5 ms / 0.5 Hz, then re-downsampled at the refined frequency),
 *    each symbol's 8 tones are measured with an exact 32-point DFT, and bit
 *    metrics are built from 1-, 2- and 3-symbol COHERENT combinations (the
 *    GFSK phase is continuous, so a correctly aligned signal adds in phase
 *    across symbols) plus a ratio metric — four LLR sets, each tried through
 *    belief propagation. The CRC still gates every decode.
 *
 * 2. SIGNAL SUBTRACTION between passes, in the TIME domain rather than on the
 *    waterfall: the waterfall is uint8 dB magnitude with no phase, so a
 *    signal cannot be removed from it exactly (two stations in one bin add as
 *    complex amplitudes; a dB-domain "subtract" either leaves most of the
 *    strong one or punches a hole through the weak one under it). A decoded
 *    message IS the waveform: its 79 tones are regenerated as GFSK at a
 *    frequency and start time refined on all 79 KNOWN symbols (~0.05 Hz,
 *    ~1 ms — a 1.5 Hz error would turn the phase a full circle in 0.7 s), its
 *    complex amplitude is estimated over half-symbol blocks and smoothed over
 *    about a symbol, and it is subtracted. The next pass rebuilds the
 *    waterfall and baseband from the residual, where stations that were
 *    under or beside a strong one now stand on their own.
 *
 * FT8 only: FT4's 48 ms symbol is not an integer number of 200 Hz samples and
 * there is no FT4 reference set to measure against, so FT4 keeps ft8_lib's
 * single waterfall pass (with the larger candidate/decode limits). */

#include <fft/kiss_fft.h>
#include <ft8/ldpc.h>
#include <ft8/crc.h>

#define BB_NFFT1       192000  /* 16 s at 12 kHz (the 15 s slot, zero padded) */
#define BB_NFFT2       3200    /* 16 s at 200 Hz */
#define BB_DF          (12000.0f / BB_NFFT1)   /* 0.0625 Hz per bin */
#define BB_SPS         32      /* FT8 samples per symbol at 200 Hz */
#define FT8_SPS        1920    /* FT8 samples per symbol at 12 kHz */
#define SUB_BLOCK      960     /* amplitude-estimation block (half a symbol) */

typedef kiss_fft_cpx cpxf;

typedef struct {
    ftx_message_t msg;
    float freq_hz;      /* tone-0 frequency (reported df) */
    float time_sec;     /* reported dt (historical convention: start + 0.16 s) */
    float snr;
    bool is_ap;
    bool have_ref;      /* f_ref/t_ref come from a refined sync */
    float f_ref;        /* tone-0 frequency, Hz */
    float t_ref;        /* signal start, 12 kHz samples from the slot start */
    char text[FTX_MAX_MESSAGE_LENGTH];
} ft_result_t;

/* ---- 200 Hz baseband (WSJT-X ft8_downsample) ---- */
typedef struct {
    kiss_fftr_cfg fwd;
    kiss_fft_cfg inv;
    float* tbuf;        /* BB_NFFT1 real */
    cpxf* spec;         /* BB_NFFT1/2+1 */
    cpxf* work;         /* BB_NFFT2 */
    cpxf* work2;        /* BB_NFFT2 */
    float taper[101];
    /* subtraction scratch */
    cpxf* cref;
    float* dphi;
    float* pulse;
    cpxf* blk_num;
    float* blk_den;
    cpxf* amp;
} bb_ctx_t;

static bool bb_init(bb_ctx_t* b) {
    memset(b, 0, sizeof(*b));
    b->fwd = kiss_fftr_alloc(BB_NFFT1, 0, NULL, NULL);
    b->inv = kiss_fft_alloc(BB_NFFT2, 1, NULL, NULL);
    b->tbuf = (float*)malloc(BB_NFFT1 * sizeof(float));
    b->spec = (cpxf*)malloc((BB_NFFT1 / 2 + 1) * sizeof(cpxf));
    b->work = (cpxf*)malloc(BB_NFFT2 * sizeof(cpxf));
    b->work2 = (cpxf*)malloc(BB_NFFT2 * sizeof(cpxf));
    int n_wave = FT8_NN * FT8_SPS;
    int nblk = (n_wave + SUB_BLOCK - 1) / SUB_BLOCK;
    b->cref = (cpxf*)malloc((size_t)n_wave * sizeof(cpxf));
    b->dphi = (float*)malloc((size_t)(n_wave + 2 * FT8_SPS) * sizeof(float));
    b->pulse = (float*)malloc((size_t)(3 * FT8_SPS) * sizeof(float));
    b->blk_num = (cpxf*)malloc((size_t)nblk * sizeof(cpxf));
    b->blk_den = (float*)malloc((size_t)nblk * sizeof(float));
    b->amp = (cpxf*)malloc((size_t)nblk * sizeof(cpxf));
    for (int i = 0; i <= 100; ++i) b->taper[i] = 0.5f * (1.0f + cosf(i * (float)M_PI / 100.0f));
    if (b->pulse) gfsk_pulse(FT8_SPS, 2.0f, b->pulse);
    return b->fwd && b->inv && b->tbuf && b->spec && b->work && b->work2 && b->cref && b->dphi && b->pulse &&
           b->blk_num && b->blk_den && b->amp;
}

static void bb_free(bb_ctx_t* b) {
    free(b->fwd); free(b->inv); free(b->tbuf); free(b->spec); free(b->work); free(b->work2);
    free(b->cref); free(b->dphi); free(b->pulse); free(b->blk_num); free(b->blk_den); free(b->amp);
    memset(b, 0, sizeof(*b));
}

/* Spectrum of the whole slot (zero padded to 16 s). */
static void bb_prepare(bb_ctx_t* b, const float* x, int n) {
    int m = (n < BB_NFFT1) ? n : BB_NFFT1;
    memcpy(b->tbuf, x, (size_t)m * sizeof(float));
    if (m < BB_NFFT1) memset(b->tbuf + m, 0, (size_t)(BB_NFFT1 - m) * sizeof(float));
    kiss_fftr(b->fwd, b->tbuf, b->spec);
}

/* 200 Hz complex baseband with tone 0 (at f0) moved to DC; out[BB_NFFT2].
 * Sample m is time m / 200 s from the slot start. The shift is a whole
 * number of 0.0625 Hz bins: returns the frequency actually moved to DC. */
static float bb_extract(bb_ctx_t* b, float f0, cpxf* out) {
    const float baud = 6.25f;
    int i0 = (int)lrintf(f0 / BB_DF);
    int it = (int)lrintf((f0 + 8.5f * baud) / BB_DF);
    int ib = (int)lrintf((f0 - 1.5f * baud) / BB_DF);
    if (it > BB_NFFT1 / 2) it = BB_NFFT1 / 2;
    if (ib < 1) ib = 1;
    cpxf* c1 = b->work;
    memset(c1, 0, BB_NFFT2 * sizeof(cpxf));
    int k = 0;
    for (int i = ib; i <= it && k < BB_NFFT2; ++i) c1[k++] = b->spec[i];
    if (k > 202) {
        for (int i = 0; i <= 100; ++i) {
            float w0 = b->taper[100 - i];            /* rising edge */
            c1[i].r *= w0; c1[i].i *= w0;
            float w1 = b->taper[i];                  /* falling edge */
            c1[k - 101 + i].r *= w1; c1[k - 101 + i].i *= w1;
        }
    }
    /* circular shift so bin i0 lands at index 0 */
    int sh = i0 - ib;
    const float norm = 1.0f / sqrtf((float)BB_NFFT1 * (float)BB_NFFT2);
    cpxf* tmp = b->work2;
    for (int j = 0; j < BB_NFFT2; ++j) tmp[j] = c1[((j + sh) % BB_NFFT2 + BB_NFFT2) % BB_NFFT2];
    kiss_fft(b->inv, tmp, out);
    for (int j = 0; j < BB_NFFT2; ++j) { out[j].r *= norm; out[j].i *= norm; }
    return i0 * BB_DF;
}

/* Per-symbol twiddles e^{-i 2pi (tone/32 + df/200) j}, tones 0..7. */
static void make_twiddles(float df, cpxf tw[8][BB_SPS]) {
    for (int t = 0; t < 8; ++t) {
        double ph = -2.0 * M_PI * (t / 32.0 + df / 200.0);
        cpxf w = { (float)cos(ph), (float)sin(ph) };
        cpxf z = { 1, 0 };
        for (int j = 0; j < BB_SPS; ++j) {
            tw[t][j] = z;
            float nr = z.r * w.r - z.i * w.i;
            z.i = z.r * w.i + z.i * w.r;
            z.r = nr;
        }
    }
}

static inline cpxf sym_dft(const cpxf* c, int base, const cpxf* w) {
    cpxf z = {0, 0};
    for (int j = 0; j < BB_SPS; ++j) {
        int m = base + j;
        if (m < 0 || m >= BB_NFFT2) continue;
        const cpxf x = c[m];
        z.r += x.r * w[j].r - x.i * w[j].i;
        z.i += x.r * w[j].i + x.i * w[j].r;
    }
    return z;
}

/* Energy of a known tone sequence starting at baseband index m0.
 * tones == NULL scores only the three Costas arrays (unknown message). */
static float seq_score(const cpxf* c, int m0, const uint8_t* tones, cpxf tw[8][BB_SPS]) {
    float e = 0;
    for (int k = 0; k < FT8_NN; ++k) {
        int t;
        if (tones) t = tones[k];
        else {
            int kk = (k < 7) ? k : (k >= 36 && k < 43) ? k - 36 : (k >= 72) ? k - 72 : -1;
            if (kk < 0) continue;
            t = kFT8_Costas_pattern[kk];
        }
        int base = m0 + k * BB_SPS;
        if (base + BB_SPS <= 0 || base >= BB_NFFT2) continue;
        cpxf z = sym_dft(c, base, tw[t]);
        e += z.r * z.r + z.i * z.i;
    }
    return e;
}

static float parabolic_offset(float ym, float y0, float yp) {
    float d = ym - 2 * y0 + yp;
    if (d >= 0) return 0;
    float o = 0.5f * (ym - yp) / d;
    if (o > 0.5f) o = 0.5f;
    if (o < -0.5f) o = -0.5f;
    return o;
}

/* Fine time/frequency sync around (f_est Hz, m_est at 200 Hz).
 * Leaves the baseband at the refined frequency in c. */
static void fine_sync(bb_ctx_t* b, cpxf* c, const uint8_t* tones, float f_est, int m_est,
                      int t_range, float f_range, float f_step,
                      float* f_out, float* m_out) {
    cpxf tw[8][BB_SPS];
    float f_dc = bb_extract(b, f_est, c);
    float df0 = f_est - f_dc;
    make_twiddles(df0, tw);
    float best = -1; int bm = m_est;
    for (int m = m_est - t_range; m <= m_est + t_range; ++m) {
        float e = seq_score(c, m, tones, tw);
        if (e > best) { best = e; bm = m; }
    }
    float bdf = 0;
    best = -1;
    int nf = (int)lrintf(f_range / f_step);
    float ef[81];
    if (nf > 40) nf = 40;
    for (int i = -nf; i <= nf; ++i) {
        make_twiddles(df0 + i * f_step, tw);
        float e = seq_score(c, bm, tones, tw);
        ef[i + nf] = e;
        if (e > best) { best = e; bdf = i * f_step; }
    }
    int bi = (int)lrintf(bdf / f_step) + nf;
    float ffrac = (bi > 0 && bi < 2 * nf) ? parabolic_offset(ef[bi - 1], ef[bi], ef[bi + 1]) : 0;
    float f1 = f_est + bdf + ffrac * f_step;
    f_dc = bb_extract(b, f1, c);
    make_twiddles(f1 - f_dc, tw);
    float et[9]; best = -1; int bm2 = bm;
    for (int d = -4; d <= 4; ++d) {
        et[d + 4] = seq_score(c, bm + d, tones, tw);
        if (et[d + 4] > best) { best = et[d + 4]; bm2 = bm + d; }
    }
    int ti = bm2 - bm + 4;
    float tfrac = (ti > 0 && ti < 8) ? parabolic_offset(et[ti - 1], et[ti], et[ti + 1]) : 0;
    *f_out = f1;
    *m_out = (float)bm2 + tfrac;
}

static void normalize_bmet(float* bmet, int n) {
    float s = 0, s2 = 0;
    for (int i = 0; i < n; ++i) { s += bmet[i]; s2 += bmet[i] * bmet[i]; }
    float av = s / n, av2 = s2 / n;
    float var = av2 - av * av;
    float sig = (var > 0) ? sqrtf(var) : sqrtf(av2);
    if (sig > 0) for (int i = 0; i < n; ++i) bmet[i] /= sig;
}

static void pack91(const uint8_t* bits, uint8_t* packed) {
    memset(packed, 0, FTX_LDPC_K_BYTES);
    for (int i = 0; i < FTX_LDPC_K; ++i)
        if (bits[i]) packed[i >> 3] |= (uint8_t)(0x80u >> (i & 7));
}

/* BP decode one LLR set; CRC-gated. */
static bool try_llr(const float* llr_in, const uint8_t* ap_mask, const uint8_t* ap_bits, int iters, ftx_message_t* msg) {
    float llr[FTX_LDPC_N];
    memcpy(llr, llr_in, sizeof(llr));
    if (ap_mask) {
        float apmag = 0;
        for (int i = 0; i < FTX_LDPC_N; ++i) if (fabsf(llr[i]) > apmag) apmag = fabsf(llr[i]);
        apmag *= 1.01f;
        for (int i = 0; i < FTX_LDPC_N; ++i) if (ap_mask[i]) llr[i] = ap_bits[i] ? apmag : -apmag;
    }
    uint8_t plain[FTX_LDPC_N];
    int errors = 0;
    bp_decode(llr, iters, plain, &errors);
    if (errors > 0) return false;
    uint8_t a91[FTX_LDPC_K_BYTES];
    pack91(plain, a91);
    uint16_t crc_ex = ftx_extract_crc(a91);
    a91[9] &= 0xF8;
    a91[10] &= 0x00;
    uint16_t crc_calc = ftx_compute_crc(a91, 96 - 14);
    if (crc_ex != crc_calc) return false;
    /* An all-zero payload is the degenerate codeword; never a message. */
    bool any = false;
    for (int i = 0; i < 10; ++i) if (a91[i]) { any = true; break; }
    if (!any) return false;
    msg->hash = crc_calc;
    for (int i = 0; i < 10; ++i) msg->payload[i] = a91[i];
    return true;
}

/* Refined (WSJT-X ft8b-style) demodulation of one candidate. */
static bool decode_refined(bb_ctx_t* b, cpxf* c, float f_est, float t_est_samples,
                           int iters, ftx_message_t* msg, bool* is_ap, float* f_out, float* t_out) {
    float f1, mf;
    int m_est = (int)lrintf((t_est_samples + 30.0f) / 60.0f);
    fine_sync(b, c, NULL, f_est, m_est, REF_T_RANGE, 2.5f, 0.5f, &f1, &mf);
    int m0 = (int)lrintf(mf);

    /* Symbol spectra */
    cpxf tw[8][BB_SPS];
    make_twiddles(0, tw);
    cpxf cs[FT8_NN][8];
    float s8[FT8_NN][8];
    const cpxf zero = { 0, 0 };
    for (int k = 0; k < FT8_NN; ++k) {
        for (int t = 0; t < 8; ++t) {
            cs[k][t] = sym_dft(c, m0 + k * BB_SPS, tw[t]);
            s8[k][t] = sqrtf(cs[k][t].r * cs[k][t].r + cs[k][t].i * cs[k][t].i);
        }
    }
    /* Sync quality: hard Costas matches (WSJT-X rejects nsync <= 6). */
    int nsync = 0;
    for (int blk = 0; blk < 3; ++blk) {
        for (int k = 0; k < 7; ++k) {
            const float* s = s8[blk * 36 + k];
            int am = 0;
            for (int t = 1; t < 8; ++t) if (s[t] > s[am]) am = t;
            if (am == kFT8_Costas_pattern[k]) ++nsync;
        }
    }
    if (nsync <= REF_MIN_NSYNC) return false;

    float bmeta[FTX_LDPC_N], bmetb[FTX_LDPC_N], bmetc[FTX_LDPC_N], bmetd[FTX_LDPC_N];
    memset(bmeta, 0, sizeof(bmeta)); memset(bmetb, 0, sizeof(bmetb));
    memset(bmetc, 0, sizeof(bmetc)); memset(bmetd, 0, sizeof(bmetd));
    float s2[512];
    for (int nsym = 1; nsym <= 3; ++nsym) {
        int nt = 1 << (3 * nsym);
        int ibmax = (nsym == 1) ? 2 : (nsym == 2) ? 5 : 8;
        for (int ihalf = 1; ihalf <= 2; ++ihalf) {
            for (int k = 1; k <= 29; k += nsym) {
                int ks = ((ihalf == 1) ? k + 7 : k + 43) - 1;   /* 0-based symbol */
                for (int i = 0; i < nt; ++i) {
                    int i1 = i / 64, i2 = (i & 63) / 8, i3 = i & 7;
                    if (nsym == 1) {
                        s2[i] = s8[ks][kFT8_Gray_map[i3]];
                    } else if (nsym == 2) {
                        cpxf a = cs[ks][kFT8_Gray_map[i2]];
                        cpxf bb2 = (ks + 1 < FT8_NN) ? cs[ks + 1][kFT8_Gray_map[i3]] : zero;
                        float zr = a.r + bb2.r, zi = a.i + bb2.i;
                        s2[i] = sqrtf(zr * zr + zi * zi);
                    } else {
                        cpxf a = cs[ks][kFT8_Gray_map[i1]];
                        cpxf bb2 = (ks + 1 < FT8_NN) ? cs[ks + 1][kFT8_Gray_map[i2]] : zero;
                        cpxf cc = (ks + 2 < FT8_NN) ? cs[ks + 2][kFT8_Gray_map[i3]] : zero;
                        float zr = a.r + bb2.r + cc.r, zi = a.i + bb2.i + cc.i;
                        s2[i] = sqrtf(zr * zr + zi * zi);
                    }
                }
                int i32 = (k - 1) * 3 + (ihalf - 1) * 87;   /* 0-based bit index */
                for (int ib = 0; ib <= ibmax; ++ib) {
                    int bit = ibmax - ib;
                    float max1 = -1e30f, max0 = -1e30f;
                    for (int i = 0; i < nt; ++i) {
                        if ((i >> bit) & 1) { if (s2[i] > max1) max1 = s2[i]; }
                        else { if (s2[i] > max0) max0 = s2[i]; }
                    }
                    int idx = i32 + ib;
                    if (idx >= FTX_LDPC_N) continue;
                    float bm = max1 - max0;
                    if (nsym == 1) {
                        bmeta[idx] = bm;
                        float den = (max1 > max0) ? max1 : max0;
                        bmetd[idx] = (den > 0) ? bm / den : 0;
                    } else if (nsym == 2) {
                        bmetb[idx] = bm;
                    } else {
                        bmetc[idx] = bm;
                    }
                }
            }
        }
    }
    normalize_bmet(bmeta, FTX_LDPC_N);
    normalize_bmet(bmetb, FTX_LDPC_N);
    normalize_bmet(bmetc, FTX_LDPC_N);
    normalize_bmet(bmetd, FTX_LDPC_N);
    const float scalefac = REF_SCALE;
    float* sets[4] = { bmeta, bmetb, bmetc, bmetd };
    for (int s = 0; s < 4; ++s)
        for (int i = 0; i < FTX_LDPC_N; ++i) sets[s][i] *= scalefac;

    *f_out = f1;
    *t_out = mf * 60.0f - 30.0f;   /* 32 point samples span 1860 of the 1920: window centre is 30 early */
    *is_ap = false;
    for (int s = 0; s < 4; ++s) {
        if (try_llr(sets[s], NULL, NULL, iters, msg)) return true;
    }
    /* A priori passes (see ap_refresh): strongest hypothesis first, on the
     * single-symbol and 3-symbol metrics only (the other two add time, not
     * decodes). */
    static const int ap_sets[2] = { 0, 2 };
    if (ap2_valid) {
        for (int s = 0; s < 2; ++s)
            if (try_llr(sets[ap_sets[s]], ap2_mask, ap2_bits, iters, msg)) { *is_ap = true; return true; }
    }
    if (ap1_valid) {
        for (int s = 0; s < 2; ++s)
            if (try_llr(sets[ap_sets[s]], ap1_mask, ap1_bits, iters, msg)) { *is_ap = true; return true; }
    }
    return false;
}

/* Remove one decoded FT8 signal from x[0..n). */
static void subtract_signal(bb_ctx_t* b, cpxf* c, float* x, int n, const uint8_t* tones,
                            float f_est, float t_est, bool precise) {
    const int nn = FT8_NN;
    const int sps = FT8_SPS;
    float f0, mf;
    fine_sync(b, c, tones, f_est, (int)lrintf((t_est + 30.0f) / 60.0f),
              precise ? 2 : SUB_T_RANGE, precise ? 0.5f : 2.5f, 0.1f, &f0, &mf);
    int i_start = (int)lrintf(mf * 60.0f - 30.0f);

    /* Complex GFSK reference (same phase shaping as synth_gfsk). */
    int n_wave = nn * sps;
    float* dphi = b->dphi;
    const float* pulse = b->pulse;
    const float dphi_peak = 2 * (float)M_PI / sps;
    for (int i = 0; i < n_wave + 2 * sps; ++i) dphi[i] = 2 * (float)M_PI * f0 / SAMPLE_RATE;
    for (int i = 0; i < nn; ++i) {
        int ib = i * sps;
        float a = dphi_peak * tones[i];
        if (a == 0) continue;
        for (int j = 0; j < 3 * sps; ++j) dphi[j + ib] += a * pulse[j];
    }
    for (int j = 0; j < 2 * sps; ++j) {
        dphi[j] += dphi_peak * pulse[j + sps] * tones[0];
        dphi[j + nn * sps] += dphi_peak * pulse[j] * tones[nn - 1];
    }
    {
        double phi = 0;
        int n_ramp = sps / 8;
        cpxf rot = { 1, 0 };
        for (int k = 0; k < n_wave; ++k) {
            if ((k & 255) == 0) { rot.r = (float)cos(phi); rot.i = (float)sin(phi); }
            float env = 1.0f;
            if (k < n_ramp) env = (1 - cosf(2 * (float)M_PI * k / (2 * n_ramp))) / 2;
            else if (k >= n_wave - n_ramp) env = (1 - cosf(2 * (float)M_PI * (n_wave - 1 - k) / (2 * n_ramp))) / 2;
            b->cref[k].r = env * rot.r;
            b->cref[k].i = env * rot.i;
            float d = dphi[k + sps];
            phi += d;
            /* advance the phasor by d (small-angle exact rotation) */
            float cr = cosf(d), ci = sinf(d);
            float nr = rot.r * cr - rot.i * ci;
            rot.i = rot.r * ci + rot.i * cr;
            rot.r = nr;
        }
    }

    /* Amplitude per half-symbol block: a = 2*sum(x*conj(c)) / sum(|c|^2). */
    int nblk = (n_wave + SUB_BLOCK - 1) / SUB_BLOCK;
    for (int bl = 0; bl < nblk; ++bl) {
        float nr = 0, ni = 0, d = 0;
        int k0 = bl * SUB_BLOCK, k1 = k0 + SUB_BLOCK;
        if (k1 > n_wave) k1 = n_wave;
        for (int k = k0; k < k1; ++k) {
            int i = i_start + k;
            if (i < 0 || i >= n) continue;
            const cpxf cr = b->cref[k];
            nr += x[i] * cr.r;
            ni -= x[i] * cr.i;
            d += cr.r * cr.r + cr.i * cr.i;
        }
        b->blk_num[bl].r = nr; b->blk_num[bl].i = ni; b->blk_den[bl] = d;
    }
    const int hw = SUB_SMOOTH;
    for (int bl = 0; bl < nblk; ++bl) {
        float nr = 0, ni = 0, d = 0;
        for (int o = -hw; o <= hw; ++o) {
            int q = bl + o;
            if (q < 0 || q >= nblk) continue;
            float w = (float)(hw + 1 - (o < 0 ? -o : o));
            nr += w * b->blk_num[q].r; ni += w * b->blk_num[q].i; d += w * b->blk_den[q];
        }
        if (d > 1e-9f) { b->amp[bl].r = 2 * nr / d; b->amp[bl].i = 2 * ni / d; }
        else { b->amp[bl].r = 0; b->amp[bl].i = 0; }
    }
    for (int k = 0; k < n_wave; ++k) {
        int i = i_start + k;
        if (i < 0 || i >= n) continue;
        float pos = ((float)k + 0.5f) / SUB_BLOCK - 0.5f;
        int b0 = (int)floorf(pos);
        float fr = pos - b0;
        int b1 = b0 + 1;
        if (b0 < 0) { b0 = 0; fr = 0; }
        if (b1 >= nblk) b1 = nblk - 1;
        if (b0 >= nblk) b0 = nblk - 1;
        float ar = b->amp[b0].r + (b->amp[b1].r - b->amp[b0].r) * fr;
        float ai = b->amp[b0].i + (b->amp[b1].i - b->amp[b0].i) * fr;
        const cpxf cr = b->cref[k];
        x[i] -= ar * cr.r - ai * cr.i;   /* Re(a * c) */
    }
}

/* Unpack + dedupe + record. Returns true if a new result was stored. */
static bool record_result(ft_result_t* res, int* nres, int max_res, const ftx_message_t* message, bool is_ap,
                          float freq_hz, float time_sec, float snr, bool have_ref, float f_ref, float t_ref) {
    if (*nres >= max_res) return false;
    for (int k = 0; k < *nres; ++k)
        if (memcmp(res[k].msg.payload, message->payload, sizeof(message->payload)) == 0) return false;
    char text[FTX_MAX_MESSAGE_LENGTH];
    ftx_message_offsets_t offsets;
    ftx_message_t m = *message;
    if (ftx_message_decode(&m, &hash_if, text, &offsets) != FTX_MESSAGE_RC_OK) return false;
    /* AP false-accept guard: an AP decode forced our call onto the bits, so
     * a genuine decode unpacks to text containing our call. If it doesn't
     * (rare AP+CRC coincidence), drop it rather than surface a bogus spot. */
    if (is_ap && ap_cached_mycall[0] && strstr(text, ap_cached_mycall) == NULL) return false;
    ft_result_t* r = &res[(*nres)++];
    r->msg = *message;
    r->is_ap = is_ap;
    strncpy(r->text, text, sizeof(r->text) - 1);
    r->text[sizeof(r->text) - 1] = '\0';
    r->freq_hz = freq_hz;
    r->time_sec = time_sec;
    r->snr = snr;
    r->have_ref = have_ref;
    r->f_ref = f_ref;
    r->t_ref = t_ref;
    return true;
}

/* One decode pass over x. Returns the new result count. */
static int decode_pass(const float* x, int n, ftx_protocol_t protocol, bb_ctx_t* bb, cpxf* cbuf,
                       ft_result_t* res, int nres, int max_res) {
    monitor_config_t cfg = {
        .f_min = 200,
        .f_max = 3000,
        .sample_rate = SAMPLE_RATE,
        .time_osr = (protocol == FTX_PROTOCOL_FT8) ? FT8_TIME_OSR : 2,
        .freq_osr = FREQ_OSR,
        .protocol = protocol
    };
    monitor_t mon;
    monitor_init(&mon, &cfg);
    for (int pos = 0; pos + mon.block_size <= n; pos += mon.block_size) {
        monitor_process(&mon, x + pos);
    }
    const bool refine = (protocol == FTX_PROTOCOL_FT8) && bb != NULL;
    if (bb != NULL && protocol == FTX_PROTOCOL_FT8) bb_prepare(bb, x, n);

    ftx_candidate_t* candidates = (ftx_candidate_t*)malloc((size_t)MAX_CANDIDATES * sizeof(ftx_candidate_t));
    int num_candidates = candidates ? ftx_find_candidates(&mon.wf, MAX_CANDIDATES, candidates, MIN_SCORE) : 0;
    /* Refined attempts that failed, to skip re-running the same signal. */
    float* tried_f = (float*)malloc((size_t)(num_candidates + 1) * sizeof(float));
    float* tried_t = (float*)malloc((size_t)(num_candidates + 1) * sizeof(float));
    int ntried = 0;

    for (int i = 0; i < num_candidates && nres < max_res; i++) {
        const ftx_candidate_t* cand = &candidates[i];
        float freq_hz = (mon.min_bin + cand->freq_offset + (float)cand->freq_sub / mon.wf.freq_osr) / mon.symbol_period;
        float time_wf = (cand->time_offset + (float)cand->time_sub / mon.wf.time_osr) * mon.symbol_period;
        /* Signal start implied by the waterfall frame (see monitor_process):
         * the analysis frame is centred on the symbol when it ends one and a
         * half symbols after the symbol starts. */
        float t_start = time_wf * SAMPLE_RATE + mon.subblock_size - 1.5f * mon.block_size;
        /* Reported dt keeps the historical (time_osr = 2) convention so the
         * engine's DT auto-calibration and any pinned latency are unchanged. */
        float time_sec = t_start / SAMPLE_RATE + FT8_SYMBOL_PERIOD;
        if (protocol == FTX_PROTOCOL_FT4) time_sec = time_wf;
        float snr = cand->score * 0.5f;

        /* Already decoded this signal (this pass or earlier)? */
        bool covered = false;
        for (int k = 0; k < nres; ++k) {
            float rf = res[k].have_ref ? res[k].f_ref : res[k].freq_hz;
            float rt = res[k].have_ref ? res[k].t_ref : (res[k].time_sec - FT8_SYMBOL_PERIOD) * SAMPLE_RATE;
            if (fabsf(rf - freq_hz) < COVER_HZ && fabsf(rt - t_start) < COVER_SAMPLES) { covered = true; break; }
        }
        if (covered && protocol == FTX_PROTOCOL_FT8) continue;

        ftx_message_t message;
        ftx_decode_status_t status;
        if (ftx_decode_candidate(&mon.wf, cand, LDPC_ITERATIONS, &message, &status)) {
            record_result(res, &nres, max_res, &message, false, freq_hz, time_sec, snr, false, 0, 0);
            continue;
        }
        if (refine) {
            bool skip = false;
            for (int k = 0; k < ntried; ++k)
                if (fabsf(tried_f[k] - freq_hz) < 1.6f && fabsf(tried_t[k] - t_start) < 240.0f) { skip = true; break; }
            if (!skip) {
                bool is_ap = false;
                float f_ref = 0, t_ref = 0;
                if (decode_refined(bb, cbuf, freq_hz, t_start, REF_LDPC, &message, &is_ap, &f_ref, &t_ref)) {
                    record_result(res, &nres, max_res, &message, is_ap, f_ref, t_ref / SAMPLE_RATE + FT8_SYMBOL_PERIOD,
                                  snr, true, f_ref, t_ref);
                    continue;
                }
                tried_f[ntried] = freq_hz; tried_t[ntried] = t_start; ++ntried;
                continue;   /* refined path already ran AP */
            }
            continue;
        }
        /* FT4 (no refined path): waterfall AP as before. */
        if (ap2_valid && ftx_decode_candidate_ap(&mon.wf, cand, LDPC_ITERATIONS, ap2_mask, ap2_bits, &message, &status)) {
            record_result(res, &nres, max_res, &message, true, freq_hz, time_sec, snr, false, 0, 0);
        } else if (ap1_valid && ftx_decode_candidate_ap(&mon.wf, cand, LDPC_ITERATIONS, ap1_mask, ap1_bits, &message, &status)) {
            record_result(res, &nres, max_res, &message, true, freq_hz, time_sec, snr, false, 0, 0);
        }
    }
    free(tried_f);
    free(tried_t);
    free(candidates);
    monitor_free(&mon);
    return nres;
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
    ++ht_epoch;

    int n = (int)length;
    int max_res = MAX_DECODED;
    ft_result_t* res = (ft_result_t*)calloc((size_t)max_res, sizeof(ft_result_t));
    float* resid = (float*)malloc((size_t)n * sizeof(float));
    if (!res || !resid) {
        free(res); free(resid);
        napi_throw_error(env, NULL, "ft8_native: out of memory");
        return NULL;
    }
    memcpy(resid, samples, (size_t)n * sizeof(float));

    bool ft8 = (protocol == FTX_PROTOCOL_FT8);
    bb_ctx_t bb;
    memset(&bb, 0, sizeof(bb));
    bool have_bb = false;
    if (ft8) {
        have_bb = bb_init(&bb);
        if (!have_bb) bb_free(&bb);   /* partial allocation: fall back to one waterfall pass */
    }
    cpxf* cbuf = have_bb ? (cpxf*)malloc(BB_NFFT2 * sizeof(cpxf)) : NULL;
    if (have_bb && !cbuf) { bb_free(&bb); have_bb = false; }

    int passes = (ft8 && have_bb) ? NUM_PASSES : 1;
    int nres = 0;
    for (int pass = 0; pass < passes && nres < max_res; ++pass) {
        int first_new = nres;
        nres = decode_pass(resid, n, protocol, have_bb ? &bb : NULL, cbuf, res, nres, max_res);
        if (nres == first_new || pass == passes - 1) break;
        for (int k = first_new; k < nres; ++k) {
            uint8_t tones[FT8_NN];
            ft8_encode(res[k].msg.payload, tones);
            float f_est = res[k].have_ref ? res[k].f_ref : res[k].freq_hz;
            float t_est = res[k].have_ref ? res[k].t_ref : (res[k].time_sec - FT8_SYMBOL_PERIOD) * SAMPLE_RATE;
            subtract_signal(&bb, cbuf, resid, n, tones, f_est, t_est, res[k].have_ref);
        }
    }
    if (have_bb) { bb_free(&bb); free(cbuf); }
    free(resid);

    napi_value result_array;
    napi_create_array(env, &result_array);
    for (int k = 0; k < nres; ++k) {
        const ft_result_t* r = &res[k];
        napi_value obj;
        napi_create_object(env, &obj);

        napi_value v_db, v_dt, v_df, v_text, v_ap, v_i3, v_n3;
        napi_create_double(env, (double)r->snr, &v_db);
        napi_create_double(env, (double)r->time_sec, &v_dt);
        napi_create_double(env, (double)r->freq_hz, &v_df);
        napi_create_string_utf8(env, r->text, NAPI_AUTO_LENGTH, &v_text);
        napi_get_boolean(env, r->is_ap, &v_ap);
        /* Message type (i3/n3) lets the QSO state machine recognize contest
         * exchanges (ARRL Field Day = i3:0 n3:3/4) without re-parsing the text. */
        napi_create_int32(env, (int32_t)ftx_message_get_i3(&r->msg), &v_i3);
        napi_create_int32(env, (int32_t)ftx_message_get_n3(&r->msg), &v_n3);

        napi_set_named_property(env, obj, "db", v_db);
        napi_set_named_property(env, obj, "dt", v_dt);
        napi_set_named_property(env, obj, "df", v_df);
        napi_set_named_property(env, obj, "text", v_text);
        napi_set_named_property(env, obj, "ap", v_ap);
        napi_set_named_property(env, obj, "i3", v_i3);
        napi_set_named_property(env, obj, "n3", v_n3);

        napi_set_element(env, result_array, k, obj);
    }
    free(res);
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
