{
  "targets": [
    {
      "target_name": "rade_native",
      "sources": [
        "rade_addon.c",
        "rade_src/rade_api_nopy.c",
        "rade_src/rade_enc.c",
        "rade_src/rade_dec.c",
        "rade_src/rade_enc_data.c",
        "rade_src/rade_dec_data.c",
        "rade_src/rade_dsp.c",
        "rade_src/rade_ofdm.c",
        "rade_src/rade_bpf.c",
        "rade_src/rade_acq.c",
        "rade_src/rade_tx.c",
        "rade_src/rade_rx.c",
        "rade_src/kiss_fft.c",
        "rade_src/kiss_fftr.c"
      ],
      "include_dirs": [
        "rade_src",
        "opus_include"
      ],
      "defines": [
        "HAVE_CONFIG_H",
        "IS_BUILDING_RADE_API=1",
        "RADE_EXPORT=",
        "RADE_PYTHON_FREE=1",
        "_USE_MATH_DEFINES"
      ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "<(module_root_dir)/opus_lib/win64/opus.lib",
            "-lmsvcrt"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "Optimization": 2,
              "DisableSpecificWarnings": ["4244", "4267", "4996"]
            }
          }
        }],
        ["OS=='mac'", {
          "libraries": [
            "<(module_root_dir)/opus_lib/macos/libopus.a",
            "-lm"
          ]
        }],
        ["OS=='linux'", {
          "libraries": [
            "<(module_root_dir)/opus_lib/linux/libopus.a",
            "-lm"
          ]
        }]
      ],
      "cflags": ["-std=c11", "-O2"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-std=c11", "-O2"]
      }
    }
  ]
}
