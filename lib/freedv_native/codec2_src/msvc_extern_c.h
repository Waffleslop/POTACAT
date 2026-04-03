/* Force C linkage for all codec2 functions when compiled as C++ on MSVC.
   This prevents name mangling mismatches between translation units. */
#ifdef __cplusplus
#define CODEC2_EXTERN_C extern "C"
#else
#define CODEC2_EXTERN_C
#endif
