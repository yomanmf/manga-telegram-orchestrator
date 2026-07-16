import assert from "node:assert/strict";
import test from "node:test";

import { isOwnerPrivateUpdate } from "../src/telegram-auth.mjs";

test("allows only owner messages from the owner's private chat", () => {
  const ownerMessage = { message: { from: { id: 123 }, chat: { id: 123, type: "private" } } };
  const otherMessage = { message: { from: { id: 456 }, chat: { id: 456, type: "private" } } };
  const ownerGroupMessage = { message: { from: { id: 123 }, chat: { id: -1001, type: "supergroup" } } };

  assert.equal(isOwnerPrivateUpdate(ownerMessage, "123"), true);
  assert.equal(isOwnerPrivateUpdate(otherMessage, "123"), false);
  assert.equal(isOwnerPrivateUpdate(ownerGroupMessage, "123"), false);
  assert.equal(isOwnerPrivateUpdate(ownerMessage, ""), false);
});

test("authorizes callback queries by the user who clicked the button", () => {
  const ownerCallback = {
    callback_query: {
      from: { id: 123 },
      message: { from: { id: 999 }, chat: { id: 123, type: "private" } }
    }
  };
  const otherCallback = {
    callback_query: {
      from: { id: 456 },
      message: { from: { id: 999 }, chat: { id: 123, type: "private" } }
    }
  };

  assert.equal(isOwnerPrivateUpdate(ownerCallback, "123"), true);
  assert.equal(isOwnerPrivateUpdate(otherCallback, "123"), false);
});
