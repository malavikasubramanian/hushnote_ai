/**
 * Approving a note and purging the raw session.
 *
 * Regression cover for the defect where approval kept whatever the model wrote
 * rather than the clinician's corrections, and for the privacy promise that the
 * transcript and audio are gone once the note is approved or discarded — even
 * when the wipe call fails or never answers. The server holds no session data,
 * so the browser's copy is the only one there is, and nothing about that call
 * may hold its clearing back.
 *
 * The API is stubbed rather than reached over the network, so the suite runs
 * without a server or a model. What it asserts is client behaviour: which text
 * survives approval, and what is cleared afterwards. The server holds no session
 * data, so there is nothing server-side to purge; the endpoint is stubbed only
 * so the wipe flow runs.
 */
const { boot, fire, wait, createChecker } = require('./harness.cjs');

const SESSION = '[00:00] Therapist: Hello.\n[45:00] Client: That helped, thank you.';
const DRAFTED_DATA = 'Client described a difficult week at work.';
const UNAVAILABLE = {
  success: true, source: 'fallback_offline', fallback: true, fallbackReason: 'no model', format: 'DAP',
  note: { data: [], subjective: [], objective: [], assessment: [], plan: [] },
  evidence: [], missing_fields: [],
  readiness: { completed: false, unavailable: true, label: 'Not drafted', checksPassed: [], missing: [] },
};

function stubApi(window) {
  const calls = [];
  window.fetch = (url, options) => {
    calls.push({ url: String(url), body: options && options.body });

    if (String(url).includes('/api/generate-note')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          source: 'ollama_gemma',
          fallback: false,
          format: 'DAP',
          note: {
            data: [DRAFTED_DATA],
            subjective: ['Client reports increased stress before meetings.'],
            objective: ['Client was engaged and coherent throughout.'],
            assessment: ['Work-related stress, responsive to reframing.'],
            plan: ['Continue weekly sessions; practice grounding.'],
          },
          evidence: [{ quote: 'It has been a difficult week.', timestamp: '01:30', section: 'subjective' }],
          missing_fields: [],
          readiness: { completed: true, label: 'Ready', checksPassed: [], missing: [] },
        }),
      });
    }

    if (String(url).includes('/api/delete-raw-session')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    }

    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  return calls;
}

