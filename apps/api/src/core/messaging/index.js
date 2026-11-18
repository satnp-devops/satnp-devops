// The messaging service's public API (docs/platform/MESSAGING.md). Other modules (automations,
// reminders, intake, the AI service) import from here:
//
//   import { sendMessage } from '../../core/messaging/index.js';
//   await sendMessage({ companyId, channel: 'whatsapp', contactId, dealId, templateId, variables, actor: { type: 'system' } });

export * from './constants.js';
export { sendMessage, sendMessageInput, pickMethod, versionContent } from './send.js';
export {
  recordInboundMessage,
  recordMessageStatus,
  recordHandover,
  recordUnsubscribe,
  resolveInboundCompany,
  normalizeAddress,
  inboundInput,
  statusInput,
  handoverInput,
} from './inbound.js';
export { customerServiceWindow, latestTime } from './window.js';
export { decideSend, purposeFor, isOptOutText, parseKeywords } from './rules.js';
export {
  STANDARD_VARIABLES,
  TEMPLATE_LIMITS,
  bodyVariableOrder,
  placeholdersIn,
  renderTemplate,
  renderedText,
  standardVariables,
  templateVariables,
  toProviderText,
  validateTemplate,
} from './templates.js';
export { applyStatus } from './status.js';
export { throttleOutbound, takeFromBucket } from './throttle.js';
export { companyMessagingConnections, pickConnection } from './connections.js';
export { moveContactMessages, eraseContactMessages } from './privacy.js';
export { messagingSettings, optOutKeywordsSetting } from './settings.js';
