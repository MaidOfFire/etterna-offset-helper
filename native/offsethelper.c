/* Etterna offset helper, native part (see offsethelper.h). The measuring is a line-for-line port
 * of the page's TypeScript, so both give the same answers:
 *   decoding   src/analysis/mp3Lead.ts (Etterna's timeline), here straight from the decoders
 *   onsets     src/analysis/sharpOnsets.ts, src/analysis/fft.ts
 *   sync       src/analysis/syncMap.ts (localOffsets), src/analysis/syncFix.ts (offset mode)
 *   choices    src/recommend.ts (wideColumns, profileShape, fixNear, recommendFromCurve)
 *   picture    drawMap in src/main.ts, without its text (the theme writes the labels). */

#include "offsethelper.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#include "decode.h"

/* Charts put the beat this long after the peak of the sharp onset curve (sharpOnsets.ts). */
#define BEAT_AFTER_ONSET_PEAK 0.0015
/* The sync map's window (syncMap.ts) and the wider one for the choices (recommend.ts). */
#define SYNC_RANGE_MS 60
#define SYNC_ROWS (2 * SYNC_RANGE_MS + 1)
#define WIDE_MS 100
#define WIDE_ROWS (2 * WIDE_MS + 1)
#define RIVAL_STRENGTH 0.8
#define SAME_PLACE_MS 10
#define SPAN 8
#define MAX_CHOICES 3

typedef struct {
  double offset, shift, strength, spread[2];
  int used;
} Choice;

typedef struct {
  double time, offset; /* offset is NAN where the stretch is unclear */
} Point;

struct OhSong {
  const char *error;
  float *samples; /* mono */
  int count, rate;
  float *env; /* the sharp onset curve: env[i] at start + i * step seconds */
  int envCount;
  double start, step;
  /* The last measurement. */
  double offset;
  Choice choices[MAX_CHOICES];
  int choiceCount;
  double *beats; /* the chart's beats within the music */
  int beatCount;
  float *columns; /* each beat's onsets out to ±WIDE_MS, scaled to its maximum */
  Point *points;  /* the sync along the song against the current beats */
  int pointCount;
  unsigned char *bmp;
};

/* -------------------------------------------------------------------------------------------- */
/* The sharp onset curve (sharpOnsets.ts, fft.ts), in the same float/double steps. */

