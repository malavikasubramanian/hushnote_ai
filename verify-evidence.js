/**
 * Evidence quotes and timestamps, confirmed against the transcript the model
 * drafted from.
 *
 * Nothing the drafting model returns is evidence by itself. A quote can be
 * paraphrased, stitched together from separate sentences, or invented; a
 * timestamp can be copied from the schema's "00:00", attached to the wrong
 * quote, or made up for a live recording whose transcript has no times at all.
 * So every quote is located in the transcript here and given a status, and
 * every timestamp is re-derived from where the quote was actually found.
 *
 * Matching is exact on words, never a similarity score: a fuzzy matcher happily
 * accepts "I have had thoughts of hurting myself" against "I have not had…".
 *
 * Pure and dependency-free, so it can be tested directly.
 */

/** A line that opens with a marker: "[03:15] Client: ...". Mid-line markers do not count. */
const MARKER_LINE = /^\s*\[(\d{1,2}):([0-5]\d)\]\s*(.*)$/;

/** A speaker label: one to three capitalised words and a colon, as in "Client:" or "Dr. Vance:". */
const SPEAKER_LABEL = /^([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,2}):\s+/;

/** A clock value as a model might write it: "03:15", "[03:15]", "0:03:15". */
const CLOCK = /^\[?(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)\]?$/;

/** Where a quote was edited: an omission ("...", "…") or an insertion ("[my manager]"). */
const EDIT_MARKS = /\.{3,}|…|\[[^\]]*\]/g;
const HAS_EDIT_MARK = /\.{3,}|…|\[[^\]]*\]/;

/** Below this many significant words a quote is too short to count as evidence. */
const MIN_QUOTE_WORDS = 3;

const FILLERS = new Set(['um', 'uh', 'uhm', 'erm', 'er', 'hmm', 'mm']);

/** Words an ellipsis must never leave out: dropping one reverses what was said. */
const NEGATIONS = new Set(['not', 'no', 'never', 'nothing', 'none', 'nobody', 'neither', 'nor', 'without']);

const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
  sixty: '60', seventy: '70', eighty: '80', ninety: '90', hundred: '100',
};

/** "twenty-one" etc: summed to its digits before the general hyphen strip below would otherwise fuse it into the unmatched word "twentyone". */
const COMPOUND_NUMBER = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)\b/g;

const IRREGULAR_NEGATIVES = { "won't": 'will not', "can't": 'can not', "shan't": 'shall not', "ain't": 'is not' };
const CONTRACTION_ENDINGS = [["'m", ' am'], ["'re", ' are'], ["'ve", ' have'], ["'ll", ' will'], ["'d", ' would']];
const IS_CONTRACTIONS = new Set(['it', 'that', 'what', 'there', 'here', 'he', 'she', 'who', 'where', 'how']);

