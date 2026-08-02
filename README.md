<div align="center">

# argano

**A recording that was interrupted still has everything in it. It just has no table of contents.**

argano writes the table of contents back, from the raw bytes, without re-encoding a single frame.

**[Repair a file in your browser](https://eugenionerelli.github.io/argano/)** · nothing is uploaded

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](#install)
[![Licence](https://img.shields.io/badge/licence-MIT-green)](LICENSE)
[![Codecs](https://img.shields.io/badge/H.264%20%C2%B7%20H.265-AAC%20%C2%B7%20PCM-orange)](#what-it-handles)

</div>

---

## What has actually gone wrong

An MP4 or MOV file is two things. `mdat` holds the encoded picture and sound.
`moov` is the index: which byte each frame starts at, how long it lasts, what
order to show it in. A recorder writes the media as it goes and the index at
the very end, in one go, when you press stop.

Interrupt it and you get a file that is 99 percent intact and completely
unplayable. Every frame is there. Nothing can find them.

That is what happens when the battery dies, the app is force quit, the phone
runs out of storage, or the recording hits a bug that stops it cleanly writing.
It is also what Photo Booth on macOS does to long recordings, which is the
file this was written for.

## What argano does about it

It reads the media with no index at all. It works out where each frame begins
by parsing the frames themselves, splits the sound into its frames with a real
decoder, puts both back on a clock, writes a new index, and then checks its own
work by reading the result back the way a strict player would.

The media bytes in the output are the media bytes from the input, unchanged.
There is no re-encode, so there is no quality lost and no waiting for one. The
original file is never modified.

```bash
argano inspect broken.mov                      # what is wrong with it
argano repair broken.mov -r working.mov        # fix it
argano gui                                     # the same thing in a window
```

There is also a [web page](https://eugenionerelli.github.io/argano/) that does
the same job with nothing installed. It is the same engine, ported to run in
the browser: the file is read from disk by the page itself and never sent
anywhere, and after the first visit the page works with the network off.

## The reference file

Most of the time argano needs a second file: any video that plays, from the
same camera or the same app. It is not used for its content. It is read for
the codec settings. Those live in the index, which is exactly what the broken
file has lost.

A good reference is one from the same device at the same recording setting.
Length does not matter, so a two second clip is fine. If the broken file still
has enough of its own index left, no reference is needed and argano says so.

Some encoders repeat their settings inside the stream, and phone cameras
usually do. Where that is true argano finds them itself and no second file is
needed at all.

## What it handles

|            | Supported                                    |
| ---------- | -------------------------------------------- |
| Containers | MP4, MOV, M4V                                |
| Video      | H.264, H.265                                 |
| Audio      | AAC, uncompressed PCM                        |
| Damage     | index never written, index destroyed, file truncated, noise written over the media |

## What it will not do

It will not repair a file whose media is genuinely gone. If the bytes were
never written or were overwritten, nothing recovers them, and a tool that
claims otherwise is guessing pixels.

It will not touch AV1, VP9, ProRes, MKV or AVI. The approach carries over to
all of them and none of it is written yet.

It will not fix a video that plays with visible corruption. That is damage
inside the encoded picture, which is a different problem from a missing index.

It will not re-encode anything to make a file play. If argano cannot index
your media it says so rather than producing something that opens.

It cannot always keep the sound. Where damage sits inside a run of audio, the
frames under it are gone, and argano says how many.

## Install

```bash
pip install argano
```

The repair itself is pure Python with no dependencies.

**For sound, install libfaad.** AAC frames carry no length of their own, so
finding where each one ends takes a decoder that reports how many bytes it
consumed. This is the one thing that is not a Python package.

```bash
brew install faad2            # macOS
sudo apt install libfaad2     # Debian, Ubuntu
```

Without it the picture is still recovered in full and argano tells you the
sound was left out.

**For the window**, `pip install 'argano[gui]'`. The command line does not need
it.

`ffmpeg` is optional. When it is on the system argano decodes the finished file
end to end as a last check.

## Using it

```bash
# What is wrong, before changing anything
argano inspect "broken.mov"

# Repair, writing "broken (repaired).mov" beside the original
argano repair "broken.mov" --reference "working.mov"

# Somewhere else, and with the index at the front for uploading
argano repair "broken.mov" -r "working.mov" -o fixed.mp4 --faststart

# No sound in the recording, so a frame rate has to be assumed
argano repair "silent.mov" -r "working.mov" --fps 30
```

`inspect` names the accident and shows the shape of the file, so you can see
that the media is all there before you spend the time.

As a library:

```python
from argano import repair, RepairOptions

result = repair("broken.mov", RepairOptions(reference="working.mov"))
print(result.video_frames, result.duration, result.scan.damage)
```

## How it works

Four things in here are worth explaining, because each one is a place where the
obvious approach quietly fails.

### Frames are found by reading them, not by trusting a length

Inside an MP4 each unit of video is written with its length in front. Walking
the stream is a matter of reading a length and stepping over that many bytes,
which works right up until the moment it does not: four bytes of compressed
picture read as a length give a plausible number often enough that a walk
following lengths alone will step into the middle of a frame and keep going,
producing samples that are noise.

So argano reads the slice header behind each length. The first three fields are
Exp-Golomb coded and have to agree with settings the file declared. Getting
three of those in a row on random data is rare enough that the walk stays on
the rails for hundreds of thousands of frames, and a position that is not the
start of a picture is rejected on the spot.

### Timing comes from the sound, not from a frame rate

Phones and screen recorders write variable frame rate video: the interval
between frames moves with the scene. Assume a constant rate over fifteen
minutes of it and the picture and the sound visibly part company long before
the end.

Every compressed audio frame is a fixed number of samples, so counting the
frames in a run gives its exact duration with no estimate involved. A recorder
interleaves the streams as it writes, which means the audio between two runs of
video measures the time those frames took. argano anchors each run of video to
the audio beside it, so the two stay together for as long as the recording
lasts, and it never has to know the frame rate at all.

### A decoder that has seen damage stays broken

libfaad handed a stretch of noise does not simply fail on it. Its state carries
prediction and windowing from the previous frame, and once that has absorbed
nonsense every frame afterwards decodes wrong, silently, reporting no error.
Segmenting a long recording with one decoder gives a few hundred frames and
then a wall of failures that look like damage and are not.

A fresh decoder for every run of audio, and again after every error, is the
whole fix. It is also why argano can keep going through damage that stops other
tools: what looks like the end of the audio is usually the decoder, not the
file.

The same trap has a second form, in the video. Asking "are these bytes a frame"
must not change anything, because the scanner asks it at every offset inside a
damaged region and most of those bytes are not video. An early version adopted
any codec settings it met on the way, which let a run of noise hand it a
fabricated set, overwrite the real ones, and make every genuine frame after
that point fail to validate. The frames were all still there. It reported them
missing.

### The output is checked as a stranger would read it

This one is here because of a bug that shipped.

A track header written four bytes too long still parses. Every field is still
in the right order to anything reading by name, and QuickTime reads by name and
cross-checks against the codec, so the file plays perfectly. Players that read
by offset take the last cell of the display matrix as the picture width,
and show the video stretched about ten to one. VLC did. WhatsApp did. YouTube
refused to finish processing it. On the machine that made it, it looked
finished.

So every box with a fixed layout is checked against its known length before it
is written, and the finished file is read back from its byte offsets and
checked against three sources that have to agree: the lengths the format fixes,
the picture size the encoder wrote into its own parameter sets, and the sample
tables' own arithmetic. With ffmpeg present the whole file is decoded as well.

## The page

`web/` is a second implementation of the same algorithm in browser JavaScript,
with no dependencies and no build step. Open `web/index.html` from a local
server and it works.

It carries its own AAC parser rather than calling a library, because finding
where an AAC frame ends means parsing its whole bitstream syntax, Huffman
coded spectral data included, and the C library that does that is under a
licence this project cannot bundle. The parser is written from the format
specification and tested against 1218 real frame boundaries taken from four
recordings, which it gets right exactly.

## Tests

```bash
pip install -e '.[dev]'
pytest                          # the Python engine
node --test web/lib/*.test.mjs  # the browser engine and the AAC parser
```

The tests build their own samples with ffmpeg, break them in the ways that
happen to people, repair them and compare against the originals. Frame counts
have to match exactly. The media bytes in the output have to be identical to
the media bytes in the input, which is the check that no re-encode crept in.
Two of the unit tests are regressions for the bugs described above.

Both engines answer the same questions about the same bytes, which is how two
ports of one algorithm are kept from drifting apart.

`tools/damage.py` is the same damage on the command line, if you want to try it
on a file of your own:

```bash
python tools/damage.py unfinalised holiday.mp4 broken.mov
python tools/damage.py garbage holiday.mp4 broken.mov --runs 3 --bytes 40000
```

## Prior art

[untrunc](https://github.com/ponchio/untrunc) is the tool most people find
first and it is a good one. It solves the same problem and it has repaired a
great many files. Where argano differs is in what happens when the media has
damage in it as well as a missing index: untrunc follows sample lengths and
loses alignment at the first stretch of noise. On the fifteen minute recording
this was written for, it recovered 25 seconds. That is one file and not a
benchmark.

Commercial recovery tools handle the same case and several are effective. They
are closed, most are paid, and none of them will tell you which frames they
could not find.

## Licence

MIT.
