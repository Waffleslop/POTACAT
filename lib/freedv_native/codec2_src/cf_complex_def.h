/*
 * Portable cf_complex type for codec2.
 * GCC/Clang: uses C99 _Complex float
 * MSVC (compiled as C++): uses std::complex<float>
 */
#ifndef CF_COMPLEX_DEF_H
#define CF_COMPLEX_DEF_H

#ifdef _MSC_VER
  /* MSVC: compile codec2 as C++ and use std::complex */
  #ifdef __cplusplus
    #include <complex>
    #include <cmath>
    typedef std::complex<float> cf_complex;
    typedef std::complex<double> cf_complexd;
    #ifndef crealf
      static inline float crealf(cf_complex z) { return z.real(); }
      static inline float cimagf(cf_complex z) { return z.imag(); }
      static inline float cabsf(cf_complex z) { return std::abs(z); }
      static inline float cargf(cf_complex z) { return std::arg(z); }
      static inline cf_complex conjf(cf_complex z) { return std::conj(z); }
      static inline cf_complex cexpf(cf_complex z) { return std::exp(z); }
      static inline cf_complex csqrtf(cf_complex z) { return std::sqrt(z); }
      static inline double creal(cf_complexd z) { return z.real(); }
      static inline double cimag(cf_complexd z) { return z.imag(); }
      static inline double cabs(cf_complexd z) { return std::abs(z); }
      static inline double carg(cf_complexd z) { return std::arg(z); }
      static inline cf_complexd conj(cf_complexd z) { return std::conj(z); }
      static inline cf_complexd cexp(cf_complexd z) { return std::exp(z); }
    #endif
    using namespace std;
    /* Allow "I" to be used for imaginary unit */
    #ifndef I
      #define I cf_complex(0.0f, 1.0f)
    #endif
  #else
    #error "codec2 on MSVC must be compiled as C++ (/TP)"
  #endif
#else
  /* GCC/Clang: use native C99 complex */
  #include <complex.h>
  #include <math.h>
  typedef float complex cf_complex;
  typedef double complex cf_complexd;
#endif

#endif /* CF_COMPLEX_DEF_H */
