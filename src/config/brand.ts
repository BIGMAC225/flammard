// Swap these out when the brand name is decided
export const BRAND = {
  name: import.meta.env.PUBLIC_APP_NAME || 'Flammard',
  tagline: 'Meeting records your organization can stand behind.',
  description:
    'Record meetings, draft structured minutes with AI, approve with a cryptographic seal, and track acknowledgement across your team.',
} as const;
