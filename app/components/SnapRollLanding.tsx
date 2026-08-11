"use client";

import { useState, useEffect, useRef } from "react";

const NAVY = "#0B1220";
const BLUE = "#2E5CFF";
const LIGHTBLUE = "#EAF0FF";
const GRAY = "#6B7688";
const LIGHTGRAY = "#F1F3F8";
const GREEN = "#16A34A";

function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, visible] as const;
}

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const [ref, visible] = useReveal();
  return (
    <div
      ref={ref}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(16px)",
        transition: `opacity 0.6s ease ${delay}s, transform 0.6s ease ${delay}s`,
      }}
    >
      {children}
    </div>
  );
}

export default function SnapRollLanding({ onSignIn, signInDisabled }: { onSignIn: () => void; signInDisabled?: boolean }) {
  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#fff", color: NAVY, margin: "-20px -20px -8px", minHeight: "100vh" }}>
      {/* ===== HERO ===== */}
      <section
        style={{
          background: NAVY,
          position: "relative",
          overflow: "hidden",
          padding: "0 0 80px",
        }}
      >
        <svg
          width="100%"
          height="520"
          viewBox="0 0 800 520"
          style={{ position: "absolute", top: 0, left: 0, opacity: 0.16 }}
        >
          <path d="M -20 120 L 200 120 L 240 160 L 500 160 L 540 120 L 820 120" stroke="#4F6BFF" strokeWidth="1.5" fill="none" />
          <path d="M -20 280 L 160 280 L 200 320 L 600 320 L 640 360 L 820 360" stroke="#4F6BFF" strokeWidth="1.5" fill="none" />
          <path d="M -20 420 L 300 420 L 340 460 L 820 460" stroke="#4F6BFF" strokeWidth="1.5" fill="none" />
          <circle cx="240" cy="160" r="4" fill="#7C93FF" />
          <circle cx="540" cy="120" r="4" fill="#7C93FF" />
          <circle cx="600" cy="320" r="4" fill="#7C93FF" />
        </svg>

        <div
          style={{
            position: "relative",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "24px 24px 0",
            maxWidth: 1100,
            margin: "0 auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: BLUE }} />
            <span style={{ color: "#fff", fontWeight: 800, fontSize: 17, letterSpacing: -0.3 }}>
              SnapRoll
            </span>
          </div>
          <button
            onClick={onSignIn}
            disabled={signInDisabled}
            style={{
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 10,
              padding: "8px 16px",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Sign in
          </button>
        </div>

        <div
          style={{
            position: "relative",
            maxWidth: 720,
            margin: "0 auto",
            textAlign: "center",
            padding: "72px 24px 0",
          }}
        >
          <div
            style={{
              display: "inline-block",
              background: "rgba(46,92,255,0.15)",
              border: "1px solid rgba(46,92,255,0.35)",
              borderRadius: 20,
              padding: "5px 14px",
              fontSize: 12,
              fontWeight: 700,
              color: "#9DB0FF",
              letterSpacing: 0.3,
              marginBottom: 22,
            }}
          >
            BUILT ON CIRCLE WALLETS + ARC
          </div>
          <h1
            style={{
              fontFamily: "'Space Grotesk', 'Inter', sans-serif",
              fontSize: "clamp(30px, 5.5vw, 46px)",
              fontWeight: 700,
              color: "#fff",
              lineHeight: 1.15,
              letterSpacing: -0.5,
              margin: "0 0 18px",
            }}
          >
            Instant USDC settlement,
            <br />
            without the wire delays.
          </h1>
          <p
            style={{
              fontSize: 16,
              color: "#AEB9D6",
              lineHeight: 1.6,
              maxWidth: 520,
              margin: "0 auto 32px",
            }}
          >
            Deploy a payroll contract only you can control. Sign in with
            Google — no seed phrases, no private keys to manage.
          </p>
          <button
            onClick={onSignIn}
            disabled={signInDisabled}
            style={{
              background: BLUE,
              border: "none",
              borderRadius: 12,
              padding: "14px 32px",
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(46,92,255,0.35)",
            }}
          >
            Get started with Google →
          </button>
          <div style={{ marginTop: 14, fontSize: 12, color: "#7A87A8" }}>
            Testnet demo · No real funds involved
          </div>
        </div>
      </section>
      {/* ===== HOW IT WORKS ===== */}
      <section style={{ padding: "88px 24px 0", maxWidth: 1000, margin: "0 auto", position: "relative", overflow: "hidden" }}>
        <Reveal>
          <div style={{ textAlign: "center", marginBottom: 60, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                top: -80,
                left: "50%",
                transform: "translateX(-50%)",
                width: 480,
                height: 380,
                background: `radial-gradient(ellipse, ${LIGHTBLUE} 0%, transparent 65%)`,
                zIndex: -1,
              }}
            />
            <div
              style={{
                position: "absolute",
                top: -40,
                left: "calc(50% - 220px)",
                width: 180,
                height: 180,
                background: `radial-gradient(circle, #FFE9C6 0%, transparent 70%)`,
                zIndex: -1,
                opacity: 0.6,
              }}
            />
            <div
              style={{
                position: "absolute",
                top: -20,
                left: "calc(50% + 140px)",
                width: 160,
                height: 160,
                background: `radial-gradient(circle, #D6E4FF 0%, transparent 70%)`,
                zIndex: -1,
                opacity: 0.8,
              }}
            />

            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: NAVY,
                borderRadius: 20,
                padding: "7px 18px",
                marginBottom: 22,
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: 3, background: "#4ADE80" }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", letterSpacing: 1.4 }}>
                HOW IT WORKS
              </span>
            </div>

            <h2
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: "clamp(34px, 6.5vw, 56px)",
                fontWeight: 800,
                margin: "0 0 16px",
                letterSpacing: -1.2,
                lineHeight: 1.05,
              }}
            >
              Set up once.
              <br />
              <span
                style={{
                  background: `linear-gradient(90deg, ${BLUE}, #7C3AED)`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                Pay on schedule.
              </span>
            </h2>
            <p style={{ fontSize: 15.5, color: GRAY, maxWidth: 440, margin: "0 auto" }}>
              Six steps from zero to a fully automated, on-chain payroll run —
              every one of them enforced by the contract, not just the UI.
            </p>
          </div>
        </Reveal>

        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              {
                n: "01",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2}>
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                ),
                title: "Deploy your contract",
                body: "One click, one wallet. Your payroll contract is yours alone — no shared admin, no backend override.",
              },
              {
                n: "02",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2}>
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                ),
                title: "Build your whitelist",
                body: "Not just a safety switch — a contact book. Whitelisting prevents the two most common on-chain mistakes: sending to the wrong address, and sending to one that was never approved.",
              },
              {
                n: "03",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2}>
                    <path d="M22 2 11 13" />
                    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
                  </svg>
                ),
                title: "Connect Telegram",
                body: "More than notifications. Telegram approval separates who creates a schedule from who approves it — and it's your recovery path if you ever need to reset a lost passkey.",
              },
              {
                n: "04",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2}>
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <path d="M3 10h18" />
                    <path d="M8 2v4M16 2v4" />
                  </svg>
                ),
                title: "Schedule payments",
                body: "Add recipients from your whitelist, one at a time or in bulk via CSV. One-time or recurring, in USDC.",
              },
              {
                n: "05",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2}>
                    <path d="m22 2-7 20-4-9-9-4Z" />
                    <path d="M22 2 11 13" />
                  </svg>
                ),
                title: "Approve on Telegram",
                body: "Approvers get notified instantly and confirm with one tap — with an optional passkey check first.",
              },
              {
                n: "06",
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2}>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ),
                title: "Executed & verified",
                body: "Approved payments run automatically within 6 hours, and every execution is checked against the chain.",
              },
            ].map((step, i) => (
              <Reveal delay={i * 0.06} key={step.n}>
                <div
                  style={{
                    display: "flex",
                    gap: 18,
                    background: LIGHTGRAY,
                    borderRadius: 16,
                    padding: 22,
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      flexShrink: 0,
                      width: 56,
                      height: 56,
                      borderRadius: 14,
                      background: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                      boxShadow: "0 1px 3px rgba(11,18,32,0.08)",
                    }}
                  >
                    {step.icon}
                    <div
                      style={{
                        position: "absolute",
                        top: -8,
                        right: -8,
                        background: NAVY,
                        color: "#fff",
                        fontSize: 10,
                        fontWeight: 800,
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {step.n}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{step.title}</div>
                    <div style={{ fontSize: 13.5, color: GRAY, lineHeight: 1.55 }}>{step.body}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
      {/* ===== PROBLEMS SOLVED ===== */}
      <section style={{ padding: "88px 24px", maxWidth: 1100, margin: "0 auto" }}>
        <Reveal>
          <div style={{ textAlign: "center", marginBottom: 56 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: NAVY,
                borderRadius: 20,
                padding: "7px 18px",
                marginBottom: 20,
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: 3, background: "#4ADE80" }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", letterSpacing: 1.4 }}>
                WHY SNAPROLL
              </span>
            </div>
            <h2
              style={{
                fontFamily: "'Space Grotesk', sans-serif",
                fontSize: "clamp(30px, 5vw, 44px)",
                fontWeight: 800,
                margin: "0 0 14px",
                letterSpacing: -1,
              }}
            >
              Neither side of payroll
              <br />
              works today.
            </h2>
            <p style={{ fontSize: 15, color: GRAY, maxWidth: 480, margin: "0 auto" }}>
              Traditional finance is slow and centralized. Raw crypto is fast, but unforgiving.
              SnapRoll is built at the intersection of both.
            </p>
          </div>
        </Reveal>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 28 }}>
          <Reveal>
            <div
              style={{
                background: NAVY,
                borderRadius: 24,
                padding: "32px 28px",
                position: "relative",
                overflow: "hidden",
                height: "100%",
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: -60,
                  right: -60,
                  width: 200,
                  height: 200,
                  borderRadius: "50%",
                  background: "radial-gradient(circle, rgba(46,92,255,0.35) 0%, transparent 70%)",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24, position: "relative" }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.1)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2}>
                    <rect x="2" y="7" width="20" height="14" rx="2" />
                    <path d="M16 21V5a2 2 0 0 0-2-2H10a2 2 0 0 0-2 2v16" />
                  </svg>
                </div>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#fff", letterSpacing: 1 }}>
                  TRADITIONAL FINANCE
                </span>
              </div>

              {[
                [
                  "Slow, manual transfers",
                  "Cross-border wires take days. SnapRoll settles in USDC instantly and bulk-schedules dozens of payments from a single CSV in seconds.",
                ],
                [
                  "A centralized point of failure",
                  "If a payroll provider's backend is hacked, payout destinations can be silently rewritten. Your contract is yours — even a compromised SnapRoll site can't alter schedules already created.",
                ],
                [
                  "Expensive cross-border fees",
                  "International transfers carry real, often opaque costs. On-chain USDC settlement keeps fees close to zero.",
                ],
              ].map(([title, body], i, arr) => (
                <div
                  key={title}
                  style={{
                    paddingBottom: i < arr.length - 1 ? 20 : 0,
                    marginBottom: i < arr.length - 1 ? 20 : 0,
                    borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.1)" : "none",
                    position: "relative",
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{title}</div>
                  <div style={{ fontSize: 13, color: "#AEB9D6", lineHeight: 1.6 }}>{body}</div>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div
              style={{
                background: `linear-gradient(160deg, ${BLUE} 0%, #1E3FCC 100%)`,
                borderRadius: 24,
                padding: "32px 28px",
                position: "relative",
                overflow: "hidden",
                height: "100%",
                boxSizing: "border-box",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  bottom: -70,
                  left: -70,
                  width: 220,
                  height: 220,
                  borderRadius: "50%",
                  background: "radial-gradient(circle, rgba(255,255,255,0.15) 0%, transparent 70%)",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24, position: "relative" }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: "rgba(255,255,255,0.18)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2}>
                    <path d="M12 2 2 7l10 5 10-5-10-5Z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                </div>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#fff", letterSpacing: 1 }}>
                  RAW CRYPTO
                </span>
              </div>

              {[
                [
                  "Private keys are a liability",
                  "One leaked key, one drained wallet. Circle Wallets remove key management entirely — sign in with Google, whitelist blocks unauthorized recipients, and optional passkey + two-step Telegram approval keep funds safe even if your Google account is compromised.",
                ],
                [
                  "One typo, funds gone",
                  "A single mistyped character sends funds irreversibly. Your whitelist doubles as an address book, and CSV bulk upload removes copy-pasting for dozens of schedules at once.",
                ],
                [
                  "42-character addresses",
                  "Random doesn't mean distinct — across many employees, addresses can look confusingly similar. Send to a registered recipient's email instead of an 0x address.",
                ],
              ].map(([title, body], i, arr) => (
                <div
                  key={title}
                  style={{
                    paddingBottom: i < arr.length - 1 ? 20 : 0,
                    marginBottom: i < arr.length - 1 ? 20 : 0,
                    borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.2)" : "none",
                    position: "relative",
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 6 }}>{title}</div>
                  <div style={{ fontSize: 13, color: "#DCE4FF", lineHeight: 1.6 }}>{body}</div>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>
      {/* ===== SECURITY / BUILT WITH ===== */}
      <section style={{ background: LIGHTGRAY, padding: "72px 24px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <Reveal>
            <div style={{ textAlign: "center", marginBottom: 44 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: BLUE, letterSpacing: 1.5, marginBottom: 10 }}>
                SECURITY BY DESIGN
              </div>
              <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 28, fontWeight: 700, margin: 0 }}>
                Every safeguard runs on-chain, not just in the UI.
              </h2>
            </div>
          </Reveal>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
            {[
              ["No shared private keys", "Circle User-Controlled Wallets — Google login, no raw key ever exposed."],
              ["Whitelist enforced on-chain", "Payments to non-whitelisted recipients revert at the contract level."],
              ["Optional passkey lock", "Protects your funds even if your Google account is compromised."],
              ["History verified on export", "Every executed payment is re-checked against its on-chain receipt."],
            ].map(([title, body], i) => (
              <Reveal delay={i * 0.06} key={title}>
                <div style={{ background: "#fff", borderRadius: 14, padding: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, background: GREEN }} />
                    <div style={{ fontSize: 14.5, fontWeight: 700 }}>{title}</div>
                  </div>
                  <div style={{ fontSize: 13, color: GRAY, lineHeight: 1.5 }}>{body}</div>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.2}>
            <div
              style={{
                marginTop: 40,
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: "10px 28px",
                fontSize: 12.5,
                color: GRAY,
                fontWeight: 600,
              }}
            >
              <span>Circle User-Controlled Wallets</span>
              <span>·</span>
              <span>Arc Testnet</span>
              <span>·</span>
              <span>Telegram Bot API</span>
              <span>·</span>
              <span>WebAuthn</span>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ===== CTA ===== */}
      <section style={{ background: NAVY, padding: "72px 24px", textAlign: "center" }}>
        <Reveal>
          <h2
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 28,
              fontWeight: 700,
              color: "#fff",
              margin: "0 0 14px",
              maxWidth: 480,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            Ready to run payroll on-chain?
          </h2>
          <p style={{ color: "#AEB9D6", fontSize: 14.5, marginBottom: 28 }}>
            Set up takes under a minute. No wallet required beforehand.
          </p>
          <button
            onClick={onSignIn}
            disabled={signInDisabled}
            style={{
              background: BLUE,
              border: "none",
              borderRadius: 12,
              padding: "14px 32px",
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(46,92,255,0.35)",
            }}
          >
            Get started with Google →
          </button>
        </Reveal>
      </section>

      <footer style={{ padding: "24px", textAlign: "center", fontSize: 12, color: GRAY }}>
        SnapRoll · Built on Arc Testnet · Testnet demo, no real funds involved
      </footer>
    </div>
  );
}
