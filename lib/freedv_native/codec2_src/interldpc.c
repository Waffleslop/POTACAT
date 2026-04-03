/*---------------------------------------------------------------------------*\

  FILE........: interldpc.c
  AUTHOR......: David Rowe
  DATE CREATED: April 2018

  Helper functions for LDPC-based waveforms.

\*---------------------------------------------------------------------------*/

/*
  Copyright (C) 2018 David Rowe

  All rights reserved.

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU Lesser General Public License version 2.1, as
  published by the Free Software Foundation.  This program is
  distributed in the hope that it will be useful, but WITHOUT ANY
  WARRANTY; without even the implied warranty of MERCHANTABILITY or
  FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public
  License for more details.

  You should have received a copy of the GNU Lesser General Public License
  along with this program; if not, see <http://www.gnu.org/licenses/>.
 */

#include "interldpc.h"
#include "cf_complex_def.h"
#ifdef _MSC_VER
#include <malloc.h>
#endif

#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gp_interleaver.h"
#include "mpdecode_core.h"
#include "ofdm_internal.h"

#ifdef __cplusplus
extern "C" {
#endif
void freedv_pack(unsigned char *bytes, unsigned char *bits, int nbits);
void freedv_unpack(unsigned char *bits, unsigned char *bytes, int nbits);
unsigned short freedv_crc16_unpacked(unsigned char *bits, int nbits);
#ifdef __cplusplus
}
#endif

void set_up_ldpc_constants(struct LDPC *ldpc, int code_length,
                           int parity_bits) {
  /* following provided for convenience and to match Octave variable names */

  /* these remain fixed */
  ldpc->ldpc_data_bits_per_frame = code_length - parity_bits;
  ldpc->ldpc_coded_bits_per_frame = code_length;

  /* in the case there are some unused data bits, these may be
     modified to be less that ldpc->ldpc_xxx versions above. We
     place known bits in the unused data bit positions, which make
     the code stronger, and allow us to mess with different speech
     codec bit allocations without designing new LDPC codes. */

  ldpc->data_bits_per_frame = ldpc->ldpc_data_bits_per_frame;
  ldpc->coded_bits_per_frame = ldpc->ldpc_coded_bits_per_frame;
  ldpc->protection_mode = LDPC_PROT_2020;
}

void set_data_bits_per_frame(struct LDPC *ldpc, int new_data_bits_per_frame) {
  ldpc->data_bits_per_frame = new_data_bits_per_frame;
  ldpc->coded_bits_per_frame =
      ldpc->data_bits_per_frame + ldpc->NumberParityBits;
}

/* 1' stuffing (code rate reduction) - tweak LDPC code setup for selected modes
 */
void ldpc_mode_specific_setup(struct OFDM *ofdm, struct LDPC *ldpc) {
  /* mode specific set up */
  if (!strcmp(ofdm->mode, "2020")) set_data_bits_per_frame(ldpc, 312);
  if (!strcmp(ofdm->mode, "2020B")) {
    set_data_bits_per_frame(ldpc, 156);
    ldpc->protection_mode = LDPC_PROT_2020B;
  }

  /* compute the number of data bits used in the codeword */
  int data_bits_per_frame = ofdm->bitsperpacket - ofdm->nuwbits -
                            ofdm->ntxtbits - ldpc->NumberParityBits;
  set_data_bits_per_frame(ldpc, data_bits_per_frame);
}

/* LDPC encode frame - generate parity bits and a codeword, applying the
   selected FEC protection scheme */
