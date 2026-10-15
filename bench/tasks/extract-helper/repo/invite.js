export function invite(emails) {
  return emails.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}
