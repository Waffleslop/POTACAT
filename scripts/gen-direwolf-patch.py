#!/usr/bin/env python3
"""Generate third_party/direwolf/potacat-socket-audio.patch from Dire Wolf's
pinned sources: hooks the POTACAT socket audio backend (src/audio_tcp.c,
device "tcp:<port>") into the three audio backends — audio.c (Linux ALSA /
sndio / OSS), audio_win.c (Windows waveIn/Out) and audio_portaudio.c (macOS)
— plus the enum in audio.h and the CMake source list.

Usage: gen-direwolf-patch.py <dir holding audio.c audio_win.c audio_portaudio.c
audio.h CMakeLists.txt (the src/ one)> <out.patch>

Dire Wolf's sources carry trailing blanks on many lines, so the patch is
generated against copies with every line right-stripped, and
scripts/build-winlink-helpers.sh strips the same five files the same way
before `patch -p1`. Every edit asserts its anchor occurs exactly once, so a
moved pin fails here, not with a half-applied patch."""
import difflib, os, sys

src_dir, out_path = sys.argv[1], sys.argv[2]

def edit(name, pairs):
    p = os.path.join(src_dir, name)
    raw = open(p, encoding='utf-8', newline='').read()
    orig = '\n'.join(l.rstrip() for l in raw.split('\n'))
    s = orig
    for old, new in pairs:
        assert s.count(old) == 1, (name, old[:70], s.count(old))
        s = s.replace(old, new)
    return orig, s

INC = '#include "audio_tcp.h"\n'

# ── audio.h: the input type ──────────────────────────────────────────────
h_orig, h_new = edit('audio.h', [
    ("""enum audio_in_type_e {
	AUDIO_IN_TYPE_SOUNDCARD,
	AUDIO_IN_TYPE_SDR_UDP,
	AUDIO_IN_TYPE_STDIN };""",
     """enum audio_in_type_e {
	AUDIO_IN_TYPE_SOUNDCARD,
	AUDIO_IN_TYPE_SDR_UDP,
	AUDIO_IN_TYPE_STDIN,
	AUDIO_IN_TYPE_TCP };	/* POTACAT: "tcp:<port>", both directions, audio_tcp.c */"""),
])

# ── CMake: the new source on every platform ──────────────────────────────
cm_orig, cm_new = edit('CMakeLists.txt', [
    ("  audio_stats.c\n", "  audio_stats.c\n  audio_tcp.c\n"),
])

