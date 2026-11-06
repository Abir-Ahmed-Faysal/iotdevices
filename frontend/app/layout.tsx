import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FishVoice IoT | Device control",
  description: "Secure dashboard for monitoring and controlling your FishVoice IoT device.",
  icons: {
    apple: "/icon.png",
  },
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
