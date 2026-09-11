/**
 * Evidence timestamps and quote statuses from the transcript (verify-evidence.js).
 *
 * The drafting model's timestamps are not evidence on their own: it can copy
 * the schema's placeholder, attach a real marker to the wrong quote, guess a
 * time mid-utterance, or invent one for a live recording that has no markers
 * at all. verifyEvidence() locates each quote with the same matcher
 * verifyQuote() uses, re-derives the time from the [MM:SS] marker of the line
 * the quote starts on, and drops whatever it cannot pin to one. An abridged
 * quote or one that runs across a speaker's lines gets a time too; an
 * unverified quote never does. Quote statuses themselves are covered in
 * verify-quote.test.cjs.
 */
const fs = require('fs');
const path = require('path');
const { createChecker, ROOT } = require('./harness.cjs');
const { verifyEvidence } = require('../verify-evidence.js');

const SAMPLE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').match(/const sample = `([\s\S]*?)`;/)[1];
const LIVE = 'The client says the week was really hard They tried the breathing exercise on Tuesday';
const REPEATED = '[01:00] Client: I feel really stuck at work.\n[09:00] Therapist: What does stuck feel like?\n[12:30] Client: I feel really stuck at work again.';
const SAME_SPEAKER = '[01:00] Client: I could not sleep at all last week.\n[01:20] Client: I kept waking up at three.';
const BRACKET = '[18:15] Client: She gave me a good review last month.';

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
  check('whole words only: "a lot more hope" is not in "a lot more hopeful"', timeFor(SAMPLE, { timestamp: '38:20', quote: 'a lot more hope' }), null);
  check('too short to count, even with a real marker', timeFor(SAMPLE, { timestamp: '16:00', quote: 'mind reading' }), null);

  console.log('\n  -- a quote on several lines keeps the model time only if it is one of their markers');
  check('model time is the first match', timeFor(REPEATED, { timestamp: '[01:00]', quote: 'I feel really stuck at work' }), '01:00');
  check('model time is the second match', timeFor(REPEATED, { timestamp: '12:30', quote: 'I feel really stuck at work' }), '12:30');
  check('model time written h:mm:ss', timeFor(REPEATED, { timestamp: '0:12:30', quote: 'I feel really stuck at work' }), '12:30');
  check('model time is a real marker, but not one of the matches', timeFor(REPEATED, { timestamp: '09:00', quote: 'I feel really stuck at work' }), null);
  check('no model time to choose between them', timeFor(REPEATED, { quote: 'I feel really stuck at work' }), null);

  console.log('\n  -- edited and line-spanning quotes get a time too');
  check('abridged quote takes its line marker',
    timeFor(SAMPLE, { quote: 'I tried the 4-7-8 breathing on Tuesday ... my heart rate did slow down a little bit' }), '09:30');
  check('bracketed quote takes its line marker', timeFor(BRACKET, { quote: '[My manager] gave me a good review last month' }), '18:15');
  check('a quote across one speaker\'s two lines takes the first line\'s marker',
    timeFor(SAME_SPEAKER, { timestamp: '01:20', quote: 'I could not sleep at all last week. I kept waking up at three.' }), '01:00');

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
  check('quote split across two speakers\' lines', timeFor('[00:00] Therapist: Hello.\n[05:00] Client: It was a hard week.', { quote: 'Hello. It was a hard week.' }), null);

  console.log('\n  -- every item carries a quote status set here, not by the model');
  check('verbatim, abridged and unverified side by side',
    verifyEvidence(SAMPLE, [
      { quote: 'Easily an 8 or a 9 out of 10.' },
      { quote: 'I tried the 4-7-8 breathing on Tuesday ... my heart rate did slow down a little bit' },
      { quote: 'I want to quit my job tomorrow' },
    ]).map((ev) => ev.quoteStatus),
    ['verbatim', 'abridged', 'unverified']);
  check('a status supplied by the model is overwritten',
    verifyEvidence(SAMPLE, [{ quote: 'I want to quit my job tomorrow', quoteStatus: 'verbatim', timestamp: '03:15' }]),
    [{ quote: 'I want to quit my job tomorrow', quoteStatus: 'unverified', timestamp: null }]);

  console.log('\n  -- malformed evidence');
  check('item with no quote field is dropped', verifyEvidence(SAMPLE, [{ timestamp: '03:15' }]), []);
  check('blank quotes are dropped', verifyEvidence(SAMPLE, [{ timestamp: '03:15', quote: '' }, { timestamp: '03:15', quote: '   ' }]), []);
  check('non-string quotes are dropped', verifyEvidence(SAMPLE, [{ quote: 42 }, { quote: null }, { quote: { text: 'hi' } }]), []);
  check('punctuation-only quote is kept, unverified and with no time',
    verifyEvidence(SAMPLE, [{ quote: '...', timestamp: '03:15' }]), [{ quote: '...', timestamp: null, quoteStatus: 'unverified' }]);
  check('only real quotes survive a mixed list',
    verifyEvidence(SAMPLE, [{ timestamp: '03:15' }, { quote: 'Easily an 8 or a 9 out of 10.' }, { quote: '' }]).map((ev) => ev.quote),
    ['Easily an 8 or a 9 out of 10.']);
  check('evidence that is not an array', [null, undefined, {}, 'x'].map((e) => verifyEvidence(SAMPLE, e)), [[], [], [], []]);
  check('non-object items are dropped', verifyEvidence(SAMPLE, [null, 'x', 3, [], { quote: 'Easily an 8 or a 9 out of 10.' }]).length, 1);

  const input = [{ quote: 'Easily an 8 or a 9 out of 10.', timestamp: '99:99', section: 'data' }];
  const output = verifyEvidence(SAMPLE, input);
  check('other fields are kept', output[0].section, 'data');
  check('the input is not modified', input[0].timestamp, '99:99');

  return results;
};
