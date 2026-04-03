/*
 * MSVC VLA compatibility — codec2 uses C99 variable-length arrays which
 * MSVC doesn't support. Replace with _alloca (stack allocation, no free needed).
 *
 * Usage: replace `float buf[n];` with `VARDECL(float, buf, n);`
 */
#ifndef CODEC2_COMPAT_H
#define CODEC2_COMPAT_H

#ifdef _MSC_VER
  #include <malloc.h>
  #define VARDECL(type, name, size) type *name = (type *)_alloca((size) * sizeof(type))
  #define VARDECL2D(type, name, rows, cols) type (*name)[cols] = (type (*)[cols])_alloca((rows) * (cols) * sizeof(type))
  /* Suppress C99 warnings */
  #pragma warning(disable: 4244 4267 4305 4996)
#else
  #define VARDECL(type, name, size) type name[size]
  #define VARDECL2D(type, name, rows, cols) type name[rows][cols]
#endif

#endif /* CODEC2_COMPAT_H */
