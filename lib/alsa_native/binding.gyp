{
  "targets": [
    {
      "target_name": "alsa_native",
      "conditions": [
        ["OS==\"linux\"", {
          "sources": ["alsa_addon.c"],
          "libraries": ["-lasound", "-lpthread"],
          # gyp uses Python eval() to parse this file. Only line comments
          # (hash) are valid; C-style block comments break it. See v1.6.0
          # arm64 build: my prior multi-line comment ended with the word
          # "headers'" and the apostrophe was read as an unterminated
          # string literal, silently dropping the whole alsa_native build.
          #
          # -std=gnu11 (not strict c11) is required: the ALSA headers'
          # *_alloca macros expand to alloca, which only resolves to
          # __builtin_alloca under GNU dialects. With -std=c11 libc may
          # not export `alloca` as a real symbol -- HA3HZ hit exactly
          # this at runtime ("undefined symbol: alloca" on .node dlopen).
          # -D_GNU_SOURCE is belt-and-suspenders for less common libcs.
          "cflags": ["-std=gnu11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Wextra", "-Wno-unused-parameter"]
        }],
        ["OS!=\"linux\"", {
          "sources": ["alsa_stub.c"],
          "cflags": ["-O2"]
        }]
      ]
    }
  ]
}
