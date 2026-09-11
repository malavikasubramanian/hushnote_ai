/**
 * Microphone capture and the recording screen's state.
 *
 * Regression cover for the defect where the timer and the "Recording session"
 * badge fired at click time, before getUserMedia had been asked and regardless
 * of its answer, so a total failure was indistinguishable from a working
 * session and no transcript ever appeared.
 *
 * The microphone, recorder, recogniser and audio graph are all faked, so the
 * suite needs no device and no permission prompt. What it asserts is that
 * nothing on screen claims to be recording until capture has genuinely started,
 * and that a failure is visible as a failure.
 */
const { boot, createChecker } = require('./harness.cjs');

/** Installs a controllable fake for every browser capture API app.js touches. */
function fakeMedia(window) {
  const ctl = {
    micMode: 'grant',      // 'grant' | 'deny' | 'inuse'
    tracksStopped: 0,
    recorderStarts: 0,
    recogniserStarts: 0,
    recognisers: [],
  };

  window.navigator.mediaDevices = {
    getUserMedia: () => {
      if (ctl.micMode === 'deny') {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      if (ctl.micMode === 'inuse') {
        const err = new Error('Device busy');
        err.name = 'NotReadableError';
        return Promise.reject(err);
      }
      return Promise.resolve({
        getTracks: () => [{ kind: 'audio', stop() { ctl.tracksStopped += 1; } }],
      });
    },
  };

  window.MediaRecorder = class {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; }
    start() { this.state = 'recording'; ctl.recorderStarts += 1; }
    stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  };

  window.SpeechRecognition = class {
    constructor() { this.started = false; ctl.recognisers.push(this); }
    start() { ctl.recogniserStarts += 1; this.started = true; if (this.onstart) this.onstart(); }
    stop() { this.started = false; if (this.onend) this.onend(); }
    /** Feeds a finalised phrase through the real onresult handler. */
    say(text) {
      const result = [{ transcript: text }];
      result.isFinal = true;
      this.onresult({ resultIndex: 0, results: Object.assign([result], { length: 1 }) });
    }
  };

  window.AudioContext = class {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 32,
        getByteFrequencyData(buf) { buf.fill(120); },
      };
    }
    close() {}
  };

  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  window.isSecureContext = true;

  return ctl;
}

