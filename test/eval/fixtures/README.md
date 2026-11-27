# Agent evaluation fixtures

`manifest.json` is the golden corpus behind `npm run eval:agent`. It scores the real code paths — the JSON parsers, the box translation routing in `src/translation.js` and `runAgentTurn` from `src/agent-harness.js` — against fixture-declared provider responses. Nothing here contacts a provider: the evaluator installs an in-memory `fetch` whose only accepted endpoints are `http://localhost:11434/v1/chat/completions` and `https://generativelanguage.googleapis.com/v1beta/models/*`, and the provider settings are constants in `scripts/agent-eval.mjs`. No API key is read.

## Schema (version 1)

| Field | Meaning |
|---|---|
| `schemaVersion` | Fixture schema version. `scripts/agent-eval.mjs` rejects any other value, and a test pins it. |
| `description` | Corpus intent. |
| `testRates` | `label`, `inputPerMillionTokensUsd`, `outputPerMillionTokensUsd`. Synthetic rates that exercise cost accounting only. The label must say they are not provider prices. |
| `cases[]` | One graded scenario per case. |

Each case declares:

| Field | Meaning |
|---|---|
| `id` | Kebab-case unique id, echoed in every failure line. |
| `kind` | `translate` (box translation routing) or `agent` (full harness turn). |
| `provider` | `openai` (OpenAI-compatible) or `gemini`. |
| `userMessage`, `tools[]` | Agent cases only. Tools declare `name`, `description`, `parameters`, `category`, `concurrencySafe` and a declarative `result`; the stub registry exposes only these tools and records every call. No editor state is touched. |
| `sourceLanguage`, `targetLanguage`, `direction`, `notes`, `glossary` | Settings handed to the real code. `glossary` is the text `lintChapter` parses. |
| `page`, `boxes[]` | Page name/size and the source boxes with stable ids and source text. |
| `script[]` | Ordered simulated provider responses. Each entry has either `reply` (the exact JSON body served) or `status`/`retryAfter` for an error response, plus an optional `note`. Extra requests and unused responses both fail. |
| `expected.translations` | Reference translation per box id (translate cases, and agent cases that update boxes). |
| `expected.toolCalls` | Expected tool calls for agent cases, in order, with exact arguments. |
| `expected.steps`, `expected.answer` | Expected protocol exchanges / final answer. |
| `gates` | Ratios that must be met: `minIdCoverage`, `minGlossaryCompliance`, `minReferenceMatches`, `minToolPrecision`, `minToolRecall`, `requireToolSequence`, `maxSteps`, `maxUntranslatedSource`. |
| `expectError` | Optional regular expression. The case passes only when production throws a matching error, which is how the ID-completeness guard is pinned. |

## Metrics

- **ID coverage** — expected box ids that came back with a non-empty translation, divided by expected ids. For agent cases the ids come from the recorded `update_box` calls.
- **Glossary compliance** — `1 - violating boxes / translated boxes`. A box violates when the production `lintChapter` reports a glossary violation for it, or when the reference translation uses an approved glossary target that the output dropped. Both the linter messages and the missing terms are in the report.
- **Reference match** — normalized exact equality against `expected.translations`; mismatches name the box and both strings.
- **Tool precision/recall** — multiset match on `name(JSON args)` between `expected.toolCalls` and the harness `toolTrace`; `requireToolSequence` also pins the order.
- **Steps** — provider exchanges for translation cases, `runAgentTurn` steps for agent cases, checked against `gates.maxSteps`.
- **Tokens and cost** — summed from the simulated responses' own usage metadata and labelled `simulated: true`. Cost uses the fixture `testRates`; without usage metadata the report says `unavailable` and asserts no cost. Production translation paths do not surface usage today, so these numbers are fixture data, not provider billing.

## Adding a case

1. Append a case with a new kebab-case id, a real source excerpt, its reference translation and the smallest simulated script that exercises the behavior you care about.
2. Prefer realistic model mistakes (dropped id, glossary drift) plus the gate that must catch them. Cases that always pass by construction add no regression value.
3. Run `npm run eval:agent` and confirm the new case passes. Deliberately break one reference, then confirm the failure names the case, metric and box.
4. Raise a gate only with a reason in review, the same rule as the image fixtures.

`npm test` covers the corpus schema, the passing default run, the offline endpoint guard, the missing/unexpected exchange checks and a temporary broken corpus (written to the OS temp directory, never committed) that exits non-zero with an actionable report.
