import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { Button } from "./kiowa/Button";
import { Card } from "./kiowa/Card";

const CONTACT_EMAIL = "karthik.sreeni@gmail.com";
const MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("MyBizCare - let's talk")}`;
const SIGNUP = "/signup";

function Eyebrow({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <p
      className="kw-label-large mb-3 uppercase"
      style={{ color: dark ? "var(--color-inverse-primary)" : "var(--color-primary)", letterSpacing: "1.2px" }}
    >
      {children}
    </p>
  );
}

function IconCircle({ icon, size = 56 }: { icon: string; size?: number }) {
  return (
    <div
      className="flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: "var(--radius-full)",
        background: "var(--color-primary-container)",
        color: "var(--color-primary)",
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: size * 0.5 }}>
        {icon}
      </span>
    </div>
  );
}

function Section({
  id,
  children,
  dark = false,
}: {
  id?: string;
  children: ReactNode;
  dark?: boolean;
}) {
  return (
    <section
      id={id}
      className="px-6 py-20"
      style={{
        background: dark ? "var(--color-inverse-surface)" : "var(--color-surface)",
        color: dark ? "var(--color-inverse-on-surface)" : "var(--color-on-surface)",
      }}
    >
      <div className="mx-auto max-w-5xl">{children}</div>
    </section>
  );
}

function FeatureCard({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <Card variant="filled" padding={24}>
      <IconCircle icon={icon} size={48} />
      <p className="kw-title-medium mt-4" style={{ color: "var(--color-on-surface)" }}>
        {title}
      </p>
      <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
        {description}
      </p>
    </Card>
  );
}

const NAV_LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#trust", label: "Trust & privacy" },
  { href: "#industries", label: "Industries" },
  { href: "#contact", label: "Contact" },
  { href: "/login", label: "Sign in" },
];

export function MarketingSite() {
  return (
    <div style={{ background: "var(--color-surface)" }}>
      {/* Nav */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-6 py-4"
        style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-outline-variant)" }}
      >
        <div className="flex items-center gap-3">
          <Logo size={32} />
          <span className="kw-title-medium" style={{ color: "var(--color-on-surface)" }}>
            MyBizCare
          </span>
        </div>
        <nav className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>
              {link.label}
            </a>
          ))}
        </nav>
        <a href={SIGNUP}>
          <Button variant="filled" size="small">
            Sign up
          </Button>
        </a>
      </header>

      {/* Hero */}
      <section
        className="px-6 py-24"
        style={{ background: "var(--color-inverse-surface)", color: "var(--color-inverse-on-surface)" }}
      >
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 flex justify-center">
            <Logo size={48} />
          </div>
          <h1 className="kw-display-small" style={{ color: "var(--color-inverse-on-surface)" }}>
            Private AI customer care, built on what you know.
          </h1>
          <p className="kw-body-large mx-auto mt-5 max-w-xl" style={{ color: "var(--color-inverse-primary)" }}>
            Instant, accurate answers for your customers — grounded in your own knowledge, on the channels they
            already use.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <a href={SIGNUP}>
              <Button variant="filled" size="large" icon="arrow_forward">
                Get started
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Problem */}
      <Section>
        <Eyebrow>The problem</Eyebrow>
        <h2 className="kw-headline-medium">Customer support is breaking under its own weight</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard icon="schedule" title="Slow responses" description="Every extra minute of wait costs you a customer's patience — and often the sale." />
          <FeatureCard icon="dark_mode" title="After hours, no answer" description="Questions don't stop at 6pm. Most support teams do." />
          <FeatureCard icon="report" title="Inconsistent answers" description="Different agent, different answer. Trust erodes one reply at a time." />
          <FeatureCard icon="local_fire_department" title="Rising cost, team burnout" description="Scaling support with more people gets expensive — and hard to sustain." />
        </div>
      </Section>

      {/* Generic AI vs MyBizCare */}
      <Section dark>
        <Eyebrow dark>Why generic AI isn&apos;t enough</Eyebrow>
        <h2 className="kw-headline-medium" style={{ color: "var(--color-inverse-on-surface)" }}>
          Off-the-shelf chatbots weren&apos;t built for your business
        </h2>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.06)" }}>
            <p className="kw-title-medium" style={{ color: "#F2B8B5" }}>
              Generic AI chatbot
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {["Trained on the open internet", "Makes things up with total confidence", "Doesn't know your policies or products", "The same generic answer for everyone"].map((t) => (
                <li key={t} className="kw-body-medium" style={{ color: "var(--color-inverse-on-surface)", opacity: 0.75 }}>
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl p-6" style={{ background: "rgba(158,239,253,0.12)" }}>
            <p className="kw-title-medium" style={{ color: "var(--color-inverse-primary)" }}>
              MyBizCare
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {["Trained only on your knowledge", "Tells you when it isn't sure", "Knows your policies, tone, and products", "Built around your business, specifically"].map((t) => (
                <li key={t} className="kw-body-medium" style={{ color: "var(--color-inverse-on-surface)" }}>
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* Three commitments */}
      <Section>
        <Eyebrow>The promise</Eyebrow>
        <h2 className="kw-headline-medium">One private AI agent. Three commitments.</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <FeatureCard icon="lock" title="Private & secure" description="Your data stays yours — never shared, never reused across customers." />
          <FeatureCard icon="menu_book" title="Grounded in your knowledge" description="Every answer traces back to your own documents and policies — not the open web." />
          <FeatureCard icon="diversity_2" title="Knows its limits" description="When it isn't confident, it hands off to your team instead of guessing." />
        </div>
      </Section>

      {/* How it works */}
      <Section id="how-it-works">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="kw-headline-medium">From your knowledge to a trusted answer</h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { n: 1, title: "Share your knowledge", desc: "Docs, FAQs, policies — whatever your team already has." },
            { n: 2, title: "We build your private engine", desc: "A secure, isolated AI knowledge base — yours alone." },
            { n: 3, title: "Customers ask", desc: "Chat, WhatsApp, or voice — whatever's natural for them." },
            { n: 4, title: "They get a grounded answer", desc: "Cited, accurate, and consistent — every time." },
          ].map((step) => (
            <div key={step.n} className="text-center">
              <div
                className="mx-auto flex items-center justify-center kw-title-medium"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "var(--radius-full)",
                  background: "var(--color-primary)",
                  color: "var(--color-on-primary)",
                }}
              >
                {step.n}
              </div>
              <p className="kw-title-medium mt-3">{step.title}</p>
              <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
                {step.desc}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* Channels */}
      <Section>
        <Eyebrow>Everywhere your customers are</Eyebrow>
        <h2 className="kw-headline-medium">One agent, every channel</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <FeatureCard icon="chat_bubble" title="Web chat" description="A native assistant right on your site." />
          <FeatureCard icon="smartphone" title="WhatsApp" description="Voice notes and text, answered instantly." />
          <FeatureCard icon="mic" title="Voice" description="Speak the question, hear the answer back." />
        </div>
      </Section>

      {/* Built-in judgment */}
      <Section id="trust">
        <Eyebrow>Built-in judgment</Eyebrow>
        <h2 className="kw-headline-medium">It knows what it doesn&apos;t know</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <Card variant="filled" padding={24} style={{ background: "var(--color-secondary-container)" }}>
            <span className="material-symbols-rounded" style={{ fontSize: 32, color: "var(--color-on-secondary-container)" }}>
              check_circle
            </span>
            <p className="kw-title-medium mt-3" style={{ color: "var(--color-on-secondary-container)" }}>
              Confident answer
            </p>
            <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-secondary-container)", opacity: 0.85 }}>
              Clear, grounded, and ready to act on.
            </p>
          </Card>
          <Card variant="filled" padding={24} style={{ background: "var(--color-tertiary-container)" }}>
            <span className="material-symbols-rounded" style={{ fontSize: 32, color: "var(--color-on-tertiary-container)" }}>
              warning
            </span>
            <p className="kw-title-medium mt-3" style={{ color: "var(--color-on-tertiary-container)" }}>
              Flagged for review
            </p>
            <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-tertiary-container)", opacity: 0.85 }}>
              Best available guidance, marked as such.
            </p>
          </Card>
          <Card variant="filled" padding={24}>
            <span className="material-symbols-rounded" style={{ fontSize: 32, color: "var(--color-on-surface)" }}>
              support_agent
            </span>
            <p className="kw-title-medium mt-3">Handed to your team</p>
            <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
              Not sure? Straight to a human — instantly.
            </p>
          </Card>
        </div>
        <p className="kw-body-large mt-6 text-center italic" style={{ color: "var(--color-on-surface-variant)" }}>
          No made-up answers. No guessing on the things that matter.
        </p>
      </Section>

      {/* Isolation */}
      <Section dark>
        <Eyebrow dark>Private by design</Eyebrow>
        <h2 className="kw-headline-medium" style={{ color: "var(--color-inverse-on-surface)" }}>
          Your knowledge stays yours
        </h2>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          {["Business A", "Business B", "Business C"].map((label, i) => (
            <div key={label} className="flex items-center gap-4">
              <div
                className="flex flex-col items-center gap-2 rounded-2xl px-8 py-6"
                style={{ background: "rgba(255,255,255,0.06)" }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 28, color: "var(--color-inverse-primary)" }}>
                  lock_person
                </span>
                <p className="kw-title-medium" style={{ color: "var(--color-inverse-on-surface)" }}>
                  {label}
                </p>
              </div>
              {i < 2 && (
                <span className="material-symbols-rounded" style={{ fontSize: 20, color: "var(--color-inverse-on-surface)", opacity: 0.35 }}>
                  block
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="kw-body-large mt-8 text-center" style={{ color: "var(--color-inverse-on-surface)", opacity: 0.75 }}>
          Every customer&apos;s knowledge lives in its own locked space — never mixed, never cross-referenced.
        </p>
      </Section>

      {/* Industries */}
      <Section id="industries">
        <Eyebrow>Built to generalize</Eyebrow>
        <h2 className="kw-headline-medium">One platform. Every kind of business.</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { icon: "shopping_cart", label: "Retail" },
            { icon: "health_and_safety", label: "Healthcare" },
            { icon: "agriculture", label: "Agriculture" },
            { icon: "account_balance", label: "Financial services" },
            { icon: "description", label: "Professional services" },
          ].map((v) => (
            <Card key={v.label} variant="filled" padding={20} style={{ textAlign: "center" }}>
              <div className="mx-auto">
                <IconCircle icon={v.icon} size={44} />
              </div>
              <p className="kw-title-small mt-3">{v.label}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* Getting started */}
      <Section>
        <Eyebrow>Getting started</Eyebrow>
        <h2 className="kw-headline-medium">Live in days, not months</h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-3">
          {[
            { icon: "upload", title: "Share your content", desc: "Send us what your team already has." },
            { icon: "settings", title: "We configure your agent", desc: "Tone, channels, and escalation — set up for you." },
            { icon: "rocket_launch", title: "Go live", desc: "Real answers, on real channels, from day one." },
          ].map((step) => (
            <div key={step.title} className="text-center">
              <div className="mx-auto">
                <IconCircle icon={step.icon} />
              </div>
              <p className="kw-title-medium mt-3">{step.title}</p>
              <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
                {step.desc}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* Final CTA / Contact */}
      <section
        id="contact"
        className="px-6 py-24 text-center"
        style={{ background: "var(--color-inverse-surface)", color: "var(--color-inverse-on-surface)" }}
      >
        <div className="mx-auto max-w-2xl">
          <h2 className="kw-headline-large" style={{ color: "var(--color-inverse-on-surface)" }}>
            Let&apos;s build your private AI agent.
          </h2>
          <p className="kw-body-large mx-auto mt-4 max-w-lg" style={{ color: "var(--color-inverse-primary)" }}>
            See it answer real questions from your own knowledge — in your very first walkthrough.
          </p>
          <div className="mt-8 flex justify-center">
            <a href={SIGNUP}>
              <Button variant="filled" size="large" icon="arrow_forward">
                Get started
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="flex flex-col items-center gap-2 px-6 py-10" style={{ background: "var(--color-surface)" }}>
        <div className="flex items-center gap-2">
          <Logo size={20} />
          <span className="kw-title-small" style={{ color: "var(--color-on-surface)" }}>
            MyBizCare
          </span>
        </div>
        <a href={MAILTO} className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
          {CONTACT_EMAIL}
        </a>
      </footer>
    </div>
  );
}

export default MarketingSite;
