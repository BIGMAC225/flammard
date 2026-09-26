// Swap these out when the brand name is decided
export const BRAND = {
  name: import.meta.env.PUBLIC_APP_NAME || 'Flammard',
  tagline: 'Meeting records your organization can stand behind.',
  description:
    'Record L10 meetings, turn the transcript into rocks, to-dos, issues and minutes, and approve the record with a cryptographic seal.',
} as const;
