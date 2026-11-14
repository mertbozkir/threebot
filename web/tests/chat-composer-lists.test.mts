import assert from "node:assert/strict";
import { test } from "node:test";
import { listNewline } from "../src/lib/chatBehavior.ts";

// Apply the edit the composer would make for a new line at the end of `value`, or at `|`.
function enter(text: string) {
  const at = text.includes("|") ? text.indexOf("|") : text.length;
  const value = text.replace("|", "");
  const edit = listNewline(value, at);
  return edit && value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
}

test("a new line continues a bullet list with the same marker and indent", () => {
  assert.equal(enter("- milk"), "- milk\n- ");
  assert.equal(enter("* milk"), "* milk\n* ");
  assert.equal(enter("+ milk"), "+ milk\n+ ");
  assert.equal(enter("- milk\n  - oat"), "- milk\n  - oat\n  - ");
});

test("numbered lists count up and keep their delimiter", () => {
  assert.equal(enter("1. First"), "1. First\n2. ");
  assert.equal(enter("9) Ninth"), "9) Ninth\n10) ");
});

test("task items continue with an empty box", () => {
  assert.equal(enter("- [x] Done"), "- [x] Done\n- [ ] ");
  assert.equal(enter("- [ ] Todo"), "- [ ] Todo\n- [ ] ");
});

test("a new line on an empty item ends the list", () => {
  assert.equal(enter("- milk\n- "), "- milk\n");
  assert.equal(enter("1. a\n2. "), "1. a\n");
  assert.equal(enter("- [ ] "), "");
  assert.equal(enter("- [ ]"), "", "a task box with no space after it is still empty");
});

test("a new line in the middle of an item splits it", () => {
  assert.equal(enter("- milk| and eggs"), "- milk\n-  and eggs");
});

test("plain text, a cursor inside the marker, and selections are left to the browser", () => {
  assert.equal(enter("Just text"), null);
  assert.equal(enter("-not a list"), null);
  assert.equal(enter("*bold*"), null);
  assert.equal(enter("-| milk"), null);
  assert.equal(listNewline("- milk", 2, 6), null);
});
