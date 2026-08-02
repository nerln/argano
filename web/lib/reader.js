/* Reading a very large local file without holding it in memory.
 *
 * A browser hands over a File, and a recording can easily be a gigabyte. The
 * scan only ever moves forward, so the file is read through a window that
 * slides along with it: a wide buffer, reloaded when the position gets close
 * to its end.
 *
 * Every offset the rest of the program deals with is absolute, an offset in
 * the file. `local` turns one into an index inside the current buffer, and
 * `ensure` is what makes that index valid. Getting this wrong is silent and
 * awful, so nothing outside this file ever indexes the buffer directly.
 */

const WINDOW = 96 * 1024 * 1024;
/* How much has to be readable ahead of the position before a reload. It has
 * to be larger than any single sample, and a frame of 4K video is a few
 * megabytes at most. */
const AHEAD = 40 * 1024 * 1024;

export class FileReader2 {
  constructor(file) {
    this.file = file;
    this.size = file.size;
    this.view = new Uint8Array(0);
    this.start = 0;
    this.end = 0;
    this.reads = 0;
  }

  async ensure(position, span = 1) {
    if (position >= this.start && position + span <= this.end) return;
    if (position >= this.start && this.end - position >= AHEAD) return;
    const from = Math.max(0, position - (1 << 20));
    const to = Math.min(this.size, from + WINDOW);
    const buffer = await this.file.slice(from, to).arrayBuffer();
    this.view = new Uint8Array(buffer);
    this.start = from;
    this.end = to;
    this.reads++;
    if (position + span > this.end && to < this.size) {
      throw new RangeError('a sample longer than the window was asked for');
    }
  }

  /* True while the window can answer for this position without reloading. */
  covers(position) {
    return position >= this.start && position < this.end;
  }

  local(position) {
    return position - this.start;
  }

  /* Where the media ends, as an index into the current buffer, clamped to it. */
  localEnd(absoluteEnd) {
    return Math.min(absoluteEnd, this.end) - this.start;
  }

  at(position) {
    return this.view[position - this.start];
  }

  /* A copy of an absolute range. Only used for small runs, such as one run of
   * sound handed to the audio parser. */
  async bytes(from, to) {
    if (from >= this.start && to <= this.end) return this.view.slice(this.local(from), this.local(to));
    const buffer = await this.file.slice(from, to).arrayBuffer();
    return new Uint8Array(buffer);
  }
}

/* The same interface over an array already in memory, which is what the tests
 * and the small paths use. */
export class BufferReader {
  constructor(bytes) {
    this.view = bytes;
    this.size = bytes.length;
    this.start = 0;
    this.end = bytes.length;
  }
  async ensure() {}
  covers() { return true; }
  local(position) { return position; }
  localEnd(absoluteEnd) { return Math.min(absoluteEnd, this.end); }
  at(position) { return this.view[position]; }
  async bytes(from, to) { return this.view.subarray(from, to); }
}
