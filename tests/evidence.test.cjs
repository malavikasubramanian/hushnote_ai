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

  window.close();
  return results;
};
