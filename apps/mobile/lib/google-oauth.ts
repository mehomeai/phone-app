export const GOOGLE_OAUTH_SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  'google-calendar': 'https://www.googleapis.com/auth/calendar.events.readonly',
  'google-drive': 'https://www.googleapis.com/auth/drive.file',
} as const;

export const GOOGLE_SERVICES = ['google-calendar', 'google-drive'] as const;

export type GoogleService = (typeof GOOGLE_SERVICES)[number];

export function googleServiceCredentialKey(profileId: string, service: GoogleService) {
  return `me-google-service-credential-v1-${service}-${profileId}`;
}
