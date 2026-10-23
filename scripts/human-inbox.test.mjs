import * as Test from "node:test";
import * as Assert from "node:assert/strict";
import { controlHumanInbox } from "./human-inbox.mjs";

const seen = [];
const exchange = async (_address, request) => {
  seen.push(request);
  return { ok: true, data: request.action === "set_state" ?
    { action: request.action, itemId: request.itemId, sourceType: request.sourceType,
      state: request.state, persisted: true } :
    request.action === "reply" ?
      { action: request.action, itemId: request.itemId, sourceType: request.sourceType,
        acceptedIntoQueue: true, deliveredToAgent: false } :
      { action: request.action, items: [], returned: 0 } };
};
const options = { exchange, home: ".t3" };
Test.test("one T3 human inbox tool accepts all four actions with exact wire contracts", async () => {
  for (const action of ["fetch_unread", "fetch_recent_read"]) {
    Assert.equal((await controlHumanInbox({ action, limit: 12 }, options)).action, action);
    Assert.equal(seen.at(-1).type, "openrig.human_inbox");
    Assert.equal(seen.at(-1).limit, 12);
  }
  const updated = await controlHumanInbox({
    action: "set_state", itemId: "qitem-exact", sourceType: "queue", state: "unread",
  }, options);
  Assert.equal(updated.persisted, true);
  Assert.equal(seen.at(-1).itemId, "qitem-exact");
  const reply = await controlHumanInbox({
    action: "reply", itemId: "qitem-exact", sourceType: "queue",
    answers: [{ questionId: "answer", value: "No" }],
  }, options);
  Assert.equal(reply.acceptedIntoQueue, true);
  Assert.equal(seen.at(-1).answers.length, 1);
});
Test.test("rejects missing target and unsupported plain text replies before contacting desktop", async () => {
  const before = seen.length;
  await Assert.rejects(controlHumanInbox({ action: "set_state", state: "read" }, options), /exact itemId/);
  await Assert.rejects(controlHumanInbox({
    action: "reply", itemId: "id", sourceType: "queue", message: "Hello",
    answers: [{ questionId: "a", value: "yes" }],
  }, options), /Plain-text reply/);
  await Assert.rejects(controlHumanInbox({
    action: "set_state", itemId: "id", sourceType: "queue", state: "cleared",
  }, options), /state=read/);
  Assert.equal(seen.length, before);
});
Test.test("rejects unconfirmed replies or incorrect target responses", async () => {
  await Assert.rejects(controlHumanInbox({
    action: "reply", itemId: "qitem-x", sourceType: "queue",
    answers: [{ questionId: "a", value: "yes" }],
  }, { home: ".t3", exchange: async () =>
    ({ ok: true, data: { action: "reply", itemId: "qitem-x", sourceType: "queue",
      acceptedIntoQueue: false } }) }), /did not confirm/);
});
