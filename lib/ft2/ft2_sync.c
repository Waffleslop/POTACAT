#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#include "ft2_constants.h"
#include "ft2_sync.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/*
 * Downmix signal to baseband at freq_hz, low-pass filter, and decimate 9:1.
 * Output: complex I/Q at 1333 Hz in out_i and out_q, each of length out_len.
 * out_len = num_samples / FT2_DS_FACTOR.
 */
static void downmix_decimate(const float* signal, int num_samples,
                              float freq_hz, float* out_i, float* out_q,
                              int out_len)
{
    /* Simple boxcar LPF over DS_FACTOR samples + decimate */
    float phase = 0.0f;
    float dphi = 2.0f * M_PI * freq_hz / FT2_SAMPLE_RATE;

    for (int k = 0; k < out_len; ++k)
    {
        float sum_i = 0.0f, sum_q = 0.0f;
        int base = k * FT2_DS_FACTOR;
        for (int j = 0; j < FT2_DS_FACTOR && (base + j) < num_samples; ++j)
        {
            float s = signal[base + j];
            float p = phase + dphi * j;
            sum_i += s * cosf(p);
            sum_q += s * (-sinf(p));
        }
        out_i[k] = sum_i / FT2_DS_FACTOR;
        out_q[k] = sum_q / FT2_DS_FACTOR;
        phase += dphi * FT2_DS_FACTOR;
        phase = fmodf(phase, 2.0f * M_PI);
    }
}

/*
 * Estimate the dominant tone (0-3) at a given symbol position in downsampled I/Q.
 * Uses a simple DFT at the 4 tone frequencies (0, 1, 2, 3 * baud_rate / num_tones).
 * Returns the tone index with the highest magnitude.
 */
static int estimate_tone(const float* ds_i, const float* ds_q,
                          int sym_start, int spsym)
{
    float best_mag = -1.0f;
    int best_tone = 0;

    for (int tone = 0; tone < 4; ++tone)
    {
        float freq = (float)tone / spsym; /* normalized frequency */
        float sum_r = 0.0f, sum_i = 0.0f;
        for (int j = 0; j < spsym; ++j)
        {
            int idx = sym_start + j;
            float angle = 2.0f * M_PI * freq * j;
            float cos_a = cosf(angle);
            float sin_a = sinf(angle);
            /* Complex multiply: (ds_i + j*ds_q) * (cos - j*sin) */
            sum_r += ds_i[idx] * cos_a + ds_q[idx] * sin_a;
            sum_i += ds_q[idx] * cos_a - ds_i[idx] * sin_a;
        }
        float mag = sum_r * sum_r + sum_i * sum_i;
        if (mag > best_mag)
        {
            best_mag = mag;
            best_tone = tone;
        }
    }
    return best_tone;
}

/*
 * Compute sync score for a given time offset (in downsampled samples) and frequency.
 * Checks all 4 Costas patterns at their expected positions.
 * Returns score (0-16, number of matching tones).
 */
static float compute_sync_score(const float* ds_i, const float* ds_q,
                                 int time_offset, int ds_len)
{
    /* Symbol positions of the 4 Costas groups within the frame */
    static const int sync_pos[4] = {
        FT2_SYNC_POS_A, FT2_SYNC_POS_B, FT2_SYNC_POS_C, FT2_SYNC_POS_D
    };
    int spsym = FT2_DS_SPSYM;
    int score = 0;

    for (int g = 0; g < 4; ++g)
    {
        for (int s = 0; s < FT2_LENGTH_SYNC; ++s)
        {
            int sym_idx = sync_pos[g] + s;
            int sample_start = time_offset + sym_idx * spsym;

            if (sample_start < 0 || sample_start + spsym > ds_len)
                continue;

            int tone = estimate_tone(ds_i, ds_q, sample_start, spsym);
            if (tone == kFT2_Costas[g][s])
                score++;
        }
    }
    return (float)score;
}

/* Comparison function for qsort: descending score */
static int cmp_candidates(const void* a, const void* b)
{
    float sa = ((const ft2_candidate_t*)a)->score;
    float sb = ((const ft2_candidate_t*)b)->score;
    if (sb > sa) return 1;
    if (sb < sa) return -1;
    return 0;
}

int ft2_find_candidates(const float* signal, int num_samples,
                        ft2_candidate_t* candidates, int max_candidates)
{
    int ds_len = num_samples / FT2_DS_FACTOR;
    float* ds_i = (float*)calloc(ds_len, sizeof(float));
    float* ds_q = (float*)calloc(ds_len, sizeof(float));
    if (!ds_i || !ds_q) { free(ds_i); free(ds_q); return 0; }

    int n_cand = 0;
    /* Temporary storage: collect all candidates above threshold, then keep best */
    int max_tmp = 2000;
    ft2_candidate_t* tmp = (ft2_candidate_t*)calloc(max_tmp, sizeof(ft2_candidate_t));
    if (!tmp) { free(ds_i); free(ds_q); return 0; }
    int n_tmp = 0;

    /* Sweep frequency */
    for (float freq = FT2_FREQ_MIN; freq <= FT2_FREQ_MAX; freq += FT2_FREQ_STEP)
    {
        downmix_decimate(signal, num_samples, freq, ds_i, ds_q, ds_len);

        /* Frame is 105 symbols * 32 ds_samples/symbol = 3360 ds_samples */
        int frame_ds = FT2_NN * FT2_DS_SPSYM;

        /* Sweep time offsets */
        int max_offset = ds_len - frame_ds;
        int time_step = FT2_DS_SPSYM / 4; /* quarter-symbol steps */
        if (time_step < 1) time_step = 1;

        for (int t = 0; t <= max_offset; t += time_step)
        {
            float score = compute_sync_score(ds_i, ds_q, t, ds_len);
            if (score >= FT2_MIN_SYNC_SCORE && n_tmp < max_tmp)
            {
                tmp[n_tmp].freq_hz = freq;
                tmp[n_tmp].time_offset = (float)(t * FT2_DS_FACTOR);
                tmp[n_tmp].score = score;
                n_tmp++;
            }
        }
    }

    /* Sort by score descending */
    qsort(tmp, n_tmp, sizeof(ft2_candidate_t), cmp_candidates);

    /* De-duplicate: remove candidates too close in time+freq */
    for (int i = 0; i < n_tmp && n_cand < max_candidates; ++i)
    {
        int dup = 0;
        for (int j = 0; j < n_cand; ++j)
        {
            float df = fabsf(tmp[i].freq_hz - candidates[j].freq_hz);
            float dt = fabsf(tmp[i].time_offset - candidates[j].time_offset);
            if (df < FT2_FREQ_STEP * 1.5f && dt < FT2_SAMPLES_PER_SYM * 2.0f)
            {
                dup = 1;
                break;
            }
        }
        if (!dup)
        {
            candidates[n_cand++] = tmp[i];
        }
    }

    free(tmp);
    free(ds_i);
    free(ds_q);
    return n_cand;
}
