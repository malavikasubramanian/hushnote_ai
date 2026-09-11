/**
 * Evidence timestamps confirmed against the transcript (verify-evidence.js).
 *
 * The drafting model's timestamps are not evidence on their own: it can copy
 * the schema's placeholder, attach a real marker to the wrong quote, guess a
 * time mid-utterance, or invent one for a live recording that has no markers
 * at all. verifyEvidence() re-derives every time from the transcript's own
 * [MM:SS] line markers and drops whatever it cannot pin to one. The first cases
 * run against the app's own sample transcript, as the investigation did; the
 * rest cover live and mixed transcripts and malformed input.
 */
const fs = require('fs');
const path = require('path');
const { createChecker, ROOT } = require('./harness.cjs');
const { verifyEvidence } = require('../verify-evidence.js');

const SAMPLE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').match(/const sample = `([\s\S]*?)`;/)[1];
const LIVE = 'The client says the week was really hard They tried the breathing exercise on Tuesday';

/** The confirmed time verifyEvidence() gives a single evidence item. */
const timeFor = (transcript, item) => verifyEvidence(transcript, [item])[0].timestamp;

module.exports = async function run() {
  const { check, results } = createChecker('verify-evidence');

  console.log('\n  -- the sample transcript is what the cases run against');
  check('sample transcript found, 23 marked lines', SAMPLE.split('\n').filter((l) => /^\[\d{2}:\d{2}\]/.test(l)).length, 23);

  console.log("\n  -- a quote on exactly one marked line takes that line's marker");
  check('right marker, verbatim quote',
    timeFor(SAMPLE, { timestamp: '03:15', quote: 'it starts as this deep tightness right in the center of my chest' }), '03:15');
  check('right marker, bracketed',
    timeFor(SAMPLE, { timestamp: '[06:40]', quote: 'Easily an 8 or a 9 out of 10.' }), '06:40');
  check('real marker, but the wrong one for the quote -> corrected',
    timeFor(SAMPLE, { timestamp: '12:00', quote: 'I avoided opening my email inbox on Thursday evening' }), '28:40');
  check('invented mid-utterance time -> corrected to the line marker',
    timeFor(SAMPLE, { timestamp: '03:40', quote: 'my hands get clammy' }), '03:15');
  check('time past the end of the session -> corrected',
    timeFor(SAMPLE, { timestamp: '52:10', quote: 'That feels manageable and clear.' }), '38:20');
  check('curly apostrophe in the transcript, straight in the quote',
    timeFor(SAMPLE, { timestamp: '18:15', quote: "I've delivered every single project on time" }), '18:15');
  check('the real 00:00 marker, verbatim quote',
    timeFor(SAMPLE, { timestamp: '00:00', quote: 'How have things been going for you since our session last Thursday?' }), '00:00');
  check('no timestamp from the model, verbatim quote -> derived',
    timeFor(SAMPLE, { quote: 'Easily an 8 or a 9 out of 10.' }), '06:40');
  check('case and punctuation differences',
    timeFor(SAMPLE, { timestamp: '06:40', quote: 'EASILY AN 8, OR A 9 OUT OF 10' }), '06:40');

  console.log('\n  -- a quote that is not in the transcript gets no time');
  check('paraphrased quote', timeFor(SAMPLE, { timestamp: '09:30', quote: 'breathing brought her anxiety from 8 down to 6' }), null);
  check('schema placeholder copied', timeFor(SAMPLE, { timestamp: '00:00', quote: 'exact quote' }), null);
  check('whole words only: "hope" is not in "hopeful"', timeFor(SAMPLE, { timestamp: '38:20', quote: 'hope' }), null);

  console.log('\n  -- a quote on several lines keeps the model time only if it is one of their markers');
  check('model time is the first match', timeFor(SAMPLE, { timestamp: '[14:20]', quote: 'mind reading' }), '14:20');
  check('model time is the second match', timeFor(SAMPLE, { timestamp: '16:00', quote: 'mind reading' }), '16:00');
  check('model time written h:mm:ss', timeFor(SAMPLE, { timestamp: '0:16:00', quote: 'mind reading' }), '16:00');
  check('model time is a real marker, but not one of the matches', timeFor(SAMPLE, { timestamp: '03:15', quote: 'mind reading' }), null);
  check('no model time to choose between them', timeFor(SAMPLE, { quote: 'mind reading' }), null);

  console.log('\n  -- a live recording has no markers, so no time is ever confirmed');
  check('live-only transcript, model claims 00:15', timeFor(LIVE, { timestamp: '00:15', quote: 'They tried the breathing exercise on Tuesday' }), null);

  const HYBRID = `${SAMPLE}\n${LIVE}`;
  check('sample then live: a live quote is not filed under the last marker',
    timeFor(HYBRID, { timestamp: '40:00', quote: 'They tried the breathing exercise on Tuesday' }), null);
  check('sample then live: a sample quote still resolves',
    timeFor(HYBRID, { timestamp: '40:00', quote: 'You did great work today.' }), '40:00');

  const ECHOED = `${SAMPLE}\nShe said it again: easily an 8 or a 9 out of 10`;
  check('phrase on a marked line and in live speech, model time matches the marker',
    timeFor(ECHOED, { timestamp: '06:40', quote: 'Easily an 8 or a 9 out of 10' }), '06:40');
  check('phrase on a marked line and in live speech, no model time',
    timeFor(ECHOED, { quote: 'Easily an 8 or a 9 out of 10' }), null);

  console.log('\n  -- transcript layout');
  check('Windows line endings', timeFor('[00:00] Therapist: Hello.\r\n[05:00] Client: It was a hard week.\r\n', { quote: 'It was a hard week.' }), '05:00');
  check('indented marker line', timeFor('   [05:00] Client: It was a hard week.', { quote: 'It was a hard week.' }), '05:00');
  check('marker not at the start of the line', timeFor('Client [05:00]: It was a hard week.', { timestamp: '05:00', quote: 'It was a hard week.' }), null);
  check('quote split across two lines', timeFor('[00:00] Therapist: Hello.\n[05:00] Client: It was a hard week.', { quote: 'Hello. It was a hard week.' }), null);

  console.log('\n  -- malformed evidence');
  check('missing quote', timeFor(SAMPLE, { timestamp: '03:15' }), null);
  check('empty quote', timeFor(SAMPLE, { timestamp: '03:15', quote: '   ' }), null);
  check('non-string quote', timeFor(SAMPLE, { timestamp: '03:15', quote: 42 }), null);
  check('evidence that is not an array', [null, undefined, {}, 'x'].map((e) => verifyEvidence(SAMPLE, e)), [[], [], [], []]);
  check('non-object items are dropped', verifyEvidence(SAMPLE, [null, 'x', 3, [], { quote: 'Easily an 8 or a 9 out of 10.' }]).length, 1);

  const input = [{ quote: 'Easily an 8 or a 9 out of 10.', timestamp: '99:99', section: 'data' }];
  const output = verifyEvidence(SAMPLE, input);
  check('other fields are kept', output[0].section, 'data');
  check('the input is not modified', input[0].timestamp, '99:99');

  return results;
};