/** "don't" → "do not", "I've" → "i have", "it's" → "it is"; a possessive just loses its apostrophe. */
function expandContraction(word) {
  if (IRREGULAR_NEGATIVES[word]) return IRREGULAR_NEGATIVES[word];
  if (word === "let's") return 'let us';
  if (word.endsWith("n't")) return `${word.slice(0, -3)} not`;
  for (const [ending, full] of CONTRACTION_ENDINGS) {
    if (word.endsWith(ending)) return word.slice(0, -ending.length) + full;
  }
  if (word.endsWith("'s") && IS_CONTRACTIONS.has(word.slice(0, -2))) return `${word.slice(0, -2)} is`;
  return word.replace(/'/g, '');
}

/**
 * The words of a piece of text as they are compared. Only differences that do
 * not change what was said are smoothed over: case and punctuation, curly or
 * straight apostrophes, contractions, number words (including a hyphenated
 * compound like "twenty-one"), hyphens, fillers ("um"), and a word repeated
 * straight after itself ("I I tried").
 */
function significantWords(text) {
  const expanded = String(text)
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(COMPOUND_NUMBER, (_, tens, ones) => String(Number(NUMBER_WORDS[tens]) + Number(NUMBER_WORDS[ones])))
    .replace(/([\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, '$1')
    .replace(/[\p{L}\p{N}]+'\p{L}+/gu, expandContraction);
  const words = expanded
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap((word) => (word === 'cannot' ? ['can', 'not'] : [NUMBER_WORDS[word] || word]))
    .filter((word) => !FILLERS.has(word));
  return words.filter((word, i) => i === 0 || word !== words[i - 1]);
}

/** Seconds for a clock value, or null when the value is not one. */
function toSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(CLOCK);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** The transcript's non-blank lines: marker (if any), speaker label (if any), and spoken words. */
function transcriptLines(transcript) {
  return String(transcript || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const marked = line.match(MARKER_LINE);
      let text = marked ? marked[3] : line.trim();
      const label = text.match(SPEAKER_LABEL);
      if (label) text = text.slice(label[0].length);
      return {
        marker: marked ? `${marked[1]}:${marked[2]}` : null,
        seconds: marked ? Number(marked[1]) * 60 + Number(marked[2]) : null,
        speaker: label ? label[1] : null,
        words: significantWords(text),
      };
    });
}

/**
 * Stretches of one person speaking: consecutive lines that carry the same
 * explicit speaker label run together, so a quote can cross a line break.
 * Unlabelled lines stand alone, since nothing says they are the same speaker.
 */
function speakerRuns(lines) {
  const runs = [];
  lines.forEach((line, i) => {
    if (!(i > 0 && line.speaker && lines[i - 1].speaker === line.speaker)) runs.push({ words: [], lineOf: [] });
    const run = runs[runs.length - 1];
    for (const word of line.words) {
      if (run.words.length && run.words[run.words.length - 1] === word) continue;
      run.words.push(word);
      run.lineOf.push(i);
    }
  });
  return runs;
}

/** Position of a word sequence within another, searching from `from`; -1 if absent. */
function indexOfWords(haystack, needle, from) {
  outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Whether pieces k... follow in order from `from`, with no negation inside any gap.
 *
 * Greedy, not backtracking: for each piece, the earliest occurrence at or after
 * the current position is always at least as good as any later one, because it
 * only shrinks the gap in front of it (so it can't newly fail the negation check)
 * and only shrinks the room needed for the pieces still to come. So once the
 * earliest occurrence is ruled out (not found, or a negation in its gap), no
 * later occurrence of that piece could have worked either, and there is nothing
 * to backtrack into. This keeps matching linear even when a common word like
 * "I" repeats through the transcript, instead of exploring every occurrence.
 */
function remainingPiecesFollow(words, pieces, k, from) {
  let at = from;
  for (let i = k; i < pieces.length; i += 1) {
    const start = indexOfWords(words, pieces[i], at);
    if (start === -1) return false;
    if (words.slice(at, start).some((word) => NEGATIONS.has(word))) return false;
    at = start + pieces[i].length;
  }
  return true;
}

/**
 * Where a quote appears, and how faithfully.
 *
 * - verbatim: every word, in order and contiguous, within one speaker's run.
 * - abridged: the quote marks an edit ("...", "…", "[...]") and each remaining
 *   piece is found in order within one speaker's run, with no negation left out
 *   of a gap. An omission can still change meaning, which is why it is labelled.
 * - unverified: anything else, or fewer than MIN_QUOTE_WORDS significant words.
 *
 * `locations` holds each distinct transcript line a match starts on.
 */
function locateQuote(lines, runs, quote) {
  const unverified = { status: 'unverified', locations: [] };
  if (typeof quote !== 'string') return unverified;

  const text = quote.trim().replace(/^["“”'‘’]+/, '').replace(SPEAKER_LABEL, '');
  const pieces = text.split(EDIT_MARKS).map(significantWords).filter((piece) => piece.length);
  if (pieces.reduce((count, piece) => count + piece.length, 0) < MIN_QUOTE_WORDS) return unverified;

  const starts = new Set();
  for (const run of runs) {
    for (let at = indexOfWords(run.words, pieces[0], 0); at !== -1; at = indexOfWords(run.words, pieces[0], at + 1)) {
      if (remainingPiecesFollow(run.words, pieces, 1, at + pieces[0].length)) starts.add(run.lineOf[at]);
    }
  }
  if (!starts.size) return unverified;
  return {
    status: HAS_EDIT_MARK.test(text) ? 'abridged' : 'verbatim',
    locations: [...starts].map((i) => lines[i]),
  };
}

/**
 * The time a located quote can be confirmed at, or null.
 *
 * - Starts on exactly one line: that line's marker, whatever the model said —
 *   null if that line has no marker.
 * - Starts on several lines: the model's time, but only if it is one of those
 *   lines' markers; otherwise null.
 * - Not located (unverified): null.
 */
function confirmedTime(locations, claimed) {
  if (locations.length === 0) return null;
  if (locations.length === 1) return locations[0].marker;
  const seconds = toSeconds(claimed);
  if (seconds === null) return null;
  const hit = locations.find((line) => line.seconds === seconds);
  return hit ? hit.marker : null;
}

/** An evidence object whose quote is non-blank text. */
function hasQuoteText(item) {
  return !!item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.quote === 'string' && item.quote.trim() !== '';
}

/**
 * How faithfully a quote appears in the transcript: 'verbatim', 'abridged' or
 * 'unverified'. See locateQuote() for what each means.
 *
 * @param {string} transcript The exact transcript the model was given.
 * @param {unknown} quote The quote to look for.
 * @returns {'verbatim' | 'abridged' | 'unverified'}
 */
export function verifyQuote(transcript, quote) {
  const lines = transcriptLines(transcript);
  return locateQuote(lines, speakerRuns(lines), quote).status;
}

/**
 * Returns the evidence with each quote's status and a timestamp confirmed
 * against the transcript (or null) set by this function, never taken from the
 * model. Other fields are kept and the input is not modified. Anything that is
 * not an evidence object, or has no quote text, is dropped: without a quote
 * there is no evidence to show or to count toward readiness.
 *
 * @param {string} transcript The exact transcript the model was given.
 * @param {unknown} evidence The model's evidence array.
 * @returns {Array<object>}
 */
export function verifyEvidence(transcript, evidence) {
  if (!Array.isArray(evidence)) return [];
  const lines = transcriptLines(transcript);
  const runs = speakerRuns(lines);
  return evidence
    .filter(hasQuoteText)
    .map((item) => {
      const { status, locations } = locateQuote(lines, runs, item.quote);
      return { ...item, quoteStatus: status, timestamp: confirmedTime(locations, item.timestamp) };
    });
}
