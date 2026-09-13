
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

Ten executions were run against the live workflow between 22:36 and 23:50 on
build day, across both ingestion channels and in two languages. Five ran during
an unplanned model outage; five completed normally. All ten are traceable by
`trace_id` in `Lead_Log`.

### Fault injection — unplanned, five consecutive executions

Not simulated. Mid-build the OpenAI account exhausted its quota and the API
returned `429 insufficient_quota` for every call over a fourteen-minute window.
Five consecutive executions (`41192`, `41193`, `41200`, `41201`, `41205`) reached
the reliability boundary carrying an error instead of a lead. Every one of them:

```text
completed without execution error        agent_valid = false
wrote its row to Lead_Log                validation_missing_fields = valid_json
escalated to needs_human_review          trace_id preserved
delivered the Slack handoff intact       customer_message_sent = false
```

Five failures, five identical outcomes, across both the Google Form and the
Manual Trigger channels. And once credit was restored, execution `41209`
succeeded on the next attempt — **no node changed, no state cleared, nothing
replayed by hand.** The system degraded deterministically and recovered on its
own.

### Successful extractions

| Trace | Lang | Input | `service_type` | Group | Booking | `missing_information` |
|---|---|---|---|---|---|---|
| 41209 | es | 16–21 Sept, husband + dog, **no year** | `unknown` (0) | 2 | low 0.2 | `year_confirmation` |
| 41213 | es | 15–21 Sept **2026**, husband + dog | `unknown` (0) | **3** | low 0.2 | `service_type` |
| 41214 | en | 12–19 Aug, 6-seat van, 2+2, **no year** | `van_rental` (1.0) | 4 — 2+2 | high 0.9 | `availability_confirmation` |
| 41227 | es | two groups of 2, rooms, 2026 | `unknown` (0) | 4 — 4 adults | medium 0.7 | `pickup_location`, `pickup_time`, `availability_confirmation` |
| 41246 | en | 12–19 Aug **2026**, 6-seat van, 2+2 | `van_rental` (1.0) | 4 — 2+2 | high 0.9 | `availability_confirmation` |

**Multilingual, without being asked for.** Spanish enquiries were classified
correctly and drafted a Spanish reply; English ones drafted English. Language
handling was never a requirement.

**It refused to guess, three times on real input.** Three of the five enquiries
never name a service. All three returned `service_type: unknown` with confidence
0 and put the gap in `missing_information`, rather than inventing a plausible
service — the behaviour most agents fail, demonstrated on live enquiries rather
than a prepared test.

**It reads indirect phrasing.** "Two groups of two people" resolved to 4 total,
4 adults.

### Three defects, open at submission

**D1 — pets counted inconsistently.** The sharpest finding, and only visible
because two comparable runs exist:

```text
41209  "con mi marido y nuestro perro"    ->  group_size.total = 2   (dog excluded)
41213  "mi marido, yo y nuestro perrito"  ->  group_size.total = 3   (dog included)
```

Same language, same structure, opposite treatment. The schema has nowhere to
record an animal, so the model resolves the ambiguity differently each time. For
a tourism operator this is not cosmetic: party size drives vehicle and room
allocation.

**D2 — `needs_year_confirmation` missed once in five.** It fired correctly in
`41209` and was correctly `false` in the three runs that state a year. It failed
only in `41214`. Four of five correct; the mechanism works, the miss is real.

**D3 — `missing_information` scope varies by service type.** Van rentals returned
`availability_confirmation` alone; the accommodation enquiry returned
`pickup_location`, `pickup_time` and `availability_confirmation`. The fields
exist in the model's vocabulary and are emitted in some contexts and not others —
a prompt-coverage gap, not an absent capability.

All three are prompt-level, all three have known fixes, and all three were left
unpatched rather than edited after the evaluation runs.

### Summary

```text
Executions analysed                                10   (5 during outage, 5 normal)
Pipeline behaved as designed                       10 / 10
Reached a human with full context                  10 / 10
customer_message_sent = true                        0
Silent failures                                     0
Partial or corrupt writes                           0
Channels exercised                                  2    Google Form, Manual Trigger
Languages exercised                                 2    en, es
Extraction defects characterised                    3    all open, all prompt-level
```

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

**Two-minute video:** https://drive.google.com/file/d/1bKJuVhyNoxCmqMZ5Av0KgTpLC2WfYYow/view?usp=sharing

**Live form:** https://docs.google.com/forms/d/e/1FAIpQLSfQKWzZj0YquoPRAqEADLYDjczXCGf_KLi2sfxdwzg7VofyGg/viewform

## Team

Estela Valiente · Esther López

## Stack

n8n · OpenAI `gpt-4o-mini` · Google Forms · Google Sheets · Google Calendar · Slack · Google Apps Script