void ldpc_encode_frame(struct LDPC *ldpc, int codeword[],
                       unsigned char tx_bits_char[]) {
  #ifdef _MSC_VER
  unsigned char *pbits = (unsigned char *)_alloca((ldpc->NumberParityBits) * sizeof(unsigned char));
  #else
  unsigned char pbits[ldpc->NumberParityBits];
  #endif
  int codec_frame;
  int i, j;

  #ifdef _MSC_VER
  unsigned char *tx_bits_char_padded = (unsigned char *)_alloca((ldpc->ldpc_data_bits_per_frame) * sizeof(unsigned char));
  #else
  unsigned char tx_bits_char_padded[ldpc->ldpc_data_bits_per_frame];
  #endif

  switch (ldpc->protection_mode) {
    case LDPC_PROT_EQUAL:
      assert(ldpc->data_bits_per_frame == ldpc->ldpc_data_bits_per_frame);
      /* we have enough data bits to fill the codeword */
      encode(ldpc, tx_bits_char, pbits);
      break;

    case LDPC_PROT_2020:
      /* not all data bits in codeword used, so set them to known values */
      memcpy(tx_bits_char_padded, tx_bits_char, ldpc->data_bits_per_frame);
      for (i = ldpc->data_bits_per_frame; i < ldpc->ldpc_data_bits_per_frame;
           i++)
        tx_bits_char_padded[i] = 1;
      encode(ldpc, tx_bits_char_padded, pbits);
      break;

    case LDPC_PROT_2020B:
      /* We only want to protect the stage 1 VQ data bits, 0..10 in
         each 52 bit codec frame. There are 3 codec frames 3x52=156
         bits, and 56 parity bits.  We only use 11*3 = 33 bits of
         the LDPC codeword data bits, the rest are set to known
         values.
       */
      for (j = 0, codec_frame = 0; codec_frame < 3; codec_frame++)
        for (i = 0; i < 11; i++, j++)
          tx_bits_char_padded[j] = tx_bits_char[codec_frame * 52 + i];
      assert(j == 33);
      for (i = 33; i < ldpc->ldpc_data_bits_per_frame; i++)
        tx_bits_char_padded[i] = 1;
      encode(ldpc, tx_bits_char_padded, pbits);

      break;

    default:
      assert(0);
  }

  /* output codeword is concatenation of (used) data bits and parity
     bits, we don't bother sending unused (known) data bits */
  for (i = 0; i < ldpc->data_bits_per_frame; i++) codeword[i] = tx_bits_char[i];
  for (j = 0; j < ldpc->NumberParityBits; i++, j++) codeword[i] = pbits[j];
}

void qpsk_modulate_frame(COMP tx_symbols[], int codeword[], int n) {
  int s, i;
  int dibit[2];
  cf_complex qpsk_symb;

  for (s = 0, i = 0; i < n; s += 2, i++) {
    dibit[0] = codeword[s + 1] & 0x1;
    dibit[1] = codeword[s] & 0x1;
    qpsk_symb = qpsk_mod(dibit);
    tx_symbols[i].real = crealf(qpsk_symb);
    tx_symbols[i].imag = cimagf(qpsk_symb);
  }
}

/* run LDPC decoder, taking into account the FEC protection scheme */
void ldpc_decode_frame(struct LDPC *ldpc, int *parityCheckCount, int *iter,
                       uint8_t out_char[], float llr[]) {
  #ifdef _MSC_VER
  float *llr_full_codeword = (float *)_alloca((ldpc->ldpc_coded_bits_per_frame) * sizeof(float));
  #else
  #ifdef _MSC_VER
  float *llr_full_codeword = (float *)_alloca((ldpc->ldpc_coded_bits_per_frame) * sizeof(float));
  #else
  float llr_full_codeword[ldpc->ldpc_coded_bits_per_frame];
  #endif
  #endif
  int unused_data_bits =
      ldpc->ldpc_data_bits_per_frame - ldpc->data_bits_per_frame;
  #ifdef _MSC_VER
  uint8_t *out_char_ldpc = (uint8_t *)_alloca((ldpc->coded_bits_per_frame) * sizeof(uint8_t));
  #else
  #ifdef _MSC_VER
  uint8_t *out_char_ldpc = (uint8_t *)_alloca((ldpc->coded_bits_per_frame) * sizeof(uint8_t));
  #else
  uint8_t out_char_ldpc[ldpc->coded_bits_per_frame];
  #endif
  #endif
  int i, j;
  int codec_frame;

  switch (ldpc->protection_mode) {
    case LDPC_PROT_EQUAL:
      /* Equal protection all data bits in codeword
         (e.g. 700D/700E), works well with rate 0.5 codes */
      assert(ldpc->data_bits_per_frame == ldpc->ldpc_data_bits_per_frame);
      *iter = run_ldpc_decoder(ldpc, out_char, llr, parityCheckCount);
      break;
    case LDPC_PROT_2020:
      /* some data bits in codeword unused, effectively
         decreasing code rate and making FEC more powerful
         (without having to design a new code) */
      for (i = 0; i < ldpc->data_bits_per_frame; i++)
        llr_full_codeword[i] = llr[i];
      // known bits ... so really likely
      for (i = ldpc->data_bits_per_frame; i < ldpc->ldpc_data_bits_per_frame;
           i++)
        llr_full_codeword[i] = -100.0f;
      // parity bits at end
      for (i = ldpc->ldpc_data_bits_per_frame;
           i < ldpc->ldpc_coded_bits_per_frame; i++)
        llr_full_codeword[i] = llr[i - unused_data_bits];
      *iter =
          run_ldpc_decoder(ldpc, out_char, llr_full_codeword, parityCheckCount);
      break;
    case LDPC_PROT_2020B:
      /* 2020B waveform, with unequal error protection.  Only the
         stage1 VQ index of each LPCNet vocoder frames is
         protected. In this case the FEC codeword is much smaller
         than the payload data. */

      // set up LDPC codeword
      for (j = 0, codec_frame = 0; codec_frame < 3; codec_frame++)
        for (i = 0; i < 11; i++, j++)
          llr_full_codeword[j] = llr[codec_frame * 52 + i];
      // set known LDPC codeword data bits
      for (i = 33; i < ldpc->ldpc_data_bits_per_frame; i++)
        llr_full_codeword[i] = -100;
      // parity bits at end
      for (i = 0; i < ldpc->NumberParityBits; i++)
        llr_full_codeword[ldpc->ldpc_data_bits_per_frame + i] =
            llr[ldpc->data_bits_per_frame + i];
      *iter = run_ldpc_decoder(ldpc, out_char_ldpc, llr_full_codeword,
                               parityCheckCount);

      // pass through received data bits, replacing only decoded bits
      for (i = 0; i < ldpc->data_bits_per_frame; i++) {
        out_char[i] = llr[i] < 0;
      }
      for (j = 0, codec_frame = 0; codec_frame < 3; codec_frame++)
        for (i = 0; i < 11; i++, j++)
          out_char[codec_frame * 52 + i] = out_char_ldpc[j];

      break;
    default:
      assert(0);
  }
}

