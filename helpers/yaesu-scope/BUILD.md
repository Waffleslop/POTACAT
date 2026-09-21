# Building `yaesu-scope`

One C file, no dependencies beyond the platform's C library. The FTDI
libraries are loaded at **run time**, so no SDK, headers or import libraries
are needed to compile — and nothing of FTDI's is redistributed.

The release workflow builds it for each platform into `assets/yaesu-scope/`
(see `.github/workflows/release.yml`). For a local build:

| Platform | Command (from this directory) |
|---|---|
| Windows, MSVC | `build.cmd` (finds Visual Studio Build Tools via `vcvars64.bat` if `cl` is not on PATH) |
| Windows, MSYS2/MinGW | `gcc -O2 -o build/yaesu-scope.exe yaesu-scope.c` |
| Linux | `./build.sh` → `gcc -O2 -o build/yaesu-scope yaesu-scope.c -ldl -lpthread -lm` |
| macOS | `./build.sh` → `clang -O2 -o build/yaesu-scope yaesu-scope.c -lpthread -lm` |

The dev checkout looks for the binary in `helpers/yaesu-scope/build/` after
`assets/yaesu-scope/`, so a local build is picked up with no configuration.

## What the operator installs

- **Windows:** the Yaesu FT-710 USB driver (which provides `ftd2xx.dll`) and
  FTDI's **LibFT4222** (`LibFT4222-64.dll`), from
  https://ftdichip.com/software-examples/ft4222h-software-examples/
- **Linux:** FTDI's LibFT4222 for Linux (`libft4222.so`, which also carries the
  D2XX entry points), then `sudo ldconfig`, plus a udev rule for the device.
- **macOS:** FTDI ships a `libft4222.dylib`; nobody has yet reported the
  FT-710 path working there, so it ships as unverified.

The radio needs **SCU-LAN10 = ON** in its menu (OPERATION SETTING > GENERAL
> 26). The setting, not the hardware box.

## Trying it without a radio

`build/yaesu-scope --synth` writes generated frames — a wandering carrier, a
breathing SSB signal and a keying CW station — so the whole POTACAT pipeline
(spawn, stream parser, pop-out, ECHOCAT) can be exercised on a desk with no
FT-710. Frames carry `kind = 1` so the UI can label them as synthetic.

`build/yaesu-scope --list` prints every FTDI device the driver can see, which
is the first thing to run on an operator's PC when the scope shows nothing.

## Capturing frames for a bug report or a fixture

    build/yaesu-scope --fps 30 > capture.bin

Stop it with Ctrl-C. The file is the exact stdout stream (8-byte header +
4096-byte frame, repeated) and can be replayed through
`lib/yaesu-scope.js` `YaesuScopeStream` unchanged.
