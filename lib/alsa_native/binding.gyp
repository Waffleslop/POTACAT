{
  "targets": [
    {
      "target_name": "alsa_native",
      "conditions": [
        ["OS==\"linux\"", {
          "sources": ["alsa_addon.c"],
          "libraries": ["-lasound", "-lpthread"],
          /* -std=gnu11 (not strict c11) is required because the ALSA
             headers' *_alloca() macros expand to alloca(), which only
             resolves to the GCC builtin (__builtin_alloca) under GNU
             dialects. With strict -std=c11, libc may not export a real
             `alloca` symbol — HA3HZ saw exactly this at runtime on a
             Raspberry Pi: "undefined symbol: alloca" on .node dlopen.
             -D_GNU_SOURCE is belt-and-suspenders: ensures <alloca.h>
             and friends declare alloca even in less common toolchains. */
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
