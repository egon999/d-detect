/**
 * Refuses the network for the whole server test suite.
 *
 * ## The failure this prevents
 *
 * `server/src/env.ts` loads `server/.env` the moment it is imported, and that file holds the
 * owner's real `GROQ_API_KEY`. Every test that boots a route imports it. So the key is live in
 * `process.env` throughout the suite, and the only thing standing between a test and a billed call
 * to api.groq.com is that the test remembered to overwrite `globalThis.fetch` itself. Fourteen of
 * the twenty-four server test files do exactly that, each with its own copy, each saving the real
 * `fetch` in a local and putting it back in `after()`.
 *
 * That leaves three ways to reach the live provider by accident, none of which announce themselves:
 * a new test file that exercises a model path without writing a stub; an existing file whose
 * `after()` restores the real `fetch` before a later test in the same file runs; and a test that
 * throws on the way to installing its own stub. The symptom is not a failure — it is a test that
 * passes, slowly, having asserted against whatever the model happened to say that minute, and
 * which fails next week when the model is updated or the key is rotated. It also spends money.
 *
 * Installed through `--import` in the `test` script, this runs in every test child process before
 * any test code. A test that wants to exercise a fetch call still assigns its own stub, exactly as
 * now; this only decides what happens when nothing was assigned.
 *
 * ## Why localhost is refused too
 *
 * A dev server is often running on 127.0.0.1:8787 while these tests run. A test that reached it
 * would pass on this machine and fail on any machine without one, and the failure would read like
 * a product bug rather than a missing stub. Tests here build their own app instance and their own
 * temporary database; none of them has a reason to speak to a running server.
 *
 * ## Why this file is .mjs and not .ts
 *
 * Written as TypeScript it has to be compiled by the `tsx` loader, and the OCR path spawns worker
 * threads that do not inherit that loader. The import then failed inside the worker with
 * `Unknown file extension ".ts"`, which surfaced as "a resource generated asynchronous activity
 * after the test ended" against thirteen unrelated image tests — a failure that named the wrong
 * tests and gave no hint of its cause. Plain JavaScript needs no loader and so cannot do that.
 */

/**
 * The real `fetch`, kept so a deliberate integration script run through this import can still
 * reach out. Nothing under `src/` uses it; it exists so the escape hatch is a named thing rather
 * than a reason not to install the seal at all.
 */
export const realFetch = globalThis.fetch;

function refusalMessage(target) {
  return (
    `A server test reached the network: ${target}\n` +
    'server/.env is loaded by src/env.ts, so the real provider key is live in this process and ' +
    'this call would have been billed and would have asserted against whatever the model said ' +
    'today. Assign globalThis.fetch in the test so the substitution is visible where it is read — ' +
    'server/test-helpers/model-double.ts has the chat-completion shape already. If this is not a ' +
    'model call, the code under test has grown a dependency on something outside the repository.'
  );
}

globalThis.fetch = async (input) => {
  const target =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input?.url ?? String(input));
  throw new Error(refusalMessage(target));
};
