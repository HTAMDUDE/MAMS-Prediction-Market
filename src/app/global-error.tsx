"use client";

import { useEffect } from "react";

/** Last-resort screen when the root layout itself fails. It renders its own document, so it can't use the app's styles. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "grid", minHeight: "100vh", placeItems: "center", margin: 0, padding: 16, textAlign: "center" }}>
        <div>
          <h1 style={{ fontSize: 24 }}>Something went wrong</h1>
          <p style={{ color: "#666" }}>The site hit an unexpected error. Please try again.</p>
          <button type="button" onClick={() => retry()} style={{ marginTop: 16, padding: "10px 20px", borderRadius: 8, border: 0, background: "#7a1f2b", color: "#fff", fontSize: 16, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
