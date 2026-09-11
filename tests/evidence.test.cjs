/**
 * Evidence chips on the review screen.
 *
 * Regression cover for a chip that showed "00:15" for any quote without a
 * timestamp: an invented moment rendered exactly like a real one, the same
 * failure as the fabricated fallback note and the length-derived CPT code. A
 * chip shows a time only when the draft supplied one that reads as a clock
 * time; otherwise it says the time is not available.
 */
const { boot, createChecker } = require('./harness.cjs');

const draftWith = (evidence) => ({
  fallback: false,
  note: { data: ['Drafted.'], assessment: ['Assessed.'], plan: ['Planned.'] },
  evidence,
  missing_fields: [],
  readiness: { completed: true, label: 'Ready', checksPassed: [], missing: [] },
});

module.exports = async function run() {
  const { check, results } = createChecker('evidence');
  const { window, App, $ } = await boot();

  App.state.selectedFormat = 'DAP';

  /** What a clinician sees on each chip: its text, and whether it carries the clock icon. */
  const chips = () => [...$('evidenceChips').children].map((chip) => ({
    text: chip.textContent.replace(/\s+/g, ' ').trim(),
    clockIcon: !!chip.querySelector('svg'),
  }));
  const render = (evidence) => {
    App.state.noteOriginals = {};
    App.state.noteEdits = {};
    App.renderReviewScreen(draftWith(evidence));
    return chips();
  };
  const timed = (time, quote) => ({ text: `${time} “${quote}”`, clockIcon: true });
  const untimed = (quote) => ({ text: `time not available “${quote}”`, clockIcon: false });

  console.log('\n  -- a real timestamp is shown as given');
  check('mm:ss', render([{ quote: 'It has been a hard week.', timestamp: '01:30' }]), [timed('01:30', 'It has been a hard week.')]);
  check('bracketed, as the transcript writes it', render([{ quote: 'Bracketed.', timestamp: '[05:30]' }]), [timed('05:30', 'Bracketed.')]);
  check('h:mm:ss', render([{ quote: 'Late in a long session.', timestamp: '1:02:03' }]), [timed('1:02:03', 'Late in a long session.')]);

  console.log('\n  -- a missing timestamp is never filled in');
  check('no timestamp field', render([{ quote: 'No field.' }]), [untimed('No field.')]);
  check('empty string', render([{ quote: 'Empty.', timestamp: '' }]), [untimed('Empty.')]);
  check('whitespace only', render([{ quote: 'Blank.', timestamp: '   ' }]), [untimed('Blank.')]);
  check('null', render([{ quote: 'Null.', timestamp: null }]), [untimed('Null.')]);

  console.log('\n  -- a value that is not a clock time is not shown as one');
  check('prose from the model', render([{ quote: 'Prose.', timestamp: 'Not documented' }]), [untimed('Prose.')]);
  check('a bare number', render([{ quote: 'Number.', timestamp: 90 }]), [untimed('Number.')]);
  check('markup', render([{ quote: 'Markup.', timestamp: '<b>01:30</b>' }]), [untimed('Markup.')]);

  console.log('\n  -- mixed evidence keeps each chip honest');
  check('timed and untimed side by side',
    render([{ quote: 'Timed.', timestamp: '12:00' }, { quote: 'Untimed.' }]),
    [timed('12:00', 'Timed.'), untimed('Untimed.')]);
  check('no invented time anywhere on the panel', /00:15/.test($('evidenceChips').textContent), false);

  /*
   * A chip with no quote text used to render the quote as "undefined" (or
   * "null", "", "[object Object]"). The quote is the evidence, so such an item
   * gets no chip; with nothing left, the panel shows its empty state.
   */
  const EMPTY_STATE = [{ text: 'No explicit timestamp quotes referenced.', clockIcon: false }];

  console.log('\n  -- an item with no quote text gets no chip');
  check('quote field missing', render([{ timestamp: '01:30' }]), EMPTY_STATE);
  check('quote null', render([{ quote: null, timestamp: '01:30' }]), EMPTY_STATE);
  check('empty and whitespace quotes', render([{ quote: '' }, { quote: '   ' }]), EMPTY_STATE);
  check('non-string quotes', render([{ quote: 42 }, { quote: { text: 'hi' } }]), EMPTY_STATE);
  check('a real quote among them keeps its chip, alone',
    render([{ timestamp: '01:30' }, { quote: 'Real.', timestamp: '01:30' }, { quote: '' }]),
    [timed('01:30', 'Real.')]);
  check('no "undefined", "null" or "[object Object]" on the panel',
    /undefined|null|\[object Object\]/.test($('evidenceChips').textContent), false);

  // These threw a TypeError before, so they run last.
  console.log('\n  -- items and lists that are not evidence at all');
  check('null and non-object items', render([null, 'x', 7]), EMPTY_STATE);
  check('evidence that is null', render(null), EMPTY_STATE);
  check('evidence that is a string', render('x'), EMPTY_STATE);

  window.close();
  return results;
};
