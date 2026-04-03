{
  "targets": [
    {
      "target_name": "freedv_native",
      "sources": [
        "freedv_addon.c",
        "codec2_src/HRA_112_112.c",
        "codec2_src/HRA_56_56.c",
        "codec2_src/HRAa_1536_512.c",
        "codec2_src/HRAb_396_504.c",
        "codec2_src/H_1024_2048_4f.c",
        "codec2_src/H_128_256_5.c",
        "codec2_src/H_16200_9720.c",
        "codec2_src/H_2064_516_sparse.c",
        "codec2_src/H_212_158.c",
        "codec2_src/H_256_512_4.c",
        "codec2_src/H_256_768_22.c",
        "codec2_src/H_4096_8192_3d.c",
        "codec2_src/codec2.c",
        "codec2_src/codec2_fft.c",
        "codec2_src/codec2_fifo.c",
        "codec2_src/codebookd.c",
        "codec2_src/codebookge.c",
        "codec2_src/codebookjmv.c",
        "codec2_src/codebooknewamp1.c",
        "codec2_src/codebooknewamp1_energy.c",
        "codec2_src/codebooknewamp2.c",
        "codec2_src/codebooknewamp2_energy.c",
        "codec2_src/codebook.c",
        "codec2_src/cohpsk.c",
        "codec2_src/dump.c",
        "codec2_src/fdmdv.c",
        "codec2_src/filter.c",
        "codec2_src/fm.c",
        "codec2_src/fmfsk.c",
        "codec2_src/freedv_1600.c",
        "codec2_src/freedv_700.c",
        "codec2_src/freedv_api.c",
        "codec2_src/freedv_data_channel.c",
        "codec2_src/freedv_fsk.c",
        "codec2_src/freedv_vhf_framing.c",
        "codec2_src/fsk.c",
        "codec2_src/golay23.c",
        "codec2_src/gp_interleaver.c",
        "codec2_src/interldpc.c",
        "codec2_src/interp.c",
        "codec2_src/kiss_fft.c",
        "codec2_src/kiss_fftr.c",
        "codec2_src/ldpc_codes.c",
        "codec2_src/linreg.c",
        "codec2_src/lpc.c",
        "codec2_src/lsp.c",
        "codec2_src/mbest.c",
        "codec2_src/modem_stats.c",
        "codec2_src/mpdecode_core.c",
        "codec2_src/newamp1.c",
        "codec2_src/nlp.c",
        "codec2_src/ofdm.c",
        "codec2_src/ofdm_mode.c",
        "codec2_src/pack.c",
        "codec2_src/phase.c",
        "codec2_src/phi0.c",
        "codec2_src/postfilter.c",
        "codec2_src/quantise.c",
        "codec2_src/reliable_text.c",
        "codec2_src/sine.c",
        "codec2_src/varicode.c"
      ],
      "include_dirs": [
        "codec2_src"
      ],
      "defines": [
        "CODEC2_MODE_EN_WB=0",
        "_USE_MATH_DEFINES",
        "GIT_HASH=\"potacat\""
      ],
      "cflags": ["-std=c99", "-O2", "-Wno-unused-variable", "-Wno-unused-function"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-std=c99", "-O2", "-Wno-unused-variable", "-Wno-unused-function"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 2,
          "CompileAs": 2,
          "AdditionalOptions": ["/permissive", "/Zc:strictStrings-"],
          "DisableSpecificWarnings": ["4244", "4267", "4996", "4576"]
        }
      }
    }
  ]
}
