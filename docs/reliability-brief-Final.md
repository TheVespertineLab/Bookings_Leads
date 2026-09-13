# Lead & Booking Workling — System & Reliability Brief

**Multi-App AI Agent Hackathon · 13 September 2026**

**Team:** Estela Valiente · Esther López ·
[Repository](https://github.com/TheVespertineLab/Bookings_Leads)

---

## 1. What it does

The Lead & Booking Workling turns an unstructured tourism booking enquiry into a
structured, traceable operational workflow across four external applications —
without ever contacting the customer on its own.

**A chatbot answers. A Workling operates.**

Tourism operators do not lose bookings because demand is missing. They lose them
because enquiries arrive as messy free text across scattered channels and
follow-up breaks. This agent does not try to reply faster. It makes the
operator's internal workflow actually run.

One inbound enquiry produces, in a single execution:

1. A structured lead — service type, dates, group size, language
2. A scored booking-intent signal
3. An explicit missing-information checklist
4. An operational log row with a full audit trail
5. A prepared internal review slot
6. A human handoff carrying the complete context
7. A safe reply draft awaiting approval — written, never sent

---

## 2. Architecture

```text
Google Form                       inbound customer enquiry (free text)
     |
     v
Apps Script onFormSubmit          HTTPS POST, no transformation
     |
     v
n8n Webhook                       /webhook/worklings-booking-request
     |
     v
Normalize Inbound Request         injects trace_id, client_id, organization_id
     |
     v
LLM Extraction + Classification   temperature 0.1, JSON-object response format
     |
     v
Validate Agent Output             ← RELIABILITY BOUNDARY
     |
     +---> Google Sheets      Lead_Log row, 39 columns, full audit trail
     +---> Google Calendar    internal review event, no attendees
     +---> Slack              human handoff, #worklings-demo-handoff
```

**External applications connected: 4** (requirement: at least 3)

| App | Role in the agent |
|---|---|
| Google Forms | Inbound customer enquiry channel |
| Google Sheets | Operational lead log and audit trail |
| Google Calendar | Prepared internal next step |
| Slack | Human handoff queue |

n8n is the orchestrator. The LLM is the reasoning layer only — it never holds
authority over an action.

### Why the form is a single free-text field

The intake form deliberately collects one open message rather than structured
dropdowns for service, dates and party size. Pre-structuring the input at the
form would move the work out of the agent and make the pipeline a field copier.
Real enquiries arrive as prose, and structuring prose is the capability being
demonstrated.

### Why a webhook rather than a polling trigger

Ingestion is an HTTP endpoint rather than a spreadsheet poll. The agent reacts
immediately instead of on a polling interval, and the ingestion contract is
explicit and channel-agnostic: the same endpoint accepts a Google Form submission
today and would accept WhatsApp, Instagram or email tomorrow without changing a
single node downstream of normalization.

A Manual Trigger path with a pinned payload remains wired in parallel as a tested
fallback, so the pipeline can be exercised end to end even if the inbound channel
is unavailable.

---

## 3. Data contract

Four fields are injected before the model sees anything and re-asserted after it,
so they survive any model behaviour:

| Field | Purpose |
|---|---|
| `trace_id` | Correlates the Sheets row, the Calendar event and the Slack message for one enquiry |
| `client_id` | Tenant context — which operator this lead belongs to |
| `organization_id` | Tenant grouping above client |
| `response_mode` | Always `human_approval_required` in this build |

The `Lead_Log` sheet stores 39 columns per lead: the full extraction, every
confidence score, the validation result and the six safety flags. **The log is
the audit trail** — every decision the agent made is inspectable afterwards,
including the decisions it declined to make.

---

## 4. Reliability design

The core design assumption is that **the LLM will eventually return something
unusable**, and the system must stay useful when it does.

### 4.1 The reliability boundary

`Validate Agent Output` sits between the model and every downstream action.
Nothing the model produces reaches Sheets, Calendar or Slack without passing
through it. It enforces three guarantees:

| Guarantee | Mechanism |
|---|---|
| **Shape** | Every field is type-coerced and defaulted. Downstream nodes always read a fully-formed object, so a malformed model response cannot throw a node error. |
| **Traceability** | `trace_id` and tenant fields are recovered from the normalization node, not from the model output, so they survive total model failure. |
| **Safety** | The six confirmation flags are written as code constants, never read from the model. The model cannot set them even if it tries. |

Parsing is tolerant by design: markdown code fences are stripped, and if the
response still fails to parse, the first balanced `{...}` block is extracted and
retried before the fallback path is taken.

### 4.2 Failure mode analysis

| Failure | Detection | System behaviour | Operator-visible result |
|---|---|---|---|
| Model returns non-JSON or fenced markdown | Parse + fenced-block recovery | Fully-formed default lead constructed | Lead logged, flagged `needs_human_review`, handoff still fires |
| Model omits required fields | `validation_missing_fields` populated | Per-field defaults applied | `agent_valid = false` in the log; handoff names the gaps |
| Model returns wrong type (string where array expected) | Type coercion at the boundary | Value normalized | Downstream nodes unaffected |
| Model hallucinates a confirmation | Flags are not model-controlled | Code constants override | All confirmation flags stay `false` |
| Model API unavailable or times out | Node error, `continueOnFail` | Fallback lead built from the raw message | Human receives the original enquiry with a review flag |
| Google Sheets unavailable | Node error, `continueOnFail` | Execution continues | Calendar and Slack still fire |
| Google Calendar unavailable | Node error, `continueOnFail` | Execution continues | Recommended action still travels in the Slack handoff |
| Slack unavailable | Node error, `continueOnFail` | Execution continues | Lead still logged in Sheets for review |
| Inbound channel unavailable | Manual observation | Manual Trigger with pinned payload | Same pipeline, same outputs |

Every downstream action runs on an independent branch with `continueOnFail`, so
the three outputs are not chained: **one failing application cannot suppress the
other two.**

The pattern is consistent. Every failure degrades to human review. No failure
results in silence, and no failure results in customer contact.

### 4.3 Safety model

The agent operates in `draft_only / human_approval_required` mode. This is a
design decision, not a limitation of the build.

Six flags are enforced in code on every execution:

```text
customer_message_sent     = false
availability_confirmed    = false
price_confirmed           = false
booking_confirmed         = false
human_approved            = false
requires_human_approval   = true
```

The agent may draft, log, notify and prepare. It may not send, confirm or commit.
There is no customer-facing send node anywhere in the workflow — not disabled,
absent — so there is nothing to misfire. The Calendar event is internal and has
no attendees.

This matters commercially, not only technically: an agent that can accidentally
confirm availability an operator does not have is an agent no tourism operator
can deploy.

---

## 5. Evaluation

Four scenarios were run against the live workflow. A–C test extraction quality
across decreasing information. D deliberately breaks the model to test the
reliability boundary under real failure rather than in theory.

### Scenario A — Strong lead, rich extraction

```text
"Hi, do you have a 6-seat van available from 12–19 August for 2 adults and 2 kids?"
```

Executed as trace `41214`, submitted through the live Google Form.

| Assertion | Expected | Result |
|---|---|---|
| `service_type` | `van_rental` | **Pass** — `van_rental`, confidence 1.0 |
| `group_size` total / adults / children | 4 / 2 / 2 | **Pass** — 4 / 2 / 2 |
| `dates_raw` | `12–19 August` | **Pass** |
| `needs_year_confirmation` | `true` — no year stated | **Fail** — returned `false` despite the year being absent |
| `booking_intent_label` | `high` | **Pass** — `high`, score 0.9 |
| `missing_information` includes pickup and drop-off location | yes | **Partial** — returned `availability_confirmation` only |
| Sheets row + Calendar event + Slack message all created | yes | **Pass** — all three destinations received the run |
| `customer_message_sent` | `false` | **Pass** |

**Two honest misses.** The agent did not flag the missing year, and its
missing-information list was thinner than the prompt requests — pickup and
drop-off location were not named. Both are prompt-quality gaps, not pipeline
failures: the lead was still logged, routed and handed off correctly, and no
incorrect information was produced. They are recorded here rather than smoothed
over, because a brief that reports only passes is not a reliability brief.

### Scenario B — Relative date, partial information

```text
"Hello, we are 5 people interested in a boat tour next Friday. Do you have
anything available?"
```

Tests extraction when the date is relative and the party breakdown is absent.

| Assertion | Expected |
|---|---|
| `service_type` | `boat_tour` |
| `group_size_total` | 5 |
| `missing_information` includes exact date, time, adult/child split, contact | yes |
| `lead_status` | `needs_clarification` or `needs_human_review` |
| `customer_message_sent` | `false` |

*Designed and specified; not executed within the hackathon window.*

### Scenario C — Ambiguous enquiry (over-assumption test)

```text
"Hi, how much is it?"
```

This is the scenario most agents fail. A system tuned for helpfulness invents a
service type and answers a question it has no basis to answer.

| Assertion | Expected |
|---|---|
| `service_type` | `unknown`, confidence 0 |
| No invented service, date, group size or price anywhere in the output | true |
| `booking_intent_label` | `low` |
| `missing_information` includes service_type, dates, group_size | yes |
| Draft asks for clarification and quotes no price | true |

The prompt forbids guessing explicitly: when a request is too vague to classify,
`service_type.label` must be `unknown` with confidence 0 rather than a plausible
service.

*Designed and specified; not executed within the hackathon window.*

### Scenario D — Injected model failure (fault injection)

This test was not simulated. During the build the OpenAI account exhausted its
quota mid-run, and the API began returning a `429 insufficient_quota` error
instead of a completion. The LLM node carries `continueOnFail`, so the error
object passed downstream and reached the reliability boundary exactly as a
malformed model response would.

```text
Method: unplanned. Live quota exhaustion on the model provider (trace 41205),
        producing a non-JSON payload at the boundary node.
```

| Assertion | Expected | Result |
|---|---|---|
| Workflow completes without execution error | true | **Pass** |
| Row still written to `Lead_Log` | true | **Pass** |
| `agent_valid` | `false` | **Pass** |
| `validation_missing_fields` | `valid_json` | **Pass** |
| `lead_status` | `needs_human_review` | **Pass** |
| `handoff_reason` names the cause | yes | **Pass** — "LLM output was not valid JSON." |
| Slack handoff delivered with the original enquiry intact | true | **Pass** |
| `trace_id` preserved | true | **Pass** — `41205` |
| `customer_message_sent` | `false` | **Pass** |

**Why this scenario matters.** A–C show the agent works. D shows what happens
when it does not — the only question that matters before putting an agent in
front of a real operator's customers.

### Summary

```text
Scenarios specified                                        4
Scenarios executed                                         2  (A, D)
Executed scenarios where the pipeline behaved as designed  2 / 2
Assertion-level misses                                     2  (both in A, prompt quality)
Executions where customer_message_sent = true              0
Executions that failed silently                            0
Executions that reached a human                            2 / 2
```

Both executed scenarios ended with a human holding the lead and its full
context, and neither produced a customer-facing action. The two assertion misses
in A are extraction-quality gaps inside a run that still routed correctly — every
failure mode the boundary exists to catch held.

---

## 6. Known limitations

Stated plainly, because a brief that claims no limitations is not a reliability
brief.

- Availability, pricing and inventory are not connected. The agent qualifies and
  routes; it does not answer. Intentional for this build.
- When a date carries no year, the agent emits the raw string plus a confirmation
  flag rather than resolved ISO dates. Resolving it would mean guessing.
- Single tenant in practice. `client_id` and `organization_id` are carried
  correctly end to end but are not yet used for routing or isolation.
- No retry or dead-letter queue. A hard n8n failure is not currently replayed.
- Evaluation is scenario-based, not statistical. Four scenarios establish that
  the failure paths work; they do not establish an accuracy rate.
- The Apps Script bridge is a single point of failure for the Form channel. The
  webhook itself is channel-agnostic, so a second channel would not share it.

---

## 7. What production would add

The invariants worth preserving from this build — `trace_id`, tenant context,
`response_mode`, the audit log, and the rule that no outbound action happens
without an approval state — are exactly the ones production needs. On top:

- An approval action in the Slack handoff that sets `human_approved = true` and
  releases the draft, closing the loop
- Real channel ingestion (WhatsApp, Instagram, email) behind the same
  normalization contract
- Availability and pricing systems connected as tools, under the same rule: the
  agent reads, the human commits
- Retry with dead-letter handling, and per-tenant isolation
- Continuous evaluation against a labelled enquiry set rather than four scenarios

---

**Team:** Estela Valiente · Esther López

**Repository:** https://github.com/TheVespertineLab/Bookings_Leads

**Demo video:** **← https://drive.google.com/file/d/1bKJuVhyNoxCmqMZ5Av0KgTpLC2WfYYow/view?usp=sharing **
