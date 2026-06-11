export default function Home() {
  return (
    <main className="shell">
      <section className="workspace">
        <p className="eyebrow">Seat Reservation Platform</p>
        <h1>Reserve one of three public seats after payment confirmation.</h1>
        <p className="lede">
          Authenticated users can hold a seat, start a Stripe test payment, and receive a reservation
          only after provider confirmation.
        </p>
      </section>
    </main>
  );
}
