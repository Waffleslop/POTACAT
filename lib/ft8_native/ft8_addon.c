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
#include <stdio.h>
#include <math.h>

#include <ft8/decode.h>
#include <ft8/encode.h>
#include <ft8/message.h>
#include <ft8/constants.h>
#include <common/monitor.h>

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

/* N-API decode function */
static napi_value Decode(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);

    if (argc < 1) {
        napi_throw_error(env, NULL, "Expected (samples, protocol?)");
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
        if (!ftx_decode_candidate(&mon.wf, cand, LDPC_ITERATIONS, &message, &status)) {
            continue;
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

        napi_set_named_property(env, obj, "db", v_db);
        napi_set_named_property(env, obj, "dt", v_dt);
        napi_set_named_property(env, obj, "df", v_df);
        napi_set_named_property(env, obj, "text", v_text);

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

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
