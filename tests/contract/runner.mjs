/**
 * Contract runner — the reusable "how" behind the table.
 *
 * Orchestration (the test file) owns why/when; this module owns how to
 * run one table against the tool catalogue and summarize results in the
 * check_model audit style: grouped per-issue lists with counts by tool.
 */
import { validateAgainstSchema } from "./validator.mjs";

/**
 * @typedef {import("./cases.mjs").ContractCase} ContractCase
 * @typedef {{case_id:string, tool:string, issue:string, field:string, hint:string}} ContractIssue
 */

/**
 * Run contract cases against a tool catalogue.
 *
 * @param {{name:string, inputSchema:Record<string,unknown>}[]} toolDefs tools from dist/tools.js
 * @param {ContractCase[]} cases table from cases.mjs
 * @returns {{case_count:number, pass_count:number, issue_count:number, by_tool:Record<string,number>, issues:ContractIssue[]}}
 */
export function runContractCases(toolDefs, cases) {
  const byName = new Map(toolDefs.map((t) => [t.name, t]));
  /** @type {ContractIssue[]} */
  const issues = [];
  let passCount = 0;

  for (const c of cases) {
    const tool = byName.get(c.tool);
    if (!tool) {
      issues.push({
        case_id: c.id,
        tool: c.tool,
        issue: "unknown_tool",
        field: "",
        hint: `tool ${JSON.stringify(c.tool)} is not in the catalogue`,
      });
      continue;
    }
    const result = validateAgainstSchema(tool.inputSchema, c.args, "");
    if (c.expect === "ok") {
      if (result.ok) {
        passCount++;
      } else {
        issues.push({
          case_id: c.id,
          tool: c.tool,
          issue: "schema_reject",
          field: result.field,
          hint: `good payload rejected: ${result.message}`,
        });
      }
    } else {
      if (result.ok) {
        issues.push({
          case_id: c.id,
          tool: c.tool,
          issue: "schema_accept",
          field: c.errorField ?? "",
          hint: `bad payload passed schema; expected error naming ${JSON.stringify(c.errorField ?? "")}`,
        });
      } else if (c.errorField && !fieldMatches(result.field, c.errorField)) {
        issues.push({
          case_id: c.id,
          tool: c.tool,
          issue: "wrong_field",
          field: result.field,
          hint: `error named ${JSON.stringify(result.field)} but case expects ${JSON.stringify(c.errorField)}: ${result.message}`,
        });
      } else {
        passCount++;
      }
    }
  }

  /** @type {Record<string, number>} */
  const byTool = {};
  for (const i of issues) {
    byTool[i.tool] = (byTool[i.tool] ?? 0) + 1;
  }

  return {
    case_count: cases.length,
    pass_count: passCount,
    issue_count: issues.length,
    by_tool: byTool,
    issues,
  };
}

/**
 * Render a grouped summary mirroring check_model's {issue_count, by_type, issues}.
 * @param {{case_count:number, pass_count:number, issue_count:number, by_tool:Record<string,number>, issues:ContractIssue[]}} summary
 */
export function formatSummary(summary) {
  const lines = [
    `contract: ${summary.pass_count}/${summary.case_count} passed, ${summary.issue_count} issue(s)`,
  ];
  for (const issue of summary.issues) {
    lines.push(`- [${issue.tool}] ${issue.case_id}: ${issue.issue} field=${JSON.stringify(issue.field)} (${issue.hint})`);
  }
  return lines.join("\n");
}

function fieldMatches(actual, expected) {
  if (actual === expected) return true;
  // "cubes" matches "cubes[0]", "from" matches "from[2]".
  return actual.startsWith(`${expected}[`) || actual.startsWith(`${expected}.`);
}
