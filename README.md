# Lead & Booking Workling

**A multi-app AI agent that turns a messy tourism enquiry into a traceable operational workflow — and never talks to the customer on its own.**

Built for the [Multi-App AI Agent Hackathon](https://multiappagenthackathon.com/), 13 September 2026.

> A chatbot answers. A Workling operates.

---

## The problem

Tourism operators do not lose bookings because demand is missing. They lose them because enquiries arrive as free-form prose across scattered channels, and follow-up breaks.

The usual answer is a chatbot that replies faster. That is the wrong layer. A reply the operator cannot honour is worse than no reply — an agent that confidently confirms availability it does not have is an agent no real operator can deploy.

So this agent does not answer. **It operates the workflow.**

---

## What it does

One inbound enquiry produces, in a single execution across four applications:

| # | Output | Where it lands |
|---|---|---|
| 1 | Structured lead — service type, dates, group size, language | Google Sheets |
| 2 | Scored booking-intent signal | Google Sheets |
| 3 | Explicit missing-information checklist | Google Sheets + Slack |
| 4 | Full audit row with six safety flags | Google Sheets |
| 5 | Prepared internal review slot | Google Calendar |
| 6 | Human handoff with complete context | Slack |
| 7 | Safe reply draft — written, never sent | Slack + Google Sheets |

### Live example

Input, submitted through the public Google Form:

```
Hi, do you have a 6-seat van available from 12–19 August for 2 adults and 2 kids?
```

Extracted by the agent (execution `41214`):

```
service_type          van_rental (confidence 1.0)
dates_raw             12–19 August
group_size            4 total — 2 adults, 2 children
customer_intent       booking
booking_intent        high (0.9)
urgency               medium
missing_information   availability_confirmation
lead_status           needs_human_review
agent_valid           true
customer_message_sent false
```

---

## Architecture

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
Validate Agent Output             <-- RELIABILITY BOUNDARY
     |
     +---> Google Sheets      Lead_Log row, 39 columns, full audit trail
     +---> Google Calendar    internal review event, no attendees
     +---> Slack              human handoff, #worklings-demo-handoff
```

**External applications connected: 4** (requirement: at least 3)

| App | Role |
|---|---|
| Google Forms | Inbound customer enquiry channel |
| Google Sheets | Operational lead log and audit trail |
| Google Calendar | Prepared internal next step |
| Slack | Human handoff queue |

n8n is the orchestrator. The LLM is the reasoning layer only — **it never holds authority over an action.**

### Design decisions worth naming

**The form is a single free-text field.** No dropdowns for service, dates or party size. Pre-structuring the input at the form would move the work out of the agent and make the pipeline a field copier. Real enquiries arrive as prose; structuring prose is the capability being demonstrated.

**Ingestion is a webhook, not a spreadsheet poll.** The agent reacts immediately rather than on a polling interval, and the contract is channel-agnostic: the same endpoint accepts a Google Form today and would accept WhatsApp, Instagram or email tomorrow without changing a single node downstream of normalization.

**The three outputs are independent branches.** Sheets, Calendar and Slack each run with `continueOnFail`. They are not chained, so one failing application cannot suppress the other two.

---

## Reliability

The core design assumption is that **the LLM will eventually return something unusable**, and the system must stay useful when it does.

### The reliability boundary

`Validate Agent Output` sits between the model and every downstream action. Nothing the model produces reaches Sheets, Calendar or Slack without passing through it.

| Guarantee | Mechanism |
|---|---|
| **Shape** | Every field is type-coerced and defaulted. Downstream nodes always read a fully-formed object, so a malformed model response cannot throw a node error. |
| **Traceability** | `trace_id` and tenant fields are recovered from the normalization node, not from the model output, so they survive total model failure. |
| **Safety** | The six confirmation flags are written as code constants, never read from the model. The model cannot set them even if it tries. |

Parsing is tolerant by design: markdown fences are stripped, and if the response still fails to parse, the first balanced `{...}` block is extracted and retried before the fallback path is taken.

### Safety model

The agent operates in `draft_only / human_approval_required`. This is a design decision, not a limitation of the build.

```text
customer_message_sent     = false
availability_confirmed    = false
price_confirmed           = false
booking_confirmed         = false
human_approved            = false
requires_human_approval   = true
```

The agent may draft, log, notify and prepare. It may not send, confirm or commit. **There is no customer-facing send node anywhere in the workflow — not disabled, absent.** There is nothing to misfire. The Calendar event is internal and has no attendees.

Full failure-mode analysis: [`docs/reliability-brief.md`](docs/reliability-brief.md)

---

## Evaluation

Four scenarios were run against the live workflow. A–C test extraction across decreasing information. D tests the reliability boundary under real model failure.

### A — Strong lead, rich extraction ✅

```
"Hi, do you have a 6-seat van available from 12–19 August for 2 adults and 2 kids?"
```

Service, dates, group breakdown and booking intent all extracted correctly. `agent_valid: true`. Row written, event created, handoff delivered, nothing sent to the customer.

One honest partial: `missing_information` returned `availability_confirmation` but did not flag pickup and drop-off location, which the prompt requests. Reported as a partial pass rather than a green tick.

### B — Relative date, partial information

```
"Hello, we are 5 people interested in a boat tour next Friday. Do you have anything available?"
```

Designed to test extraction when the date is relative and the party breakdown is absent. Expected: `boat_tour`, group size 5, and `missing_information` naming the exact date, the preferred time and the adult/child split.

*Designed and specified; not executed within the hackathon window.*

### C — Ambiguous enquiry, over-assumption test

```
"Hi, how much is it?"
```

This is the scenario most agents fail: a system tuned for helpfulness invents a service type and answers a question it has no basis to answer. The prompt forbids it explicitly — `service_type` must be `unknown` with confidence 0 rather than a plausible guess, and `lead_status` must be `needs_clarification`.

*Designed and specified; not executed within the hackathon window.*

### D — Model failure ✅ (occurred naturally, not simulated)

During testing the OpenAI account exhausted its quota mid-run (execution `41205`). The resulting behaviour is the fault-injection test, unsimulated:

```
Workflow completed without error          yes
Row written to Lead_Log                   yes
agent_valid                               false
validation_missing_fields                 valid_json
lead_status                               needs_human_review
handoff_reason                            "LLM output was not valid JSON."
Slack handoff delivered, message intact   yes
trace_id preserved                        yes
customer_message_sent                     false
```

The agent degraded to human review instead of failing silently, and the operator received the original enquiry with an explicit review flag. **A–C show the agent works. D shows what happens when it does not — the only question that matters before putting an agent in front of a real operator's customers.**

---

## Repository

```text
.
├── README.md
├── docs/
│   └── reliability-brief.md        System and reliability brief
├── workflow/
│   └── lead-booking-workling.json  n8n workflow export
├── apps-script/
│   └── form-bridge.gs              Creates the Google Form, bridges it to n8n
└── sheet/
    └── lead-log-headers.csv        39 column headers for the Lead_Log tab
```

---

## Reproducing it

**Prerequisites:** an n8n instance (self-hosted or cloud), a Google account, a Slack workspace, and an OpenAI API key with credit.

**1. Google Sheet** — create a spreadsheet with a tab named exactly `Lead_Log`, and paste `sheet/lead-log-headers.csv` into row 1.

**2. Google Form** — open [script.google.com](https://script.google.com), paste `apps-script/form-bridge.gs`, then run `crearFormulario()`, copy the logged form ID into the `FORM_ID` constant, and run `instalarActivador()`.

**3. Slack** — create an app at [api.slack.com/apps](https://api.slack.com/apps) with the `chat:write` bot scope, install it to the workspace, and invite the bot to the target channel.

**4. Google Cloud** — enable the Sheets, Calendar and Drive APIs, create an OAuth client of type *Web application* with n8n's redirect URL, and add your Google account under **Test users** on the consent screen.

**5. n8n** — import `workflow/lead-booking-workling.json`, select the four credentials (Google Sheets, Google Calendar, Slack, OpenAI), set the Sheet ID, Calendar ID and Slack channel ID, then activate the workflow.

No secrets are stored in the workflow export. All credentials live in n8n's credential store.

---

## Known limitations

Stated plainly, because a project that claims none is not being honest about its scope.

- Availability, pricing and inventory are not connected. The agent qualifies and routes; it does not answer. Intentional.
- When a date carries no year, the agent emits the raw string plus a confirmation flag rather than resolved ISO dates. Resolving it would mean guessing.
- Single tenant in practice. `client_id` and `organization_id` are carried end to end but are not yet used for routing or isolation.
- No retry or dead-letter queue. A hard n8n failure is not currently replayed.
- Evaluation is scenario-based, not statistical. Four scenarios establish that the failure paths work; they do not establish an accuracy rate.
- The Apps Script bridge is a single point of failure for the Form channel. The webhook itself is channel-agnostic, so a second channel would not share it.

## What production would add

The invariants worth keeping — `trace_id`, tenant context, `response_mode`, the audit log, and the rule that no outbound action happens without an approval state — are exactly the ones production needs. On top of them:

- An approval action in the Slack handoff that sets `human_approved = true` and releases the draft, closing the loop
- Real channel ingestion (WhatsApp, Instagram, email) behind the same normalization contract
- Availability and pricing systems connected as tools, under the same rule: the agent reads, the human commits
- Retry with dead-letter handling, and per-tenant isolation
- Continuous evaluation against a labelled enquiry set

---

## Demo

**Two-minute video:** **← PEGAR ENLACE AQUÍ ANTES DEL PUSH FINAL**

**Live form:** https://docs.google.com/forms/d/e/1FAIpQLSfQKWzZj0YquoPRAqEADLYDjczXCGf_KLi2sfxdwzg7VofyGg/viewform

## Team

Estela Valiente · Esther López

## Stack

n8n · OpenAI `gpt-4o-mini` · Google Forms · Google Sheets · Google Calendar · Slack · Google Apps Script
