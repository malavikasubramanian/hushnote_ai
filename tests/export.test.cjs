/**
 * Leaving with the approved note.
 *
 * Regression cover for the gap where the flow ended at a success overlay with
 * no way to get the note out: state.approvedNote was captured in memory and
 * logged, but nothing surfaced it, so a clinician finished a session, watched
 * the raw data get wiped, and was left with nothing.
 *
 * The clipboard and the blob URL are captured rather than exercised for real —
 * jsdom has neither — so what this asserts is that the app hands over the right
 * text, and that the text is the clinician's edit rather than the model's draft.
 * The browser actually delivering it is not something jsdom can prove.
 */
const { boot, fire, wait, createChecker } = require('./harness.cjs');

const DRAFTED_DATA = 'Client described a difficult week at work.';

function stubApi(window) {
  window.fetch = (url) => {
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
          evidence: [],
          missing_fields: [],
          readiness: { completed: true, label: 'Ready', checksPassed: [], missing: [] },
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
  };
}

/** Captures what the page would put on the clipboard and into a download. */
function captureOutputs(window) {
  const out = { clipboard: null, download: null, blobs: new Map() };

  window.navigator.clipboard = {
    writeText: (text) => { out.clipboard = text; return Promise.resolve(); },
  };

  window.URL.createObjectURL = (blob) => {
    const url = `blob:test/${out.blobs.size}`;
    out.blobs.set(url, blob);
    return url;
  };
  window.URL.revokeObjectURL = () => {};

  // Anchor clicks are what trigger the download; intercept rather than follow.
  const realClick = window.HTMLElement.prototype.click;
  window.HTMLElement.prototype.click = function click() {
    if (this.tagName === 'A' && this.download) {
      out.download = { name: this.download, url: this.href };
      return;
    }
    realClick.call(this);
  };

  return out;
}

module.exports = async function run() {
  const { check, results } = createChecker('export');

  let out;
  const { window, App, $ } = boot({
    beforeLoad: (w) => { stubApi(w); out = captureOutputs(w); },
  });

  App.state.transcript = '[00:00] Therapist: Hello.\n[45:00] Client: That helped.';
  App.state.recordingSeconds = 2700;
  App.state.selectedFormat = 'DAP';
  App.state.selectedPurpose = 'billing_insurance';

  console.log('\n  -- generate, correct a section, approve');
  await App.executeNoteGeneration();
  await wait(1600);

  const CORRECTION = 'Client denied chest pain. Reports sleep improving.';
  $('note-data').value = CORRECTION;
  fire(window, $('note-data'), 'input');

  await App.executeApproveAndDelete();
  await wait(900);

  check('approved note holds the correction', App.state.approvedNote.data, [CORRECTION]);
  check('export actions visible after approval', $('exportActions').hidden, false);

  console.log('\n  -- the exported text is the approved note');
  const text = App.formatApprovedNoteText();
  check('contains the correction', text.includes(CORRECTION), true);
  check('does not contain the superseded draft', text.includes(DRAFTED_DATA), false);
  check('carries the DAP section headings', ['DATA', 'ASSESSMENT', 'PLAN'].every((h) => text.includes(h)), true);
  check('DAP omits Objective', text.includes('OBJECTIVE'), false);

  console.log('\n  -- copy to clipboard');
  fire(window, $('copyNoteBtn'), 'click');
  await wait(120);
  check('something reached the clipboard', typeof out.clipboard === 'string' && out.clipboard.length > 0, true);
  check('clipboard matches the formatted note', out.clipboard, text);
  check('clipboard carries the correction', out.clipboard.includes(CORRECTION), true);
  check('button confirms the copy', $('copyNoteLabel').textContent, 'Copied');

  console.log('\n  -- download as .txt');
  fire(window, $('downloadNoteBtn'), 'click');
  await wait(120);
  check('a download was triggered', !!out.download, true);
  check('filename is dated and .txt', /^hushnote-note-\d{4}-\d{2}-\d{2}\.txt$/.test(out.download.name), true);

  const blob = out.blobs.get(out.download.url);
  check('blob is plain text', blob.type, 'text/plain;charset=utf-8');
  const body = await blob.text();
  check('file body matches the approved note', body, text);
  check('file body carries the correction', body.includes(CORRECTION), true);
  check('file body lacks the superseded draft', body.includes(DRAFTED_DATA), false);
  check('clipboard and file are identical', out.clipboard, body);

  console.log('\n  -- SOAP includes Objective, and gaps are marked not dropped');
  App.state.selectedFormat = 'SOAP';
  App.state.approvedNote = { subjective: ['S line.'], objective: [], assessment: ['A line.'], plan: ['P line.'] };
  const soap = App.formatApprovedNoteText();
  check('all four SOAP headings present', ['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN'].every((h) => soap.includes(h)), true);
  check('an empty section is marked, not omitted', soap.includes('(not documented)'), true);

  console.log('\n  -- a discarded session has nothing to export');
  App.state.approvedNote = null;
  check('no note yields no text', App.formatApprovedNoteText(), '');

  window.close();
  return results;
};
