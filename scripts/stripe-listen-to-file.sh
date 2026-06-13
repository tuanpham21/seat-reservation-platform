#!/bin/sh
set -eu

secret_file="${STRIPE_WEBHOOK_SECRET_FILE:-/run/stripe/webhook-secret}"
forward_to="${STRIPE_FORWARD_TO:-http://app:3000/api/stripe/webhook}"

case "${STRIPE_API_KEY:-}" in
  sk_test_replace_me)
    echo "STRIPE_API_KEY must be replaced with a real Stripe test secret key before enabling the Stripe listener." >&2
    exit 1
    ;;
  sk_test_*)
    ;;
  *)
    echo "STRIPE_API_KEY must be a Stripe test secret key before enabling the Stripe listener." >&2
    exit 1
    ;;
esac

mkdir -p "$(dirname "$secret_file")"
rm -f "$secret_file"

pipe_dir="$(mktemp -d)"
log_pipe="$pipe_dir/stripe-listen.log"
stripe_pid=""

cleanup() {
  if [ -n "$stripe_pid" ]; then
    kill "$stripe_pid" 2>/dev/null || true
  fi
  rm -f "$log_pipe"
  rmdir "$pipe_dir" 2>/dev/null || true
}

trap cleanup EXIT INT TERM
mkfifo "$log_pipe"

stripe listen --api-key "$STRIPE_API_KEY" --forward-to "$forward_to" >"$log_pipe" 2>&1 &
stripe_pid="$!"

while IFS= read -r line; do
  printf '%s\n' "$line"

  secret="$(printf '%s\n' "$line" | sed -n 's/.*\(whsec_[A-Za-z0-9_]*\).*/\1/p' | head -n 1)"
  if [ -n "$secret" ]; then
    printf '%s' "$secret" > "$secret_file"
    chmod 600 "$secret_file"
  fi
done < "$log_pipe"

set +e
wait "$stripe_pid"
stripe_status="$?"
set -e
stripe_pid=""

if [ "$stripe_status" -ne 0 ]; then
  echo "stripe listen exited with status $stripe_status." >&2
  exit "$stripe_status"
fi
