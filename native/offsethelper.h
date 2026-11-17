/* Etterna offset helper, native part: decodes a song as Etterna plays it and recommends its
 * offset, the same way as the helper page (src/recommend.ts). Loaded by the in-game part
 * (src/theme/offsethelper.lua) through LuaJIT's FFI; see native/README.md. */
#ifndef OFFSETHELPER_H
#define OFFSETHELPER_H

#ifdef _WIN32
#define OH_API __declspec(dllexport)
#else
#define OH_API __attribute__((visibility("default")))
#endif

typedef struct OhSong OhSong;

/* Decodes MP3, OGG Vorbis or WAV bytes on Etterna's timeline (an MP3's lead-in and "Info" frame
 * included) and computes the onset curve. Never NULL: check oh_error. */
OH_API OhSong *oh_decode(const unsigned char *data, int size);
/* The same from a file (a UTF-8 path; Etterna's Lua cannot pass binary data). Its error starts
 * with "cannot open" when there is no such file. */
OH_API OhSong *oh_decode_file(const char *utf8Path);
/* Why decoding or measuring failed, or NULL. */
OH_API const char *oh_error(const OhSong *song);
OH_API double oh_duration(const OhSong *song);
OH_API int oh_rate(const OhSong *song);

/* Measures the sync against the chart's whole beats (seconds, from beat 0 up to past the end of
 * the music) and its current offset. 0 when it worked, else see oh_error. */
OH_API int oh_measure(OhSong *song, const double *beats, int count, double offset);
/* The choices, most likely first: the offset, how far it moves the beats (ms), how strong the
 * attacks there are (0..1), and the middle 80% of the 8-beat stretches after it (ms). */
OH_API int oh_choice_count(const OhSong *song);
OH_API double oh_choice_offset(const OhSong *song, int i);
OH_API double oh_choice_shift(const OhSong *song, int i);
OH_API double oh_choice_strength(const OhSong *song, int i);
OH_API double oh_choice_spread(const OhSong *song, int i, int high);

/* The sync map of the last measurement as a 24-bit BMP (width x height pixels), and how many ms
 * either side of the beats it shows. The bytes stay valid until the next call or oh_free. */
OH_API int oh_map_bmp(OhSong *song, int width, int height, const unsigned char **bytes);
OH_API int oh_map_range(const OhSong *song);
/* The same picture written to a file (a UTF-8 path); 0 when it worked. */
OH_API int oh_map_bmp_file(OhSong *song, int width, int height, const char *utf8Path);

/* The decoded music, mono, for tests. */
OH_API const float *oh_samples(const OhSong *song, int *count);

OH_API void oh_free(OhSong *song);

#endif
