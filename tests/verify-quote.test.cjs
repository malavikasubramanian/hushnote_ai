/**
 * Quote verification against the transcript (verifyQuote in verify-evidence.js).
 *
 * A drafted quote is only evidence if it is actually in the transcript, so each
 * one gets one of three statuses:
 *
 *   verbatim    found as written, allowing only differences that do not change
 *               what was said: punctuation and case, a speaker label, contractions,
 *               number words, hyphens, fillers and repeated words, and a line
 *               break between two sentences from the same speaker;
 *   abridged    marked as edited ("..." or [brackets]), with every remaining
 *               piece found in order within one speaker's words and no negation
 *               left out of a gap;
 *   unverified  anything else, and any quote of fewer than three significant words.
 *
 * Matching is exact on words, never a similarity score. The cases are the
 * investigation's 19-row table and its ellipsis and negation probes.
 */
const fs = require('fs');
const path = require('path');
const { createChecker, ROOT } = require('./harness.cjs');
const { verifyQuote } = require('../verify-evidence.js');

const SAMPLE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').match(/const sample = `([\s\S]*?)`;/)[1];
const SAME_SPEAKER = '[01:00] Client: I could not sleep at all last week.\n[01:20] Client: I kept waking up at three.';
const SPEECH = 'the client says um I I tried the the breathing thing and it was about an eight out of ten';
const NEGATION = '[20:00] Therapist: Any thoughts of hurting yourself?\n[20:10] Client: No. I have not had any thoughts of hurting myself.';
const CONTRACTION = '[02:00] Client: I do not want to go back to work on Monday.';
const AGE = '[03:00] Client: I am twenty-one years old.';
const MISHEARD = 'i have been feeling really ankshus about the presentation';
const BRACKET = '[18:15] Client: She gave me a good review last month.';
const LIVE = 'The client says the week was really hard They tried the breathing exercise on Tuesday';
const DRINKING = '[05:00] Client: I stopped drinking last year but I started again this month.';
const NOTES = 'Client reported she was exhausted and had not slept for three nights.';
const SHORT = '[05:00] Client: It was a hard week.';

module.exports = async function run() {
  const { check, results } = createChecker('verify-quote');

  console.log('\n  -- found as written');
  check('exact match', verifyQuote(SAMPLE, 'Easily an 8 or a 9 out of 10.'), 'verbatim');
  check('different quotation marks and a curly apostrophe', verifyQuote(SAMPLE, '“I’ve delivered every single project on time”'), 'verbatim');
  check('speaker label included in the quote', verifyQuote(SAMPLE, 'Client: Easily an 8 or a 9 out of 10'), 'verbatim');
  check('live transcript with no punctuation or capitals', verifyQuote(LIVE, 'They tried the breathing exercise on Tuesday.'), 'verbatim');

  console.log('\n  -- differences that do not change what was said');
  check('one speaker across two lines', verifyQuote(SAME_SPEAKER, 'I could not sleep at all last week. I kept waking up at three.'), 'verbatim');
  check('fillers and repeated words cleaned up', verifyQuote(SPEECH, 'I tried the breathing thing'), 'verbatim');
  check('number written as digits', verifyQuote(SPEECH, 'about an 8 out of 10'), 'verbatim');
  check('contraction', verifyQuote(CONTRACTION, "I don't want to go back to work on Monday"), 'verbatim');
  check('hyphenation', verifyQuote(SAMPLE, 'my manager helped me re-prioritize'), 'verbatim');
  check('hyphenated compound number', verifyQuote(AGE, 'I am 21 years old'), 'verbatim');

  console.log('\n  -- marked as edited, with every piece found');
  check('ellipsis inside one utterance (a 30-word gap)',
    verifyQuote(SAMPLE, 'I tried the 4-7-8 breathing on Tuesday ... my heart rate did slow down a little bit'), 'abridged');
  check('bracketed clarification', verifyQuote(BRACKET, '[My manager] gave me a good review last month'), 'abridged');
  check('short omission', verifyQuote(DRINKING, 'I stopped drinking ... but I started again this month'), 'abridged');
  check('an omission that changes the meaning is still only "abridged", never verbatim',
    verifyQuote(DRINKING, 'I stopped drinking ... this month'), 'abridged');

  console.log('\n  -- not in the transcript');
  check('ellipsis spanning two speakers', verifyQuote(SAMPLE, 'That somatic response ... Easily an 8 or a 9'), 'unverified');
  check('pieces stitched together with no ellipsis',
    verifyQuote(SAMPLE, 'Easily an 8 or a 9 out of 10 I actually had to sit on the edge of my bed'), 'unverified');
  check('paraphrase', verifyQuote(SAMPLE, 'breathing brought her anxiety from 8 down to 6'), 'unverified');
  check('negation flip', verifyQuote(NEGATION, 'I have had thoughts of hurting myself.'), 'unverified');
  check('negation left out of an ellipsis gap', verifyQuote(NEGATION, 'I have ... had any thoughts of hurting myself'), 'unverified');
  check('outright invented', verifyQuote(SAMPLE, 'I want to quit my job tomorrow'), 'unverified');
  check('schema placeholder', verifyQuote(SAMPLE, 'exact quote'), 'unverified');
  check('speech-recognition error the model corrected (real, but not provable from the text)',
    verifyQuote(MISHEARD, 'I have been feeling really anxious about the presentation'), 'unverified');

  console.log('\n  -- too short to count as evidence');
  check('one word, even though it is in the transcript', verifyQuote(SAMPLE, 'Yes'), 'unverified');
  check('two words, even though they are in the transcript', verifyQuote(SAMPLE, 'mind reading'), 'unverified');
  check('fillers do not count toward the minimum', verifyQuote(SPEECH, 'um uh I tried'), 'unverified');
  check('the pieces of an abridged quote are counted together', verifyQuote(SHORT, 'It ... week'), 'unverified');
  check('three significant words is enough', verifyQuote(SHORT, 'a hard week'), 'verbatim');

  console.log('\n  -- performance: a repeated common word must not blow up matching');
  const REPEATED_WORD = `[01:00] Client: ${'I '.repeat(400)}went to the store.`;
  const repeatedWordStart = Date.now();
  check('a piece that never resolves gives up in roughly linear time, not exponential',
    verifyQuote(REPEATED_WORD, 'I ' + 'I '.repeat(399) + 'flew to the moon'), 'unverified');
  check('...and stays well under a second', Date.now() - repeatedWordStart < 1000, true);

  console.log('\n  -- what "verified" does and does not mean');
  check('matched in pasted clinician notes: present in the transcript, though not the client\'s own words',
    verifyQuote(NOTES, 'she was exhausted and had not slept'), 'verbatim');
  check('a sentence ending in a colon is not taken for a speaker label',
    verifyQuote('She said it again: easily an 8 or a 9 out of 10', 'She said it again: easily an 8'), 'verbatim');
  check('non-string quote', verifyQuote(SAMPLE, 42), 'unverified');
  check('empty transcript', verifyQuote('', 'Easily an 8 or a 9 out of 10'), 'unverified');

  return results;
};
