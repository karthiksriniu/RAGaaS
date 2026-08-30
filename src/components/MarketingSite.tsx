import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { Button } from "./kiowa/Button";
import { Card } from "./kiowa/Card";
import { getBillingConfig } from "@/lib/billing";
import { PLAN_PRICE_INR } from "@/lib/upi";

const CONTACT_EMAIL = "hello@mybizcare.com";
const MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("MyBizCare - let's talk")}`;
const SIGNUP = "/signup";

/** The price the page advertises must be the price the QR actually asks for,
 * so it comes from the same config the payment order does. But this is the
 * public landing page: a database that is down or a settings table that does
 * not exist yet must cost us a price, not the whole page. */
async function advertisedPrice(): Promise<number> {
  try {
    const { priceInr } = await getBillingConfig();
    return priceInr;
  } catch {
    return PLAN_PRICE_INR;
  }
}

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
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: size * 0.5 }}>
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

/** The CTA that sits on a dark section. A filled Button there is deep teal on
 * near-black, which reads as a shape rather than a button - so the dark-section
 * CTA inverts: light fill, dark label. Both tokens flip together under a theme
 * swap, so this stays right in either theme. */
function DarkCta({ children, icon }: { children: ReactNode; icon?: string }) {
  return (
    <a href={SIGNUP}>
      <Button
        variant="filled"
        size="large"
        icon={icon}
        style={{ background: "var(--color-inverse-primary)", color: "var(--color-inverse-surface)" }}
      >
        {children}
      </Button>
    </a>
  );
}

/** One side of a side-by-side comparison. `tone` decides whether the items read
 * as the thing being rejected or the thing being offered. */
function CompareColumn({
  title,
  items,
  tone,
  dark = false,
}: {
  title: string;
  items: string[];
  tone: "them" | "us";
  dark?: boolean;
}) {
  const good = tone === "us";
  const titleColor = dark
    ? good
      ? "var(--color-inverse-primary)"
      : "#F2B8B5"
    : good
      ? "var(--color-primary)"
      : "var(--color-on-surface-variant)";

  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: dark
          ? good
            ? "rgba(158,239,253,0.12)"
            : "rgba(255,255,255,0.06)"
          : good
            ? "var(--color-primary-container)"
            : "var(--color-surface-container-highest)",
      }}
    >
      <p className="kw-title-medium" style={{ color: titleColor }}>
        {title}
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((t) => (
          <li key={t} className="flex items-start gap-2">
            <span
              className="material-symbols-rounded"
              aria-hidden="true"
              style={{
                fontSize: 20,
                lineHeight: "24px",
                color: titleColor,
                opacity: good ? 1 : 0.7,
              }}
            >
              {good ? "check" : "close"}
            </span>
            <span
              className="kw-body-medium"
              style={{
                color: dark
                  ? "var(--color-inverse-on-surface)"
                  : good
                    ? "var(--color-on-primary-container)"
                    : "var(--color-on-surface-variant)",
                opacity: dark && !good ? 0.75 : 1,
              }}
            >
              {t}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Where the number goes. The differentiator is not "we are self-service", it
 * is that an owner leaves with something they can paste somewhere today, so
 * these are named as places they already have rather than as "channels". */
function PlacementChip({ icon, label }: { icon: string; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full px-4 py-2"
      style={{ background: "var(--color-surface-container-highest)" }}
    >
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18, color: "var(--color-primary)" }}>
        {icon}
      </span>
      <span className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>
        {label}
      </span>
    </span>
  );
}

const PLACEMENTS = [
  { icon: "photo_camera", label: "Your Instagram bio" },
  { icon: "chat", label: "Your WhatsApp profile" },
  { icon: "location_on", label: "Your Google listing" },
  { icon: "storefront", label: "The board outside your shop" },
  { icon: "badge", label: "Your visiting card" },
];

const NAV_LINKS = [
  { href: "#difference", label: "Why us" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#on-the-call", label: "On the call" },
  { href: "#pricing", label: "Pricing" },
];

const PRICING_INCLUDES = [
  "A phone number of your own",
  "An agent that learns from your website and your documents",
  "As many documents and price lists as you want to add",
  "Answers on the phone, on web chat and on WhatsApp",
  "Handover to your team when a caller needs a person",
  "Change the voice, the knowledge and the style whenever you like",
];

export async function MarketingSite() {
  const price = await advertisedPrice();

  return (
    <div style={{ background: "var(--color-surface)" }}>
      {/* Nav */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-6 py-4"
        style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-outline-variant)" }}
      >
        {/* The wordmark goes at the narrowest widths. On a 375px phone the mark,
            the name and both buttons do not fit, and the name is what collides
            with Login - the logo alone still identifies the page. */}
        <div className="flex items-center gap-3">
          <Logo size={32} />
          <span className="kw-title-medium hidden sm:inline" style={{ color: "var(--color-on-surface)" }}>
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
        <div className="flex items-center gap-2">
          {/* Straight to /app: an already-signed-in owner lands on their
              dashboard, and anyone else is bounced to /login from there. */}
          <a href="/app">
            <Button variant="outlined" size="small">
              Login
            </Button>
          </a>
          <a href={SIGNUP}>
            <Button variant="filled" size="small">
              Get started
            </Button>
          </a>
        </div>
      </header>

      {/* Hero */}
      <section
        className="px-6 py-24"
        style={{ background: "var(--color-inverse-surface)", color: "var(--color-inverse-on-surface)" }}
      >
        <div className="mx-auto max-w-3xl text-center">
          <p
            className="kw-label-large mb-4 uppercase"
            style={{ color: "var(--color-inverse-primary)", letterSpacing: "1.2px" }}
          >
            AI that answers your business calls
          </p>
          <h1 className="kw-display-small" style={{ color: "var(--color-inverse-on-surface)" }}>
            Never miss a customer call again.
          </h1>
          <p className="kw-body-large mx-auto mt-5 max-w-2xl" style={{ color: "var(--color-inverse-primary)" }}>
            Set it up yourself in the next few minutes. Your customers get a number to call, and it answers
            them like someone who works for you — day or night, in English or their own language.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <DarkCta icon="arrow_forward">Set up my agent</DarkCta>
            <a href="#how-it-works">
              <Button variant="text" size="large" style={{ color: "var(--color-inverse-primary)" }}>
                See how it works
              </Button>
            </a>
          </div>
          <p className="kw-body-small mt-6" style={{ color: "var(--color-inverse-on-surface)", opacity: 0.7 }}>
            ₹{price} a month · No setup fee · No contract · Nobody to talk to first
          </p>
        </div>
      </section>

      {/* The differentiator */}
      <Section id="difference">
        <Eyebrow>What makes us different</Eyebrow>
        {/* text-pretty, NOT text-balance. Balance equalises the two lines, which
            on a wide screen left the headline sitting in about half the section
            with a dead gutter beside it. Pretty only refuses to strand the last
            word, so the line fills the container and still never orphans. */}
        <h2 className="kw-headline-medium text-pretty">
          Everyone else books you a demo. You get a number to put in your Instagram bio.
        </h2>
        <p className="kw-body-large mt-4 max-w-3xl" style={{ color: "var(--color-on-surface-variant)" }}>
          Not a trial and not a sandbox — a real phone number, yours, at the end of signing up. Put it behind
          the call button on your Instagram, on your Google listing, on the board outside your shop. Anybody
          who rings it gets straight answers about your services, your prices and your timings.
        </p>
        <div className="mt-7 flex flex-wrap gap-2">
          {PLACEMENTS.map((p) => (
            <PlacementChip key={p.label} icon={p.icon} label={p.label} />
          ))}
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <CompareColumn
            tone="them"
            title="The usual way"
            items={[
              "Fill a form and wait for someone to call you back",
              "Sit through a demo, then a scoping call",
              "Weeks of setup, done by their team",
              "An IT project to connect it to anything",
              "Price on request, and a yearly contract",
            ]}
          />
          <CompareColumn
            tone="us"
            title="With MyBizCare"
            items={[
              "Sign up yourself, right now, on your phone",
              "Describe your business in your own words",
              "It reads your website and learns the rest",
              "A number you can share the same day you sign up",
              `₹${price} a month, and you can stop any time`,
            ]}
          />
        </div>
      </Section>

      {/* How it works */}
      <Section id="how-it-works" dark>
        <Eyebrow dark>How it works</Eyebrow>
        <h2 className="kw-headline-medium" style={{ color: "var(--color-inverse-on-surface)" }}>
          Four steps, and nobody else has to be involved
        </h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              n: 1,
              title: "Tell it about your business",
              desc: "Type it out, or just tap the mic and say it — whatever you would tell someone on their first day.",
            },
            {
              n: 2,
              title: "It reads your website",
              desc: "Your services, your rates, the questions people always ask. It picks all that up on its own.",
            },
            {
              n: 3,
              title: "Verify and pay",
              desc: `A code to your mobile, ₹${price} on UPI. That is the whole checkout.`,
            },
            {
              n: 4,
              title: "Your line goes live",
              desc: "You get a phone number. Put it on your shopfront, your card, your listing. It starts answering.",
            },
          ].map((step) => (
            <div key={step.n} className="text-center">
              <div
                className="mx-auto flex items-center justify-center kw-title-medium"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "var(--radius-full)",
                  background: "var(--color-inverse-primary)",
                  color: "var(--color-inverse-surface)",
                }}
              >
                {step.n}
              </div>
              <p className="kw-title-medium mt-3" style={{ color: "var(--color-inverse-on-surface)" }}>
                {step.title}
              </p>
              <p className="kw-body-medium mt-1" style={{ color: "var(--color-inverse-on-surface)", opacity: 0.75 }}>
                {step.desc}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-12 flex justify-center">
          <DarkCta icon="arrow_forward">Set up my agent</DarkCta>
        </div>
      </Section>

      {/* On the call */}
      <Section id="on-the-call">
        <Eyebrow>On the call</Eyebrow>
        <h2 className="kw-headline-medium">It sounds like someone who works there</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard
            icon="forum"
            title="A real conversation"
            description="No press-1-for-sales menus. People just say what they want, the way they would say it to you."
          />
          <FeatureCard
            icon="translate"
            title="Your customer's language"
            description="English, or the regional language they are comfortable in — Tamil and Malayalam today. Switch mid-sentence and it switches too."
          />
          <FeatureCard
            icon="schedule"
            title="It always picks up"
            description="Nights, Sundays, the festival rush. Nobody is left holding, and nobody hangs up."
          />
          <FeatureCard
            icon="record_voice_over"
            title="The voice you pick"
            description="Choose how your agent sounds from your dashboard. The very next call uses it."
          />
        </div>
      </Section>

      {/* Grounded, not generic */}
      <Section dark>
        <Eyebrow dark>Why not just use a chatbot</Eyebrow>
        <h2 className="kw-headline-medium" style={{ color: "var(--color-inverse-on-surface)" }}>
          A general AI does not know your prices
        </h2>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <CompareColumn
            dark
            tone="them"
            title="A general AI chatbot"
            items={[
              "Learned from the open internet",
              "Sounds just as confident when it is wrong",
              "Does not know your rates, timings or rules",
              "Gives your customer the same answer it gives everyone",
            ]}
          />
          <CompareColumn
            dark
            tone="us"
            title="Your MyBizCare agent"
            items={[
              "Learns only from what you give it",
              "Says so plainly when it is not sure",
              "Knows your services, your prices, your policies",
              "Answers as your business, and only about your business",
            ]}
          />
        </div>
      </Section>

      {/* Knows its limits */}
      <Section>
        <Eyebrow>When it is not sure</Eyebrow>
        <h2 className="kw-headline-medium">It does not make things up</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <Card variant="filled" padding={24} style={{ background: "var(--color-secondary-container)" }}>
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 32, color: "var(--color-on-secondary-container)" }}>
              check_circle
            </span>
            <p className="kw-title-medium mt-3" style={{ color: "var(--color-on-secondary-container)" }}>
              It knows the answer
            </p>
            <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-secondary-container)", opacity: 0.85 }}>
              It answers straight away and gets on with the call.
            </p>
          </Card>
          <Card variant="filled" padding={24} style={{ background: "var(--color-tertiary-container)" }}>
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 32, color: "var(--color-on-tertiary-container)" }}>
              warning
            </span>
            <p className="kw-title-medium mt-3" style={{ color: "var(--color-on-tertiary-container)" }}>
              It is only half sure
            </p>
            <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-tertiary-container)", opacity: 0.85 }}>
              It gives what it actually has, and says so — instead of inventing the rest.
            </p>
          </Card>
          <Card variant="filled" padding={24}>
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 32, color: "var(--color-on-surface)" }}>
              support_agent
            </span>
            <p className="kw-title-medium mt-3">You are the better answer</p>
            <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
              It hands the caller to your team rather than take a guess.
            </p>
          </Card>
        </div>
        <p className="kw-body-large mt-6 text-center" style={{ color: "var(--color-on-surface-variant)" }}>
          The worst thing an agent can do is tell your customer something untrue, confidently. This one will
          not.
        </p>
      </Section>

      {/* One knowledge base, every channel */}
      <Section>
        <Eyebrow>Beyond the phone</Eyebrow>
        <h2 className="kw-headline-medium">Teach it once. It answers everywhere.</h2>
        <p className="kw-body-large mt-4 max-w-3xl" style={{ color: "var(--color-on-surface-variant)" }}>
          Everything your agent knows sits in one place. So the answer a customer gets on the phone is the
          same one they get on your web page or on WhatsApp — and when you change a price, it changes in all
          three at once.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <FeatureCard icon="call" title="Phone calls" description="Your own number, answered out loud. This is the main event." />
          <FeatureCard icon="chat_bubble" title="Web chat" description="A chat box on your own MyBizCare page, answering from the same knowledge." />
          <FeatureCard icon="smartphone" title="WhatsApp" description="Typed questions and voice notes, answered the same way." />
        </div>
      </Section>

      {/* Stays yours */}
      <Section>
        <Eyebrow>It stays yours</Eyebrow>
        <h2 className="kw-headline-medium">Change anything yourself, whenever you like</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <FeatureCard
            icon="folder"
            title="What it knows"
            description="Add documents, price lists, policies. Take out what is out of date. No ticket, no waiting on anyone."
          />
          <FeatureCard
            icon="graphic_eq"
            title="How it sounds"
            description="Pick a voice that suits your business. Change your mind as often as you like."
          />
          <FeatureCard
            icon="tune"
            title="How it answers"
            description="Tell it to keep replies short, to always mention delivery charges, to never discuss competitors. In plain English."
          />
        </div>
        <p className="kw-body-large mt-8 text-center" style={{ color: "var(--color-on-surface-variant)" }}>
          What you upload is used to answer your customers and nothing else. It is never shared, and never
          used to train anybody else&apos;s agent.
        </p>
      </Section>

      {/* Industries */}
      <Section id="industries">
        <Eyebrow>Who it is for</Eyebrow>
        <h2 className="kw-headline-medium">If customers call you, this is for you</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { icon: "storefront", label: "Shops & retail" },
            { icon: "health_and_safety", label: "Clinics & wellness" },
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

      {/* Pricing */}
      <Section id="pricing">
        <Eyebrow>Pricing</Eyebrow>
        <h2 className="kw-headline-medium">₹{price} a month. That is the whole price list.</h2>
        <p className="kw-body-large mt-4 max-w-3xl" style={{ color: "var(--color-on-surface-variant)" }}>
          One plan, everything in it. No setup fee, no per-call charge, and nothing you have to ask us for a
          quote on.
        </p>
        <Card variant="outlined" padding={32} className="mt-10" style={{ maxWidth: 560 }}>
          <div className="flex items-baseline justify-between">
            <span className="kw-title-large">Standard</span>
            <span className="kw-headline-medium">
              ₹{price}
              <span className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>
                /month
              </span>
            </span>
          </div>
          <ul className="mt-5 flex flex-col gap-3">
            {PRICING_INCLUDES.map((f) => (
              <li key={f} className="flex items-start gap-2">
                <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20, lineHeight: "24px", color: "var(--color-primary)" }}>
                  check
                </span>
                <span className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>
                  {f}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-7">
            <a href={SIGNUP}>
              <Button variant="filled" size="large" fullWidth icon="arrow_forward">
                Set up my agent
              </Button>
            </a>
          </div>
          <p className="kw-body-small mt-4 text-center" style={{ color: "var(--color-on-surface-variant)" }}>
            Pay by UPI. It renews every month, and stops when you stop paying.
          </p>
        </Card>
      </Section>

      {/* Final CTA */}
      <section
        id="contact"
        className="px-6 py-24 text-center"
        style={{ background: "var(--color-inverse-surface)", color: "var(--color-inverse-on-surface)" }}
      >
        <div className="mx-auto max-w-2xl">
          <h2 className="kw-headline-large" style={{ color: "var(--color-inverse-on-surface)" }}>
            Your customers are already calling.
          </h2>
          <p className="kw-body-large mx-auto mt-4 max-w-lg" style={{ color: "var(--color-inverse-primary)" }}>
            Give them something that always picks up. A few minutes from now, it can be answering.
          </p>
          <div className="mt-8 flex justify-center">
            <DarkCta icon="arrow_forward">Set up my agent</DarkCta>
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
