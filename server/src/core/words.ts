/**
 * A big sorted word list (one word per line) that answers `has(word)` by binary search
 * straight on the text. Building a Set of 270k words costs far more CPU than the free
 * plan's 10 ms per request; this costs nothing up front and microseconds per lookup.
 * The list must be sorted in plain code-unit order (`LC_ALL=C sort`).
 */
export class SortedWords {
  private readonly text: string;

  constructor(raw: string) {
    const body = raw.replace(/\r/g, '');
    this.text = `\n${body.endsWith('\n') ? body : `${body}\n`}`;
  }

  has(word: string): boolean {
    if (!word || word.includes('\n')) return false;
    const text = this.text;
    let lo = 1;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const start = text.lastIndexOf('\n', mid - 1) + 1;
      const end = text.indexOf('\n', start);
      if (end < 0) return false;
      const line = text.slice(start, end);
      if (line === word) return true;
      if (line < word) lo = end + 1;
      else hi = start - 1;
    }
    return false;
  }

  /** Every word, for the rare places that need to walk the list. */
  *words(): Generator<string> {
    let start = 1;
    const text = this.text;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      if (end < 0) break;
      if (end > start) yield text.slice(start, end);
      start = end + 1;
    }
  }
}
