import assert from "node:assert/strict";
import { test } from "node:test";
import { escapePriceDollars } from "../src/lib/currencyDollars.ts";

test("prices are escaped, formulas are not", () => {
  const line = "Groq transcription costs about $36 for all 888 hours with whisper-large-v3-turbo at $0.04/hour, or about $99 with large-v3.";
  assert.equal(escapePriceDollars(line), line.replace("$36", "\\$36").replace("$0.04", "\\$0.04").replace("$99", "\\$99"));
  for (const price of ["$5", "$1,250.50", "$1.2k", "$3M", "$4bn", "$20%", "($12)", "$7.", "$7—"]) assert.match(escapePriceDollars(`a ${price} b`), /\\\$\d/, price);
  for (const formula of ["$x^2$", "$2^n$", "$5$", "$a+b$", "$$x$$", "\\$5 already", "US$5", "$2x + 1$"]) assert.equal(escapePriceDollars(formula), formula, formula);
});

test("code keeps its dollars", () => {
  assert.equal(escapePriceDollars("run `echo $5` then pay $5"), "run `echo $5` then pay \\$5");
  const fenced = "```sh\nprice=$5\n```\npaid $5";
  assert.equal(escapePriceDollars(fenced), "```sh\nprice=$5\n```\npaid \\$5");
  assert.equal(escapePriceDollars("~~~\n$1 and $2\n~~~"), "~~~\n$1 and $2\n~~~");
});

test("property: escaping only adds backslashes before dollars, and running it twice changes nothing", () => {
  const pieces = ["$", "$5", "$0.04", " ", "x", "^2", "`", "```\n", "\n", "\\", "12", "$x$", "/hour", ",", "("];
  let seed = 42;
  const pick = () => pieces[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % pieces.length];
  for (let run = 0; run < 2000; run++) {
    const input = Array.from({ length: 1 + (run % 24) }, pick).join("");
    const once = escapePriceDollars(input);
    assert.equal(once.replace(/\\(?=\$)/g, ""), input.replace(/\\(?=\$)/g, ""), input);
    assert.equal(escapePriceDollars(once), once, input);
  }
});
