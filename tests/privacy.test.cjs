/**
 * Privacy and stale-data guarantees.
 *
 * Regression cover for three defects that each let clinical content escape or
 * be invented: the session transcript and generated note being written to the
 * browser console, and a sample conversation preloaded into state that could be
 * drafted into a note for a session that never happened.
 *
 * The server's loopback binding is the third fix and is not testable from here;
 * it is asserted against the running process instead.
 */
const { boot, fire, wait, createChecker } = require('./harness.cjs');

const SAMPLE_FRAGMENT = 'tightness in my chest';
const TRANSCRIPT = '[00:00] Therapist: Hello.\n[45:00] Client: That helped, thank you.';
const DRAFTED = 'Client described a difficult week at work.';

/** Records every console argument so a test can search them for content. */
function captureConsole(window) {
  const lines = [];
  const record = (...args) => {
    lines.push(args.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' '));
  };
  window.console.log = record;
  window.console.warn = record;
  window.console.error = record;
  return lines;
}

function stubApi(window) {
  window.fetch = (url) => {
    if (String(url).includes('/api/generate-note')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true, source: 'ollama_gemma', fallback: false, model: 'gemma4', format: 'DAP',
          note: {
            data: [DRAFTED],
            assessment: ['Work-related stress, responsive to reframing.'],
            plan: ['Continue weekly sessions.'],
          },
          evidence: [{ quote: 'It has been a difficult week.', timestamp: '01:30', section: 'data' }],
          missing_fields: [],
          readiness: { completed: true, label: 'Ready', checksPassed: [], missing: [] },
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
  };
}

module.exports = async function run() {
  const { check, results } = createChecker('privacy');

  let logs;
  const { window, App, $ } = boot({
    beforeLoad: (w) => { stubApi(w); logs = captureConsole(w); },
  });

  console.log('\n  -- no sample conversation is preloaded into state');
  check('transcript starts empty', App.state.transcript, '');
  check('no sample fragment anywhere in state', JSON.stringify(App.state).includes(SAMPLE_FRAGMENT), false);

  console.log('\n  -- an empty transcript cannot produce a note');
  const before = logs.length;
  await App.executeNoteGeneration();
  check('no request was made', logs.slice(before).some(l => l.includes('/api/generate-note')), false);
  check('no draft was stored', App.state.generatedNoteResponse, null);
  check('the error panel explains why', $('purposeError').hidden, false);
  check('message names the remedy', /no transcript to draft from/i.test($('purposeErrorText').textContent), true);
  check('the processing overlay was not shown', App.state.currentScreen === 'processing-screen', false);

  console.log('\n  -- whitespace is still empty');
  App.state.transcript = '   \n  \t ';
  await App.executeNoteGeneration();
  check('whitespace-only is refused too', App.state.generatedNoteResponse, null);

  console.log('\n  -- a real transcript generates normally and clears the error');
  App.state.transcript = TRANSCRIPT;
  App.state.recordingSeconds = 2700;
  App.state.selectedFormat = 'DAP';
  await App.executeNoteGeneration();
  await wait(1600);
  check('a draft was produced', !!App.state.generatedNoteResponse, true);
  check('error panel cleared', $('purposeError').hidden, true);

  console.log('\n  -- the console carries no clinical content');
  const joined = logs.join('\n');
  check('transcript not logged', joined.includes('That helped, thank you'), false);
  check('drafted note text not logged', joined.includes(DRAFTED), false);
  check('evidence quote not logged', joined.includes('It has been a difficult week'), false);
  check('shape-only metadata is still logged', /transcriptChars/.test(joined), true);
  check('provenance is still logged', /ollama_gemma/.test(joined), true);

  console.log('\n  -- approving logs section names, not the note');
  $('note-data').value = 'Client denied chest pain.';
  fire(window, $('note-data'), 'input');
  const beforeApprove = logs.length;
  await App.executeApproveAndDelete();
  await wait(900);
  const approveLogs = logs.slice(beforeApprove).join('\n');
  check('approved note text not logged', approveLogs.includes('Client denied chest pain.'), false);
  check('section names are logged', /sections/.test(approveLogs), true);
  check('approved note still captured in memory', App.state.approvedNote.data, ['Client denied chest pain.']);

  console.log('\n  -- a new session inherits nothing');
  App.resetSessionState();
  check('transcript cleared', App.state.transcript, '');
  check('speech buffer cleared', App.state.speechTranscriptBuffer, '');
  check('base transcript cleared', App.state.baseTranscript, '');
  check('textarea cleared', $('transcriptInput').value, '');
  check('previous draft cleared', App.state.generatedNoteResponse, null);
  check('approved note cleared', App.state.approvedNote, null);

  console.log('\n  -- and cannot then draft from the previous session');
  await App.executeNoteGeneration();
  check('refused after reset', App.state.generatedNoteResponse, null);

  window.close();
  return results;
};
