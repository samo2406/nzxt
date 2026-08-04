/**
 * Spotify requires the redirect URI to match the registered one byte for byte.
 * Deriving it from the live location is the only way to guarantee the string
 * shown in the config UI is the string actually sent.
 */
export function redirectUri(): string {
  return location.origin + location.pathname;
}
