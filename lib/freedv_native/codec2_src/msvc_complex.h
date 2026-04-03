/*
 * Map C99 complex to C++ std::complex for MSVC.
 * Include this BEFORE any codec2 headers that use complex float.
 */
#ifndef MSVC_COMPLEX_H
#define MSVC_COMPLEX_H

#ifdef _MSC_VER
#include <complex>
#include <cmath>

/* C99 uses "complex float", C++ uses "std::complex<float>" */
typedef std::complex<float> _Complex_float;
typedef std::complex<double> _Complex_double;

/* Redirect C99 keywords/macros */
#define complex
#define _Complex
#define I std::complex<float>(0.0f, 1.0f)

/* C99 complex functions → C++ equivalents */
#define crealf(z)   ((z).real())
#define cimagf(z)   ((z).imag())
#define cabsf(z)    std::abs(z)
#define cargf(z)    std::arg(z)
#define conjf(z)    std::conj(z)
#define cexpf(z)    std::exp(z)
#define cpowf(a,b)  std::pow(a,b)
#define csqrtf(z)   std::sqrt(z)

/* "complex float" becomes just "float" after #define complex → empty,
   but we need it to be std::complex<float>. Force it: */
/* NOTE: codec2 uses "complex float" as a type. With #define complex empty,
   this becomes just "float". We need a different approach. */
#undef complex

/* Instead: use a force-include that replaces "complex float" everywhere.
   This is handled by a /FI (force include) in binding.gyp. */

#endif /* _MSC_VER */
#endif /* MSVC_COMPLEX_H */