module.exports = async function run() {
  const { check, results } = createChecker('approval');

  let calls;
  const mediaCalls = [];
  const { window, App, $ } = await boot({ beforeLoad: (w) => {
    calls = stubApi(w);
    // jsdom has no media playback; record what the wipe asks of the player.
    w.HTMLMediaElement.prototype.load = function load() { mediaCalls.push('load'); };
    w.HTMLMediaElement.prototype.pause = function pause() { mediaCalls.push('pause'); };
  } });
  const alerts = [];
  window.alert = (message) => { alerts.push(message); };

  /** Every browser-side copy a recorded session leaves behind. */
  function seedSessionCopies() {
    App.state.transcript = SESSION;
    App.state.baseTranscript = SESSION;
    App.state.speechTranscriptBuffer = 'Client: That helped, thank you.';
    $('transcriptInput').value = SESSION;
    App.state.audioChunks = [new window.Blob(['recorded audio'])];
    App.state.audioUrl = 'blob:test/session-audio';
    $('audioPlayback').src = App.state.audioUrl;
    $('audioPlayback').hidden = false;
  }

  const rawCopies = () => ({
    transcript: App.state.transcript,
    baseTranscript: App.state.baseTranscript,
    speechTranscriptBuffer: App.state.speechTranscriptBuffer,
    textarea: $('transcriptInput').value,
    generatedNoteResponse: App.state.generatedNoteResponse,
    noteOriginals: App.state.noteOriginals,
    noteEdits: App.state.noteEdits,
    audioChunks: App.state.audioChunks.length,
    audioUrl: App.state.audioUrl,
    playerSrc: $('audioPlayback').getAttribute('src'),
    playerHidden: $('audioPlayback').hidden,
  });
  const NO_RAW_COPIES = {
    transcript: '', baseTranscript: '', speechTranscriptBuffer: '', textarea: '',
    generatedNoteResponse: null, noteOriginals: {}, noteEdits: {},
    audioChunks: 0, audioUrl: null, playerSrc: null, playerHidden: true,
  };

  const reviewPanels = () => ({
    noteBody: $('noteBody').innerHTML.trim(),
    evidenceChips: $('evidenceChips').innerHTML.trim(),
    missingFields: $('missingFields').innerHTML.trim(),
  });
  const EMPTY_PANELS = { noteBody: '', evidenceChips: '', missingFields: '' };

  seedSessionCopies();
  App.state.recordingSeconds = 2700;
  App.state.selectedFormat = 'DAP';
  App.state.selectedPurpose = 'billing_insurance';

  console.log('\n  -- generating a note reaches the API with the session duration');
  await App.executeNoteGeneration();
  await wait(1600); // the review render sits behind a deliberate delay

  const generateCall = calls.find((c) => c.url.includes('/api/generate-note'));
  const sent = JSON.parse(generateCall.body);
  check('durationSeconds sent as a number', typeof sent.durationSeconds, 'number');
  check('durationSeconds carries the recorded value', sent.durationSeconds, 2700);
  check('drafted text rendered into the field', $('note-data').value, DRAFTED_DATA);

  console.log('\n  -- the clinician corrects a section');
  const CORRECTION = 'Client denied chest pain. Reports sleep improving.';
  $('note-data').value = CORRECTION;
  fire(window, $('note-data'), 'input');
  check('correction differs from the draft', $('note-data').value !== DRAFTED_DATA, true);

  console.log('\n  -- approving keeps the correction, not the draft');
  const mediaMark = mediaCalls.length;
  const approving = App.executeApproveAndDelete();
  // Raw copies go at once; the review panels stay until the success screen covers them.
  check('raw copies cleared as soon as approve is pressed', rawCopies(), NO_RAW_COPIES);
  check('review panels still showing behind the spinner', $('evidenceChips').textContent.includes('It has been a difficult week.'), true);
  await approving;
  await wait(900);

  check('approved note captured', !!App.state.approvedNote, true);
  check('approved note uses the correction', App.state.approvedNote.data, [CORRECTION]);
  check('approved note does not keep the draft', App.state.approvedNote.data.includes(DRAFTED_DATA), false);
  check('untouched section keeps its drafted text', App.state.approvedNote.plan, ['Continue weekly sessions; practice grounding.']);

  console.log('\n  -- the raw session is purged from the client');
  check('purge endpoint called', calls.some((c) => c.url.includes('/api/delete-raw-session')), true);
  check('every raw copy cleared', rawCopies(), NO_RAW_COPIES);
  check('player paused, then unloaded', mediaCalls.slice(mediaMark), ['pause', 'load']);
  check('review panels emptied once the success screen is up', reviewPanels(), EMPTY_PANELS);
  check('consent cleared for the next session', App.state.consentGiven, false);
  check('the export still carries the edited note', App.formatApprovedNoteText().includes(CORRECTION), true);

  /*
   * The server keeps nothing, so a failed wipe call can only mean the event went
   * unrecorded. None of these outcomes may hold the browser's copy back.
   */
  const workingFetch = window.fetch;
  let wipeCalls = 0;

  async function sessionEndingWith(wipeReply, { fallback = false } = {}) {
    App.resetSessionState();
    seedSessionCopies();
    App.state.recordingSeconds = 2700;
    App.state.selectedFormat = 'DAP';
    wipeCalls = 0;
    window.fetch = (url, options) => {
      if (String(url).includes('/api/delete-raw-session')) {
        wipeCalls += 1;
        return wipeReply();
      }
      if (fallback && String(url).includes('/api/generate-note')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(UNAVAILABLE) });
      }
      return workingFetch(url, options);
    };
    await App.executeNoteGeneration();
    await wait(1600);
    if (!fallback) {
      $('note-data').value = CORRECTION;
      fire(window, $('note-data'), 'input');
    }
    // Deliberately not awaited: a wipe call that never answers must not hold
    // the local wipe back, and awaiting it would hang the suite instead.
    App.executeApproveAndDelete();
    await wait(900);
    window.fetch = workingFetch;
  }

  const failures = [
    ['the server cannot be reached', () => Promise.reject(new Error('Failed to fetch'))],
    ['the server answers with an error status', () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) })],
    ['the server never answers', () => new Promise(() => {})],
  ];

  for (const [label, wipeReply] of failures) {
    console.log(`\n  -- approving still clears the browser's copy when ${label}`);
    await sessionEndingWith(wipeReply);
    check('the wipe call was still made', wipeCalls, 1);
    check('reaches the success screen', App.state.currentScreen, 'success-screen');
    check('the edited note is kept', App.state.approvedNote && App.state.approvedNote.data, [CORRECTION]);
    check('every raw copy cleared', rawCopies(), NO_RAW_COPIES);
    check('review panels emptied', reviewPanels(), EMPTY_PANELS);
    check('consent cleared', App.state.consentGiven, false);
  }

  console.log("\n  -- discarding still clears the browser's copy when the server cannot be reached");
  await sessionEndingWith(() => Promise.reject(new Error('Failed to fetch')), { fallback: true });
  check('the wipe call was still made', wipeCalls, 1);
  check('reaches the success screen', App.state.currentScreen, 'success-screen');
  check('says nothing was kept', $('success-title').textContent.trim(), 'Nothing was kept');
  check('no note kept', App.state.approvedNote, null);
  check('every raw copy cleared', rawCopies(), NO_RAW_COPIES);
  check('review panels emptied', reviewPanels(), EMPTY_PANELS);

  console.log('\n  -- a failed wipe call is never framed as exposed data');
  check('no wipe-failure panel on the review screen', $('purgeError'), null);
  check('no alert() at any point', alerts, []);

  /*
   * Harness regression. It used to dispatch its own DOMContentLoaded and jsdom
   * then fired the real one at the first await, so app.js bound every inline
   * handler twice and a single click here raised two dialogs.
   */
  console.log('\n  -- a back link clicked after an await runs its handler once');
  const confirms = [];
  window.confirm = (message) => { confirms.push(message); return true; };
  window.document.querySelector('[data-back="purpose-screen"]').click();
  check('one confirmation dialog per click', confirms.length, 1);
  check('lands on the purpose screen', App.state.currentScreen, 'purpose-screen');

  window.close();
  return results;
};
