import assert from "node:assert/strict";
import test from "node:test";
import {
  isDiscoveryCompletionAffirmation,
  isSimpleAffirmative,
  shouldSalvageDiscoveryComplete,
} from "../dist/src/discovery/engine.js";

test("completion salvage fires on affirmed completion acknowledgement without marker", () => {
  assert.equal(
    shouldSalvageDiscoveryComplete("Draft it.", "Good session."),
    true
  );
  assert.equal(
    shouldSalvageDiscoveryComplete(
      "yes",
      "Got it - drafting your policy files now."
    ),
    true
  );
});

test("completion salvage accepts long-form messages ending with a clean affirmation", () => {
  assert.equal(
    shouldSalvageDiscoveryComplete(
      "The SonarCloud encoding clarification is right, and the contracts scope clarification is right. Draft it.",
      "Good session."
    ),
    true
  );
});

test("completion salvage rejects long-form messages with late-change signals", () => {
  assert.equal(
    shouldSalvageDiscoveryComplete(
      "Yes, but change the contracts scope first. Draft it.",
      "Good session."
    ),
    false
  );
  assert.equal(
    isDiscoveryCompletionAffirmation(
      "Yes. Add one more testing note before the handoff. Draft it."
    ),
    false
  );
});

test("completion salvage does not fire without prior affirmation", () => {
  assert.equal(
    shouldSalvageDiscoveryComplete("Can you explain first?", "Good session."),
    false
  );
  assert.equal(
    shouldSalvageDiscoveryComplete(
      "one more thing",
      "Got it - drafting your policy files now."
    ),
    false
  );
});

test("completion salvage does not fire when response asks a question", () => {
  assert.equal(
    shouldSalvageDiscoveryComplete(
      "yes",
      "Good session. Want me to draft those now?"
    ),
    false
  );
});

test("completion salvage does not fire without completion intent", () => {
  assert.equal(
    shouldSalvageDiscoveryComplete("yes", "Got it. I'll keep that in mind."),
    false
  );
});

test("completion salvage does not fire when literal marker is present", () => {
  assert.equal(
    shouldSalvageDiscoveryComplete(
      "yes",
      "Got it - drafting now. [DISCOVERY_COMPLETE]"
    ),
    false
  );
  assert.equal(
    shouldSalvageDiscoveryComplete(
      "no changes",
      "Everything is current. [NO_CHANGES]"
    ),
    false
  );
});

test("draft-style user approvals count as simple affirmations", () => {
  assert.equal(isSimpleAffirmative("Draft it."), true);
  assert.equal(isSimpleAffirmative("write those"), true);
  assert.equal(
    isDiscoveryCompletionAffirmation("Those clarifications are correct. Draft it."),
    true
  );
});
