#ifndef _INCLUDE_FT2_CONSTANTS_H_
#define _INCLUDE_FT2_CONSTANTS_H_

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* FT2 protocol parameters */
#define FT2_SAMPLE_RATE     12000
#define FT2_SYMBOL_PERIOD   (1.0f / 41.667f)   /* ~0.024 s */
#define FT2_SAMPLES_PER_SYM 288                 /* 12000 / 41.667 */
#define FT2_SYMBOL_BT       1.0f                /* GFSK bandwidth-time product */
#define FT2_NUM_TONES       4                   /* 4-GFSK */

#define FT2_NN              105                 /* total symbols per frame */
#define FT2_ND              87                  /* data symbols (3 x 29) */
#define FT2_NR              2                   /* ramp symbols (first + last) */
#define FT2_LENGTH_SYNC     4                   /* symbols per Costas group */
#define FT2_NUM_SYNC        4                   /* number of Costas groups */
#define FT2_SYNC_OFFSET     33                  /* offset between sync groups */

#define FT2_TX_SAMPLES      30240               /* 105 * 288 */
#define FT2_INPUT_SAMPLES   45000               /* 3.75s buffer */
#define FT2_CYCLE_SEC       3.8f

/* Sync symbol positions within the 105-symbol frame */
/* ramp(1) + costas_a(4) + data(29) + costas_b(4) + data(29) + costas_c(4) + data(29) + costas_d(4) + ramp(1) */
#define FT2_SYNC_POS_A      1
#define FT2_SYNC_POS_B      34
#define FT2_SYNC_POS_C      67
#define FT2_SYNC_POS_D      100

/* Data symbol positions: 5-33, 38-66, 71-99 */
#define FT2_DATA_POS_0      5
#define FT2_DATA_POS_1      38
#define FT2_DATA_POS_2      71

/* Costas arrays for FT2 (same as FT4) */
static const uint8_t kFT2_Costas[4][4] = {
    { 0, 1, 3, 2 },
    { 1, 0, 2, 3 },
    { 2, 3, 1, 0 },
    { 3, 2, 0, 1 }
};

/* Gray code map: bit-pair -> tone (same as FT4) */
static const uint8_t kFT2_Gray_map[4] = { 0, 1, 3, 2 };

/* Inverse Gray map: tone -> bit-pair */
static const uint8_t kFT2_Gray_inv[4] = { 0, 1, 3, 2 };

/*
 * FT2 XOR randomization vector — 77 bits packed into 10 bytes (MSB first).
 * Verified bit-by-bit against Decodium Fortran source.
 * The same sequence as FT4 uses — FT2 inherits this from the FTx family.
 */
static const uint8_t kFT2_XOR_sequence[10] = {
    0x4Au, /* 01001010 */
    0x5Eu, /* 01011110 */
    0x89u, /* 10001001 */
    0xB4u, /* 10110100 */
    0xB0u, /* 10110000 */
    0x8Au, /* 10001010 */
    0x79u, /* 01111001 */
    0x55u, /* 01010101 */
    0xBEu, /* 10111110 */
    0x28u, /* 00101000 */
};

/* Decoder tuning */
#define FT2_LDPC_ITERS      25
#define FT2_MAX_CANDIDATES  120
#define FT2_MAX_DECODED     50
#define FT2_MIN_SYNC_SCORE  10      /* minimum sum of 16 Costas correlations */
#define FT2_FREQ_MIN        200.0f
#define FT2_FREQ_MAX        3000.0f
#define FT2_FREQ_STEP       20.0f   /* Hz step for coarse frequency search */

/* Downsampled decoder parameters */
#define FT2_DS_RATE         1333    /* downsampled rate (12000/9) */
#define FT2_DS_FACTOR       9       /* decimation factor */
#define FT2_DS_SPSYM        32      /* samples per symbol after decimation */
#define FT2_FFT_SIZE        32      /* FFT size for tone extraction */

#ifdef __cplusplus
}
#endif

#endif /* _INCLUDE_FT2_CONSTANTS_H_ */