# ── audio.c (Linux) ───────────────────────────────────────────────────────
al_orig, al_new = edit('audio.c', [
    ('#include "audio_stats.h"\n', '#include "audio_stats.h"\n' + INC),
    # recognise the device (after the udp block)
    ("""	        snprintf (pa->adev[a].adevice_in, sizeof(pa->adev[a].adevice_in), "udp:%d", DEFAULT_UDP_AUDIO_PORT);
	      }
	    }
""",
     """	        snprintf (pa->adev[a].adevice_in, sizeof(pa->adev[a].adevice_in), "udp:%d", DEFAULT_UDP_AUDIO_PORT);
	      }
	    }
	    if (tcpaudio_is_spec(pa->adev[a].adevice_in)) {
	      adev[a].g_audio_in_type = AUDIO_IN_TYPE_TCP;	/* POTACAT socket audio, both directions */
	    }
"""),
    # open it, in the input switch
    ("""   	      case AUDIO_IN_TYPE_STDIN:

	        /* Do we need to adjust any properties of stdin? */

	        adev[a].inbuf_size_in_bytes = 1024;

	        break;
""",
     """   	      case AUDIO_IN_TYPE_STDIN:

	        /* Do we need to adjust any properties of stdin? */

	        adev[a].inbuf_size_in_bytes = 1024;

	        break;

	      case AUDIO_IN_TYPE_TCP:
	        if (tcpaudio_open (pa->adev[a].adevice_in, pa->adev[a].samples_per_sec, pa->adev[a].num_channels, pa->adev[a].bits_per_sample) < 0) {
	          return (-1);
	        }
	        adev[a].inbuf_size_in_bytes = 1024;
	        break;
"""),
    # no sound-card output for tcp: wrap the whole ALSA/sndio/OSS output block
    (""" * Output device.  Only "soundcard" is supported at this time.
 */

#if USE_ALSA
	    err = snd_pcm_open (&(adev[a].audio_out_handle), audio_out_name, SND_PCM_STREAM_PLAYBACK, 0);""",
     """ * Output device.  Only "soundcard" is supported at this time.
 */

	    if (adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	      adev[a].outbuf_size_in_bytes = 1024;	/* POTACAT: transmit audio goes back down the same socket */
	    } else {
#if USE_ALSA
	    err = snd_pcm_open (&(adev[a].audio_out_handle), audio_out_name, SND_PCM_STREAM_PLAYBACK, 0);"""),
    ("""#endif

/*
 * Finally allocate buffer for each direction.
 */
	    adev[a].inbuf_ptr = malloc(adev[a].inbuf_size_in_bytes);""",
     """#endif
	    }

/*
 * Finally allocate buffer for each direction.
 */
	    adev[a].inbuf_ptr = malloc(adev[a].inbuf_size_in_bytes);"""),
    # read
    ("""	  case AUDIO_IN_TYPE_STDIN:

	    while (adev[a].inbuf_next >= adev[a].inbuf_len) {
	      //int ch, res,i;
	      int res;
""",
     """	  case AUDIO_IN_TYPE_TCP:

	    while (adev[a].inbuf_next >= adev[a].inbuf_len) {
	      int res = tcpaudio_read (adev[a].inbuf_ptr, adev[a].inbuf_size_in_bytes);
	      if (res <= 0) {
	        text_color_set(DW_COLOR_INFO);
	        dw_printf ("\\nAudio via POTACAT: the audio connection closed.  Exiting.\\n");
	        exit (0);
	      }
	      adev[a].inbuf_len = res;
	      adev[a].inbuf_next = 0;
	    }
	    break;

	  case AUDIO_IN_TYPE_STDIN:

	    while (adev[a].inbuf_next >= adev[a].inbuf_len) {
	      //int ch, res,i;
	      int res;
"""),
    # write
    ("""int audio_put (int a, int c)
{
	/* Should never be full at this point. */
""",
     """int audio_put (int a, int c)
{
	if (adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	  return (tcpaudio_put (c));
	}
	/* Should never be full at this point. */
"""),
    ("""int audio_flush (int a)
{
#if USE_ALSA
	int k;
""",
     """int audio_flush (int a)
{
	if (adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	  return (tcpaudio_flush ());
	}
#if USE_ALSA
	int k;
"""),
    ("""void audio_wait (int a)
{

	audio_flush (a);
""",
     """void audio_wait (int a)
{

	audio_flush (a);
	if (adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	  tcpaudio_wait ();	/* until the last sample has played — then PTT may drop */
	  return;
	}
"""),
    ("""	for (a = 0; a < MAX_ADEVS; a++) {

#if USE_ALSA
	  if (adev[a].audio_in_handle != NULL && adev[a].audio_out_handle != NULL) {""",
     """	for (a = 0; a < MAX_ADEVS; a++) {

	  if (adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	    tcpaudio_close ();
	    continue;
	  }
#if USE_ALSA
	  if (adev[a].audio_in_handle != NULL && adev[a].audio_out_handle != NULL) {"""),
])

