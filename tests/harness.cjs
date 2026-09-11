/**
 * Shared jsdom bootstrap for the UI suites.
 *
 * The app is a static index.html plus a single app.js that wires itself up on
 * DOMContentLoaded. There is no module boundary to import, so a test loads the
 * real markup and the real script into a jsdom window and drives the app the
 * way a browser would — through DOM events and window.HushNoteApp.
 *
 * Everything the browser provides but jsdom does not (fetch, alert, blob URLs,
 * media capture) is stubbed per suite, so no suite needs a server or a device.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

/**
 * Boots the app in a fresh window.
 *
 * @param {object} [options]
 * @param {(window: object) => void} [options.beforeLoad]
 *   Runs after the document exists but before app.js executes — the only place
 *   to install globals the script touches while initialising.
 * @returns {Promise<{window: object, App: object, $: (id: string) => object|null}>}
 *   Resolves once app.js has initialised on jsdom's real DOMContentLoaded, so
 *   every suite must `await boot(...)` before driving the app.
 */
async function boot(options = {}) {
  // app.js is injected as a classic script rather than left as the module tag,
  // so it shares the window scope and its globals stay reachable from a test.
  const html = fs
    .readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script type="module"[^>]*><\/script>/, '');
  const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost:3000/' });
  const { window } = dom;

  // app.js narrates itself on startup; silenced here rather than after boot so
  // its initialisation logs do not land in the suite output.
  window.console.log = () => {};
  window.console.warn = () => {};

  // Defaults every suite wants. A suite can override them in beforeLoad.
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  window.alert = () => {};
  window.confirm = () => true;
  window.scrollTo = () => {};
  window.URL.createObjectURL = () => 'blob:test/object';
  window.URL.revokeObjectURL = () => {};
  // jsdom has no media playback: load(), pause() and play() only print "Not
  // implemented". Silent stand-ins keep suite output clean; a suite that cares
  // what the player was asked to do overrides them in beforeLoad.
  window.HTMLMediaElement.prototype.load = () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();

  if (options.beforeLoad) options.beforeLoad(window);

  const script = window.document.createElement('script');
  script.textContent = appJs;
  window.document.body.appendChild(script);

  /*
   * Initialise on jsdom's own DOMContentLoaded, not a synthetic one. jsdom
   * queues the real event while constructing the document and fires it at the
   * first microtask checkpoint afterwards, so dispatching our own here made
   * app.js initialise twice: once now, and again at a test's first await, with
   * every inline handler bound a second time. Awaiting the real event runs it
   * once — trusted, with readyState "interactive" — as a browser would.
   */
  await new Promise((resolve) => {
    window.document.addEventListener('DOMContentLoaded', resolve, { once: true });
  });

  if (!window.HushNoteApp) {
    throw new Error('app.js did not expose window.HushNoteApp — did initialisation throw?');
  }

  return {
    window,
    App: window.HushNoteApp,
    $: (id) => window.document.getElementById(id),
  };
}

/** Fires a real bubbling event, so delegated listeners see it. */
function fire(window, element, type) {
  element.dispatchEvent(new window.Event(type, { bubbles: true }));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collects results rather than throwing, so one failure does not hide the rest
 * of a suite. Comparison is structural: these assert on arrays and DOM strings.
 */
function createChecker(suiteName) {
  const results = { name: suiteName, passed: 0, failed: 0, failures: [] };

  function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      results.passed += 1;
    } else {
      results.failed += 1;
      results.failures.push({ label, actual, expected });
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
    if (!ok) {
      console.log(`          expected: ${JSON.stringify(expected)}`);
      console.log(`          actual:   ${JSON.stringify(actual)}`);
    }
  }

  return { check, results };
}


module.exports = { boot, fire, wait, createChecker, ROOT };
