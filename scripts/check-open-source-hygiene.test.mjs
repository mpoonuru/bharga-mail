import assert from "node:assert/strict";
import test from "node:test";

import { scanText } from "./check-open-source-hygiene.mjs";

test("reports blocked identities by location without echoing source content", () => {
  const blocked = ["private", "tenant"].join("-");
  const findings = scanText("fixture.ts", `owner=${blocked}\n`, [blocked]);

  assert.deepEqual(findings, [{ file: "fixture.ts", line: 1, rule: "blocked-identity" }]);
  assert.equal(JSON.stringify(findings).includes(`owner=${blocked}`), false);
});
