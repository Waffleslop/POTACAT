/* Variable-Length-Array support test.
 *
 * Used by Opus's CFeatureCheck.cmake to detect whether the C compiler
 * supports VLAs (declaring an array with a runtime-known size). VLAs
 * were introduced in C99 and are supported by GCC and Clang; MSVC
 * doesn't support them.
 *
 * This file ships with upstream Opus but was missing from POTACAT's
 * vendored copy in lib/rade_native/opus_src/cmake/, which broke the
 * RADE V1 native addon build on macOS and Linux every release. Windows
 * was unaffected only because we ship a prebuilt opus.lib in
 * opus_lib/win64/ instead of compiling from source. (M0XYZ report on
 * v1.5.10: FreeDV RADE failed to load — rade_native.node missing.)
 *
 * The test passes (compiles) when VLAs are available. Compilation
 * failure is also a valid outcome — Opus disables VLA usage in that
 * case and the rest of the build proceeds. Either way, this file
 * needs to exist for the CMake configure step to succeed.
 */
int main(int argc, char *argv[]) {
  int arr[argc];
  arr[0] = 0;
  return arr[0];
}
