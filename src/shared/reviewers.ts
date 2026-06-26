import { defineAgentProfile } from "@flue/runtime";
import * as v from "valibot";
import type { ReviewDimension } from "./scope.ts";

// Specialist reviewers, delegated to by the master agent via session.task().
// They RETURN structured findings; they do not post to GitHub — the master
// synthesizes and posts. Subagents share the parent's sandbox, so the domain
// reviewer can read the repo checkout at /workspace/repo with its file tools.

/** Structured findings every specialist returns. */
export const FindingsSchema = v.object({
  summary: v.string(),
  findings: v.array(
    v.object({
      severity: v.picklist(["critical", "important", "minor"]),
      title: v.string(),
      file: v.optional(v.string()),
      line: v.optional(v.number()),
      detail: v.string(),
    }),
  ),
});
export type Findings = v.InferOutput<typeof FindingsSchema>;

// Specialists run focused, parallel reviews — Flash is enough; the master
// orchestrator runs Pro. Profiles inherit the parent model unless set here.
const SPECIALIST_MODEL = "deepseek/deepseek-v4-flash";

export const architectReviewer = defineAgentProfile({
  name: "architect_reviewer",
  model: SPECIALIST_MODEL,
  description:
    "Reviews architecture: separation of concerns, coupling, abstractions, scalability, and how the change integrates with surrounding code.",
  instructions:
    "You review the architecture of a code change. Focus on: separation of concerns, module boundaries and coupling, appropriate (not premature) abstraction, data flow, scalability/performance, and clean integration with existing code. Identify concrete design risks only — no style nits. Return structured findings; do not post anywhere.",
});

export const testReviewer = defineAgentProfile({
  name: "test_reviewer",
  model: SPECIALIST_MODEL,
  description:
    "Reviews testing under a TDD workflow: are changed behaviors covered by tests that assert real behavior, and do tests look written test-first?",
  instructions:
    "You review testing for a code change in a TDD codebase. Check: does every changed behavior have a corresponding test; do tests assert real behavior (not mocks echoing themselves); are edge cases and error paths covered; do integration tests exist where they matter; is there evidence the change was driven test-first (tests accompany or precede implementation). Flag untested changed code as important. Return structured findings; do not post anywhere.",
});

export const securityReviewer = defineAgentProfile({
  name: "security_reviewer",
  model: SPECIALIST_MODEL,
  description:
    "Reviews security: authn/authz, input validation, injection, secrets, SSRF, and multi-tenant isolation.",
  instructions:
    "You review the security of a code change for a multi-tenant platform. Check: authentication/authorization boundaries; input validation and injection (SQL, command, path); secret handling and leakage; SSRF and unbounded effects from user-configured HTTP/MCP tools; deserialization; and cross-tenant (Workspace) data isolation. Rate true risks by severity; do not invent hypotheticals unsupported by the diff. Return structured findings; do not post anywhere.",
});

export const domainReviewer = defineAgentProfile({
  name: "domain_reviewer",
  model: SPECIALIST_MODEL,
  description:
    "Reviews eccho domain alignment against PRDs/ADRs/CONTEXT using the repo checkout at /workspace/repo.",
  instructions:
    "You review whether a change aligns with eccho's documented domain decisions. The repository is checked out at /workspace/repo — read CONTEXT.md, docs/** (especially any docs/adr/** ADRs), and .github/instructions/** with your file tools, and cross-check the change against them and the PR description (the PRD/intent). Flag: contradictions with an ADR or the domain model (Workspace, Chatbot, Account, Conversation, Operator, Guardrail, Escalation, Tool Registry, ContactPoint,...), missing handling the docs require, and decisions that should have an ADR but don't. Cite the doc path. Return structured findings; do not post anywhere.",
});

export const reviewerProfiles = [
  architectReviewer,
  testReviewer,
  securityReviewer,
  domainReviewer,
];

/** Map a scope dimension to its subagent name. */
export const dimensionAgent: Record<ReviewDimension, string> = {
  architecture: "architect_reviewer",
  testing: "test_reviewer",
  security: "security_reviewer",
  domain: "domain_reviewer",
};

/** Build the task prompt handed to one specialist. */
export function buildSpecialistPrompt(args: {
  dimension: ReviewDimension;
  prTitle: string;
  prBody: string;
  diff: string;
}): string {
  const repoNote =
    args.dimension === "domain"
      ? "\nThe full repository is checked out at /workspace/repo — read the governance docs there and cross-check."
      : "";
  return [
    `Review this pull request from your ${args.dimension} perspective.`,
    `Title: ${args.prTitle}`,
    `Description:\n${args.prBody || "(none)"}`,
    repoNote,
    "",
    "Unified diff under review:",
    "```diff",
    args.diff,
    "```",
    "",
    "Return your findings as structured data.",
  ].join("\n");
}
