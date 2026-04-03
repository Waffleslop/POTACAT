/* Force C linkage for codec2 when compiled as C++ on MSVC.
   This is force-included via /FI in binding.gyp. */
#ifdef __cplusplus
extern "C" {
#endif