# ── audio_win.c (Windows) ─────────────────────────────────────────────────
wi_orig, wi_new = edit('audio_win.c', [
    ('#include "audio_stats.h"\n', '#include "audio_stats.h"\n' + INC),
    ("""	        snprintf (pa->adev[a].adevice_in, sizeof(pa->adev[a].adevice_in), "udp:%d", DEFAULT_UDP_AUDIO_PORT);
	      }
	    }
""",
     """	        snprintf (pa->adev[a].adevice_in, sizeof(pa->adev[a].adevice_in), "udp:%d", DEFAULT_UDP_AUDIO_PORT);
	      }
	    }
	    else if (tcpaudio_is_spec(pa->adev[a].adevice_in)) {
	      A->g_audio_in_type = AUDIO_IN_TYPE_TCP;	/* POTACAT socket audio, both directions */
	    }
"""),
    # output device: not for tcp (the device type is parsed above, at the top of audio_open)
    ("""	     err = waveOutOpen (&(A->audio_out_handle), out_dev_no[a], &wf, (DWORD_PTR)out_callback, a, CALLBACK_FUNCTION);
	     if (err != MMSYSERR_NOERROR) {
	       text_color_set(DW_COLOR_ERROR);
	       dw_printf ("Could not open audio device for output.\\n");
	       return (-1);
	     }
""",
     """	     if (A->g_audio_in_type != AUDIO_IN_TYPE_TCP) {
	     err = waveOutOpen (&(A->audio_out_handle), out_dev_no[a], &wf, (DWORD_PTR)out_callback, a, CALLBACK_FUNCTION);
	     if (err != MMSYSERR_NOERROR) {
	       text_color_set(DW_COLOR_ERROR);
	       dw_printf ("Could not open audio device for output.\\n");
	       return (-1);
	     }
	     }
"""),
    # open the socket in the input switch
    ("""   	       case AUDIO_IN_TYPE_STDIN:

	         // https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/setmode?view=msvc-170
""",
     """   	       case AUDIO_IN_TYPE_TCP:
	         if (tcpaudio_open (pa->adev[a].adevice_in, pa->adev[a].samples_per_sec, pa->adev[a].num_channels, pa->adev[a].bits_per_sample) < 0) {
	           return (-1);
	         }
	         A->stream_next= 0;
	         A->stream_len = 0;
	         break;

   	       case AUDIO_IN_TYPE_STDIN:

	         // https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/setmode?view=msvc-170
"""),
    # read
    ("""   	  case AUDIO_IN_TYPE_STDIN:

	    while (A->stream_next >= A->stream_len) {
	      int res;

	      res = read(STDIN_FILENO, A->stream_data, sizeof(A->stream_data));
""",
     """   	  case AUDIO_IN_TYPE_TCP:

	    while (A->stream_next >= A->stream_len) {
	      int res = tcpaudio_read (A->stream_data, sizeof(A->stream_data));
	      if (res <= 0) {
	        text_color_set(DW_COLOR_INFO);
	        dw_printf ("\\nAudio via POTACAT: the audio connection closed.  Exiting.\\n");
	        exit (0);
	      }
	      A->stream_len = res;
	      A->stream_next = 0;
	    }
	    sample = A->stream_data[A->stream_next] & 0xff;
	    A->stream_next++;
	    return (sample);
	    break;

   	  case AUDIO_IN_TYPE_STDIN:

	    while (A->stream_next >= A->stream_len) {
	      int res;

	      res = read(STDIN_FILENO, A->stream_data, sizeof(A->stream_data));
"""),
    # write
    ("""int audio_put (int a, int c)
{
	WAVEHDR *p;

	struct adev_s *A;
	A = &(adev[a]);
""",
     """int audio_put (int a, int c)
{
	WAVEHDR *p;

	struct adev_s *A;
	A = &(adev[a]);
	if (A->g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	  return (tcpaudio_put (c));
	}
"""),
    ("""int audio_flush (int a)
{
	WAVEHDR *p;
	MMRESULT e;
	struct adev_s *A;

	A = &(adev[a]);
""",
     """int audio_flush (int a)
{
	WAVEHDR *p;
	MMRESULT e;
	struct adev_s *A;

	A = &(adev[a]);
	if (A->g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	  return (tcpaudio_flush ());
	}
"""),
    ("""void audio_wait (int a)
{

	audio_flush (a);

} /* end audio_wait */
""",
     """void audio_wait (int a)
{

	audio_flush (a);
	if (adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	  tcpaudio_wait ();	/* until the last sample has played — then PTT may drop */
	}

} /* end audio_wait */
"""),
    ("""      	  if (save_audio_config_p->adev[a].defined) {

            struct adev_s *A = &(adev[a]);

	    assert (A->audio_in_handle != 0);
	    assert (A->audio_out_handle != 0);
""",
     """      	  if (save_audio_config_p->adev[a].defined) {

            struct adev_s *A = &(adev[a]);

	    if (A->g_audio_in_type == AUDIO_IN_TYPE_TCP) {
	      tcpaudio_close ();
	      continue;
	    }
	    assert (A->audio_in_handle != 0);
	    assert (A->audio_out_handle != 0);
"""),
])

