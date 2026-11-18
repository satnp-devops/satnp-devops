import { z } from 'zod';

// Setting definitions of the messaging module, declared here so the messaging service can read
// them with getSetting(); modules/messaging/module.js lists them so they show on the Settings screen.

export const optOutKeywordsSetting = {
  key: 'messaging.optOutKeywords',
  category: 'Messaging',
  label: 'Opt-out keywords',
  description:
    'When a person replies with exactly one of these words (comma-separated), their marketing consent on that channel is withdrawn. Transactional messages such as receipts still go out.',
  input: 'text',
  schema: z.string().trim().max(300),
  default: 'STOP, UNSUBSCRIBE, STOP ALL, बंद करें',
  levels: ['group', 'company'],
};

export const messagingSettings = [optOutKeywordsSetting];
