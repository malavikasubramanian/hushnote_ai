/**
 * Consent gating on the consent screen.
 *
 * Regression cover for the "Begin session" guard. The button is disabled until
 * the clinician confirms consent, so the click handler's check is a guard rather
 * than a prompt. It used to raise an OS-level alert() instead — reachable only by
 * a click dispatched from script, never by a user. A session must never start
 * without consent, and no browser dialog should be raised on the way.
 */
const { boot, createChecker } = require('./harness.cjs');

module.exports = async function run() {
  const { check, results } = createChecker('consent');

  const alerts = [];
  const { window, App, $ } = await boot({ beforeLoad: (w) => { w.alert = (m) => alerts.push(m); } });

  // Recording itself is covered by recording.test.cjs; here it only matters
  // whether a session was started at all.
  let sessionsStarted = 0;
  window.autoStartRecordingOrTimer = () => { sessionsStarted += 1; };

  const btn = $('confirmConsentBtn');
  const box = $('consentCheckbox');
  App.showScreen('consent-screen');

  console.log('\n  -- without consent the session cannot begin');
  check('begin button starts disabled', btn.disabled, true);
  btn.click();
  check('a click does not leave the consent screen', App.state.currentScreen, 'consent-screen');

  console.log('\n  -- a click dispatched from script is refused by the guard, silently');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('still on the consent screen', App.state.currentScreen, 'consent-screen');
  check('no session was started', sessionsStarted, 0);
  check('no alert() was raised', alerts, []);

  console.log('\n  -- unticking consent disables the button again');
  box.click();
  check('ticking enables the button', btn.disabled, false);
  box.click();
  check('unticking disables it again', btn.disabled, true);
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('refused after unticking', sessionsStarted, 0);

  console.log('\n  -- with consent the session begins');
  box.click();
  btn.click();
  check('moves to the recording screen', App.state.currentScreen, 'recording-screen');
  check('the session was started', sessionsStarted, 1);
  check('no alert() at any point', alerts, []);

  window.close();
  return results;
};
