// Text for the web top bar's signed-in pill (components/Shell.tsx): the reader's
// initial for the round badge and a short form of the email (the part before "@",
// cut to MAX chars with an ellipsis). Pure (lib/__tests__/accountLabel.test.ts).

export const SHORT_EMAIL_MAX = 18;

export function accountInitial(email: string | null | undefined): string {
  const c = (email ?? '').trim().charAt(0);
  return c ? c.toUpperCase() : 'E';
}

export function shortEmail(email: string | null | undefined, max = SHORT_EMAIL_MAX): string {
  const local = (email ?? '').trim().split('@')[0];
  if (!local) return 'Account';
  return local.length > max ? `${local.slice(0, max - 1)}…` : local;
}