/* Count uncoded (raw) bit errors over frame, note we don't include UW
   of txt bits as this is done after we dissassemmble the frame */

int count_uncoded_errors(struct LDPC *ldpc, struct OFDM_CONFIG *config,
                         COMP codeword_symbols_de[], int crc16) {
  int i, Nerrs;

  int coded_syms_per_frame = ldpc->coded_bits_per_frame / config->bps;
  int coded_bits_per_frame = ldpc->coded_bits_per_frame;
  int data_bits_per_frame = ldpc->data_bits_per_frame;
  #ifdef _MSC_VER
  int *rx_bits_raw = (int *)_alloca((coded_bits_per_frame) * sizeof(int));
  #else
  #ifdef _MSC_VER
  int *rx_bits_raw = (int *)_alloca((coded_bits_per_frame) * sizeof(int));
  #else
  int rx_bits_raw[coded_bits_per_frame];
  #endif
  #endif

  /* generate test codeword from known payload data bits */

  #ifdef _MSC_VER
  int *test_codeword = (int *)_alloca((coded_bits_per_frame) * sizeof(int));
  #else
  #ifdef _MSC_VER
  int *test_codeword = (int *)_alloca((coded_bits_per_frame) * sizeof(int));
  #else
  int test_codeword[coded_bits_per_frame];
  #endif
  #endif
  #ifdef _MSC_VER
  uint16_t *r = (uint16_t *)_alloca((data_bits_per_frame) * sizeof(uint16_t));
  #else
  #ifdef _MSC_VER
  uint16_t *r = (uint16_t *)_alloca((data_bits_per_frame) * sizeof(uint16_t));
  #else
  uint16_t r[data_bits_per_frame];
  #endif
  #endif
  #ifdef _MSC_VER
  uint8_t *tx_bits = (uint8_t *)_alloca((data_bits_per_frame) * sizeof(uint8_t));
  #else
  #ifdef _MSC_VER
  uint8_t *tx_bits = (uint8_t *)_alloca((data_bits_per_frame) * sizeof(uint8_t));
  #else
  uint8_t tx_bits[data_bits_per_frame];
  #endif
  #endif

  ofdm_rand(r, data_bits_per_frame);

  for (i = 0; i < data_bits_per_frame; i++) {
    tx_bits[i] = r[i] > 16384;
  }
  if (crc16) {
    uint16_t tx_crc16 =
        freedv_crc16_unpacked(tx_bits, data_bits_per_frame - 16);
    uint8_t tx_crc16_bytes[] = {tx_crc16 >> 8, tx_crc16 & 0xff};
    freedv_unpack(tx_bits + data_bits_per_frame - 16, tx_crc16_bytes, 16);
  }
  ldpc_encode_frame(ldpc, test_codeword, tx_bits);

  for (i = 0; i < coded_syms_per_frame; i++) {
    int bits[2];
    cf_complex s =
        codeword_symbols_de[i].real + I * codeword_symbols_de[i].imag;
    qpsk_demod(s, bits);
    rx_bits_raw[config->bps * i] = bits[1];
    rx_bits_raw[config->bps * i + 1] = bits[0];
  }

  Nerrs = 0;

  for (i = 0; i < coded_bits_per_frame; i++) {
    if (test_codeword[i] != rx_bits_raw[i]) Nerrs++;
  }

  return Nerrs;
}

