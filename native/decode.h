/* Decoding a song as Etterna plays it (mp3.c, ogg.c): mono samples at the file's rate. */
#ifndef OH_DECODE_H
#define OH_DECODE_H

typedef struct {
  float *data;
  int count, capacity;
} Buffer;

int oh_push(Buffer *b, float v);
/* NULL when it worked, else why not. */
const char *oh_decode_mp3(const unsigned char *data, int size, Buffer *out, int *rate);
const char *oh_decode_ogg(const unsigned char *data, int size, Buffer *out, int *rate);

#endif
