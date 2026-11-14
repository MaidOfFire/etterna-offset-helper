/* MP3 on Etterna's timeline, with minimp3 (see offsethelper.c). */
#include <string.h>

#include "decode.h"

#define MINIMP3_IMPLEMENTATION
#define MINIMP3_FLOAT_OUTPUT
#define MINIMP3_NO_SIMD
#include "vendor/minimp3.h"

int oh_push(Buffer *b, float v) {
  if (b->count == b->capacity) {
    int cap = b->capacity ? b->capacity * 2 : 1 << 20;
    float *d = (float *)realloc(b->data, (size_t)cap * sizeof(float));
    if (!d) return 0;
    b->data = d;
    b->capacity = cap;
  }
  b->data[b->count++] = v;
  return 1;
}

/* The first MP3 frame (after ID3v2 tags): its offset, length, samples per frame, and whether it
 * is a "Xing" (variable bitrate) or "Info" (constant) header frame. As mp3Lead.ts reads it. */
static const int RATES[4][3] = {{11025, 12000, 8000}, {0, 0, 0}, {22050, 24000, 16000}, {44100, 48000, 32000}};
static const int KBPS_V1[15] = {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320};
static const int KBPS_V2[15] = {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160};

static int frame_at(const unsigned char *b, int size, int p, int *bytes, int *version, int *mono) {
  if (p + 4 > size || b[p] != 0xff || (b[p + 1] & 0xe0) != 0xe0) return 0;
  int v = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, kbps = b[p + 2] >> 4, rate = (b[p + 2] >> 2) & 3;
  if (v == 1 || layer != 1 || kbps == 0 || kbps == 15 || rate == 3) return 0;
  int bitrate = (v == 3 ? KBPS_V1 : KBPS_V2)[kbps] * 1000;
  *bytes = (v == 3 ? 144 : 72) * bitrate / RATES[v][rate] + ((b[p + 2] >> 1) & 1);
  *version = v;
  *mono = (b[p + 3] >> 6) == 3;
  return 1;
}

typedef enum { TAG_NONE, TAG_XING, TAG_INFO } HeaderTag;

static int first_frame(const unsigned char *b, int size, int *pos, int *bytes, int *spf, HeaderTag *tag) {
  int p = 0, n, v, mono, n2, v2, mono2;
  while (p + 10 <= size && b[p] == 'I' && b[p + 1] == 'D' && b[p + 2] == '3') {
    int tagSize = ((b[p + 6] & 0x7f) << 21) | ((b[p + 7] & 0x7f) << 14) | ((b[p + 8] & 0x7f) << 7) | (b[p + 9] & 0x7f);
    p += 10 + tagSize + ((b[p + 5] & 0x10) ? 10 : 0);
  }
  for (int end = p + 65536 < size ? p + 65536 : size; p < end; ++p) {
    if (frame_at(b, size, p, &n, &v, &mono) && frame_at(b, size, p + n, &n2, &v2, &mono2)) {
      int side = v == 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
      int q = p + 4 + side;
      *pos = p;
      *bytes = n;
      *spf = v == 3 ? 1152 : 576;
      *tag = TAG_NONE;
      if (q + 4 <= size && !memcmp(b + q, "Xing", 4)) *tag = TAG_XING;
      if (q + 4 <= size && !memcmp(b + q, "Info", 4)) *tag = TAG_INFO;
      return 1;
    }
  }
  return 0;
}

/* Etterna (libmad) keeps everything at the start of an MP3: the encoder's lead-in and the
 * decoder's own 529 samples come out of the decoder anyway, and an "Info" frame plays as a
 * frame of silence; a "Xing" frame is skipped. So: the decoder's output as it is, after an
 * Info frame's worth of silence, without the header frame itself. */
const char *oh_decode_mp3(const unsigned char *data, int size, Buffer *out, int *rate) {
  int pos, bytes, spf;
  HeaderTag tag;
  if (!first_frame(data, size, &pos, &bytes, &spf, &tag)) return "not an MP3 or OGG file";
  if (tag != TAG_NONE) {
    if (tag == TAG_INFO)
      for (int i = 0; i < spf; ++i)
        if (!oh_push(out, 0)) return "out of memory";
    pos += bytes;
  }
  mp3dec_t dec;
  mp3dec_init(&dec);
  mp3d_sample_t pcm[MINIMP3_MAX_SAMPLES_PER_FRAME];
  mp3dec_frame_info_t info;
  *rate = 0;
  while (pos < size) {
    int samples = mp3dec_decode_frame(&dec, data + pos, size - pos, pcm, &info);
    if (!info.frame_bytes) break;
    pos += info.frame_bytes;
    if (!samples) continue;
    if (!*rate) *rate = info.hz;
    for (int i = 0; i < samples; ++i) {
      float v = 0;
      for (int c = 0; c < info.channels; ++c) v += pcm[i * info.channels + c] / (float)info.channels;
      if (!oh_push(out, v)) return "out of memory";
    }
  }
  return *rate ? NULL : "no audio in the MP3";
}

