/* OGG Vorbis as Etterna plays it, with stb_vorbis (see offsethelper.c). */
#include "decode.h"

#define STB_VORBIS_NO_STDIO
#define STB_VORBIS_NO_PUSHDATA_API
#include "vendor/stb_vorbis.c"

/* Etterna reads OGG with libvorbisfile, which starts at the stream's first sample, as stb_vorbis does. */
const char *oh_decode_ogg(const unsigned char *data, int size, Buffer *out, int *rate) {
  int err = 0;
  stb_vorbis *v = stb_vorbis_open_memory(data, size, &err, NULL);
  if (!v) return "could not read the OGG file";
  stb_vorbis_info info = stb_vorbis_get_info(v);
  *rate = (int)info.sample_rate;
  float **channels;
  int n;
  while ((n = stb_vorbis_get_frame_float(v, NULL, &channels)) > 0) {
    for (int i = 0; i < n; ++i) {
      float s = 0;
      for (int c = 0; c < info.channels; ++c) s += channels[c][i] / (float)info.channels;
      if (!oh_push(out, s)) {
        stb_vorbis_close(v);
        return "out of memory";
      }
    }
  }
  stb_vorbis_close(v);
  return out->count ? NULL : "no audio in the OGG file";
}

