/**
 * Evidence timestamps, confirmed against the transcript the model drafted from.
 *
 * The drafting model is asked for timestamped quotes, but nothing it returns is
 * evidence by itself. It can copy the schema's "00:00", attach a real marker to
 * the wrong quote, guess a time part-way through an utterance, or supply one
 * for a live recording whose transcript has no times at all. The only times
 * worth showing are the transcript's own [MM:SS] line markers, so every
 * timestamp is re-derived from those here, and anything that cannot be pinned
 * to exactly one of them is dropped.
 *
 * Pure and dependency-free, so it can be tested directly.
 */

/** A line that opens with a marker: "[03:15] Client: ...". Mid-line markers do not count. */
const MARKER_LINE = /^\s*\[(\d{1,2}):([0-5]\d)\]\s*(.*)$/;

/** A clock value as a model might write it: "03:15", "[03:15]", "0:03:15". */
const CLOCK = /^\[?(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)\]?$/;

/**
 * Words only, for comparing a quote with the transcript: lower-cased, with
 * apostrophes removed (so curly, straight and missing ones all agree) and every
 * other run of punctuation or whitespace collapsed to a single space.
 */
function normalise(text) {
  return String(text)
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Seconds for a clock value, or null when the value is not one. */
function toSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(CLOCK);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * The transcript's non-blank lines. A marker-led line carries its marker; any
 * other line (live speech appended to a transcript, say) carries none, but
 * still counts when deciding whether a quote is ambiguous.
 */
function transcriptLines(transcript) {
  return String(transcript || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.match(MARKER_LINE);
      return match
        ? { marker: `${match[1]}:${match[2]}`, seconds: Number(match[1]) * 60 + Number(match[2]), words: ` ${normalise(match[3])} ` }
        : { marker: null, seconds: null, words: ` ${normalise(line)} ` };
    });
}

/**
 * The time a quote can be confirmed at, or null.
 *
 * - On exactly one line: that line's marker, whatever the model said — null if
 *   that line has no marker.
 * - On several lines: the model's time, but only if it is one of those lines'
 *   markers; otherwise null.
 * - Not on any line (paraphrased, invented, or split across lines): null.
 */
function confirmedTime(lines, item) {
  const quote = typeof item.quote === 'string' ? normalise(item.quote) : '';
  if (!quote) return null;

  // Whole words only: " hope " must not match inside " hopeful ".
  const hits = lines.filter((line) => line.words.includes(` ${quote} `));
  if (hits.length === 1) return hits[0].marker;
  if (hits.length === 0) return null;

  const claimed = toSeconds(item.timestamp);
  if (claimed === null) return null;
  const hit = hits.find((line) => line.seconds === claimed);
  return hit ? hit.marker : null;
}

/**
 * Returns the evidence with every timestamp replaced by one confirmed against
 * the transcript, or null. Other fields are kept; the input is not modified;
 * anything that is not an evidence object is dropped.
 *
 * @param {string} transcript The exact transcript the model was given.
 * @param {unknown} evidence The model's evidence array.
 * @returns {Array<object>}
 */
export function verifyEvidence(transcript, evidence) {
  if (!Array.isArray(evidence)) return [];
  const lines = transcriptLines(transcript);
  return evidence
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({ ...item, timestamp: confirmedTime(lines, item) }));
}
