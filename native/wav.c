/* WAV as Etterna plays it (RageSoundReader_WAV): PCM of 8 to 32 bits, 32-bit float, Microsoft
 * 4-bit ADPCM, one or two channels, from the first sample of the data chunk; an MP3 inside a WAV
 * goes to the MP3 decoder, as Etterna hands it to libmad. Other formats (WAVE_FORMAT_EXTENSIBLE
 * among them) Etterna does not play, so neither does this. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "decode.h"

static int u16(const unsigned char *b) { return b[0] | (b[1] << 8); }
static int16_t s16(const unsigned char *b) { return (int16_t)(b[0] | (b[1] << 8)); }
static int32_t s32(const unsigned char *b) { return (int32_t)((uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24)); }

static char message[96];

/* Microsoft ADPCM, block by block, as Etterna decodes it (including its 16-bit wraparound). */
static const char *adpcm(const unsigned char *d, int size, const unsigned char *extra, int extraSize, int channels, int blockAlign, Buffer *out) {
  if (extraSize < 4) return "ADPCM WAV without its coefficients";
  int framesPerBlock = s16(extra), numCoef = s16(extra + 2);
  if (numCoef <= 0 || extraSize < 4 + 4 * numCoef || framesPerBlock < 2 || blockAlign <= 7 * channels) return "ADPCM WAV with a broken header";
  static const int adaption[16] = {230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230};
  for (int at = 0; at + 7 * channels <= size; at += blockAlign) {
    const unsigned char *p = d + at;
    int pred[2], coef1[2], coef2[2];
    int16_t delta[2], samp1[2], samp2[2];
    for (int c = 0; c < channels; ++c) pred[c] = (int8_t)*p++;
    for (int c = 0; c < channels; ++c, p += 2) delta[c] = s16(p);
    for (int c = 0; c < channels; ++c, p += 2) samp1[c] = s16(p);
    for (int c = 0; c < channels; ++c, p += 2) samp2[c] = s16(p);
    for (int c = 0; c < channels; ++c) {
      if (pred[c] >= numCoef || pred[c] < 0) pred[c] = 0;
      coef1[c] = s16(extra + 4 + 4 * pred[c]);
      coef2[c] = s16(extra + 6 + 4 * pred[c]);
    }
    int left = blockAlign - 7 * channels;
    if (left > size - (int)(p - d)) left = size - (int)(p - d);
    if (left <= 0) break;
    float frame = 0;
    for (int c = 0; c < channels; ++c) frame += samp2[c] / 32768.0f / channels;
    if (!oh_push(out, frame)) return "out of memory";
    frame = 0;
    for (int c = 0; c < channels; ++c) frame += samp1[c] / 32768.0f / channels;
    if (!oh_push(out, frame)) return "out of memory";
    int bufSize = 0, done = 0;
    uint8_t buf = 0;
    for (int i = 2; !done && i < framesPerBlock; ++i) {
      frame = 0;
      int c;
      for (c = 0; !done && c < channels; ++c) {
        if (!bufSize) {
          if (!left) {
            done = 1;
            continue;
          }
          buf = *p++;
          --left;
          bufSize = 2;
        }
        int8_t err = (int8_t)buf >> 4;
        uint8_t errU = buf >> 4;
        buf <<= 4;
        --bufSize;
        int32_t predicted = (samp1[c] * coef1[c] + samp2[c] * coef2[c]) / (1 << 8);
        if (predicted < -32768) predicted = -32768;
        if (predicted > 32767) predicted = 32767;
        int16_t sample = (int16_t)((int16_t)predicted + delta[c] * err);
        frame += sample / 32768.0f / channels;
        delta[c] = (int16_t)((delta[c] * adaption[errU]) / (1 << 8));
        if (delta[c] < 16) delta[c] = 16;
        samp2[c] = samp1[c];
        samp1[c] = sample;
      }
      if (c == channels && !oh_push(out, frame)) return "out of memory";
    }
  }
  return NULL;
}

const char *oh_decode_wav(const unsigned char *data, int size, Buffer *out, int *rate) {
  if (size < 12 || memcmp(data, "RIFF", 4) || memcmp(data + 8, "WAVE", 4)) return "not a WAV file";
  const unsigned char *fmt = NULL, *body = NULL;
  int fmtSize = 0, bodySize = 0;
  for (int p = 12; p + 8 <= size && !(fmt && body);) {
    int chunk = s32(data + p + 4);
    const unsigned char *at = data + p + 8;
    if (!memcmp(data + p, "fmt ", 4)) fmt = at, fmtSize = chunk < 0 || chunk > size - (p + 8) ? size - (p + 8) : chunk;
    if (!memcmp(data + p, "data", 4)) {
      body = at;
      /* A data chunk longer than the file (cut short, or streamed with no size) ends with the file. */
      bodySize = chunk < 0 || chunk > size - (p + 8) ? size - (p + 8) : chunk;
    }
    if (chunk < 0) break;
    p += 8 + ((chunk + 1) & ~1);
  }
  if (!fmt || fmtSize < 16 || !body) return "a WAV file without its format or data";
  int tag = u16(fmt), channels = u16(fmt + 2), blockAlign = u16(fmt + 12), bits = u16(fmt + 14);
  *rate = s32(fmt + 4);
  if (channels < 1 || channels > 2) return snprintf(message, sizeof message, "a WAV with %d channels (Etterna plays 1 or 2)", channels), message;
  if (*rate < 4000 || *rate > 100000) return "a WAV with an invalid sample rate";
  if (tag == 85) {
    *rate = 0;
    return oh_decode_mp3(body, bodySize, out, rate);
  }
  if (tag == 2) {
    if (bits != 4) return "an ADPCM WAV that is not 4-bit";
    return adpcm(body, bodySize, fmt + 18, fmtSize - 18, channels, blockAlign, out);
  }
  if (tag != 1 && tag != 3) return snprintf(message, sizeof message, "a WAV in a format Etterna does not play (%d)", tag), message;
  int bytes = (bits + 7) / 8;
  if (bytes < 1 || bytes > 4 || (tag == 3 && bits != 32)) return "a WAV with an unsupported sample size";
  int frames = bodySize / (bytes * channels);
  for (int i = 0; i < frames; ++i) {
    float v = 0;
    for (int c = 0; c < channels; ++c) {
      const unsigned char *s = body + (i * channels + c) * bytes;
      float x;
      if (tag == 3) {
        union { uint32_t u; float f; } u = {(uint32_t)s32(s)};
        x = u.f;
      } else if (bytes == 1) x = (s[0] - 128) / 128.0f;
      else if (bytes == 2) x = s16(s) / 32768.0f;
      else if (bytes == 3) x = (int32_t)(((uint32_t)s[0] << 8) | ((uint32_t)s[1] << 16) | ((uint32_t)s[2] << 24)) / 2147483648.0f;
      else x = s32(s) / 2147483648.0f;
      v += x / channels;
    }
    if (!oh_push(out, v)) return "out of memory";
  }
  return frames ? NULL : "no audio in the WAV file";
}
