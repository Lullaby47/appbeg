export function getPublicDisplayName(username: string): string {
  const stripped = username.replace(/\d+$/, '').trim();
  return stripped || username;
}
