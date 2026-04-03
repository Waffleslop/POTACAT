/*
 * MSVC C99 complex compatibility — MSVC doesn't support _Complex.
 * Map complex float to a struct-based implementation.
 */
#ifndef CODEC2_COMPLEX_COMPAT_H
#define CODEC2_COMPLEX_COMPAT_H

#ifdef _MSC_VER

#include <math.h>

/* MSVC doesn't have _Complex. Use a struct. */
typedef struct { float _real; float _imag; } _msvc_complex_float;
typedef struct { double _real; double _imag; } _msvc_complex_double;

#define complex
#define _Complex_I _msvc_make_complexf(0.0f, 1.0f)
#define I _Complex_I

static __inline _msvc_complex_float _msvc_make_complexf(float r, float i) {
  _msvc_complex_float c; c._real = r; c._imag = i; return c;
}

#define crealf(z) ((z)._real)
#define cimagf(z) ((z)._imag)
#define cabsf(z)  sqrtf((z)._real * (z)._real + (z)._imag * (z)._imag)
#define cargf(z)  atan2f((z)._imag, (z)._real)
#define conjf(z)  _msvc_make_complexf((z)._real, -(z)._imag)

/* Arithmetic — implemented as inline functions */
static __inline _msvc_complex_float _msvc_caddf(_msvc_complex_float a, _msvc_complex_float b) {
  return _msvc_make_complexf(a._real + b._real, a._imag + b._imag);
}
static __inline _msvc_complex_float _msvc_csubf(_msvc_complex_float a, _msvc_complex_float b) {
  return _msvc_make_complexf(a._real - b._real, a._imag - b._imag);
}
static __inline _msvc_complex_float _msvc_cmulf(_msvc_complex_float a, _msvc_complex_float b) {
  return _msvc_make_complexf(a._real * b._real - a._imag * b._imag,
                             a._real * b._imag + a._imag * b._real);
}
static __inline _msvc_complex_float _msvc_cdivf(_msvc_complex_float a, _msvc_complex_float b) {
  float denom = b._real * b._real + b._imag * b._imag;
  return _msvc_make_complexf((a._real * b._real + a._imag * b._imag) / denom,
                             (a._imag * b._real - a._real * b._imag) / denom);
}
static __inline _msvc_complex_float _msvc_cscalef(_msvc_complex_float a, float s) {
  return _msvc_make_complexf(a._real * s, a._imag * s);
}
static __inline _msvc_complex_float _msvc_cexpf(_msvc_complex_float z) {
  float e = expf(z._real);
  return _msvc_make_complexf(e * cosf(z._imag), e * sinf(z._imag));
}

/* Override "complex float" to use our struct */
#define float _msvc_complex_float

/* NOTE: This is a VERY rough compatibility layer. It handles simple cases
   but C99 complex arithmetic (a + b, a * b with complex operands) does NOT
   work with MSVC since operator overloading requires C++. The codec2 code
   that uses complex float extensively (ofdm.c, cohpsk.c) would need
   manual conversion to use explicit function calls. */

#undef float  /* Don't actually redefine float globally */

#else /* GCC/Clang: use native C99 complex */
#include <complex.h>
#endif

#endif /* CODEC2_COMPLEX_COMPAT_H */
