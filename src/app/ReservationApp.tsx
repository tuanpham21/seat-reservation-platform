"use client";

import { Armchair, CreditCard, LogOut, RefreshCw, TicketCheck, UserRound } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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

type StatusMessage = {
  scope: "auth" | "seat" | "payment";
  text: string;
  tone: "error" | "info" | "success";
};

type PendingAction = "auth" | "refresh" | "hold" | "checkout" | "logout" | null;
type SeatLoadState = "idle" | "loading" | "ready" | "error";

const authStorageKey = "seat_reservation_auth";
const terminalPaymentStates = new Set<PaymentStatus["businessState"]>([
  "succeeded",
  "requires_review",
  "failed",
  "expired"
]);

function readStoredAuth(): AuthState | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(authStorageKey) ?? window.localStorage.getItem(authStorageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthState;
    window.sessionStorage.setItem(authStorageKey, JSON.stringify(parsed));
    window.localStorage.removeItem(authStorageKey);
    return parsed;
  } catch {
    window.localStorage.removeItem(authStorageKey);
    window.sessionStorage.removeItem(authStorageKey);
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

function formatCountdownForSpeech(expiresAt: string | null, now: number) {
  if (!expiresAt) return null;
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ${seconds} ${
    seconds === 1 ? "second" : "seconds"
  }`;
}

function buildAuthHeaders(base: HeadersInit = {}, auth: AuthState | null = null): Headers {
  const headers = new Headers(base);
  if (auth) {
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
  }
  return headers;
}

function isTerminalPaymentState(state: PaymentStatus["businessState"]) {
  return terminalPaymentStates.has(state);
}

function getStatusBadgeClass(state: PaymentStatus["businessState"]) {
  if (state === "succeeded") return "badge success";
  if (state === "failed" || state === "expired") return "badge danger";
  if (state === "requires_review") return "badge warning";
  if (state === "processing") return "badge processing";
  return "badge info";
}

function reservationStatusText(payment: PaymentStatus) {
  if (payment.reservationId) return payment.reservationId;
  if (payment.businessState === "succeeded") return "Confirmed";
  if (payment.businessState === "requires_review") return "Pending manual review";
  if (payment.businessState === "failed") return "Payment failed";
  if (payment.businessState === "expired") return "Payment expired";
  return "Pending provider confirmation";
}

function paymentNextStepText(payment: PaymentStatus) {
  if (payment.businessState === "succeeded") return "Reservation confirmed. Polling has stopped.";
  if (payment.businessState === "requires_review") return "This payment needs manual review before the seat is confirmed.";
  if (payment.businessState === "failed") return "The payment failed. Hold an available seat and try checkout again.";
  if (payment.businessState === "expired") return "The payment expired. Hold an available seat and start checkout again.";
  return "Waiting for provider confirmation. Polling pauses while this tab is inactive.";
}

function seatDisabledReason(
  seat: Seat,
  auth: AuthState | null,
  pendingAction: PendingAction,
  seatLoadState: SeatLoadState
) {
  if (!auth) return "Sign in to hold an available seat";
  if (seatLoadState === "loading") return "Seats are loading";
  if (seatLoadState === "error") return "Refresh seats before changing seats";
  if (pendingAction) return "Another action is in progress";
  if (seat.status === "held") return "Seat is held by another user";
  if (seat.status === "reserved") return "Seat is already reserved";
  if (seat.status === "disabled") return "Seat is unavailable";
  return null;
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const data = (await response.json()) as { error?: { message?: string } };
    return data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function clearLocalActiveHoldAfterTerminalPayment(seats: Seat[], state: PaymentStatus["businessState"]) {
  const fallbackStatus: Seat["status"] = state === "succeeded" ? "reserved" : "disabled";

  return seats.map((seat) =>
    seat.status === "held_by_you"
      ? {
          ...seat,
          hold: null,
          status: fallbackStatus
        }
      : seat
  );
}

export function ReservationApp({ initialPaymentId }: { initialPaymentId?: string }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const authRef = useRef<AuthState | null>(null);
  const seatLoadRequestId = useRef(0);
  const [authHydrated, setAuthHydrated] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("Password123!");
  const [seats, setSeats] = useState<Seat[]>([]);
  const [seatLoadState, setSeatLoadState] = useState<SeatLoadState>("idle");
  const [seatLoadError, setSeatLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [paymentId, setPaymentId] = useState(initialPaymentId ?? "");
  const [payment, setPayment] = useState<PaymentStatus | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [now, setNow] = useState(Date.now());
  const isBusy = pendingAction !== null;
  const isAuthBusy = pendingAction === "auth";
  const isRefreshBusy = pendingAction === "refresh";
  const isCheckoutBusy = pendingAction === "checkout";
  const isLogoutBusy = pendingAction === "logout";

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeHoldSeat = useMemo(() => {
    return seats.find((seat) => {
      if (seat.status !== "held_by_you" || !seat.hold) return false;
      return new Date(seat.hold.expiresAt).getTime() > now;
    }) ?? null;
  }, [now, seats]);
  const activeHold = activeHoldSeat?.hold ?? null;
  const seatPickerHint = !auth
    ? "Sign in to hold an available seat."
    : seatLoadState === "loading"
      ? "Seats are loading."
      : seatLoadState === "error"
        ? "Refresh seats before changing seats."
        : isBusy
          ? "Finish the current action before changing seats."
          : null;
  const checkoutDisabledReason = !auth
    ? "Sign in before checkout."
    : seatLoadState === "loading"
      ? "Seats are loading."
      : seatLoadState === "error"
        ? "Refresh seats before checkout."
        : isBusy
          ? "Finish the current action before checkout."
          : !activeHold
            ? "Hold an available seat before checkout."
            : null;
  const canCheckout = checkoutDisabledReason === null;
  const storeAuth = useCallback((next: AuthState | null) => {
    authRef.current = next;
    setAuth(next);
    if (next) {
      window.localStorage.removeItem(authStorageKey);
      window.sessionStorage.setItem(authStorageKey, JSON.stringify(next));
    } else {
      window.localStorage.removeItem(authStorageKey);
      window.sessionStorage.removeItem(authStorageKey);
    }
  }, []);

  useEffect(() => {
    storeAuth(readStoredAuth());
    setAuthHydrated(true);
  }, [storeAuth]);

  const refreshAuth = useCallback(
    async (current = authRef.current) => {
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
    [storeAuth]
  );

  const authorizedFetch = useCallback(
    async (input: string, init: RequestInit = {}, overrideAuth: AuthState | null = authRef.current) => {
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
    [refreshAuth]
  );

  const loadSeats = useCallback(async (overrideAuth: AuthState | null = authRef.current, options: { quiet?: boolean } = {}) => {
    const requestId = seatLoadRequestId.current + 1;
    seatLoadRequestId.current = requestId;
    const isLatestRequest = () => requestId === seatLoadRequestId.current;

    if (!options.quiet) {
      setSeatLoadState("loading");
      setSeatLoadError(null);
    }

    try {
      const response = await authorizedFetch("/api/seats", {}, overrideAuth);
      if (!response.ok) {
        const errorMessage = await readErrorMessage(response, "Unable to load seats.");
        if (!isLatestRequest()) return false;
        setSeatLoadState("error");
        setSeatLoadError(errorMessage);
        if (!options.quiet) {
          setMessage({ scope: "seat", text: errorMessage, tone: "error" });
        }
        return false;
      }

      const data = (await response.json()) as { seats: Seat[] };
      if (!isLatestRequest()) return false;
      setSeats(data.seats);
      setSeatLoadState("ready");
      setSeatLoadError(null);
      return true;
    } catch {
      if (!isLatestRequest()) return false;
      const errorMessage = "Unable to load seats.";
      setSeatLoadState("error");
      setSeatLoadError(errorMessage);
      if (!options.quiet) {
        setMessage({ scope: "seat", text: errorMessage, tone: "error" });
      }
      return false;
    }
  }, [authorizedFetch]);

  useEffect(() => {
    if (!authHydrated) return;
    void loadSeats();
  }, [auth?.user.id, authHydrated, loadSeats]);

  useEffect(() => {
    if (document.visibilityState !== "visible") return;

    const hasExpiredVisibleHold = seats.some(
      (seat) => seat.hold && new Date(seat.hold.expiresAt).getTime() <= now
    );

    if (hasExpiredVisibleHold) {
      void loadSeats(authRef.current, { quiet: true });
    }
  }, [auth?.user.id, loadSeats, now, seats]);

  useEffect(() => {
    if (!paymentId || !auth) return;

    let cancelled = false;
    let inFlight = false;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedulePoll = () => {
      clearTimer();
      if (!cancelled && document.visibilityState === "visible") {
        timer = window.setTimeout(() => {
          void poll();
        }, 2500);
      }
    };

    async function poll() {
      if (cancelled || inFlight || document.visibilityState !== "visible") return;

      inFlight = true;
      let shouldContinuePolling = true;

      try {
        const response = await authorizedFetch(`/api/payments/${paymentId}`);
        if (!response.ok) {
          const errorMessage = await readErrorMessage(response, "Unable to check payment status.");
          if (!cancelled) {
            setMessage({ scope: "payment", text: errorMessage, tone: "error" });
          }
          return;
        }
        if (cancelled) return;

        const data = (await response.json()) as PaymentStatus;
        setPayment(data);
        setMessage((current) => (current?.scope === "payment" ? null : current));

        if (isTerminalPaymentState(data.businessState)) {
          shouldContinuePolling = false;
          setPaymentId("");
          setSeats((currentSeats) => clearLocalActiveHoldAfterTerminalPayment(currentSeats, data.businessState));
          const seatsRefreshed = await loadSeats(authRef.current, { quiet: true });
          if (!seatsRefreshed && !cancelled) {
            setMessage({
              scope: "payment",
              text: "Payment status updated, but seats could not refresh. Refresh seats before starting another checkout.",
              tone: "error"
            });
          }
        }
      } catch {
        if (!cancelled) {
          setMessage({
            scope: "payment",
            text: "Unable to check payment status. Polling will retry while this tab is open.",
            tone: "error"
          });
        }
      } finally {
        inFlight = false;
        if (shouldContinuePolling) {
          schedulePoll();
        }
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
      } else {
        clearTimer();
      }
    };

    void poll();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [auth, authorizedFetch, loadSeats, paymentId]);

  async function submitAuth(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pendingAction) return;

    setPendingAction("auth");
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
      setMessage({
        scope: "auth",
        text: mode === "register" ? "Registered and signed in." : "Signed in.",
        tone: "success"
      });
    } catch (error) {
      setMessage({
        scope: "auth",
        text: error instanceof Error ? error.message : "Authentication failed.",
        tone: "error"
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function logout() {
    if (pendingAction) return;

    setPendingAction("logout");
    try {
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
    } finally {
      setPendingAction(null);
    }
  }

  async function holdSeat(seatId: string) {
    if (!auth || pendingAction) return;

    setPendingAction("hold");
    setMessage(null);
    try {
      const response = await authorizedFetch("/api/seats/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Unable to hold seat.");
      setMessage({ scope: "seat", text: `Held ${data.seat.label}.`, tone: "success" });
      await loadSeats();
    } catch (error) {
      setMessage({
        scope: "seat",
        text: error instanceof Error ? error.message : "Unable to hold seat.",
        tone: "error"
      });
      await loadSeats(authRef.current, { quiet: true });
    } finally {
      setPendingAction(null);
    }
  }

  async function proceedToPayment() {
    if (!auth || !activeHold || pendingAction || seatLoadState !== "ready") return;

    setPendingAction("checkout");
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
      setMessage({
        scope: "payment",
        text: error instanceof Error ? error.message : "Unable to start payment.",
        tone: "error"
      });
      setPendingAction(null);
    }
  }

  async function refreshSeats() {
    if (pendingAction) return;

    setPendingAction("refresh");
    try {
      await loadSeats();
    } finally {
      setPendingAction(null);
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
          aria-label={isRefreshBusy ? "Refreshing seats" : "Refresh seats"}
          className={`icon-button ${isRefreshBusy ? "animate-spin" : ""}`}
          onClick={() => {
            void refreshSeats();
          }}
          title="Refresh seats"
          type="button"
          disabled={isBusy}
        >
          <RefreshCw aria-hidden="true" size={18} />
        </button>
      </section>

      <section className="workspace">
        <div className="auth-panel">
          {auth ? (
            <div className="signed-in">
              <div className="user-avatar">
                <UserRound aria-hidden="true" size={20} />
              </div>
              <div>
                <span className="user-label">Authenticated User</span>
                <strong>{auth.user.email}</strong>
              </div>
              <button className="ghost-button" onClick={logout} type="button" disabled={isBusy}>
                {isLogoutBusy ? (
                  <RefreshCw className="animate-spin" aria-hidden="true" size={16} />
                ) : (
                  <LogOut aria-hidden="true" size={16} />
                )}
                {isLogoutBusy ? "Logging out…" : "Logout"}
              </button>
            </div>
          ) : (
            <form aria-describedby={message?.scope === "auth" ? "auth-message" : undefined} onSubmit={submitAuth}>
              <fieldset className="tabs">
                <legend className="sr-only">Authentication mode</legend>
                <button
                  aria-pressed={mode === "login"}
                  className={mode === "login" ? "active" : ""}
                  onClick={() => setMode("login")}
                  type="button"
                  disabled={isBusy}
                >
                  Login
                </button>
                <button
                  aria-pressed={mode === "register"}
                  className={mode === "register" ? "active" : ""}
                  onClick={() => setMode("register")}
                  type="button"
                  disabled={isBusy}
                >
                  Register
                </button>
              </fieldset>
              <label>
                Email
                <input
                  autoComplete="email"
                  disabled={isBusy}
                  inputMode="email"
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  spellCheck={false}
                  type="email"
                  value={email}
                />
              </label>
              <label>
                Password
                <input
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  disabled={isBusy}
                  name="password"
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
              </label>
              <button className="primary-button" disabled={isBusy} type="submit">
                {isAuthBusy ? (
                  <RefreshCw className="animate-spin" aria-hidden="true" size={16} />
                ) : (
                  <UserRound aria-hidden="true" size={16} />
                )}
                {isAuthBusy ? "Authenticating…" : mode === "register" ? "Register" : "Login"}
              </button>
              {message?.scope === "auth" ? (
                <p aria-live="polite" className={`message ${message.tone}`} id="auth-message" role="status">
                  {message.text}
                </p>
              ) : null}
            </form>
          )}
        </div>

        <div className="seat-section">
          <div className="section-heading">
            <h2>Seats</h2>
            <span>USD 50.00</span>
          </div>

          <div className="screen-container">
            <div className="screen-line"></div>
            <div className="screen-text">Stage / Screen</div>
          </div>

          <div className="seat-legend">
            <div className="legend-item">
              <span aria-hidden="true" className="legend-dot available"></span>
              <span>Available</span>
            </div>
            <div className="legend-item">
              <span aria-hidden="true" className="legend-dot held-by-you"></span>
              <span>Held by You</span>
            </div>
            <div className="legend-item">
              <span aria-hidden="true" className="legend-dot held"></span>
              <span>Held (Others)</span>
            </div>
            <div className="legend-item">
              <span aria-hidden="true" className="legend-dot reserved"></span>
              <span>Reserved</span>
            </div>
          </div>
          {seatPickerHint ? (
            <p className="inline-hint" id="seat-picker-hint">
              {seatPickerHint}
            </p>
          ) : null}

          <div aria-busy={seatLoadState === "loading"} aria-describedby={seatPickerHint ? "seat-picker-hint" : undefined} className="seat-grid">
            {seatLoadState === "loading" && seats.length === 0 ? (
              <p aria-live="polite" className="seat-grid-status" role="status">
                Loading seats…
              </p>
            ) : null}
            {seatLoadState === "error" && seats.length === 0 ? (
              <p aria-live="polite" className="seat-grid-status error" role="status">
                {seatLoadError ?? "Unable to load seats."}
              </p>
            ) : null}
            {seatLoadState === "ready" && seats.length === 0 ? (
              <p aria-live="polite" className="seat-grid-status" role="status">
                No seats are configured.
              </p>
            ) : null}
            {seats.map((seat) => {
              const countdown = formatCountdown(seat.hold?.expiresAt ?? null, now);
              const countdownSpeech = formatCountdownForSpeech(seat.hold?.expiresAt ?? null, now);
              const disabledReason = seatDisabledReason(seat, auth, pendingAction, seatLoadState);
              const disabled = !auth || isBusy || seatLoadState !== "ready" || !["available", "held_by_you"].includes(seat.status);
              return (
                <button
                  aria-describedby={seatPickerHint ? "seat-picker-hint" : undefined}
                  aria-label={`${seat.label}: ${statusLabel(seat.status)}${
                    countdownSpeech ? `, hold expires in ${countdownSpeech}` : ""
                  }${disabledReason ? `. ${disabledReason}.` : ""}`}
                  className={`seat-tile ${seat.status}`}
                  disabled={disabled}
                  key={seat.id}
                  onClick={() => holdSeat(seat.id)}
                  type="button"
                >
                  <Armchair aria-hidden="true" size={24} style={{ color: "inherit", opacity: 0.8 }} />
                  <span>{seat.label}</span>
                  <strong>{statusLabel(seat.status)}</strong>
                  {countdown ? <em aria-hidden="true">{countdown}</em> : null}
                </button>
              );
            })}
          </div>

          <div className="action-row">
            <div>
              <span className="summary-label">Active Seat Hold</span>
              <strong>
                {activeHoldSeat && activeHold ? (
                  <>
                    <span aria-hidden="true" className="hold-summary">
                      {activeHoldSeat.label} - {formatCountdown(activeHold.expiresAt, now)}
                    </span>
                    <span className="sr-only">
                      {activeHoldSeat.label} hold expires in {formatCountdownForSpeech(activeHold.expiresAt, now)}
                    </span>
                  </>
                ) : (
                  "None"
                )}
              </strong>
            </div>
            <button
              aria-describedby={checkoutDisabledReason ? "checkout-hint" : undefined}
              className="primary-button"
              disabled={!canCheckout}
              onClick={proceedToPayment}
              type="button"
            >
              {isCheckoutBusy ? (
                <RefreshCw className="animate-spin" aria-hidden="true" size={16} />
              ) : (
                <CreditCard aria-hidden="true" size={16} />
              )}
              {isCheckoutBusy ? "Redirecting…" : "Proceed to payment"}
            </button>
          </div>
          {checkoutDisabledReason ? (
            <p className="inline-hint" id="checkout-hint">
              {checkoutDisabledReason}
            </p>
          ) : null}
          {message?.scope === "seat" ? (
            <p aria-live="polite" className={`message ${message.tone}`} role="status">
              {message.text}
            </p>
          ) : null}
        </div>

        <div className="status-panel">
          <div className="section-heading">
            <h2>Payment Status</h2>
            <TicketCheck aria-hidden="true" size={19} />
          </div>
          <div aria-live="polite" role="status">
            {payment ? (
              <dl>
                <div>
                  <dt>Payment</dt>
                  <dd>
                    <span className={getStatusBadgeClass(payment.businessState)}>
                      {payment.businessState.replace("_", " ")}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Reservation</dt>
                  <dd>{reservationStatusText(payment)}</dd>
                </div>
                <div>
                  <dt>Next step</dt>
                  <dd>{paymentNextStepText(payment)}</dd>
                </div>
                {payment.requiresReviewReason ? (
                  <div>
                    <dt>Review</dt>
                    <dd>{payment.requiresReviewReason.replaceAll("_", " ")}</dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="muted">
                {paymentId
                  ? "Checking payment status…"
                  : "After Stripe redirects back, this area polls for confirmation."}
              </p>
            )}
            {message?.scope === "payment" ? <p className={`message ${message.tone}`}>{message.text}</p> : null}
          </div>
        </div>
      </section>
    </main>
  );

}