int count_errors(uint8_t tx_bits[], uint8_t rx_bits[], int n) {
  int i;
  int Nerrs = 0;

  for (i = 0; i < n; i++)
    if (tx_bits[i] != rx_bits[i]) Nerrs++;

  return Nerrs;
}

/* for unequal protection modes, count coded errors only in those bits that have
 * been protected */
void count_errors_protection_mode(int protection_mode, int *pNerrs,
                                  int *pNcoded, uint8_t tx_bits[],
                                  uint8_t rx_bits[], int n) {
  int i;
  int Nerrs = 0;
  int Ncoded = 0;

  switch (protection_mode) {
    case LDPC_PROT_EQUAL:
    case LDPC_PROT_2020:
      for (i = 0; i < n; i++) {
        if (tx_bits[i] != rx_bits[i]) Nerrs++;
        Ncoded++;
      }
      break;
    case LDPC_PROT_2020B:
      /* We only protect bits 0..10 in each 52 bit LPCNet codec
          frame. There are 3 codec frames 3x52=156 data bits, of
          which only 11*3 = 33 bits are protected.
        */
      for (int codec_frame = 0; codec_frame < 3; codec_frame++) {
        for (i = 0; i < 11; i++) {
          if (tx_bits[codec_frame * 52 + i] != rx_bits[codec_frame * 52 + i])
            Nerrs++;
          Ncoded++;
        }
      }
      break;
    default:
      assert(0);
  }

  *pNerrs = Nerrs;
  *pNcoded = Ncoded;
}

/*
   Given an array of tx_bits, LDPC encodes, interleaves, and OFDM modulates
 */

void ofdm_ldpc_interleave_tx(struct OFDM *ofdm, struct LDPC *ldpc,
                             cf_complex tx_sams[], uint8_t tx_bits[],
                             uint8_t txt_bits[]) {
  int Npayloadsymsperpacket = ldpc->coded_bits_per_frame / ofdm->bps;
  int Npayloadbitsperpacket = ldpc->coded_bits_per_frame;
  int Nbitsperpacket = ofdm_get_bits_per_packet(ofdm);
  #ifdef _MSC_VER
  int *codeword = (int *)_alloca((Npayloadbitsperpacket) * sizeof(int));
  #else
  #ifdef _MSC_VER
  int *codeword = (int *)_alloca((Npayloadbitsperpacket) * sizeof(int));
  #else
  int codeword[Npayloadbitsperpacket];
  #endif
  #endif
  #ifdef _MSC_VER
  COMP *payload_symbols = (COMP *)_alloca((Npayloadsymsperpacket) * sizeof(COMP));
  #else
  #ifdef _MSC_VER
  COMP *payload_symbols = (COMP *)_alloca((Npayloadsymsperpacket) * sizeof(COMP));
  #else
  COMP payload_symbols[Npayloadsymsperpacket];
  #endif
  #endif
  #ifdef _MSC_VER
  COMP *payload_symbols_inter = (COMP *)_alloca((Npayloadsymsperpacket) * sizeof(COMP));
  #else
  #ifdef _MSC_VER
  COMP *payload_symbols_inter = (COMP *)_alloca((Npayloadsymsperpacket) * sizeof(COMP));
  #else
  COMP payload_symbols_inter[Npayloadsymsperpacket];
  #endif
  #endif
  #ifdef _MSC_VER
  cf_complex *tx_symbols = (cf_complex *)_alloca((Nbitsperpacket / ofdm->bps) * sizeof(cf_complex));
  #else
  #ifdef _MSC_VER
  cf_complex *tx_symbols = (cf_complex *)_alloca((Nbitsperpacket / ofdm->bps) * sizeof(cf_complex));
  #else
  cf_complex tx_symbols[Nbitsperpacket / ofdm->bps];
  #endif
  #endif

  ldpc_encode_frame(ldpc, codeword, tx_bits);
  qpsk_modulate_frame(payload_symbols, codeword, Npayloadsymsperpacket);
  gp_interleave_comp(payload_symbols_inter, payload_symbols,
                     Npayloadsymsperpacket);
  ofdm_assemble_qpsk_modem_packet_symbols(ofdm, tx_symbols,
                                          payload_symbols_inter, txt_bits);
  ofdm_txframe(ofdm, tx_sams, tx_symbols);
}
