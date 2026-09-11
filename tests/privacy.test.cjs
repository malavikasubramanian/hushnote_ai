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

/**
 * A recorder that behaves like Chrome's when started without a timeslice:
 * stop() returns at once, and the whole recording arrives afterwards — first as
 * dataavailable, then stop. Verified against headless Chrome 153. Counts object
 * URLs, so a test can tell whether playback was rebuilt from late audio.
 */
function installLateRecorder(window) {
  const ctl = { objectUrls: 0 };
  window.navigator.mediaDevices = {
    getUserMedia: () => Promise.resolve({ getTracks: () => [{ kind: 'audio', stop() {} }] }),
  };
  window.MediaRecorder = class {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new window.Blob(['the whole recording']) });
        if (this.onstop) this.onstop();
      }, 0);
    }
  };
  const createObjectURL = window.URL.createObjectURL;
  window.URL.createObjectURL = (blob) => { ctl.objectUrls += 1; return createObjectURL(blob); };
  return ctl;
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

  console.log('\n  -- a failed draft request lands in the panel, not a browser dialog');
  const alerts = [];
  window.alert = (message) => { alerts.push(message); };
  const workingFetch = window.fetch;
  window.fetch = () => Promise.reject(new Error('Failed to fetch'));
  App.state.transcript = TRANSCRIPT;
  $('purposeError').hidden = true;
  await App.executeNoteGeneration();
  check('no alert() was raised', alerts, []);
  check('back on the purpose screen', App.state.currentScreen, 'purpose-screen');
  check('the error panel is showing', $('purposeError').hidden, false);
  check('message says the draft failed', /could not be drafted: Failed to fetch/.test($('purposeErrorText').textContent), true);
  check('no draft was stored after a failure', App.state.generatedNoteResponse, null);
  window.fetch = workingFetch;

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

  console.log('\n  -- a failed wipe call still clears the browser, and logs no content');
  App.state.transcript = TRANSCRIPT;
  App.state.selectedFormat = 'DAP';
  await App.executeNoteGeneration();
  await wait(1600);
  $('note-data').value = 'Client denied chest pain.';
  fire(window, $('note-data'), 'input');
  const workingApi = window.fetch;
  window.fetch = (url, options) => String(url).includes('/api/delete-raw-session')
    ? Promise.reject(new Error('Failed to fetch'))
    : workingApi(url, options);
  const beforeFailedWipe = logs.length;
  await App.executeApproveAndDelete();
  await wait(900);
  window.fetch = workingApi;
  const failedWipeLogs = logs.slice(beforeFailedWipe).join('\n');
  check('transcript cleared despite the failed call', App.state.transcript, '');
  check('the failure is logged', /Wipe event not recorded/.test(failedWipeLogs), true);
  check('the failure log carries no transcript', failedWipeLogs.includes('That helped, thank you'), false);
  check('the failure log carries no note text', failedWipeLogs.includes('Client denied chest pain.'), false);

  console.log('\n  -- reset empties the review panels and the player straight away');
  App.resetSessionState();
  App.state.transcript = TRANSCRIPT;
  App.state.selectedFormat = 'DAP';
  await App.executeNoteGeneration();
  await wait(1600);
  App.state.audioUrl = 'blob:test/session-audio';
  $('audioPlayback').src = App.state.audioUrl;
  $('audioPlayback').hidden = false;
  check('the draft is on the review screen first', $('evidenceChips').textContent.includes('It has been a difficult week.'), true);
  App.resetSessionState();
  check('note text gone from the page', $('noteBody').innerHTML.trim(), '');
  check('evidence quotes gone from the page', $('evidenceChips').innerHTML.trim(), '');
  check('session details gone from the page', $('missingFields').innerHTML.trim(), '');
  check('player detached', $('audioPlayback').getAttribute('src'), null);
  check('player hidden', $('audioPlayback').hidden, true);

  console.log('\n  -- resetting mid-recording does not bring the recording back');
  const recorder = installLateRecorder(window);
  await App.startAudioRecording();
  check('recording is live', App.state.isRecording, true);
  const urlsBeforeReset = recorder.objectUrls;
  App.resetSessionState();
  await wait(50); // let the recorder's late data and stop event arrive
  check('no audio came back into state', App.state.audioChunks.length, 0);
  check('no audio URL was rebuilt', recorder.objectUrls, urlsBeforeReset);
  check('state holds no audio URL', App.state.audioUrl, null);
  check('player not re-attached', $('audioPlayback').getAttribute('src'), null);
  check('player still hidden', $('audioPlayback').hidden, true);

  console.log("\n  -- a new recording does not inherit a stale recorder's audio");
  await App.startAudioRecording();
  const urlsBeforeRestart = recorder.objectUrls;
  await App.startAudioRecording();
  await wait(50);
  check('the new recording starts with no audio', App.state.audioChunks.length, 0);
  check('no audio URL built from the stale recorder', recorder.objectUrls, urlsBeforeRestart);
  check('player not attached to the stale recording', $('audioPlayback').getAttribute('src'), null);
  App.resetSessionState();
  await wait(50);

  window.close();
  return results;
};
