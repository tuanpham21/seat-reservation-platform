"use client";

import { CreditCard, LogOut, RefreshCw, TicketCheck, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type User = {
  id: string;
  email: string;
};

type Seat = {
  id: string;
  label: string;
  sortOrder: number;
  status: "available" | "held" | "held_by_you" | "reserved" | "disabled";
  hold: {
    id: string;
    expiresAt: string;
  } | null;
};

type PaymentStatus = {
  paymentId: string;
  holdId: string;
  amountCents: number;
  currency: string;
  businessState: "checkout_created" | "processing" | "succeeded" | "requires_review" | "failed" | "expired";
  providerStatus: string | null;
  reservationId: string | null;
  requiresReviewReason: string | null;
};

type AuthState = {
  accessToken: string;
  csrfToken: string;
  user: User;
};

const authStorageKey = "seat_reservation_auth";

function readStoredAuth(): AuthState | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(authStorageKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthState;
  } catch {
    window.localStorage.removeItem(authStorageKey);
    return null;
  }
}

function statusLabel(status: Seat["status"]) {
  if (status === "held_by_you") return "Held by you";
  if (status === "held" || status === "disabled") return "Unavailable";
  return status[0].toUpperCase() + status.slice(1);
}

function formatCountdown(expiresAt: string | null, now: number) {
  if (!expiresAt) return null;
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function buildAuthHeaders(base: HeadersInit = {}, auth: AuthState | null = null): Headers {
  const headers = new Headers(base);
  if (auth) {
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
  }
  return headers;
}

export function ReservationApp({ initialPaymentId }: { initialPaymentId?: string }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("Password123!");
  const [seats, setSeats] = useState<Seat[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState(initialPaymentId ?? "");
  const [payment, setPayment] = useState<PaymentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setAuth(readStoredAuth());
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeHold = useMemo(() => {
    const current = seats.find((seat) => {
      if (!seat.hold) return false;
      return new Date(seat.hold.expiresAt).getTime() > now;
    });

    return current?.hold ?? null;
  }, [now, seats]);
  const storeAuth = (next: AuthState | null) => {
    setAuth(next);
    if (next) {
      window.localStorage.setItem(authStorageKey, JSON.stringify(next));
    } else {
      window.localStorage.removeItem(authStorageKey);
    }
  };

  const refreshAuth = useCallback(
    async (current = auth) => {
      if (!current) return null;

      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: {
          "x-csrf-token": current.csrfToken
        }
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          storeAuth(null);
        }
        return null;
      }

      const data = (await response.json()) as AuthState;
      storeAuth(data);
      return data;
    },
    [auth]
  );

  const authorizedFetch = useCallback(
    async (input: string, init: RequestInit = {}, overrideAuth: AuthState | null = auth) => {
      const first = await fetch(input, {
        ...init,
        headers: buildAuthHeaders(init.headers ?? {}, overrideAuth)
      });

      if (first.status !== 401) {
        return first;
      }

      const refreshed = await refreshAuth(overrideAuth);
      if (!refreshed) {
        return first;
      }

      return fetch(input, {
        ...init,
        headers: buildAuthHeaders(init.headers ?? {}, refreshed)
      });
    },
    [auth, refreshAuth]
  );

  const loadSeats = useCallback(async (overrideAuth: AuthState | null = auth) => {
    const response = await authorizedFetch("/api/seats", {}, overrideAuth);
    if (!response.ok) return;
    const data = (await response.json()) as { seats: Seat[] };
    setSeats(data.seats);
  }, [auth, authorizedFetch]);

  useEffect(() => {
    void loadSeats();
  }, [loadSeats]);

  useEffect(() => {
    const hasExpiredVisibleHold = seats.some(
      (seat) => seat.hold && new Date(seat.hold.expiresAt).getTime() <= now
    );

    if (hasExpiredVisibleHold) {
      void loadSeats();
    }
  }, [loadSeats, now, seats]);

  useEffect(() => {
    if (!paymentId || !auth) return;

    let cancelled = false;
    const poll = async () => {
      const response = await authorizedFetch(`/api/payments/${paymentId}`);
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as PaymentStatus;
      setPayment(data);
      if (["succeeded", "requires_review", "failed", "expired"].includes(data.businessState)) {
        await loadSeats();
      }
    };

    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [auth, authorizedFetch, loadSeats, paymentId]);

  async function submitAuth() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Authentication failed.");
      storeAuth(data as AuthState);
      setMessage(mode === "register" ? "Registered and signed in." : "Signed in.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (auth) {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": auth.csrfToken }
      }).catch(() => undefined);
    }
    storeAuth(null);
    setPayment(null);
    setPaymentId("");
    await loadSeats(null);
  }

  async function holdSeat(seatId: string) {
    if (!auth) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch("/api/seats/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Unable to hold seat.");
      setMessage(`Held ${data.seat.label}.`);
      await loadSeats();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to hold seat.");
    } finally {
      setBusy(false);
    }
  }

  async function proceedToPayment() {
    if (!auth || !activeHold) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch("/api/payments/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holdId: activeHold.id })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Unable to start payment.");
      window.location.assign(data.checkoutUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to start payment.");
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Seat Reservation Platform</p>
          <h1>Three seats. One active hold. Payment-confirmed reservations.</h1>
        </div>
        <button
          className="icon-button"
          onClick={() => {
            void loadSeats();
          }}
          title="Refresh seats"
          type="button"
        >
          <RefreshCw aria-hidden="true" size={18} />
        </button>
      </section>

      <section className="workspace">
        <div className="auth-panel">
          {auth ? (
            <div className="signed-in">
              <UserRound aria-hidden="true" size={20} />
              <div>
                <span>Authenticated User</span>
                <strong>{auth.user.email}</strong>
              </div>
              <button className="ghost-button" onClick={logout} type="button">
                <LogOut aria-hidden="true" size={16} />
                Logout
              </button>
            </div>
          ) : (
            <>
              <div className="tabs" role="tablist" aria-label="Authentication mode">
                <button
                  className={mode === "login" ? "active" : ""}
                  onClick={() => setMode("login")}
                  type="button"
                >
                  Login
                </button>
                <button
                  className={mode === "register" ? "active" : ""}
                  onClick={() => setMode("register")}
                  type="button"
                >
                  Register
                </button>
              </div>
              <label>
                Email
                <input value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button className="primary-button" disabled={busy} onClick={submitAuth} type="button">
                <UserRound aria-hidden="true" size={16} />
                {mode === "register" ? "Register" : "Login"}
              </button>
            </>
          )}
        </div>

        <div className="seat-section">
          <div className="section-heading">
            <h2>Seats</h2>
            <span>USD 50.00</span>
          </div>
          <div className="seat-grid">
            {seats.map((seat) => {
              const countdown = formatCountdown(seat.hold?.expiresAt ?? null, now);
              const disabled = !auth || busy || !["available", "held_by_you"].includes(seat.status);
              return (
                <button
                  className={`seat-tile ${seat.status}`}
                  disabled={disabled}
                  key={seat.id}
                  onClick={() => holdSeat(seat.id)}
                  type="button"
                >
                  <span>{seat.label}</span>
                <strong>{statusLabel(seat.status)}</strong>
                  {countdown ? <em>{countdown}</em> : null}
                </button>
              );
            })}
          </div>

          <div className="action-row">
            <div>
              <span>Active Seat Hold</span>
              <strong>{activeHold ? formatCountdown(activeHold.expiresAt, now) : "None"}</strong>
            </div>
            <button
              className="primary-button"
              disabled={!auth || !activeHold || busy}
              onClick={proceedToPayment}
              type="button"
            >
              <CreditCard aria-hidden="true" size={16} />
              Proceed to payment
            </button>
          </div>
        </div>

        <div className="status-panel">
          <div className="section-heading">
            <h2>Payment Status</h2>
            <TicketCheck aria-hidden="true" size={19} />
          </div>
          {payment ? (
            <dl>
              <div>
                <dt>Payment</dt>
                <dd>{payment.businessState.replace("_", " ")}</dd>
              </div>
              <div>
                <dt>Reservation</dt>
                <dd>{payment.reservationId ?? "Pending provider confirmation"}</dd>
              </div>
              {payment.requiresReviewReason ? (
                <div>
                  <dt>Review</dt>
                  <dd>{payment.requiresReviewReason.replaceAll("_", " ")}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="muted">After Stripe redirects back, this area polls for confirmation.</p>
          )}
          {message ? <p className="message">{message}</p> : null}
        </div>
      </section>
    </main>
  );

}
