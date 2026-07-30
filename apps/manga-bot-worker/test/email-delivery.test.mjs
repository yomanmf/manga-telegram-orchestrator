import test from "node:test";
import assert from "node:assert/strict";

import { createEmailDelivery } from "../src/email-delivery.mjs";

test("emails each web manga EPUB without Amazon authentication", async () => {
  const messages = [];
  const delivery = createEmailDelivery({
    host: "smtp.example.com",
    port: 465,
    secure: true,
    user: "user",
    pass: "pass",
    from: "sender@example.com",
    kindleEmail: "reader@kindle.com",
    maxBytes: 20_000_000
  }, () => ({ async sendMail(message) { messages.push(message); } }));

  await delivery.deliver([
    { fileName: "Part 1.epub", filePath: "/tmp/part-1.epub", size: 10 },
    { fileName: "Part 2.epub", filePath: "/tmp/part-2.epub", size: 20 }
  ], "The Fable");

  assert.deepEqual(messages.map((message) => message.attachments[0].filename), ["Part 1.epub", "Part 2.epub"]);
  assert.ok(messages.every((message) => message.to === "reader@kindle.com"));
});
