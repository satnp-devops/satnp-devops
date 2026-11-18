// Enquiry channels: how a lead reached a company. These are kinds of source, not connected
// accounts (a company's WhatsApp numbers and inboxes arrive with the integration framework).
//
// Channels are configuration in the module registry, like unit types: the deals module
// contributes the built-in ones below and any module can add more with `channels: [...]` in its
// module.js. deals.channel stores the key as text, so adding a channel needs no migration and no
// frontend change (the web app reads GET /deals/channels).
//
//   group          how the web app groups and colours the channel
//   firstReplySla  new enquiries on this channel get a first-reply target (deals.firstReplySlaMinutes)

export const BUILT_IN_CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp', group: 'messaging', firstReplySla: true },
  { key: 'website_form', label: 'Website form', group: 'web', firstReplySla: true },
  { key: 'website_checkout', label: 'Website checkout', group: 'web', firstReplySla: false },
  { key: 'voice_call', label: 'Phone call', group: 'voice', firstReplySla: true },
  { key: 'email', label: 'Email', group: 'email', firstReplySla: true },
  { key: 'lead_ad_instagram', label: 'Instagram lead ad', group: 'ads', firstReplySla: true },
  { key: 'lead_ad_facebook', label: 'Facebook lead ad', group: 'ads', firstReplySla: true },
  { key: 'partner_referral', label: 'Partner referral', group: 'partner', firstReplySla: true },
  { key: 'csv_import', label: 'CSV import', group: 'import', firstReplySla: false },
  { key: 'manual', label: 'Added by hand', group: 'manual', firstReplySla: false },
];

export const CHANNEL_GROUPS = ['messaging', 'web', 'voice', 'email', 'ads', 'partner', 'import', 'manual', 'other'];

const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** Check a channel contributed by a module. Throws on a malformed definition. */
export function assertChannelDefinition(channel) {
  if (!channel || typeof channel !== 'object') throw new Error('A channel must be an object');
  if (!KEY.test(channel.key ?? '')) throw new Error(`Channel key "${channel.key}" must be lowercase letters, digits and _`);
  if (!channel.label) throw new Error(`Channel "${channel.key}" needs a label`);
  if (channel.group && !CHANNEL_GROUPS.includes(channel.group)) {
    throw new Error(`Channel "${channel.key}" has an unknown group "${channel.group}"`);
  }
}

/** Every channel in the registry, in registration order, ready for the API. */
export function listChannels(registry) {
  return [...(registry?.channels?.values() ?? [])].map(({ key, label, group, firstReplySla }) => ({
    key,
    label,
    group: group ?? 'other',
    firstReplySla: firstReplySla === true,
  }));
}

export function isKnownChannel(registry, key) {
  return Boolean(registry?.channels?.has(key));
}

/** Does a new enquiry on this channel get a first-reply target? Unknown channels do not. */
export function channelHasFirstReplySla(registry, key) {
  return registry?.channels?.get(key)?.firstReplySla === true;
}