static void fft(float *re, float *im, int n) {
  for (int i = 1, j = 0; i < n; ++i) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      float t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    double ang = -2 * M_PI / len, wr = cos(ang), wi = sin(ang);
    for (int i = 0; i < n; i += len) {
      double cr = 1, ci = 0;
      for (int k = 0; k < len / 2; ++k) {
        int a = i + k, b = a + len / 2;
        double tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = (float)(re[a] - tr);
        im[b] = (float)(im[a] - ti);
        re[a] = (float)(re[a] + tr);
        im[a] = (float)(im[a] + ti);
        double ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

static int sharp_onsets(OhSong *s) {
  enum { N = 256, H = 32 };
  int step = s->rate > 32000 ? 2 : 1;
  double rate = (double)s->rate / step;
  int frames = (s->count / step - N) / H;
  if (frames < 0) frames = 0;
  float window[N], re[N], im[N], prevBuf[N / 2] = {0}, curBuf[N / 2] = {0};
  float *prev = prevBuf, *cur = curBuf;
  for (int i = 0; i < N; ++i) window[i] = (float)(0.5 - 0.5 * cos(2 * M_PI * i / (N - 1)));
  s->env = (float *)calloc(frames ? frames : 1, sizeof(float));
  if (!s->env) return 0;
  for (int f = 0; f < frames; ++f) {
    int off = f * H * step;
    for (int i = 0; i < N; ++i) {
      double v = 0;
      for (int k = 0; k < step; ++k) v += s->samples[off + i * step + k];
      re[i] = (float)(v / step * window[i]);
      im[i] = 0;
    }
    fft(re, im, N);
    double flux = 0;
    for (int k = 1; k < N / 2; ++k) {
      float mag = (float)log1p(100 * hypot(re[k], im[k]));
      cur[k] = mag;
      if (mag > prev[k]) flux += (double)mag - prev[k];
    }
    s->env[f] = (float)flux;
    float *t = prev;
    prev = cur;
    cur = t;
  }
  s->envCount = frames;
  s->start = N / 2 / rate;
  s->step = H / rate;
  return 1;
}

/* The curve at time t (linearly interpolated, 0 outside it). */
static double at(const OhSong *s, double t) {
  double p = (t - s->start) / s->step;
  double fi = floor(p);
  if (fi < 0 || fi + 1 >= s->envCount) return 0;
  int i = (int)fi;
  return s->env[i] + ((double)s->env[i + 1] - s->env[i]) * (p - i);
}

/* -------------------------------------------------------------------------------------------- */
/* Measuring (syncMap.ts localOffsets, syncFix.ts fitSync in offset mode, recommend.ts). */

static int cmp_double(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}

/* The upper median, as `sorted[floor(n / 2)]` in the TypeScript. */
static double median(double *v, int n) {
  qsort(v, n, sizeof(double), cmp_double);
  return v[n / 2];
}

/* The sync over stretches of SPAN beats: where the summed onsets around the beats peak (ms). */
static int local_offsets(const OhSong *s, const double *beats, int n, Point *out) {
  int count = 0;
  double sum[SYNC_ROWS], sorted[SYNC_ROWS];
  for (int i = 0; i + SPAN <= n; i += SPAN) {
    memset(sum, 0, sizeof sum);
    for (int j = i; j < i + SPAN; ++j)
      for (int k = 0; k < SYNC_ROWS; ++k) sum[k] += (float)at(s, beats[j] - BEAT_AFTER_ONSET_PEAK + (k - SYNC_RANGE_MS) / 1000.0);
    int top = 0;
    for (int r = 1; r < SYNC_ROWS; ++r)
      if (sum[r] > sum[top]) top = r;
    memcpy(sorted, sum, sizeof sum);
    double med = median(sorted, SYNC_ROWS);
    Point p = {(beats[i] + beats[i + SPAN - 1]) / 2, NAN};
    if (top != 0 && top != SYNC_ROWS - 1 && sum[top] >= 1.5 * med) {
      double a = sum[top - 1], b = sum[top], c = sum[top + 1];
      double frac = a - 2 * b + c < 0 ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
      p.offset = top - SYNC_RANGE_MS + frac;
    }
    out[count++] = p;
  }
  return count;
}

/* The beats moved by `ms`, kept within the music (as songBeats over the moved timing). */
static int moved_beats(const OhSong *s, const double *beats, int n, double ms, double *out) {
  double duration = (double)s->count / s->rate;
  int count = 0;
  for (int i = 0; i < n; ++i) {
    double t = beats[i] + ms / 1000;
    if (t > duration) break;
    if (t >= 0) out[count++] = t;
  }
  return count;
}

/* The fix that puts the beats on the attacks around `nearMs`; 0 when too few clear stretches. */
static int fix_near(const OhSong *s, const double *beats, int n, double nearMs, Choice *c, Point *pointsOut, int *pointCount) {
  double *moved = (double *)malloc((size_t)(n ? n : 1) * sizeof(double));
  Point *points = (Point *)malloc((size_t)(n / SPAN + 1) * sizeof(Point));
  double *clear = (double *)malloc((size_t)(n / SPAN + 1) * sizeof(double));
  double *kept = (double *)malloc((size_t)(n / SPAN + 1) * sizeof(double));
  int ok = 0;
  if (moved && points && clear && kept) {
    int m = moved_beats(s, beats, n, nearMs, moved);
    int np = local_offsets(s, moved, m, points);
    if (pointsOut) {
      memcpy(pointsOut, points, (size_t)np * sizeof(Point));
      *pointCount = np;
    }
    /* Clear stretches, without spikes (off their neighbours' median by over 8 ms). */
    int nc = 0;
    for (int i = 0; i < np; ++i)
      if (!isnan(points[i].offset)) clear[nc++] = points[i].offset;
    int nk = 0;
    for (int i = 0; i < nc; ++i) {
      double around[5];
      int nn = 0;
      for (int j = i - 2 < 0 ? 0 : i - 2; j < nc && j < i + 3; ++j) around[nn++] = clear[j];
      if (fabs(clear[i] - median(around, nn)) <= 8) kept[nk++] = clear[i];
    }
    if (nk >= 4) {
      double typical = median(kept, nk); /* sorts kept */
      c->offset = (s->offset - nearMs / 1000) - typical / 1000;
      c->shift = (s->offset - c->offset) * 1000;
      c->used = nk;
      /* The stretches relative to where this fix puts the beats. */
      int na = 0;
      for (int i = 0; i < np; ++i)
        if (!isnan(points[i].offset)) clear[na++] = points[i].offset - typical;
      qsort(clear, na, sizeof(double), cmp_double);
      int lo = (int)floor(0.1 * na), hi = (int)floor(0.9 * na);
      c->spread[0] = clear[lo < na ? lo : na - 1];
      c->spread[1] = clear[hi < na ? hi : na - 1];
      ok = 1;
    }
  }
  free(moved);
  free(points);
  free(clear);
  free(kept);
  return ok;
}

static int settled_fix_near(const OhSong *s, const double *beats, int n, double nearMs, Choice *c) {
  if (!fix_near(s, beats, n, nearMs, c, NULL, NULL)) return 0;
  if (fabs(c->shift - nearMs) < 2) return 1;
  Choice again;
  if (fix_near(s, beats, n, c->shift, &again, NULL, NULL)) *c = again;
  return 1;
}

typedef struct {
  double ms, height;
} Peak;

static int cmp_peak(const void *a, const void *b) {
  double x = ((const Peak *)a)->height, y = ((const Peak *)b)->height;
  return x > y ? -1 : x < y;
}

static double height_at(const double *smooth, double base, double ms) {
  double p = ms + WIDE_MS;
  if (p < 0) p = 0;
  if (p > WIDE_ROWS - 1) p = WIDE_ROWS - 1;
  int i = (int)floor(p);
  if (i > WIDE_ROWS - 2) i = WIDE_ROWS - 2;
  double v = smooth[i] + (smooth[i + 1] - smooth[i]) * (p - i) - base;
  return v > 0 ? v : 0;
}

static int cmp_choice(const void *a, const void *b) {
  double x = ((const Choice *)a)->strength, y = ((const Choice *)b)->strength;
  return x > y ? -1 : x < y;
}

int oh_measure(OhSong *s, const double *beats, int count, double offset) {
  if (!s || (s->error && !s->env)) return -1;
  s->error = NULL;
  s->offset = offset;
  s->choiceCount = 0;
  free(s->beats);
  free(s->columns);
  free(s->points);
  s->beats = (double *)malloc((size_t)(count ? count : 1) * sizeof(double));
  if (!s->beats) return s->error = "out of memory", -1;
  s->beatCount = moved_beats(s, beats, count, 0, s->beats);
  int n = s->beatCount;

  /* Each beat's onsets out to ±WIDE_MS, and their sum over the song (wideColumns). */
  s->columns = (float *)calloc((size_t)(n ? n : 1) * WIDE_ROWS, sizeof(float));
  s->points = (Point *)malloc((size_t)(n / SPAN + 1) * sizeof(Point));
  if (!s->columns || !s->points) return s->error = "out of memory", -1;
  double profile[WIDE_ROWS] = {0};
  float col[WIDE_ROWS];
  for (int i = 0; i < n; ++i) {
    float max = 0;
    for (int k = 0; k < WIDE_ROWS; ++k) {
      col[k] = (float)at(s, s->beats[i] - BEAT_AFTER_ONSET_PEAK + (k - WIDE_MS) / 1000.0);
      profile[k] += col[k];
      if (col[k] > max) max = col[k];
    }
    if (max > 0)
      for (int k = 0; k < WIDE_ROWS; ++k) s->columns[i * WIDE_ROWS + k] = col[k] / max;
  }

  /* profileShape: lightly smoothed, as heights above its median, and its peaks. */
  double smooth[WIDE_ROWS], sorted[WIDE_ROWS];
  for (int k = 0; k < WIDE_ROWS; ++k)
    smooth[k] = (profile[k > 0 ? k - 1 : 0] + profile[k] + profile[k < WIDE_ROWS - 1 ? k + 1 : WIDE_ROWS - 1]) / 3;
  memcpy(sorted, smooth, sizeof smooth);
  double base = median(sorted, WIDE_ROWS);
  Peak peaks[WIDE_ROWS];
  int np = 0;
  for (int k = 3; k < WIDE_ROWS - 3; ++k) {
    int top = 1;
    for (int j = k - SAME_PLACE_MS < 0 ? 0 : k - SAME_PLACE_MS; j <= k + SAME_PLACE_MS && j < WIDE_ROWS && top; ++j)
      if (smooth[j] > smooth[k]) top = 0;
    if (top && smooth[k] > base) peaks[np++] = (Peak){k - WIDE_MS, smooth[k] - base};
  }
  qsort(peaks, np, sizeof(Peak), cmp_peak);

  /* The sync map's answer, or, when it finds nothing within ±60 ms, the strongest place further out. */
  Choice here, first;
  int haveHere = fix_near(s, beats, count, 0, &here, s->points, &s->pointCount);
  int haveFirst = haveHere ? settled_fix_near(s, beats, count, here.shift, &first) : np ? settled_fix_near(s, beats, count, peaks[0].ms, &first) : 0;
  if (!haveHere) s->pointCount = 0;
  if (!haveFirst) return s->error = "too few clear attacks on the beats to go by: check the BPM first", -1;
  Choice found[MAX_CHOICES];
  int nf = 0;
  found[nf++] = first;
  double mainHeight = height_at(smooth, base, first.shift);
  /* Other places nearly as strong (or stronger) could be the beat as well. */
  for (int p = 0; p < np && nf < MAX_CHOICES; ++p) {
    int same = 0;
    for (int f = 0; f < nf; ++f)
      if (fabs(found[f].shift - peaks[p].ms) <= SAME_PLACE_MS) same = 1;
    if (peaks[p].height < RIVAL_STRENGTH * mainHeight || same) continue;
    Choice alt;
    if (!settled_fix_near(s, beats, count, peaks[p].ms, &alt)) continue;
    for (int f = 0; f < nf; ++f)
      if (fabs(found[f].shift - alt.shift) <= SAME_PLACE_MS) same = 1;
    if (!same) found[nf++] = alt;
  }
  /* Strongest first: where the attacks pile up most over the whole song is the likeliest beat. */
  double top = 1e-9;
  for (int f = 0; f < nf; ++f) top = fmax(top, height_at(smooth, base, found[f].shift));
  for (int p = 0; p < np; ++p) top = fmax(top, peaks[p].height);
  for (int f = 0; f < nf; ++f) found[f].strength = height_at(smooth, base, found[f].shift) / top;
  qsort(found, nf, sizeof(Choice), cmp_choice);
  memcpy(s->choices, found, (size_t)nf * sizeof(Choice));
  s->choiceCount = nf;
  return 0;
}

/* -------------------------------------------------------------------------------------------- */
/* The sync map as a picture (drawMap in main.ts, without text). */

static void blend(unsigned char *px, double r, double g, double b, double a) {
  px[0] = (unsigned char)(px[0] + (r - px[0]) * a + 0.5);
  px[1] = (unsigned char)(px[1] + (g - px[1]) * a + 0.5);
  px[2] = (unsigned char)(px[2] + (b - px[2]) * a + 0.5);
}

int oh_map_range(const OhSong *s) {
  return s && s->choiceCount == 1 && fabs(s->choices[0].shift) <= 45 ? 60 : WIDE_MS;
}

int oh_map_bmp(OhSong *s, int w, int h, const unsigned char **bytes) {
  if (!s || !s->choiceCount || w <= 0 || h <= 0) return 0;
  int range = oh_map_range(s);
  double duration = (double)s->count / s->rate, scale = h / 120.0; /* lines are as thick as on a 120 px map, scaled */
  unsigned char *rgb = (unsigned char *)calloc((size_t)w * h * 3, 1);
  if (!rgb) return 0;
  /* One pixel column per slice of the song: the beats in it averaged, or else the last beat before it. */
  float column[WIDE_ROWS];
  int b = 0;
  for (int x = 0; x < w; ++x) {
    double t1 = (double)(x + 1) / w * duration;
    int n = 0;
    memset(column, 0, sizeof column);
    while (b < s->beatCount && s->beats[b] < t1) {
      for (int k = 0; k < WIDE_ROWS; ++k) column[k] += s->columns[b * WIDE_ROWS + k];
      ++n;
      ++b;
    }
    if (!n && b > 0 && t1 - s->beats[b - 1] < 2) {
      memcpy(column, s->columns + (b - 1) * WIDE_ROWS, sizeof column);
      n = 1;
    }
    for (int y = 0; y < h; ++y) {
      int row = WIDE_MS - range + (int)lround(2 * range * (1 - (y + 0.5) / h));
      double v = n ? column[row] / n : 0;
      unsigned char g = (unsigned char)lround(18 + 237 * v * v);
      unsigned char *p = rgb + ((size_t)y * w + x) * 3;
      p[0] = p[1] = p[2] = g;
    }
  }
#define Y_OF(ms) (h / 2.0 - (ms) / (double)range * (h / 2.0))
  int thin = scale < 1 ? 1 : (int)lround(scale);
  /* Reference lines, then the chart's beats now. */
  static const int narrowLines[] = {-30, -10, 10, 30}, wideLines[] = {-75, -50, -25, 25, 50, 75};
  const int *lines = range == 60 ? narrowLines : wideLines;
  int nl = range == 60 ? 4 : 6;
  for (int l = 0; l < nl; ++l)
    for (int y = (int)Y_OF(lines[l]), d = 0; d < thin; ++d)
      if (y + d >= 0 && y + d < h)
        for (int x = 0; x < w; ++x) blend(rgb + ((size_t)(y + d) * w + x) * 3, 255, 255, 255, 0.10);
  for (int y = (int)Y_OF(0), d = 0; d < thin; ++d)
    if (y + d >= 0 && y + d < h)
      for (int x = 0; x < w; ++x) blend(rgb + ((size_t)(y + d) * w + x) * 3, 74, 143, 217, 0.75);
  /* Where each choice puts the beats: dashed. */
  int dash = (int)lround(5 * scale), gap = (int)lround(4 * scale), margin = (int)lround(14 * scale);
  for (int c = 0; c < s->choiceCount; ++c) {
    int y = (int)Y_OF(s->choices[c].shift);
    for (int d = 0; d < thin; ++d)
      if (y + d >= 0 && y + d < h)
        for (int x = margin; x < w - margin; ++x)
          if ((x - margin) % (dash + gap) < dash) blend(rgb + ((size_t)(y + d) * w + x) * 3, 255, 170, 40, 0.9);
  }
  /* The measured sync over every 8 beats, where it is clear: a line about 1.5 px thick (scaled). */
  double radius = 0.75 * scale;
  for (int i = 0; i + 1 < s->pointCount; ++i) {
    if (isnan(s->points[i].offset) || isnan(s->points[i + 1].offset)) continue;
    double x0 = s->points[i].time / duration * w, y0 = Y_OF(s->points[i].offset);
    double x1 = s->points[i + 1].time / duration * w, y1 = Y_OF(s->points[i + 1].offset);
    int steps = (int)(hypot(x1 - x0, y1 - y0) * 2) + 1;
    for (int k = 0; k <= steps; ++k) {
      double cx = x0 + (x1 - x0) * k / steps, cy = y0 + (y1 - y0) * k / steps;
      for (int y = (int)floor(cy - radius); y <= (int)ceil(cy + radius); ++y)
        for (int x = (int)floor(cx - radius); x <= (int)ceil(cx + radius); ++x)
          if (x >= 0 && x < w && y >= 0 && y < h && hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius + 0.5)
            blend(rgb + ((size_t)y * w + x) * 3, 90, 209, 255, 0.9);
    }
  }
#undef Y_OF
  /* A 24-bit BMP, rows bottom-up, each padded to 4 bytes. */
  int row = (w * 3 + 3) & ~3, size = 54 + row * h;
  free(s->bmp);
  s->bmp = (unsigned char *)calloc((size_t)size, 1);
  if (!s->bmp) {
    free(rgb);
    return 0;
  }
  unsigned char *o = s->bmp;
#define LE32(at, v) (o[at] = (unsigned char)(v), o[at + 1] = (unsigned char)((v) >> 8), o[at + 2] = (unsigned char)((v) >> 16), o[at + 3] = (unsigned char)((v) >> 24))
  o[0] = 'B';
  o[1] = 'M';
  LE32(2, size);
  LE32(10, 54);
  LE32(14, 40);
  LE32(18, w);
  LE32(22, h);
  o[26] = 1;
  o[28] = 24;
  LE32(34, row * h);
#undef LE32
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      const unsigned char *p = rgb + ((size_t)y * w + x) * 3;
      unsigned char *q = o + 54 + (size_t)(h - 1 - y) * row + x * 3;
      q[0] = p[2];
      q[1] = p[1];
      q[2] = p[0];
    }
  free(rgb);
  *bytes = s->bmp;
  return size;
}

/* -------------------------------------------------------------------------------------------- */

OhSong *oh_decode(const unsigned char *data, int size) {
  OhSong *s = (OhSong *)calloc(1, sizeof(OhSong));
  if (!s) return NULL;
  Buffer out = {0};
  int ogg = size >= 4 && !memcmp(data, "OggS", 4);
  s->error = ogg ? oh_decode_ogg(data, size, &out, &s->rate) : oh_decode_mp3(data, size, &out, &s->rate);
  s->samples = out.data;
  s->count = out.count;
  if (!s->error && !sharp_onsets(s)) s->error = "out of memory";
  return s;
}

/* A file by a UTF-8 path (Windows paths in Etterna may hold any characters). */
static FILE *open_utf8(const char *path, const char *mode) {
#ifdef _WIN32
  wchar_t wpath[4096], wmode[8];
  if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, 4096) || !MultiByteToWideChar(CP_UTF8, 0, mode, -1, wmode, 8)) return NULL;
  return _wfopen(wpath, wmode);
#else
  return fopen(path, mode);
#endif
}

