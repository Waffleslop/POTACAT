{
  "targets": [
    {
      "target_name": "ft8_native",
      "sources": [
        "ft8_addon.c",
        "ft8_lib/ft8/constants.c",
        "ft8_lib/ft8/crc.c",
        "ft8_lib/ft8/decode.c",
        "ft8_lib/ft8/encode.c",
        "ft8_lib/ft8/ldpc.c",
        "ft8_lib/ft8/message.c",
        "ft8_lib/ft8/text.c",
        "ft8_lib/common/monitor.c",
        "ft8_lib/fft/kiss_fft.c",
        "ft8_lib/fft/kiss_fftr.c"
      ],
      "include_dirs": [
        "ft8_lib"
      ],
      "cflags": ["-std=c11", "-O2"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-std=c11", "-O2"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 2
        }
      }
    }
  ]
}
