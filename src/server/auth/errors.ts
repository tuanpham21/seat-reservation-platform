export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid_credentials"
      | "email_taken"
      | "missing_session"
      | "invalid_session"
      | "csrf_failed"
      | "rate_limited"
  ) {
    super(message);
  }
}
