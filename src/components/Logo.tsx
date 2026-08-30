/**
 * MyBizCare mark - a voice orb.
 *
 * Replaces the original chat-bubble-and-check glyph, which said "messaging
 * with a verified answer" back when the product was text over WhatsApp. The
 * product is now a phone line, so the mark says voice: a gradient orb with a
 * sound level inside it, and sound radiating out of it on both sides.
 *
 * Deliberately no microphone. A mic is the device you speak into; the arcs are
 * speech itself arriving and leaving, which is the thing being sold - and a mic
 * silhouette turns to mush at the 20px the footer renders this at.
 *
 * On palette rather than on the reference image: the Kiowa brand gradient
 * (#22BCCE -> #006874, the same one the previous mark used) carries it, and the
 * radiating arcs are the light stop of that gradient fading outward. The
 * reference's magenta would mean adding a hue the design system does not have.
 *
 * Drawn on a 40x40 grid with everything inside r=18.8, so it stays clear of the
 * viewBox edge at any size, and with 2.4-wide round-capped arcs so nothing
 * thins out to invisibility when this is 20px in a footer.
 *
 * Optically sized: below 24px the second ring of arcs stops being a second ring
 * and just fills the gap between the first one and the orb, so the mark goes
 * muddy. At those sizes it drops to a single arc each side.
 */
export function Logo({ size = 32 }: { size?: number }) {
  const detailed = size >= 24;

  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="mybizcare-mark" x1="11" y1="11" x2="29" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22BCCE" />
          <stop offset="1" stopColor="#006874" />
        </linearGradient>
      </defs>

      {/* Halo. The reference image's glow, done as a flat low-opacity disc
          rather than a blur filter - a filter is expensive, and at 20px it
          renders as a grey smudge instead of a glow. */}
      <circle cx="20" cy="20" r="11.6" fill="#22BCCE" fillOpacity="0.13" />

      {/* The orb */}
      <circle cx="20" cy="20" r="9" fill="url(#mybizcare-mark)" />

      {/* Sound level inside it: short-tall-short reads as a voice meter at any
          size, where five bars would fill in solid once this gets small. */}
      <rect x="15.5" y="17.5" width="2.2" height="5" rx="1.1" fill="white" />
      <rect x="18.9" y="15.5" width="2.2" height="9" rx="1.1" fill="white" />
      <rect x="22.3" y="17.5" width="2.2" height="5" rx="1.1" fill="white" />

      {/* Sound leaving, both sides, fading outward */}
      <g stroke="#22BCCE" strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path d="M29.96 11.64 A13 13 0 0 1 29.96 28.36" />
        <path d="M10.04 11.64 A13 13 0 0 0 10.04 28.36" />
        {detailed && (
          <>
            <path d="M33.41 8.75 A17.5 17.5 0 0 1 33.41 31.25" strokeOpacity="0.42" />
            <path d="M6.59 8.75 A17.5 17.5 0 0 0 6.59 31.25" strokeOpacity="0.42" />
          </>
        )}
      </g>
    </svg>
  );
}

export default Logo;
