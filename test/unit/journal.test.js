const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Journal, readEvents, readNewEvents, eventsFile, lastSeq } = require("../../dist/journal.js");

function tmpRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-journal-test-"));
}

test("append then read round-trips events with increasing seq", async () => {
  const dir = tmpRunDir();
  const j = new Journal(dir);
  j.append("run.created", { meta: { id: "r1" } });
  j.append("log", { msg: "hello" });
  await j.flush();
  const evs = readEvents(dir);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2]);
  assert.equal(lastSeq(dir), 2);
});

test("torn final line is tolerated", async () => {
  const dir = tmpRunDir();
  const j = new Journal(dir);
  j.append("log", { msg: "ok" });
  await j.flush();
  fs.appendFileSync(eventsFile(dir), '{"seq":2,"t":123,"type":"log","ms');
  const evs = readEvents(dir);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].msg, "ok");
});

test("new journal continues seq after existing events", async () => {
  const dir = tmpRunDir();
  const j1 = new Journal(dir);
  j1.append("log", { msg: "a" });
  await j1.flush();
  const j2 = new Journal(dir);
  j2.append("log", { msg: "b" });
  await j2.flush();
  const evs = readEvents(dir);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2]);
});

test("readNewEvents tails incrementally across partial writes", async () => {
  const dir = tmpRunDir();
  const file = eventsFile(dir);
  const state = { offset: 0, carry: "" };
  fs.writeFileSync(file, '{"seq":1,"t":1,"type":"log"}\n{"seq":2,"t":2,');
  let evs = readNewEvents(file, state);
  assert.equal(evs.length, 1);
  fs.appendFileSync(file, '"type":"log"}\n');
  evs = readNewEvents(file, state);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].seq, 2);
});
