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

test("flushSync recovers the chunk an in-flight async drain holds", async () => {
  const dir = tmpRunDir();
  const j = new Journal(dir);
  const orig = fs.promises.appendFile;
  let release;
  // Hang the async write the way a SIGTERM-during-libuv-write would.
  fs.promises.appendFile = (...args) => new Promise((res) => { release = () => res(orig(...args)); });
  try {
    j.append("log", { msg: "in-flight" });
    await new Promise((r) => setImmediate(r)); // drain starts, holds the chunk
    j.append("log", { msg: "buffered" });
    j.flushSync(); // must persist BOTH, not just the new buffer
  } finally {
    fs.promises.appendFile = orig;
  }
  assert.deepEqual(readEvents(dir).map((e) => e.msg), ["in-flight", "buffered"]);
  // The abandoned write lands after all — the duplicate chunk must collapse.
  release();
  await j.flush();
  assert.deepEqual(readEvents(dir).map((e) => e.msg), ["in-flight", "buffered"]);
});

test("readNewEvents drops seqs already delivered (flushSync race duplicates)", () => {
  const dir = tmpRunDir();
  const file = eventsFile(dir);
  const state = { offset: 0, carry: "" };
  fs.writeFileSync(file, '{"seq":1,"t":1,"type":"log","msg":"a"}\n{"seq":2,"t":2,"type":"log","msg":"b"}\n');
  assert.equal(readNewEvents(file, state).length, 2);
  // A raced duplicate of seq 1-2 followed by genuinely new seq 3.
  fs.appendFileSync(file, '{"seq":1,"t":1,"type":"log","msg":"a"}\n{"seq":3,"t":3,"type":"log","msg":"c"}\n');
  const evs = readNewEvents(file, state);
  assert.deepEqual(evs.map((e) => e.seq), [3]);
});