module.exports = async function run() {
  const { check, results } = createChecker('recording');

  let ctl;
  const { window, App, $ } = await boot({ beforeLoad: (w) => { ctl = fakeMedia(w); } });

  const badge = () => ($('recordingIndicatorText') || {}).textContent;
  const parked = () => $('waveform').classList.contains('waveform-idle');
  const lastRecogniser = () => ctl.recognisers[ctl.recognisers.length - 1];

  console.log('\n  -- nothing claims to be recording before permission settles');
  ctl.micMode = 'grant';
  const pending = App.startAudioRecording();
  check('state is "requesting"', App.state.micState, 'requesting');
  check('badge does not say Recording session', badge() !== 'Recording session', true);
  check('timer is not running', App.state.timerInterval, null);
  check('isRecording still false', App.state.isRecording, false);
  await pending;

  console.log('\n  -- a granted permission produces real recording state');
  check('micState live', App.state.micState, 'live');
  check('badge says Recording session', badge(), 'Recording session');
  check('timer now running', App.state.timerInterval !== null, true);
  check('isRecording true', App.state.isRecording, true);
  check('recorder started', ctl.recorderStarts, 1);
  check('recognition started', ctl.recogniserStarts, 1);
  check('waveform no longer parked', parked(), false);
  check('no error panel', $('micErrorPanel').hidden, true);
  check('retry button hidden', $('startRecordingBtn').hidden, true);

  console.log('\n  -- speaking produces a transcript');
  lastRecogniser().say('the client reports sleeping better this week');
  check('transcript captured in state', App.state.transcript, 'the client reports sleeping better this week');
  check('transcript shown in the textarea', $('transcriptInput').value, 'the client reports sleeping better this week');

  console.log('\n  -- stopping releases the device');
  App.stopAudioRecording();
  check('isRecording false', App.state.isRecording, false);
  check('recorder cleared', App.state.mediaRecorder, null);
  check('recogniser cleared', App.state.speechRecognition, null);
  check('stream released', App.state.micStream, null);
  check('tracks stopped', ctl.tracksStopped >= 1, true);
  check('timer stopped', App.state.timerInterval, null);
  check('waveform parked again', parked(), true);
  check('captured audio offered for playback', $('audioPlayback').hidden, false);

  console.log('\n  -- a denied permission looks like a failure, not a session');
  ctl.micMode = 'deny';
  const denied = await App.startAudioRecording();
  check('reports failure', denied, false);
  check('micState failed', App.state.micState, 'failed');
  check('isRecording not left true', App.state.isRecording, false);
  check('timer not running', App.state.timerInterval, null);
  check('badge does not say Recording session', badge() !== 'Recording session', true);
  check('badge says Not recording', badge(), 'Not recording');
  check('error panel visible', $('micErrorPanel').hidden, false);
  check('error names the cause', /blocked/i.test($('micErrorText').textContent), true);
  check('retry offered', $('startRecordingBtn').hidden, false);
  check('waveform parked', parked(), true);

  console.log('\n  -- a busy device reports its own cause');
  ctl.micMode = 'inuse';
  await App.startAudioRecording();
  check('names the other application', /another application/i.test($('micErrorText').textContent), true);

  console.log('\n  -- retrying after a denial works');
  ctl.micMode = 'grant';
  const retried = await App.startAudioRecording();
  check('retry succeeds', retried, true);
  check('micState live', App.state.micState, 'live');
  check('error panel hidden again', $('micErrorPanel').hidden, true);

  console.log('\n  -- a fatal recognition error stops retrying');
  const rec = lastRecogniser();
  const beforeFatal = ctl.recogniserStarts;
  rec.onerror({ error: 'not-allowed' });
  check('marked fatal', App.state.speechFatal, true);
  rec.onend();
  rec.onend();
  rec.onend();
  check('no restarts after a fatal error', ctl.recogniserStarts, beforeFatal);

  console.log('\n  -- a benign end resumes, but within a budget');
  App.state.speechFatal = false;
  App.state.speechRestarts = 0;
  App.state.isRecording = true;
  const beforeBenign = ctl.recogniserStarts;
  rec.onend();
  check('benign end resumes once', ctl.recogniserStarts, beforeBenign + 1);
  App.state.speechRestarts = 999;
  const beforeBudget = ctl.recogniserStarts;
  rec.onend();
  check('budget stops a runaway loop', ctl.recogniserStarts, beforeBudget);
  check('marked fatal once the budget is spent', App.state.speechFatal, true);

  console.log('\n  -- a new session starts clean');
  App.state.isRecording = true;
  App.state.speechFatal = true;
  App.resetSessionState();
  check('isRecording reset', App.state.isRecording, false);
  check('recorder cleared', App.state.mediaRecorder, null);
  check('recogniser cleared', App.state.speechRecognition, null);
  check('stream released', App.state.micStream, null);
  check('speechFatal cleared', App.state.speechFatal, false);
  check('restart counter cleared', App.state.speechRestarts, 0);
  check('micState back to idle', App.state.micState, 'idle');
  check('timer cleared', App.state.timerInterval, null);

  console.log('\n  -- a non-secure origin is reported as such');
  const savedDevices = window.navigator.mediaDevices;
  delete window.navigator.mediaDevices;
  window.isSecureContext = false;
  await App.startAudioRecording();
  check('micState failed', App.state.micState, 'failed');
  check('explains the https/localhost requirement', /localhost|HTTPS/i.test($('micErrorText').textContent), true);
  window.navigator.mediaDevices = savedDevices;
  window.isSecureContext = true;

  window.close();
  return results;
};
