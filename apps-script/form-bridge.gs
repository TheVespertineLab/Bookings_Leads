/**
 * Lead & Booking Workling — Google Form intake bridge
 *
 * Creates the public intake form and forwards every submission to the n8n
 * webhook that runs the agent.
 *
 * The bridge performs no transformation. It forwards the answers using the same
 * keys the "Normalize Inbound Request" node already reads, so all normalization
 * logic stays in one place: the workflow.
 *
 * SETUP (run once, in this order):
 *   1. Run  createForm()        -> creates the form and logs its ID
 *   2. Copy the logged ID into the FORM_ID constant below
 *   3. Run  installTrigger()    -> connects the form to the webhook
 *   4. Run  testWebhook()       -> verifies the connection without submitting
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Production webhook URL. Requires the workflow to be ACTIVE in n8n.
// To test against an inactive workflow, swap /webhook/ for /webhook-test/ and
// press "Test workflow" in n8n immediately before submitting.
const WEBHOOK_URL = 'https://YOUR_N8N_HOST/webhook/worklings-booking-request';

// Filled in after step 1, with the value printed to the execution log.
const FORM_ID = 'PASTE_FORM_ID_HERE';

// Exact question titles. These are the keys sent to n8n and the ones the
// "Normalize Inbound Request" node reads. Changing them here means changing
// them in that node too.
const QUESTIONS = {
  name: 'Customer name',
  email: 'Email',
  phone: 'Phone',
  message: 'Message'
};

// ---------------------------------------------------------------------------
// Step 1 — Create the form
// ---------------------------------------------------------------------------

/**
 * Creates the intake form with its four questions. Run once.
 * The resulting form ID is written to the execution log.
 */
function createForm() {
  const form = FormApp.create('Worklings Demo — Booking Request');

  form.setTitle('Mediterranean Tours & Rentals — Booking Request');
  form.setDescription(
    'Tell us what you are looking for and our team will get back to you.\n\n' +
    'Van rentals · Boat tours · Guided experiences · Airport transfers'
  );
  form.setConfirmationMessage(
    'Thanks for your message. Our team is reviewing your request and will ' +
    'get back to you shortly.'
  );

  // Email is a regular question rather than an auto-collected field, so the
  // agent has to detect when contact details are missing.
  form.setCollectEmail(false);
  form.setAllowResponseEdits(false);
  form.setProgressBar(false);

  form.addTextItem()
    .setTitle(QUESTIONS.name)
    .setHelpText('Optional')
    .setRequired(false);

  form.addTextItem()
    .setTitle(QUESTIONS.email)
    .setHelpText('Optional, but it helps us reply faster')
    .setRequired(false);

  form.addTextItem()
    .setTitle(QUESTIONS.phone)
    .setHelpText('Optional')
    .setRequired(false);

  // Deliberately a single free-text field. Structuring prose is the agent's
  // job; pre-structuring it here would reduce the pipeline to a field copier.
  form.addParagraphTextItem()
    .setTitle(QUESTIONS.message)
    .setHelpText(
      'Tell us what you need — dates, how many people, what kind of service. ' +
      'Write it however you like.'
    )
    .setRequired(true);

  Logger.log('=== FORM CREATED ===');
  Logger.log('FORM_ID (copy into the constant above): ' + form.getId());
  Logger.log('Public URL: ' + form.getPublishedUrl());
  Logger.log('Edit URL:   ' + form.getEditUrl());
}

// ---------------------------------------------------------------------------
// Step 2 — Connect the form to the webhook
// ---------------------------------------------------------------------------

/**
 * Installs the on-form-submit trigger.
 * Idempotent: removes any previous trigger for the same handler first.
 */
function installTrigger() {
  if (FORM_ID === 'PASTE_FORM_ID_HERE') {
    throw new Error('FORM_ID is not set. Run createForm() first and copy the logged ID.');
  }

  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'onFormSubmit')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('onFormSubmit')
    .forForm(FormApp.openById(FORM_ID))
    .onFormSubmit()
    .create();

  Logger.log('Trigger installed.');
}

// ---------------------------------------------------------------------------
// Bridge to n8n
// ---------------------------------------------------------------------------

/**
 * Runs on every form submission and forwards the response to the webhook.
 * @param {Object} e Google Forms event, carrying e.response (FormResponse).
 */
function onFormSubmit(e) {
  const answers = {};

  if (e && e.response) {
    e.response.getItemResponses().forEach((item) => {
      answers[item.getItem().getTitle()] = String(item.getResponse() || '').trim();
    });
  }

  sendToWorkling(answers);
}

/**
 * Posts the payload to the n8n webhook.
 * @param {Object} answers Map of question title -> answer.
 */
function sendToWorkling(answers) {
  const payload = {
    source_channel: 'google_form',
    'Customer name': answers[QUESTIONS.name] || '',
    'Email':         answers[QUESTIONS.email] || '',
    'Phone':         answers[QUESTIONS.phone] || '',
    'Message':       answers[QUESTIONS.message] || ''
  };

  // muteHttpExceptions keeps a network failure from leaving the trigger in an
  // error state and blocking later submissions. The outcome is logged below.
  const response = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });

  Logger.log('Sent to Workling — HTTP ' + response.getResponseCode());
  Logger.log('Payload: ' + JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Scenario A — strong lead. Verifies the connection without using the form. */
function testWebhook() {
  sendToWorkling({
    [QUESTIONS.name]: 'Demo Customer',
    [QUESTIONS.email]: 'customer@example.com',
    [QUESTIONS.phone]: '+34600000000',
    [QUESTIONS.message]:
      'Hi, do you have a 6-seat van available from 12-19 August for 2 adults and 2 kids?'
  });
}

/** Scenario C — ambiguous enquiry. The agent must not invent a service type. */
function testAmbiguousEnquiry() {
  sendToWorkling({
    [QUESTIONS.name]: '',
    [QUESTIONS.email]: '',
    [QUESTIONS.phone]: '',
    [QUESTIONS.message]: 'Hi, how much is it?'
  });
}
