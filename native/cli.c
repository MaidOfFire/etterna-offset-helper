/* A test tool around the native part: decodes a song, writes its mono samples, and measures it
 * against beat times from a file (one per line) and an offset, printing the choices.
 *   oh-cli song.mp3 [--dump samples.f32] [--beats beats.txt --offset -0.453] [--bmp map.bmp] */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "offsethelper.h"

static unsigned char *slurp(const char *path, int *size) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *b = malloc(n ? n : 1);
  *size = (int)fread(b, 1, n, f);
  fclose(f);
  return b;
}

int main(int argc, char **argv) {
  if (argc < 2) return fprintf(stderr, "usage: oh-cli song [--dump f32] [--beats txt --offset s] [--bmp file]\n"), 2;
  const char *dump = NULL, *beatsPath = NULL, *bmpPath = NULL;
  double offset = 0;
  for (int i = 2; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "--dump")) dump = argv[i + 1];
    else if (!strcmp(argv[i], "--beats")) beatsPath = argv[i + 1];
    else if (!strcmp(argv[i], "--offset")) offset = atof(argv[i + 1]);
    else if (!strcmp(argv[i], "--bmp")) bmpPath = argv[i + 1];
  }
  int size;
  unsigned char *data = slurp(argv[1], &size);
  if (!data) return fprintf(stderr, "cannot read %s\n", argv[1]), 1;
  OhSong *song = oh_decode(data, size);
  free(data);
  if (oh_error(song)) return fprintf(stderr, "decode: %s\n", oh_error(song)), 1;
  int count;
  const float *samples = oh_samples(song, &count);
  printf("rate=%d samples=%d duration=%.6f\n", oh_rate(song), count, oh_duration(song));
  if (dump) {
    FILE *f = fopen(dump, "wb");
    fwrite(samples, sizeof(float), count, f);
    fclose(f);
  }
  if (beatsPath) {
    FILE *f = fopen(beatsPath, "r");
    int n = 0, cap = 1024;
    double *beats = malloc(cap * sizeof(double)), t;
    while (fscanf(f, "%lf", &t) == 1) {
      if (n == cap) beats = realloc(beats, (cap *= 2) * sizeof(double));
      beats[n++] = t;
    }
    fclose(f);
    if (oh_measure(song, beats, n, offset)) return fprintf(stderr, "measure: %s\n", oh_error(song)), 1;
    for (int i = 0; i < oh_choice_count(song); ++i)
      printf("choice%d offset=%.6f shift=%.3f strength=%.3f spread=%.2f..%.2f\n", i + 1, oh_choice_offset(song, i), oh_choice_shift(song, i),
             oh_choice_strength(song, i), oh_choice_spread(song, i, 0), oh_choice_spread(song, i, 1));
    free(beats);
  }
  if (bmpPath) {
    const unsigned char *bmp;
    int n = oh_map_bmp(song, 768, 240, &bmp);
    FILE *f = fopen(bmpPath, "wb");
    fwrite(bmp, 1, n, f);
    fclose(f);
    printf("bmp=%d bytes range=%d\n", n, oh_map_range(song));
  }
  oh_free(song);
  return 0;
}
