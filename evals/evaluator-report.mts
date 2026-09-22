/**
 * Measure the hallucination checker against hand labels.
 *
 * `pnpm eval:evaluator <labelled-file.json>`
 *
 * Why this exists. Every other number in this project is produced by code
 * checking code. This one is produced by a model reading prose, and a metric
 * built on a model has an error rate of its own that no amount of internal
 * consistency reveals -- a checker that is confidently wrong agrees with
 * itself perfectly. The only way to find out is to disagree with it on purpose,
 * by hand, and count.
 *
 * The number that matters most is the FALSE POSITIVE rate: how often the
 * checker calls a truthful message a hallucination. A checker that cries wolf
 * gets switched off within a week, and every number it ever produced becomes
 * unusable at the same moment.
 */

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm eval:evaluator <labelled-file.json>");
  console.error("Produce one with: pnpm eval:hallucination --dump claims.json");
  process.exit(1);
}

interface LabelledClaim {
  kind: string;
  text: string;
  verdict: string;
  reason: string;
  label: string | null;
}
interface Row {
  messageId: string;
  claims: LabelledClaim[];
}

const rows = JSON.parse(readFileSync(file, "utf8")) as Row[];
const claims = rows.flatMap((r) => r.claims);
const labelled = claims.filter((c) => c.label !== null && c.label !== "");

if (labelled.length === 0) {
  console.error(`No labels found in ${file}.`);
  console.error(`Fill in the "label" field on each claim: supported | unsupported | ambiguous`);
  process.exit(1);
}

let agree = 0;
let falsePositives = 0; // checker says unsupported, human says it was fine
let falseNegatives = 0; // checker says supported, human says it was a hallucination
const disagreements: LabelledClaim[] = [];

for (const c of labelled) {
  if (c.verdict === c.label) {
    agree += 1;
    continue;
  }
  disagreements.push(c);
  if (c.verdict === "unsupported" && c.label !== "unsupported") falsePositives += 1;
  if (c.verdict === "supported" && c.label === "unsupported") falseNegatives += 1;
}

const flaggedByChecker = labelled.filter((c) => c.verdict === "unsupported").length;
const realByHuman = labelled.filter((c) => c.label === "unsupported").length;

console.log(`labelled claims: ${labelled.length} of ${claims.length} extracted`);
console.log(`agreement: ${agree}/${labelled.length} (${((agree / labelled.length) * 100).toFixed(1)}%)`);
console.log();
console.log(`checker flagged as hallucination: ${flaggedByChecker}`);
console.log(`human judged hallucination:       ${realByHuman}`);
console.log();
console.log(
  `FALSE POSITIVE RATE: ${flaggedByChecker === 0 ? "n/a" : (falsePositives / flaggedByChecker).toFixed(4)}` +
    `  (${falsePositives} of ${flaggedByChecker} flags were wrong)`,
);
console.log(
  `FALSE NEGATIVE RATE: ${realByHuman === 0 ? "n/a" : (falseNegatives / realByHuman).toFixed(4)}` +
    `  (${falseNegatives} of ${realByHuman} real hallucinations were missed)`,
);

if (disagreements.length > 0) {
  console.log(`\ndisagreements:`);
  for (const d of disagreements) {
    console.log(`  checker=${d.verdict.padEnd(11)} human=${String(d.label).padEnd(11)} ${d.kind}: "${d.text}"`);
    console.log(`     ${d.reason}`);
  }
}

console.log(
  `\nPut the false positive rate in the README. An evaluator whose own error ` +
    `rate is unstated is not evidence.`,
);
