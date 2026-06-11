import { ReservationApp } from "@/app/ReservationApp";

export default function PaymentSuccess({
  searchParams
}: {
  searchParams: { paymentId?: string };
}) {
  return <ReservationApp initialPaymentId={searchParams.paymentId} />;
}
