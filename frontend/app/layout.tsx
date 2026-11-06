import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Faysal IoT | Device control",
  description: "Secure dashboard for monitoring and controlling your Faysal IoT device.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
