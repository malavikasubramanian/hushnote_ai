/**
 * Review-screen note editing.
 *
 * Regression cover for the defect where the note textareas had no id, no name
 * and no listener, so a correction typed by the clinician was silently
 * discarded and the approved note was whatever the model first wrote.
 */
const { boot, fire, createChecker } = require('./harness.cjs');

module.exports = async function run() {
  const { check, results } = createChecker('editing');
  const { window, App, $ } = await boot();

  const ta = (key) => $(`note-${key}`);
  const flag = (key) => $(`note-edited-${key}`);

  const DRAFT = {
    fallback: false,
    note: {
      data: ['Original line one.', 'Original line two.'],
      assessment: ['Original assessment.'],
      plan: ['Original plan.'],
    },
    evidence: [],
    missing_fields: [],
    readiness: { completed: true, label: 'Ready', checksPassed: [], missing: [] },
  };

  App.state.selectedFormat = 'DAP';
  App.state.generatedNoteResponse = DRAFT;
  App.state.noteOriginals = {};
  App.state.noteEdits = {};

  console.log('\n  -- a drafted note renders as editable fields');
  App.renderReviewScreen(DRAFT);
  check('textarea has an id', !!ta('data'), true);
  check('textarea has a name', ta('data').getAttribute('name'), 'note-data');
  check('seeded with the drafted text', ta('data').value, 'Original line one.\nOriginal line two.');
  check('"Edited" marker starts hidden', flag('data').hidden, true);
  check('all three DAP sections render', ['data', 'assessment', 'plan'].every((k) => !!ta(k)), true);

  console.log('\n  -- typing is captured');
  ta('data').value = 'Corrected line one.\nCorrected line two.';
  fire(window, ta('data'), 'input');
  check('edit stored in state', App.state.noteEdits.data, 'Corrected line one.\nCorrected line two.');
  check('marker becomes visible', flag('data').hidden, false);
  check('untouched section has no marker', flag('plan').hidden, true);
  check('untouched section absent from edits', 'plan' in App.state.noteEdits, false);

  console.log('\n  -- getFinalNote() prefers the edit over the draft');
  check('edited section uses typed text', App.getFinalNote().data, ['Corrected line one.', 'Corrected line two.']);
  check('untouched section falls back to draft', App.getFinalNote().plan, ['Original plan.']);
  check('the response object is not mutated', DRAFT.note.data, ['Original line one.', 'Original line two.']);

  console.log('\n  -- edits survive leaving the screen and coming back');
  App.showScreen('purpose-screen');
  App.showScreen('review-screen');
  App.renderReviewScreen(DRAFT);
  check('edit survives a re-render', ta('data').value, 'Corrected line one.\nCorrected line two.');
  check('marker still visible', flag('data').hidden, false);
  check('untouched section still shows the draft', ta('plan').value, 'Original plan.');

  console.log('\n  -- undoing an edit clears the marker');
  ta('data').value = 'Original line one.\nOriginal line two.';
  fire(window, ta('data'), 'input');
  check('marker hidden once text matches the draft', flag('data').hidden, true);

  console.log('\n  -- blank lines are kept while typing, dropped on export');
  ta('plan').value = 'Plan line.\n\nSecond plan line.';
  fire(window, ta('plan'), 'input');
  check('raw text preserved in state', App.state.noteEdits.plan, 'Plan line.\n\nSecond plan line.');
  check('blank line dropped from the final note', App.getFinalNote().plan, ['Plan line.', 'Second plan line.']);

  console.log('\n  -- a new draft clears prior edits');
  App.state.noteEdits = {};
  App.state.noteOriginals = {};
  const DRAFT2 = { ...DRAFT, note: { data: ['Fresh draft.'], assessment: ['A.'], plan: ['P.'] } };
  App.state.generatedNoteResponse = DRAFT2;
  App.renderReviewScreen(DRAFT2);
  check('new draft shown, not the stale edit', ta('data').value, 'Fresh draft.');
  check('marker hidden on a fresh draft', flag('data').hidden, true);

  console.log('\n  -- SOAP renders four keyed sections');
  App.state.selectedFormat = 'SOAP';
  App.state.noteEdits = {};
  App.state.noteOriginals = {};
  const SOAP = { ...DRAFT, note: { subjective: ['S.'], objective: ['O.'], assessment: ['A.'], plan: ['P.'] } };
  App.state.generatedNoteResponse = SOAP;
  App.renderReviewScreen(SOAP);
  check('all SOAP sections keyed', ['subjective', 'objective', 'assessment', 'plan'].every((k) => !!ta(k)), true);

  console.log('\n  -- an absent Objective stays empty rather than being invented');
  App.state.noteEdits = {};
  App.state.noteOriginals = {};
  const NO_OBJ = { ...DRAFT, note: { subjective: ['S.'], assessment: ['A.'], plan: ['P.'] } };
  App.state.generatedNoteResponse = NO_OBJ;
  App.renderReviewScreen(NO_OBJ);
  check('Objective textarea is empty', ta('objective').value, '');
  check('no invented observation in the note body', /attentive and responsive/i.test($('noteBody').innerHTML), false);
  check('placeholder prompts rather than asserting', !!ta('objective').getAttribute('placeholder'), true);
  check('empty Objective is not flagged as edited', flag('objective').hidden, true);
  check('final note invents no objective', App.getFinalNote().objective, undefined);

  console.log('\n  -- the clinician can still fill Objective in');
  ta('objective').value = 'Client appeared tearful when discussing work.';
  fire(window, ta('objective'), 'input');
  check('typed observation captured', App.getFinalNote().objective, ['Client appeared tearful when discussing work.']);
  check('marker appears for the new text', flag('objective').hidden, false);

  console.log('\n  -- a model-supplied Objective still renders verbatim');
  App.state.noteEdits = {};
  App.state.noteOriginals = {};
  const WITH_OBJ = { ...DRAFT, note: { subjective: ['S.'], objective: ['Client was restless.'], assessment: ['A.'], plan: ['P.'] } };
  App.state.generatedNoteResponse = WITH_OBJ;
  App.renderReviewScreen(WITH_OBJ);
  check('model Objective shown as written', ta('objective').value, 'Client was restless.');
  check('not flagged as edited', flag('objective').hidden, true);

  window.close();
  return results;
};
