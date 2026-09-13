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

Ten executions were run against the live workflow between 22:36 and 23:50 on
build day, across both the Google Form channel and the Manual Trigger fallback,
and in two languages. All ten are traceable by `trace_id` in `Lead_Log`.

Five of them ran during an unplanned model outage. Five completed normally. Both
halves are reported.

### 5.1 Fault injection — unplanned, five consecutive executions

This was not simulated. Mid-build the OpenAI account exhausted its quota and the
API returned `429 insufficient_quota` instead of a completion for every call over
a fourteen-minute window. Five consecutive executions therefore reached the
reliability boundary carrying an error object rather than a JSON lead:

| Trace | Channel | Language | Outcome |
|---|---|---|---|
| 41192 | Manual Trigger | en | Fallback lead, handoff delivered |
| 41193 | Manual Trigger | en | Fallback lead, handoff delivered |
| 41200 | Google Form | en | Fallback lead, handoff delivered |
| 41201 | Manual Trigger | en | Fallback lead, handoff delivered |
| 41205 | Google Form | es | Fallback lead, handoff delivered |

Identical behaviour in all five:

```text
Workflow completed without execution error      yes
Row written to Lead_Log                         yes
agent_valid                                     false
validation_missing_fields                       valid_json
lead_status                                     needs_human_review
handoff_reason                                  "LLM output was not valid JSON."
Slack handoff delivered, original message intact yes
trace_id preserved                              yes
customer_message_sent                           false
```

Three things this establishes that a single injected failure could not:

**The degradation is deterministic.** Five failures, five identical outcomes, no
variation and no partial writes.

**It holds across both ingestion channels.** The outage caught Manual Trigger and
Google Form runs alike; the boundary sits downstream of normalization, so the
entry channel is irrelevant to it.

**Recovery required no intervention in the workflow.** Once credit was restored,
execution `41209` succeeded on the next attempt. No node was changed, no state was
cleared, nothing was replayed by hand. The system resumed on its own.

### 5.2 Successful extractions

| Trace | Lang | Input | `service_type` | `group_size` | Intent | Booking | `missing_information` |
|---|---|---|---|---|---|---|---|
| 41209 | es | 16–21 Sept, husband + dog, **no year** | `unknown` (0) | 2 — 2 adults | travel | low 0.2 | `year_confirmation` |
| 41213 | es | 15–21 Sept **2026**, husband + dog | `unknown` (0) | **3** — 2 adults | travel | low 0.2 | `service_type` |
| 41214 | en | 12–19 Aug, 6-seat van, 2+2, **no year** | `van_rental` (1.0) | 4 — 2+2 | booking | high 0.9 | `availability_confirmation` |
| 41227 | es | two groups of 2, rooms, 2026 | `unknown` (0) | 4 — 4 adults | request_accommodation | medium 0.7 | `pickup_location`, `pickup_time`, `availability_confirmation` |
| 41246 | en | 12–19 Aug **2026**, 6-seat van, 2+2 | `van_rental` (1.0) | 4 — 2+2 | booking | high 0.9 | `availability_confirmation` |

`agent_valid: true` and `customer_message_sent: false` in all five.

**What went right, evidenced rather than asserted:**

*Language handling was never specified as a requirement and works anyway.* Spanish
enquiries were classified correctly and drafted a Spanish reply; English
enquiries drafted English. The agent detected the language and answered in it
without being told to.

*Refusal to guess held.* Three of the five enquiries never name a service. In all
three the agent returned `service_type: unknown` with confidence 0 and put the
gap in `missing_information`, rather than inventing a plausible service. This is
the behaviour scenario C was designed to test, and it was demonstrated three
times on real inputs instead.

*Arithmetic on indirect phrasing.* "Two groups of two people" resolved to 4 total,
4 adults (`41227`). Group size was never stated as a number in any Spanish
enquiry and was inferred correctly except where noted below.

*Repeatability.* `41214` and `41246` are the same enquiry with and without a
stated year. Service, confidence, group breakdown, intent and booking score are
identical across both.

### 5.3 Defects found

Three, all in extraction quality, none in the pipeline. All are open at
submission and were not patched after the runs.

**D1 — Pets are counted inconsistently in `group_size`.** The clearest defect in
the set, and it only surfaces because two comparable runs exist:

```text
41209  "con mi marido y nuestro perro"        -> group_size.total = 2  (dog excluded)
41213  "mi marido, yo y nuestro perrito"      -> group_size.total = 3  (dog included)
```

Same language, same structure, same kind of party, opposite treatment. The
schema has no place to record a pet, so the model resolves the ambiguity
differently each time. For a tourism operator this matters directly — party size
drives vehicle and room allocation. The fix is a schema field for animals plus an
explicit prompt rule, not a change to the pipeline.

**D2 — `needs_year_confirmation` missed once in five.** It fired correctly in
`41209`, where the year was absent and the flag was raised and surfaced in the
handoff. It was correctly `false` in the three runs that state a year. It failed
in `41214` only: the year was absent from an English enquiry and the flag stayed
`false`. Four of five correct; the miss is real but the mechanism works. An
earlier reading of this brief, based on two runs, concluded the flag was inert —
the wider sample disproves that and the conclusion has been corrected here.

**D3 — `missing_information` scope varies with service type.** For the two van
rentals it returned `availability_confirmation` alone, without pickup or drop-off
location. For the accommodation enquiry it returned `pickup_location`,
`pickup_time` and `availability_confirmation`. So the fields are in the model's
vocabulary and are emitted in some contexts and not others. This is a
prompt-coverage gap — the checklist is not anchored per service type — rather
than an absent capability.

### Summary

```text
Executions analysed                                    10
  during model outage                                   5
  with the model available                              5
Executions where the pipeline behaved as designed      10 / 10
Executions that reached a human with full context      10 / 10
Executions where customer_message_sent was true          0
Executions that failed silently                          0
Partial or corrupt writes                                0
Ingestion channels exercised                             2  (Google Form, Manual Trigger)
Languages exercised                                      2  (en, es)
Extraction defects characterised                         3  (all open, all prompt-level)
```

Every execution — including all five during the outage — ended with a human
holding the lead and the original enquiry. None produced a customer-facing
action. The three defects are extraction-quality gaps inside runs that still
logged, routed and handed off correctly.

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
- Evaluation is observational, not statistical. Ten live executions establish
  that the failure paths hold and characterise three extraction defects; they do
  not establish an accuracy rate. Five of the ten share one root cause (a single
  model outage), so the effective sample of successful extractions is five.
- Three extraction defects are open at submission: inconsistent pet handling in
  `group_size`, one missed `needs_year_confirmation`, and `missing_information`
  scope varying by service type. All three are prompt-level with known fixes,
  left unpatched rather than edited after the evaluation runs.
- `group_size` has no field for animals, which is what makes D1 possible. The
  schema, not only the prompt, is incomplete for this domain.
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

**Demo video:** https://drive.google.com/file/d/1bKJuVhyNoxCmqMZ5Av0KgTpLC2WfYYow/view?usp=sharing