# ── audio_portaudio.c (macOS) ─────────────────────────────────────────────
pa_orig, pa_new = edit('audio_portaudio.c', [
    ('#include "audio_stats.h"\n', '#include "audio_stats.h"\n' + INC),
    ("""					snprintf (pa->adev[a].adevice_in, sizeof(pa->adev[a].adevice_in), "udp:%d", DEFAULT_UDP_AUDIO_PORT);
				}
			}
""",
     """					snprintf (pa->adev[a].adevice_in, sizeof(pa->adev[a].adevice_in), "udp:%d", DEFAULT_UDP_AUDIO_PORT);
				}
			}
			if (tcpaudio_is_spec(pa->adev[a].adevice_in)) {
				adev[a].g_audio_in_type = AUDIO_IN_TYPE_TCP;	/* POTACAT socket audio, both directions */
			}
"""),
    ("""				case AUDIO_IN_TYPE_STDIN:

					/* Do we need to adjust any properties of stdin? */

					//adev[a].inbuf_size_in_bytes = 1024;

					break;
""",
     """				case AUDIO_IN_TYPE_STDIN:

					/* Do we need to adjust any properties of stdin? */

					//adev[a].inbuf_size_in_bytes = 1024;

					break;

				case AUDIO_IN_TYPE_TCP:
					/* POTACAT socket audio: no PortAudio stream either way, so the sanity checks below see real sizes. */
					if (tcpaudio_open (pa->adev[a].adevice_in, pa->adev[a].samples_per_sec, pa->adev[a].num_channels, pa->adev[a].bits_per_sample) < 0) {
						return (-1);
					}
					adev[a].inbuf_size_in_bytes = 1024;
					adev[a].outbuf_size_in_bytes = 1024;
					break;
"""),
    ("""		case AUDIO_IN_TYPE_STDIN:

			while (adev[a].inbuf_next >= adev[a].inbuf_len) {
				int res;

				res = read(STDIN_FILENO, adev[a].inbuf_ptr, (size_t)adev[a].inbuf_size_in_bytes);
""",
     """		case AUDIO_IN_TYPE_TCP:

			while (adev[a].inbuf_next >= adev[a].inbuf_len) {
				int res = tcpaudio_read (adev[a].inbuf_ptr, adev[a].inbuf_size_in_bytes);
				if (res <= 0) {
					text_color_set(DW_COLOR_INFO);
					dw_printf ("\\nAudio via POTACAT: the audio connection closed.  Exiting.\\n");
					exit (0);
				}
				adev[a].inbuf_len = res;
				adev[a].inbuf_next = 0;
			}
			break;

		case AUDIO_IN_TYPE_STDIN:

			while (adev[a].inbuf_next >= adev[a].inbuf_len) {
				int res;

				res = read(STDIN_FILENO, adev[a].inbuf_ptr, (size_t)adev[a].inbuf_size_in_bytes);
"""),
    ("""int audio_put (int a, int c)
{
	int err = 0;
	size_t frames = 0;
""",
     """int audio_put (int a, int c)
{
	int err = 0;
	size_t frames = 0;
	if (adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
		return (c >= 0 ? tcpaudio_put (c) : tcpaudio_flush ());	/* audio_flush() calls audio_put(a, -1) */
	}
"""),
    ("""void audio_wait (int a)
{
	audio_flush(a);
""",
     """void audio_wait (int a)
{
	audio_flush(a);
	if (adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
		tcpaudio_wait ();	/* until the last sample has played — then PTT may drop */
	}
"""),
    ("""	for (a = 0; a < MAX_ADEVS; a++) {
		if(adev[a].g_audio_in_type == AUDIO_IN_TYPE_SOUNDCARD) {

			audio_wait (a);""",
     """	for (a = 0; a < MAX_ADEVS; a++) {
		if(adev[a].g_audio_in_type == AUDIO_IN_TYPE_TCP) {
			tcpaudio_close ();
		}
		if(adev[a].g_audio_in_type == AUDIO_IN_TYPE_SOUNDCARD) {

			audio_wait (a);"""),
])

out = []
for path, a, b in [('src/audio.h', h_orig, h_new), ('src/CMakeLists.txt', cm_orig, cm_new),
                   ('src/audio.c', al_orig, al_new), ('src/audio_win.c', wi_orig, wi_new),
                   ('src/audio_portaudio.c', pa_orig, pa_new)]:
    out.extend(difflib.unified_diff(a.splitlines(True), b.splitlines(True), 'a/' + path, 'b/' + path))
open(out_path, 'w', encoding='utf-8', newline='').write(''.join(out))
print('wrote', out_path, sum(1 for l in out if l.startswith('+') and not l.startswith('+++')), 'added lines')
