/**
 * Readiness for evidence quotes (readiness.ts).
 *
 * verifyEvidence() nulls every timestamp it cannot confirm, so a live
 * recording's quotes never carry a time. The progress rule therefore asks only
 * that quotes exist, and the checklist has to say truthfully how many carry a
 * confirmed time — including none — and how many it could not find in the
 * transcript at all, rather than claiming quotes were "matched" at a count of
 * zero, or staying silent when the only "evidence" is unverified. Evidence goes
 * through the real verifyEvidence() first, exactly as the server does.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const { tsImport } = require('tsx/esm/api');
const { createChecker, ROOT } = require('./harness.cjs');
const { verifyEvidence } = require('../verify-evidence.js');

const NOTE = { data: ['Client reported a hard week.'], assessment: ['Work-related stress.'], plan: ['Continue weekly sessions.'] };
const LIVE = 'The client says the week was really hard I tried the breathing exercise on Tuesday';
const TIMED = '[00:00] Therapist: How was the week?\n[05:00] Client: The week was really hard.\n[09:30] Client: I tried the breathing exercise on Tuesday.';
const QUOTES = [
  { quote: 'The week was really hard', timestamp: '05:00', section: 'data' },
  { quote: 'I tried the breathing exercise on Tuesday', timestamp: '09:30', section: 'data' },
];

module.exports = async function run() {
  const { check, results } = createChecker('readiness');
  const { calculateReadiness } = await tsImport(pathToFileURL(path.join(ROOT, 'readiness.ts')).href, pathToFileURL(__filename).href);
  const readinessFor = (purpose, transcript, quotes) =>
    calculateReadiness(purpose, NOTE, verifyEvidence(transcript, quotes), transcript, 1200);

  console.log('\n  -- a live-only progress draft completes, and says no time was confirmed');
  check('no timestamp survives verification', verifyEvidence(LIVE, QUOTES).map((ev) => ev.timestamp), [null, null]);
  const live = readinessFor('progress', LIVE, QUOTES);
  check('the draft is complete', live.completed, true);
  check('labelled ready', live.label, 'Ready for Progress Tracking');
  check('nothing missing', live.missing, []);
  check('checklist says quotes exist but no time was confirmed', live.checksPassed,
    ['2 evidence quotes referenced, no timestamp confirmed against the transcript']);
  check('both quotes were still found in the transcript, just with no timestamp to confirm',
    verifyEvidence(LIVE, QUOTES).map((ev) => ev.quoteStatus), ['verbatim', 'verbatim']);

  console.log('\n  -- the checklist stays true at every confirmed count');
  check('all confirmed', readinessFor('progress', TIMED, QUOTES).checksPassed,
    ['2 evidence quotes referenced, all timestamps confirmed against the transcript']);
  check('some confirmed, and the unmatched one says so', readinessFor('progress', TIMED, [...QUOTES, { quote: 'a paraphrase that is not in the transcript', timestamp: '01:00' }]).checksPassed,
    ['3 evidence quotes referenced, 2 with a timestamp confirmed against the transcript, 1 not found in the transcript as written']);
  check('one quote, confirmed', readinessFor('progress', TIMED, [QUOTES[0]]).checksPassed,
    ['1 evidence quote referenced, its timestamp confirmed against the transcript']);
  check('one quote, not confirmed', readinessFor('progress', LIVE, [QUOTES[0]]).checksPassed,
    ['1 evidence quote referenced, no timestamp confirmed against the transcript']);

  console.log('\n  -- an unverified quote is counted, but the checklist says so');
  const INVENTED = { quote: 'a completely invented quote never said in the session', timestamp: '05:00' };
  const unverifiedOnly = readinessFor('progress', TIMED, [INVENTED]);
  check('a progress draft passes on an unverified quote alone (existence, not proof, is the gate)',
    unverifiedOnly.completed, true);
  check('but the checklist admits it was never found, not just that it lacks a time',
    unverifiedOnly.checksPassed, ['1 evidence quote referenced, no timestamp confirmed against the transcript, not found in the transcript as written']);
  check('a mix of confirmed and unverified quotes states both counts',
    readinessFor('progress', TIMED, [...QUOTES, INVENTED]).checksPassed,
    ['3 evidence quotes referenced, 2 with a timestamp confirmed against the transcript, 1 not found in the transcript as written']);
  check('when every quote is unverified, the clause reads "none", not "N"',
    readinessFor('progress', TIMED, [INVENTED, { quote: 'another line no one in the session ever said', timestamp: '09:30' }]).checksPassed,
    ['2 evidence quotes referenced, no timestamp confirmed against the transcript, none found in the transcript as written']);

  console.log('\n  -- a progress draft with no quotes at all is still incomplete');
  const none = readinessFor('progress', TIMED, []);
  check('not complete', none.completed, false);
  check('says a quote is needed', none.missing, ['At least one evidence quote required']);
  check('no evidence line in the checklist', none.checksPassed, []);

  console.log('\n  -- evidence items with no quote text do not count as quotes');
  const quoteless = readinessFor('progress', TIMED, [{ timestamp: '05:00' }, { quote: '', timestamp: '09:30' }, { quote: null }]);
  check('quote-less items alone leave the draft incomplete', quoteless.completed, false);
  check('and still say a quote is needed', quoteless.missing, ['At least one evidence quote required']);
  check('a real quote alongside them is counted alone',
    readinessFor('progress', TIMED, [{ timestamp: '05:00' }, QUOTES[0], { quote: '   ' }]).checksPassed,
    ['1 evidence quote referenced, its timestamp confirmed against the transcript']);

  console.log('\n  -- billing reports the same line');
  const billingLive = readinessFor('billing_insurance', LIVE, QUOTES);
  check('live-only billing lists quotes with no confirmed time',
    billingLive.checksPassed.includes('2 evidence quotes referenced, no timestamp confirmed against the transcript'), true);
  check('billing with no quotes has no evidence line',
    readinessFor('billing_insurance', TIMED, []).checksPassed.some((line) => /evidence quote/.test(line)), false);

  return results;
};