OhSong *oh_decode_file(const char *path) {
  FILE *f = open_utf8(path, "rb");
  if (!f) {
    OhSong *s = (OhSong *)calloc(1, sizeof(OhSong));
    if (s) s->error = "cannot open the music file";
    return s;
  }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *data = (unsigned char *)malloc(n > 0 ? (size_t)n : 1);
  size_t got = data ? fread(data, 1, (size_t)n, f) : 0;
  fclose(f);
  OhSong *s = data ? oh_decode(data, (int)got) : NULL;
  free(data);
  return s;
}

int oh_map_bmp_file(OhSong *s, int width, int height, const char *path) {
  const unsigned char *bytes;
  int n = oh_map_bmp(s, width, height, &bytes);
  if (n <= 0) return -1;
  FILE *f = open_utf8(path, "wb");
  if (!f) return -1;
  size_t wrote = fwrite(bytes, 1, (size_t)n, f);
  fclose(f);
  return wrote == (size_t)n ? 0 : -1;
}

const char *oh_error(const OhSong *s) { return s ? s->error : "out of memory"; }
double oh_duration(const OhSong *s) { return s && s->rate ? (double)s->count / s->rate : 0; }
int oh_rate(const OhSong *s) { return s ? s->rate : 0; }
int oh_choice_count(const OhSong *s) { return s ? s->choiceCount : 0; }
static const Choice *choice(const OhSong *s, int i) { return s && i >= 0 && i < s->choiceCount ? &s->choices[i] : NULL; }
double oh_choice_offset(const OhSong *s, int i) { return choice(s, i) ? choice(s, i)->offset : NAN; }
double oh_choice_shift(const OhSong *s, int i) { return choice(s, i) ? choice(s, i)->shift : NAN; }
double oh_choice_strength(const OhSong *s, int i) { return choice(s, i) ? choice(s, i)->strength : NAN; }
double oh_choice_spread(const OhSong *s, int i, int high) { return choice(s, i) ? choice(s, i)->spread[high ? 1 : 0] : NAN; }

const float *oh_samples(const OhSong *s, int *count) {
  if (count) *count = s ? s->count : 0;
  return s ? s->samples : NULL;
}

void oh_free(OhSong *s) {
  if (!s) return;
  free(s->samples);
  free(s->env);
  free(s->beats);
  free(s->columns);
  free(s->points);
  free(s->bmp);
  free(s);
}
