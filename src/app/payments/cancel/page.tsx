import { ReservationApp } from "@/app/ReservationApp";

export default function PaymentCancel({
  searchParams
}: {
  searchParams: { paymentId?: string };
}) {
  return <ReservationApp initialPaymentId={searchParams.paymentId} />;
}
