'use strict';

// Outbound email, used for sign-in codes. Two implementations behind one method, send({to, subject, text}):
//  - createMockEmailer: records messages (tests, local demos)
//  - createSesEmailer: Amazon SES v2. NOT yet exercised against real SES: verify the sender address/domain in SES
//    first, and note new SES accounts start in a sandbox that only delivers to verified addresses.
function createMockEmailer() {
  const emailer = { kind: 'mock', sent: [], async send(msg) { emailer.sent.push({ ...msg }); return { id: `mock_${emailer.sent.length}` }; } };
  return emailer;
}

function createSesEmailer({ from, region = process.env.AWS_REGION || 'ap-southeast-2', client = null }) {
  if (!from) throw new Error('PORTAL_FROM_EMAIL is required to send sign-in emails');
  let ses = client;
  return {
    kind: 'ses',
    async send({ to, subject, text }) {
      if (!ses) {
        const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
        ses = { client: new SESv2Client({ region }), SendEmailCommand };
      }
      const cmd = ses.SendEmailCommand
        ? new ses.SendEmailCommand({ FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } } })
        : { FromEmailAddress: from, Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } } };
      const out = await (ses.client || ses).send(cmd);
      return { id: out && out.MessageId };
    },
  };
}

module.exports = { createMockEmailer, createSesEmailer };
