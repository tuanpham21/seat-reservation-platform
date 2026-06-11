import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Seat Reservation Platform",
  description: "Public seat reservation assessment app"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
