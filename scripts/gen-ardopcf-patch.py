#!/usr/bin/env python3
"""Generate third_party/ardopcf/potacat-socket-audio.patch from the PINNED
ardopcf sources: hooks the POTACAT socket audio backend (src/SocketAudio.c)
into Waveout.c (Windows), ALSASound.c (Linux) and the Makefile. Run with the
pinned tag's src/windows/Waveout.c, src/linux/ALSASound.c and Makefile in a
directory given as argv[1]; writes the patch to argv[2]. The build applies it
with `git apply` (no Python needed on the runners)."""
import difflib, os, sys

src_dir, out_path = sys.argv[1], sys.argv[2]

def edit(name, pairs):
    p = os.path.join(src_dir, name)
    orig = open(p, encoding='utf-8', newline='').read()
    s = orig
    for old, new in pairs:
        assert s.count(old) == 1, (name, old[:60], s.count(old))
        s = s.replace(old, new)
    return orig, s

INC = '#include "common/SocketAudio.h"\n'

# ── Windows ──────────────────────────────────────────────────────────────
wo_orig, wo_new = edit('Waveout.c', [
    ('#include "common/ardopcommon.h"\n', '#include "common/ardopcommon.h"\n' + INC),
    # SendtoCard: ship the buffer to POTACAT and pace like the double buffer did.
    ("""	if (strcmp(PlaybackDevice, "NOSOUND") == 0) {
		Index = !Index;
		return &buffer[Index][0];
	}

	header[Index].dwBufferLength = n * 2;""",
     """	if (strcmp(PlaybackDevice, "NOSOUND") == 0) {
		Index = !Index;
		return &buffer[Index][0];
	}

	if (sa_active()) {
		sa_write((const short *)buf, n);
		while (sa_tx_backlog_ms() > 100)
			txSleep(10);  // keep one buffer ahead, as the sound card did
		Index = !Index;
		return &buffer[Index][0];
	}

	header[Index].dwBufferLength = n * 2;"""),
    # InitSound: no sound card at all.
    ("""int InitSound(BOOL Report)
{
	int i, ret;
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return TRUE;
""",
     """int InitSound(BOOL Report)
{
	int i, ret;
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return TRUE;
	if (sa_active())
		return sa_init(CaptureDevice, PlaybackDevice) ? TRUE : FALSE;
"""),
    # PollReceivedSamples: samples come from POTACAT.
    ("""void PollReceivedSamples()
{
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return;
""",
     """void PollReceivedSamples()
{
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return;
	if (sa_active()) {
		static short sabuf[ReceiveSize];
		int n;
		while ((n = sa_read(sabuf, ReceiveSize)) > 0) {
			if (rxwf != NULL)
				WriteWav(sabuf, n, rxwf);
			if (Capturing && Loopback == FALSE)
				ProcessNewSamples(sabuf, n);
		}
		return;
	}
"""),
    ("""void CloseSound()
{
	waveInClose(hWaveIn);""",
     """void CloseSound()
{
	if (sa_active()) {
		sa_close();
		return;
	}
	waveInClose(hWaveIn);"""),
    ("""	// Wait for all sound output to complete
	if (strcmp(PlaybackDevice, "NOSOUND") != 0) {
		while (!(header[0].dwFlags & WHDR_DONE))""",
     """	// Wait for all sound output to complete
	if (sa_active()) {
		while (sa_tx_backlog_ms() > 0)
			txSleep(10);
	} else if (strcmp(PlaybackDevice, "NOSOUND") != 0) {
		while (!(header[0].dwFlags & WHDR_DONE))"""),
])

# ── Linux ────────────────────────────────────────────────────────────────
al_orig, al_new = edit('ALSASound.c', [
    ('#include "common/ardopcommon.h"\n', '#include "common/ardopcommon.h"\n' + INC),
    ("""short * SendtoCard(short * buf, int n)
{
	if (Loopback)
	{
		// Loop back   to decode for testing

		ProcessNewSamples(buf, 1200);  // signed
	}
""",
     """short * SendtoCard(short * buf, int n)
{
	if (Loopback)
	{
		// Loop back   to decode for testing

		ProcessNewSamples(buf, 1200);  // signed
	}

	if (sa_active()) {
		sa_write(&buffer[Index][0], n);
		if (txwff != NULL)
			WriteWav(&buffer[Index][0], n, txwff);
		while (sa_tx_backlog_ms() > 100)
			txSleep(10);
		return &buffer[Index][0];
	}
"""),
    ("""int InitSound(BOOL Quiet)
{
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return (1);
""",
     """int InitSound(BOOL Quiet)
{
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return (1);
	if (sa_active())
		return sa_init(CaptureDevice, PlaybackDevice);
"""),
    ("""void PollReceivedSamples()
{
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return;
""",
     """void PollReceivedSamples()
{
	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return;
	if (sa_active()) {
		static short sabuf[ReceiveSize];
		int n;
		while ((n = sa_read(sabuf, ReceiveSize)) > 0) {
			if (rxwf != NULL)
				WriteWav(sabuf, n, rxwf);
			if (Capturing && Loopback == FALSE)
				ProcessNewSamples(sabuf, n);
		}
		return;
	}
"""),
    ("""void StopCapture()
{
	Capturing = FALSE;

	if (strcmp(PlaybackDevice, "NOSOUND") == 0)
		return;
""",
     """void StopCapture()
{
	Capturing = FALSE;

	if (strcmp(PlaybackDevice, "NOSOUND") == 0 || sa_active())
		return;
"""),
    ("""void StartCodec(char * strFault)
{
	strFault[0] = 0;
	OpenSoundCard(CaptureDevice, PlaybackDevice, 12000, 12000, strFault);
}

void StopCodec(char * strFault)
{
	strFault[0] = 0;
	CloseSoundCard();
}
""",
     """void StartCodec(char * strFault)
{
	strFault[0] = 0;
	if (sa_active()) {
		if (!sa_init(CaptureDevice, PlaybackDevice))
			strcpy(strFault, "socket audio connect failed");
		return;
	}
	OpenSoundCard(CaptureDevice, PlaybackDevice, 12000, 12000, strFault);
}

void StopCodec(char * strFault)
{
	strFault[0] = 0;
	if (sa_active()) {
		sa_close();
		return;
	}
	CloseSoundCard();
}
"""),
    ("""void CloseSound()
{
	CloseSoundCard();
}""",
     """void CloseSound()
{
	if (sa_active()) {
		sa_close();
		return;
	}
	CloseSoundCard();
}"""),
])

mk_orig, mk_new = edit('Makefile', [
    ("\tsrc/common/ARDOPC.o \\\n", "\tsrc/common/ARDOPC.o \\\n\tsrc/common/SocketAudio.o \\\n"),
])

out = []
for path, a, b in [('src/windows/Waveout.c', wo_orig, wo_new), ('src/linux/ALSASound.c', al_orig, al_new), ('Makefile', mk_orig, mk_new)]:
    out.extend(difflib.unified_diff(a.splitlines(True), b.splitlines(True), 'a/' + path, 'b/' + path))
open(out_path, 'w', encoding='utf-8', newline='').write(''.join(out))
print('wrote', out_path, sum(1 for l in out if l.startswith('+') and not l.startswith('+++')), 'added lines')
